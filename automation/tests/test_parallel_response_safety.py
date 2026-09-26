"""Independent transport checks for pending Responses during peer failure."""
import copy
import json
import os
import sys
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import studio_common
from studio_common import ResponsesClient, StudioClient, StudioError, key_for


SCHEMA = {"type": "object", "properties": {"answer": {"type": "integer"}},
          "required": ["answer"], "additionalProperties": False}
TASK, MODEL, PROMPT = "lesson-practice-problem-1-0", "fixture-model", "Fixture task; preserve the original request."
FINGERPRINT = key_for("ai", [TASK, MODEL, PROMPT, SCHEMA, []])


class Reply:
    def __init__(self, value, status=200):
        self.value, self.status_code = value, status
        self.ok = 200 <= status < 300

    def json(self):
        return copy.deepcopy(self.value)


def completed(response_id="resp_pending"):
    return Reply({"id": response_id, "status": "completed", "output": [
        {"type": "message", "content": [{"type": "output_text", "text": '{"answer":7}'}]}]})


class MemoryHTTP:
    """Both actual clients use this private in-memory transport; no network exists."""
    def __init__(self, api_script):
        self.values, self.writes, self.api_calls = {}, [], []
        self.api_script, self.after_api = list(api_script), None
        self.lock = threading.RLock()

    def request(self, method, url, **kwargs):
        with self.lock:
            if url.startswith("https://studio.example/api/studio/runner/jobs/fixture-job"):
                if "/checkpoints/" in url:
                    key = url.rsplit("/", 1)[1]
                    if method == "GET":
                        return Reply({"value": self.values[key]}) if key in self.values else Reply({}, 404)
                    if method == "PUT":
                        value = json.loads(kwargs["data"])["value"]
                        self.values[key] = copy.deepcopy(value)
                        self.writes.append((key, copy.deepcopy(value)))
                        return Reply({"ok": True})
                if method == "GET":
                    return Reply({"job": {"status": "running", "runId": os.environ.get("GITHUB_RUN_ID", "fixture-run")}})
                raise AssertionError("Unexpected Studio mutation")
            if not url.startswith("https://api.openai.com/v1/responses"):
                raise AssertionError("No network is available")
            suffix = url.removeprefix("https://api.openai.com/v1/responses")
            self.api_calls.append((method, suffix, json.loads(kwargs["data"]) if kwargs.get("data") else None))
            if not self.api_script:
                raise AssertionError("Unexpected additional provider request")
            expected_method, expected_suffix, response = self.api_script.pop(0)
            if (method, suffix) != (expected_method, expected_suffix):
                raise AssertionError("A saved response was not resumed with its original ID")
            if self.after_api:
                self.after_api(method, suffix)
            return response


class Session:
    def __init__(self, transport):
        self.transport, self.closed = transport, False

    def request(self, *args, **kwargs):
        if self.closed:
            raise AssertionError("Closed worker session reused")
        return self.transport.request(*args, **kwargs)

    def close(self):
        self.closed = True


class ParallelResponseSafetyTests(unittest.TestCase):
    def parent(self, transport):
        studio = StudioClient("https://studio.example", "fake-runner-token", "fixture-job", Session(transport))
        return ResponsesClient("fake-api-token", MODEL, studio, Session(transport), sleeper=lambda _seconds: None)

    def worker(self, parent, transport, event):
        with patch.object(studio_common.requests, "Session", side_effect=lambda: Session(transport)):
            worker = parent.for_worker(event)
        self.addCleanup(worker.close)
        return worker

    def ask(self, worker):
        return worker.structured(TASK, PROMPT, SCHEMA, max_tokens=28000)

    def test_worker_reuses_existing_pending_response_without_duplicate_post(self):
        transport = MemoryHTTP([("GET", "/resp_pending", completed())])
        transport.values[FINGERPRINT] = {"responseId": "resp_pending", "maxOutputTokens": 28000, "budgetIncreases": 0}
        worker = self.worker(self.parent(transport), transport, threading.Event())
        self.assertEqual(self.ask(worker), {"answer": 7})
        self.assertEqual([(method, suffix) for method, suffix, _ in transport.api_calls], [("GET", "/resp_pending")])
        self.assertEqual(json.loads(transport.values[FINGERPRINT]["resultJson"]), {"answer": 7})
        self.assertEqual(self.ask(worker), {"answer": 7})
        self.assertEqual(len(transport.api_calls), 1, "A second invocation must reuse the completed checkpoint")

    def test_peer_stop_after_post_still_saves_response_id_and_resume_uses_get(self):
        transport = MemoryHTTP([
            ("POST", "", Reply({"id": "resp_created_before_stop", "status": "in_progress"})),
            ("GET", "/resp_created_before_stop", completed("resp_created_before_stop")),
        ])
        stop = threading.Event()
        # A peer fails while our HTTP request is in flight, before its response is handled.
        transport.after_api = lambda method, _suffix: stop.set() if method == "POST" else None
        parent = self.parent(transport)
        worker = self.worker(parent, transport, stop)
        with self.assertRaises(StudioError) as caught:
            self.ask(worker)
        self.assertEqual(caught.exception.code, "peer_cancelled")
        self.assertEqual(transport.values[FINGERPRINT]["responseId"], "resp_created_before_stop")
        self.assertEqual(len(transport.api_calls), 1, "Peer stop must prevent the next poll")
        worker.close()
        resumed = self.worker(parent, transport, threading.Event())
        self.assertEqual(self.ask(resumed), {"answer": 7})
        self.assertEqual([(method, suffix) for method, suffix, _ in transport.api_calls],
                         [("POST", ""), ("GET", "/resp_created_before_stop")])
        self.assertEqual(json.loads(transport.values[FINGERPRINT]["resultJson"]), {"answer": 7})

    def test_rate_limited_pending_poll_preserves_id_for_a_new_worker(self):
        transport = MemoryHTTP([
            ("GET", "/resp_pending", Reply({"error": "PRIVATE provider body"}, 429)),
            ("GET", "/resp_pending", completed()),
        ])
        transport.values[FINGERPRINT] = {"responseId": "resp_pending", "maxOutputTokens": 28000, "budgetIncreases": 0}
        parent = self.parent(transport)
        worker = self.worker(parent, transport, threading.Event())
        with self.assertRaises(StudioError) as caught:
            self.ask(worker)
        self.assertEqual(caught.exception.code, "model_unavailable")
        self.assertNotIn("PRIVATE", caught.exception.public_message)
        self.assertEqual(transport.values[FINGERPRINT]["responseId"], "resp_pending")
        worker.close()
        resumed = self.worker(parent, transport, threading.Event())
        self.assertEqual(self.ask(resumed), {"answer": 7})
        self.assertEqual([(method, suffix) for method, suffix, _ in transport.api_calls],
                         [("GET", "/resp_pending"), ("GET", "/resp_pending")])
        self.assertEqual(json.loads(transport.values[FINGERPRINT]["resultJson"]), {"answer": 7})


if __name__ == "__main__":
    unittest.main()
