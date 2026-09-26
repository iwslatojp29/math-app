"""Real Python clients survive a JavaScript checkpoint serialization boundary."""
import copy
import json
import math
import subprocess
import unittest

from test_parallel_response_safety import MemoryHTTP, Reply, Session
from studio_common import MAX_CHECKPOINT_BYTES, ResponsesClient, StudioClient, StudioError, json_bytes, key_for


MODEL = "fixture-model"
VALUE_SCHEMA = {"type": "object", "properties": {
    "x": {"type": "number"}, "width": {"type": "number"}, "rotation": {"type": "number"},
    "large": {"type": "integer"}, "tiny": {"type": "number"}, "text": {"type": "string"},
    "numericKeys": {"type": "object", "properties": {"10": {"type": "string"}, "2": {"type": "string"}},
                    "required": ["10", "2"], "additionalProperties": False},
    "values": {"type": "array", "items": {"type": "number"}}},
    "required": ["x", "width", "rotation", "large", "tiny", "text", "numericKeys", "values"], "additionalProperties": False}
REVIEW_SCHEMA = {"type": "object", "properties": {"approved": {"type": "boolean"}},
                 "required": ["approved"], "additionalProperties": False}
RAW_VALUE = ('{ "x":25.0, "width":2.50e+0, "rotation":-0.0, "large":9007199254740993,'
             ' "tiny":1e-200, "text":"数と雪☃", "numericKeys":{"10":"十","2":"二"},'
             ' "values":[0.0,-0.0,1.125,9007199254740995] }')


def completed(response_id, result_json):
    return Reply({"id": response_id, "status": "completed", "privateProviderField": "PRIVATE provider metadata",
                  "output": [{"type": "message", "content": [{"type": "output_text", "text": result_json}]},
                             {"type": "reasoning", "summary": [{"type": "summary_text", "text": "PRIVATE provider reasoning"}]}]})


