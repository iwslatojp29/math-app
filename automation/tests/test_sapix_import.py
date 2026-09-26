"""Offline contract, source-integrity, model and atomic-publication checks."""
import copy
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import fitz
import requests
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sapix_import as imp
import run_sapix_import
from studio_common import StudioError

MODEL = "claude-fable-5-1"


def image_bytes():
    stream = io.BytesIO()
    Image.new("RGB", (120, 80), "white").save(stream, format="PNG")
    return stream.getvalue()


def source(data=None, file_id="fixture-file"):
    data = image_bytes() if data is None else data
    return {"id": file_id, "name": "算数.pdf" if data.startswith(b"%PDF") else "算数.png",
        "mimeType": "application/pdf" if data.startswith(b"%PDF") else "image/png",
        "createdTime": "2026-09-24T01:00:00Z", "modifiedTime": "2026-09-24T02:00:00Z",
        "md5Checksum": hashlib.md5(data).hexdigest(), "size": str(len(data)),
        "parents": [imp.SOURCE_FOLDER], "unitPath": "速さ", "fingerprint": "revision-fixture"}


def question(label="1(1)", page=1):
    return {"sourceLabel": label, "startPage": page, "pages": [page], "unit": "速さ", "title": "速さ " + label,
        "stars": 1, "question": "分速60mで3分間進みます。道のりを求めなさい。",
        "answers": [{"label": "", "text": "180m"}],
        "steps": [{"title": "1分で進む長さを3つ分にする", "text": "60×3＝180なので、180mです。"}]}


def candidate(questions=None, targets=None):
    questions = [question()] if questions is None else questions
    targets = [1] if targets is None else targets
    return {"checkedPages": targets, "problems": questions, "pageCoverage": [
        {"page": page, "leafLabels": [q["sourceLabel"] for q in questions if q["startPage"] == page],
         "nonQuestionReason": "解答欄のみ" if not any(q["startPage"] == page for q in questions) else ""}
        for page in targets], "unresolvedIssues": []}


def review(count=1, targets=None):
    return {"approved": True, "checkedPages": targets or [1], "checks": [
        {"index": i, "sourceSupported": True, "singleLeaf": True, "standalone": True, "answerCorrect": True,
         "elementaryMethod": True, "handwritingSeparated": True} for i in range(1, count + 1)],
        "allPrintedQuestionsIncluded": True, "unresolvedIssues": []}


class MemoryStudio:
    root = "/sapix-import/jobs/fixture-job"

    def __init__(self, files=None):
        self.files = copy.deepcopy(files or [source()])
        self.values, self.updates, self.requests = {}, [], []
        self.active_checks = 0
        self.active_error = None
        self.snapshot = {"status": "queued", "files": copy.deepcopy(self.files), "folderId": imp.SOURCE_FOLDER,
                         "model": {"id": MODEL}}
        self.configuration = {"files": copy.deepcopy(self.files), "folderId": imp.SOURCE_FOLDER, "cutoff": imp.CUTOFF,
            "driveAccessToken": "private-drive-fixture", "driveExpiresIn": 3600, "anthropicApiKey": "private-claude-fixture",
            "model": {"id": MODEL}, "existingSourceFileIds": []}

    def job(self):
        return copy.deepcopy(self.snapshot)

    def config(self):
        return copy.deepcopy(self.configuration)

    def update(self, **value):
        self.updates.append(copy.deepcopy(value))
        self.snapshot.update(value)

    def ensure_active(self):
        self.active_checks += 1
        if self.active_error:
            raise self.active_error

    def checkpoint(self, key, value=...):
        if value is ...:
            return copy.deepcopy(self.values.get(key))
        self.values[key] = copy.deepcopy(value)

    def request(self, method, path, value=None):
        self.requests.append((method, path, copy.deepcopy(value)))
        if path.endswith("/publish") and not value["catalog"]["sources"]:
            return {"addedSources": 0, "addedProblems": 0}
        return {"url": "https://fixture.example/sapix/", "commitSha": "a" * 40, "addedProblems": 1, "addedSources": 1}


class FakeAI:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def structured(self, task, prompt, schema, images, **kwargs):
        self.calls.append({"task": task, "prompt": prompt, "schema": schema, "pages": [i.number for i in images]})
        if not self.replies:
            raise AssertionError("Unbounded or unexpected model call")
        value = self.replies.pop(0)
        if isinstance(value, Exception):
            raise value
        return copy.deepcopy(value)


class FakeDrive:
    def __init__(self, selected, data=None, mutate_at=None):
        self.selected, self.data, self.mutate_at = copy.deepcopy(selected), data or image_bytes(), mutate_at
        self.reads, self.downloads = 0, []

    def metadata(self, file_id):
        self.reads += 1
        result = copy.deepcopy(self.selected)
        if self.mutate_at is not None and self.reads >= self.mutate_at:
            result["modifiedTime"] = "2026-09-25T01:00:00Z"
        return result

    def download(self, file_id, path):
        self.downloads.append(file_id)
        path.write_bytes(self.data)


class StreamReply:
    def __init__(self, events=None, status=200, headers=None):
        self.events, self.status_code, self.headers = events or [], status, headers or {}
        self.ok, self.closed = 200 <= status < 300, False

    def close(self):
        self.closed = True

    def iter_lines(self):
        for event in self.events:
            if isinstance(event, Exception):
                raise event
            yield b"data: " + json.dumps(event, ensure_ascii=False).encode()


def stream_result(value, stop="end_turn", *, stopped=True, model=MODEL):
    events = [{"type": "message_start", "message": {"model": model}},
              {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "private"}},
              {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "private reasoning"}},
              {"type": "ping"},
              {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
              {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": json.dumps(value, ensure_ascii=False)}},
              {"type": "message_delta", "delta": {"stop_reason": stop}}]
    if stopped:
        events.append({"type": "message_stop"})
    return StreamReply(events)


class HTTPSession:
    def __init__(self, replies):
        self.replies, self.calls = list(replies), []

    def post(self, url, **kwargs):
        self.calls.append((url, kwargs))
        if not self.replies:
            raise AssertionError("Unbounded API request")
        value = self.replies.pop(0)
        if isinstance(value, Exception):
            raise value
        return value


class SapixImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name)
        self.images = [imp.PageImage(i, self.directory / f"{i}.png",
            f"assets/drive/fixture-file/{str(i) * 64}.png", "image/png", b"image" + str(i).encode()) for i in range(1, 9)]

    def assert_error(self, code, callback):
        with self.assertRaises(StudioError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_cutoff_is_japan_midnight_and_uses_creation_not_modification(self):
        selected = source()
        selected["createdTime"] = imp.CUTOFF
        imp.validate_snapshot(selected)
        selected["createdTime"] = "2026-09-23T14:59:59Z"
        selected["modifiedTime"] = "2026-09-26T00:00:00Z"
        self.assert_error("source_cutoff", lambda: imp.validate_snapshot(selected))

    def test_snapshot_rejects_each_revision_or_parent_change(self):
        selected = source()
        imp.verify_revision(selected, copy.deepcopy(selected))
        for field, value in (("name", "別.png"), ("modifiedTime", "2026-09-25T00:00:00Z"),
                ("createdTime", "2026-09-25T00:00:00Z"), ("md5Checksum", "a" * 32), ("size", "1"),
                ("parents", ["elsewhere"]), ("trashed", True)):
            with self.subTest(field=field):
                actual = {**selected, field: value}
                self.assert_error("source_changed", lambda: imp.verify_revision(selected, actual))

    def test_full_pdf_page_images_have_content_hash_paths(self):
        original = self.directory / "source.pdf"
        with fitz.open() as document:
            for index in range(2):
                page = document.new_page(width=120, height=160)
                page.insert_text((10, 30), f"Question {index + 1}")
            document.save(original)
        selected = source(original.read_bytes())
        images = imp.prepare_images(selected, original, self.directory / "pages")
        self.assertEqual([image.number for image in images], [1, 2])
        for image in images:
            self.assertIn(hashlib.sha256(image.path.read_bytes()).hexdigest(), image.asset_path)
            with Image.open(image.path) as raster:
                self.assertGreater(raster.height, raster.width)

    def test_original_image_is_not_cropped_or_rewritten(self):
        data, original = image_bytes(), self.directory / "original"
        original.write_bytes(data)
        images = imp.prepare_images(source(data), original, self.directory / "pages")
        self.assertEqual(images[0].path.read_bytes(), data)
        self.assertEqual(images[0].path, original)

    def test_wrong_mime_is_rejected(self):
        original = self.directory / "original"
        original.write_bytes(image_bytes())
        selected = source()
        selected["mimeType"] = "image/jpeg"
        self.assert_error("image_type", lambda: imp.prepare_images(selected, original, self.directory / "pages"))

    def test_leaf_problems_have_distinct_stable_ids_common_condition_and_empty_subquestions(self):
        ai = FakeAI([candidate([question("1(1)"), question("1(2)")]), review(2)])
        questions = imp.generate_questions(ai, MemoryStudio(), source(), self.images[:1])
        catalog = imp.make_catalog(source(), questions, self.images[:1])
        imp.validate_catalog(catalog)
        self.assertEqual([problem["id"] for problem in catalog["problems"]], ["drive-fixture-file-q1", "drive-fixture-file-q2"])
        self.assertTrue(all(problem["subquestions"] == [] for problem in catalog["problems"]))
        self.assertIn("1 problem =", ai.calls[0]["prompt"])
        self.assertIn("共通条件", ai.calls[0]["prompt"])
        self.assertEqual(ai.calls[0]["pages"], ai.calls[1]["pages"])

    def test_source_unreadable_and_missing_leaf_are_bounded_and_never_auto_approved(self):
        unreadable = candidate()
        unreadable["unresolvedIssues"] = ["印刷の数値が読めない"]
        ai = FakeAI([unreadable] * 3)
        self.assert_error("import_unresolved", lambda: imp.generate_questions(ai, MemoryStudio(), source(), self.images[:1]))
        self.assertEqual(len(ai.calls), 3)
        self.assertIn("印刷の数値が読めない", ai.calls[1]["prompt"])

    def test_reviewer_rejects_merged_subquestions_or_handwriting_used_as_truth(self):
        for field in ("singleLeaf", "handwritingSeparated", "answerCorrect", "standalone"):
            with self.subTest(field=field):
                rejected = review()
                rejected["checks"][0][field] = False
                ai = FakeAI([candidate(), rejected] * 3)
                self.assert_error("import_unresolved", lambda: imp.generate_questions(ai, MemoryStudio(), source(), self.images[:1]))
                self.assertEqual(len(ai.calls), 6)

    def test_schema_failure_repaired_and_coverage_keeps_context_outside_target(self):
        initial = candidate([question(page=1)], [1, 2, 3, 4])
        second = candidate([question("2(1)", 5)], [5, 6, 7, 8])
        ai = FakeAI([StudioError("claude_schema", "safe"), initial, review(1, [1, 2, 3, 4]), second, review(1, [5, 6, 7, 8])])
        result = imp.generate_questions(ai, MemoryStudio(), source(), self.images)
        self.assertEqual([q["startPage"] for q in result], [1, 5])
        self.assertEqual(ai.calls[0]["pages"], [1, 2, 3, 4, 5])
        self.assertEqual(ai.calls[1]["pages"], [1, 2, 3, 4, 5, 6])
        self.assertEqual(ai.calls[1]["pages"], ai.calls[2]["pages"])

    def test_duplicates_outside_pages_html_and_empty_steps_are_structural_failures(self):
        for mutate, expected in (
            (lambda value: value["problems"].append(copy.deepcopy(value["problems"][0])), "source_label_duplicate"),
            (lambda value: value["problems"][0].update(pages=[99]), "source_pages"),
            (lambda value: value["problems"][0].update(startPage=2), "start_page_order"),
            (lambda value: value["problems"][0].update(question="<script>bad()</script>"), "question"),
            (lambda value: value["problems"][0].update(steps=[]), "steps")):
            with self.subTest(expected=expected):
                value = candidate()
                mutate(value)
                issues = imp.extraction_issues(value, [1], [1, 2])
                self.assertTrue(any(expected in issue for issue in issues), issues)

    def test_catalog_rejects_cross_source_asset_duplicate_id_and_nested_subquestion(self):
        original = imp.make_catalog(source(), [question()], self.images[:1])
        for mutate in (
            lambda value: value["problems"][0].update(sourceImages=["assets/drive/other/" + "a" * 64 + ".png"]),
            lambda value: value["problems"].append(copy.deepcopy(value["problems"][0])),
            lambda value: value["problems"][0].update(subquestions=[{"label": "(2)", "text": "merged"}])):
            value = copy.deepcopy(original)
            mutate(value)
            self.assert_error("import_catalog", lambda: imp.validate_catalog(value))

    def test_atomic_publish_happens_only_after_verified_catalog_and_staged_images(self):
        studio, drive = MemoryStudio(), FakeDrive(source())
        ai = FakeAI([candidate(), review()])
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "fixture-run"}):
            result = imp.run_import(studio, self.directory, drive_factory=lambda *_: drive, ai_factory=lambda *_: ai)
        self.assertEqual(result["addedProblems"], 1)
        self.assertEqual([path.rsplit("/", 1)[-1] for _, path, _ in studio.requests], ["assets", "publish"])
        self.assertEqual(studio.updates[0]["runId"], "fixture-run")
        self.assertEqual(drive.reads, 4)
        catalog = studio.requests[-1][2]["catalog"]
        self.assertEqual(catalog["sources"][0]["fingerprint"], source()["fingerprint"])

    def test_source_change_after_download_and_during_staging_blocks_publication(self):
        for mutation, expected_assets in ((2, 0), (4, 1)):
            with self.subTest(mutation=mutation):
                studio, drive = MemoryStudio(), FakeDrive(source(), mutate_at=mutation)
                ai = FakeAI([candidate(), review()])
                self.assert_error("source_changed", lambda: imp.run_import(studio, self.directory,
                    drive_factory=lambda *_: drive, ai_factory=lambda *_: ai))
                self.assertEqual(len(studio.requests), expected_assets)
                self.assertFalse(any(path.endswith("/publish") for _, path, _ in studio.requests))

    def test_md5_integrity_failure_does_not_call_model_or_publish(self):
        studio, drive, ai = MemoryStudio(), FakeDrive(source(), data=b"changed"), FakeAI([])
        self.assert_error("source_changed", lambda: imp.run_import(studio, self.directory,
            drive_factory=lambda *_: drive, ai_factory=lambda *_: ai))
        self.assertEqual(ai.calls, [])
        self.assertEqual(studio.requests, [])

    def test_already_imported_file_skips_download_model_and_requests_verified_noop(self):
        studio = MemoryStudio()
        studio.configuration["existingSourceFileIds"] = ["fixture-file"]
        def unexpected(*_):
            raise AssertionError("Already imported source must not be processed")
        result = imp.run_import(studio, self.directory, drive_factory=unexpected, ai_factory=unexpected)
        self.assertEqual(result, {"addedSources": 0, "addedProblems": 0})
        self.assertEqual(studio.requests, [("POST", studio.root + "/publish", {"catalog": {"schemaVersion": 1, "sources": [], "problems": []}})])

    def test_image_capacity_is_checked_before_any_model_call(self):
        studio, drive, ai = MemoryStudio(), FakeDrive(source()), FakeAI([])
        with patch.object(imp, "MAX_JOB_ASSET_BYTES", 1):
            self.assert_error("image_capacity", lambda: imp.run_import(studio, self.directory,
                drive_factory=lambda *_: drive, ai_factory=lambda *_: ai))
        self.assertEqual(ai.calls, [])
        self.assertEqual(studio.requests, [])

    def test_partial_external_duplicate_requires_fresh_selection_before_model_cost(self):
        studio = MemoryStudio([source(), source(file_id="second-file")])
        studio.configuration["existingSourceFileIds"] = ["fixture-file"]
        def unexpected(*_):
            raise AssertionError("Partial external duplicate must be resolved before generation")
        self.assert_error("import_duplicate", lambda: imp.run_import(studio, self.directory,
            drive_factory=unexpected, ai_factory=unexpected))
        self.assertEqual(studio.requests, [])

    def test_publishing_or_committed_result_never_reclaims_or_regenerates(self):
        for status, saved in (("publishing", None), ("publishing", {"commitSha": "a" * 40}),
                              ("needs_attention", {"commitSha": "b" * 40}), ("completed", {"addedProblems": 1})):
            with self.subTest(status=status, result=bool(saved)):
                studio = MemoryStudio()
                studio.snapshot["status"] = status
                if saved is not None:
                    studio.snapshot["result"] = saved
                def unexpected(*_):
                    raise AssertionError("Committed publication must not be regenerated")
                with patch.object(studio, "config", side_effect=unexpected):
                    result = imp.run_import(studio, self.directory, drive_factory=unexpected, ai_factory=unexpected)
                self.assertEqual(result, saved or {})
                self.assertEqual(studio.updates, [])
                self.assertEqual(studio.requests, [])

    def test_conflicting_config_snapshot_or_model_or_cutoff_blocks_before_model(self):
        for modify in (
            lambda config: config["files"][0].update(modifiedTime="2026-09-25T00:00:00Z"),
            lambda config: config["model"].update(id="claude-fable-5-2"),
            lambda config: config.update(cutoff="2026-09-24T00:00:00Z"),
            lambda config: config.update(folderId="wrong-folder")):
            studio = MemoryStudio()
            modify(studio.configuration)
            with self.assertRaises(StudioError):
                imp.run_import(studio, self.directory, drive_factory=lambda *_: self.fail("No Drive call"))