class JavaScriptCheckpointHTTP(MemoryHTTP):
    """Use actual Node JSON.parse/stringify for every real Studio PUT body."""
    def request(self, method, url, **kwargs):
        if method == "PUT" and "/checkpoints/" in url:
            process = subprocess.run(["node", "-e",
                "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>process.stdout.write(JSON.stringify(JSON.parse(s))));"],
                input=kwargs["data"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=10)
            kwargs = {**kwargs, "data": process.stdout}
        return super().request(method, url, **kwargs)


class ResponseCheckpointJSONTests(unittest.TestCase):
    def client(self, transport):
        studio = StudioClient("https://studio.example", "fake-runner-key", "fixture-job", Session(transport))
        return ResponsesClient("fake-api-key", MODEL, studio, Session(transport), sleeper=lambda _seconds: None)

    @staticmethod
    def fingerprint(task, prompt, schema):
        return key_for("ai", [task, MODEL, prompt, schema, []])

    def test_node_roundtrip_preserves_number_types_signed_zero_large_integers_and_review_cache(self):
        transport = JavaScriptCheckpointHTTP([
            ("POST", "", completed("resp_number_candidate", RAW_VALUE)),
            ("POST", "", completed("resp_number_review", '{"approved":true}')),
        ])
        def pipeline(client):
            candidate = client.structured("lesson-fixture-0", "Synthetic numeric candidate", VALUE_SCHEMA)
            review_prompt = "Review the actual candidate: " + json_bytes(candidate).decode()
            review = client.structured("lesson-review-fixture-0", review_prompt, REVIEW_SCHEMA)
            return candidate, review, review_prompt
        first = pipeline(self.client(transport))
        self.assertEqual(len(transport.api_calls), 2)
        snapshot = copy.deepcopy(transport.values)
        second = pipeline(self.client(transport))
        third = pipeline(self.client(transport))
        self.assertEqual(len(transport.api_calls), 2, "Both resumes must issue neither POST nor GET")
        self.assertEqual(json_bytes(first), json_bytes(second))
        self.assertEqual(json_bytes(first), json_bytes(third))
        self.assertEqual(transport.values, snapshot)
        value = second[0]
        self.assertIs(type(value["x"]), float)
        self.assertIs(type(value["values"][0]), float)
        self.assertEqual(math.copysign(1, value["rotation"]), -1)
        self.assertEqual(math.copysign(1, value["values"][1]), -1)
        self.assertEqual(value["large"], 9007199254740993)
        self.assertEqual(value["values"][-1], 9007199254740995)
        self.assertEqual(value["width"], 2.5)
        self.assertEqual(value["tiny"], 1e-200)
        self.assertEqual(value["text"], "数と雪☃")
        self.assertEqual(list(value["numericKeys"]), ["10", "2"])
        fingerprint = self.fingerprint("lesson-fixture-0", "Synthetic numeric candidate", VALUE_SCHEMA)
        self.assertEqual(snapshot[fingerprint]["resultJson"], RAW_VALUE)
        self.assertNotIn("result", snapshot[fingerprint])
        self.assertEqual(set(snapshot), {fingerprint,
            self.fingerprint("lesson-review-fixture-0", first[2], REVIEW_SCHEMA)})
        saved = json_bytes(snapshot).decode()
        for forbidden in ("PRIVATE provider", "fake-api-key", "fake-runner-key", "Authorization", "privateProviderField"):
            self.assertNotIn(forbidden, saved)

    def test_legacy_result_object_remains_readable_without_migration_or_provider_requests(self):
        transport = JavaScriptCheckpointHTTP([])
        task, prompt = "lesson-review-legacy", "Original cached review"
        fingerprint = self.fingerprint(task, prompt, REVIEW_SCHEMA)
        transport.values[fingerprint] = {"responseId": "resp_legacy", "result": {"approved": False}}
        before = copy.deepcopy(transport.values)
        self.assertEqual(self.client(transport).structured(task, prompt, REVIEW_SCHEMA), {"approved": False})
        self.assertEqual(transport.values, before)
        self.assertEqual(transport.api_calls, [])
        self.assertEqual(transport.writes, [])

    def test_malformed_or_schema_invalid_result_json_stops_without_leaking_data_or_requesting_api(self):
        for raw in ("PRIVATE malformed JSON", '{"private":"PRIVATE schema mismatch"}', {"approved": True}):
            with self.subTest(representation=type(raw).__name__):
                transport = JavaScriptCheckpointHTTP([])
                fingerprint = self.fingerprint("lesson-review-invalid", "Original review", REVIEW_SCHEMA)
                transport.values[fingerprint] = {"responseId": "resp_bad_cache", "resultJson": raw}
                with self.assertRaises(StudioError) as caught:
                    self.client(transport).structured("lesson-review-invalid", "Original review", REVIEW_SCHEMA)
                self.assertEqual(caught.exception.code, "model_schema")
                self.assertNotIn("PRIVATE", str(caught.exception) + caught.exception.public_message)
                self.assertEqual(transport.api_calls, [])
                self.assertEqual(transport.writes, [])

    def test_escaped_string_size_uses_actual_checkpoint_payload_and_oversize_resumes_via_get(self):
        schema = {"type": "object", "properties": {"text": {"type": "string"}},
                  "required": ["text"], "additionalProperties": False}
        value = {"text": '"' * 170000}
        raw = json.dumps(value, separators=(",", ":"))
        self.assertLess(len(json_bytes({"value": {"result": value}})), MAX_CHECKPOINT_BYTES)
        self.assertGreater(len(json_bytes({"value": {"resultJson": raw}})), MAX_CHECKPOINT_BYTES)
        transport = JavaScriptCheckpointHTTP([
            ("POST", "", completed("resp_oversize", raw)),
            ("GET", "/resp_oversize", completed("resp_oversize", raw)),
        ])
        task, prompt = "lesson-large-cache", "Synthetic quoted text"
        fingerprint = self.fingerprint(task, prompt, schema)
        self.assertEqual(self.client(transport).structured(task, prompt, schema), value)
        pending = copy.deepcopy(transport.values[fingerprint])
        self.assertEqual(pending["responseId"], "resp_oversize")
        self.assertNotIn("result", pending)
        self.assertNotIn("resultJson", pending)
        self.assertEqual(self.client(transport).structured(task, prompt, schema), value)
        self.assertEqual([(method, suffix) for method, suffix, _ in transport.api_calls],
                         [("POST", ""), ("GET", "/resp_oversize")])
        self.assertEqual(transport.values[fingerprint], pending)
        self.assertTrue(all(len(json_bytes({"value": saved})) <= MAX_CHECKPOINT_BYTES for _, saved in transport.writes))


if __name__ == "__main__":
    unittest.main()