class ClaudeTransportTests(unittest.TestCase):
    def client(self, replies, studio=None):
        studio = studio or MemoryStudio()
        http = HTTPSession(replies)
        return imp.ClaudeClient("private-fixture-api-key", MODEL, studio, http, sleeper=lambda _: None), http, studio

    def ask(self, client):
        return client.structured("fixture", "private problem statement", imp.EXTRACTION_SCHEMA, [])

    def test_streamed_json_ignores_thinking_and_cache_avoids_duplicate_post(self):
        client, http, studio = self.client([stream_result(candidate())])
        self.assertEqual(self.ask(client), candidate())
        self.assertEqual(self.ask(client), candidate())
        self.assertEqual(len(http.calls), 1)
        body = json.loads(http.calls[0][1]["data"])
        self.assertEqual(body["model"], MODEL)
        self.assertTrue(body["stream"])
        self.assertEqual(body["output_config"]["format"]["type"], "json_schema")
        self.assertNotIn("tools", body)
        self.assertNotIn("private reasoning", json.dumps(studio.values))

    def test_429_and_connection_retry_are_bounded_without_raw_logging(self):
        client, http, _ = self.client([StreamReply(status=429, headers={"Retry-After": "1"}),
            requests.ConnectionError("private-secret-provider-payload"), stream_result(candidate())])
        with patch("builtins.print") as output:
            self.assertEqual(self.ask(client), candidate())
        self.assertEqual(len(http.calls), 3)
        output.assert_not_called()
        client, http, _ = self.client([StreamReply(status=529)] * 3)
        with self.assertRaises(StudioError) as caught:
            self.ask(client)
        self.assertEqual(caught.exception.code, "claude_unavailable")
        self.assertEqual(len(http.calls), 3)

    def test_truncated_json_even_parseable_is_not_cached_or_accepted(self):
        client, http, studio = self.client([stream_result(candidate(), stopped=False)])
        with self.assertRaises(StudioError) as caught:
            self.ask(client)
        self.assertEqual(caught.exception.code, "claude_stream")
        self.assertEqual(studio.values, {})

    def test_max_token_expansion_persists_and_exhaustion_does_not_reset_on_resume(self):
        client, http, studio = self.client([stream_result(candidate(), stop="max_tokens")] * 2)
        for _ in range(2):
            with self.assertRaises(StudioError) as caught:
                self.ask(client)
            self.assertEqual(caught.exception.code, "claude_output_limit")
        self.assertEqual([json.loads(call[1]["data"])["max_tokens"] for call in http.calls], [32000, 64000])
        self.assertTrue(all(value.get("stopReason") == "max_tokens" for value in studio.values.values()))

    def test_refusal_schema_error_or_model_substitution_is_never_cached(self):
        for reply, code in ((stream_result(candidate(), stop="refusal"), "claude_incomplete"),
                            (stream_result({"invalid": True}), "claude_schema"),
                            (stream_result(candidate(), model="claude-fable-5-2"), "claude_model")):
            with self.subTest(code=code):
                client, _, studio = self.client([reply])
                with self.assertRaises(StudioError) as caught:
                    self.ask(client)
                self.assertEqual(caught.exception.code, code)
                self.assertEqual(studio.values, {})

    def test_cancellation_or_deadline_prevents_even_cached_provider_work(self):
        client, http, studio = self.client([stream_result(candidate())])
        self.ask(client)
        for code in ("cancelled", "continue_later", "runner_conflict"):
            studio.active_error = StudioError(code, "safe")
            with self.assertRaises(StudioError) as caught:
                self.ask(client)
            self.assertEqual(caught.exception.code, code)
        self.assertEqual(len(http.calls), 1)

    def test_runner_route_and_checkpoint_namespace_match_backend(self):
        studio = imp.SapixStudio("https://studio.example", "private-token", "fixture-job")
        self.assertEqual(studio.base, "https://studio.example/studio/runner")
        with patch.object(studio, "request", return_value={"value": {"approved": True}}) as request:
            self.assertEqual(studio.checkpoint("safe-key"), {"approved": True})
        request.assert_called_once_with("GET", "/sapix-import/jobs/fixture-job/checkpoints/safe-key", missing=True)

    def test_entrypoint_suppresses_conflict_and_provider_exception_details(self):
        with patch.dict(os.environ, {"STUDIO_URL": "https://studio.example", "STUDIO_RUNNER_TOKEN": "private-token", "GITHUB_RUN_ID": "run"}):
            with patch.object(run_sapix_import, "run_import", side_effect=StudioError("runner_conflict", "safe")), patch("builtins.print") as output:
                self.assertEqual(run_sapix_import.main(["--job-id", "fixture-job"]), 0)
                output.assert_not_called()
            with patch.object(run_sapix_import, "run_import", side_effect=RuntimeError("private secret")), \
                 patch.object(imp.SapixStudio, "update"), patch("builtins.print") as output:
                self.assertEqual(run_sapix_import.main(["--job-id", "fixture-job"]), 1)
                self.assertNotIn("private secret", str(output.call_args_list))


if __name__ == "__main__":
    unittest.main()
