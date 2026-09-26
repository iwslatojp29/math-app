import hashlib
import copy
import io
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import pymupdf as fitz
import requests
import jsonschema

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lesson_pipeline import reconcile_solution_pages, render_lesson, validate_problem_coverage
from pdf_pipeline import extract_pdf, obj, plans_from_classification, same_pdf_visual_content, verify_extracted
from run_monthly import generate_verified_lesson, main, run_job, save_verified, validate_job
from studio_common import (ADVANCED_FOLDER, PRACTICE_FOLDER, SOURCE_FOLDER, DriveClient, ResponsesClient,
                           StudioClient, StudioError, digest_file, key_for, response_diagnostic)


class FakeResponse:
    def __init__(self, value=None, status=200, headers=None):
        self.value, self.status_code, self.headers = value, status, headers or {}
        self.ok = 200 <= status < 300

    def json(self):
        return self.value

    def close(self):
        pass


class FakeSession:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


class MemoryStudio:
    def __init__(self):
        self.values, self.updates, self.active_checks = {}, [], 0
        self.job_id = "test-job"

    def checkpoint(self, key, value=...):
        if value is ...:
            return self.values.get(key)
        self.values[key] = value

    def ensure_active(self):
        self.active_checks += 1

    def update(self, **value):
        self.updates.append(value)


class PDFTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        self.source_path = self.directory / "source.pdf"
        document = fitz.open()
        for index in range(3):
            page = document.new_page(width=400, height=240)
            page.draw_rect(fitz.Rect(20, 20, 180, 180), color=(0, 0, 1), fill=(0.8, 0.9, 1))
            page.draw_circle((300, 100), 55, color=(1, 0.4, 0))
            page.insert_text((25, 205), f"Question page {index + 1}: 3 + 4 = 7", fontsize=16)
        document.save(self.source_path)
        document.close()
        self.source = fitz.open(self.source_path)

    def tearDown(self):
        self.source.close()
        self.temp.cleanup()

    def plan(self, numbers):
        return {"pages": [{"pdfPage": number, "labels": ["practice_questions"], "crop": None, "rotation": 0}
                          for number in numbers]}

    def test_direct_page_copy_preserves_pixels_order_bookmarks_and_source(self):
        original_hash = digest_file(self.source_path)
        output = self.directory / "selected.pdf"
        plan = self.plan([1, 3])
        plan["pages"][1]["labels"] = ["contest_solutions"]
        result = extract_pdf(self.source, plan, output)
        self.assertEqual(result["pageCount"], 2)
        self.assertTrue(result["allPagesPixelMatched"])
        self.assertEqual([item["sourcePdfPage"] for item in result["pages"]], [1, 3])
        with fitz.open(output) as generated:
            self.assertEqual(len(generated), 2)
            self.assertTrue(generated.get_toc())
            self.assertEqual(generated.get_toc()[1], [1, "学力コンテスト 解答・解説（同じ冊子に掲載）", 2])
            self.assertIn("page 3", generated[1].get_text())
        self.assertEqual(digest_file(self.source_path), original_hash)

    def test_invalid_page_ranges_are_rejected(self):
        for numbers in ([], [1, 1], [3, 1], [0], [4]):
            with self.subTest(numbers=numbers), self.assertRaises(StudioError):
                extract_pdf(self.source, self.plan(numbers), self.directory / "invalid.pdf")

    def test_crop_requires_evidence_and_matches_original_region(self):
        plan = self.plan([1])
        plan["pages"][0]["crop"] = [200, 0, 400, 240]
        with self.assertRaises(StudioError):
            extract_pdf(self.source, plan, self.directory / "no-proof.pdf")
        plan["pages"][0]["cropEvidence"] = "Fixture spread: right-hand page boundary is x=200."
        output = self.directory / "crop.pdf"
        self.assertTrue(extract_pdf(self.source, plan, output)["allPagesPixelMatched"])
        with fitz.open(output) as crop:
            self.assertEqual(crop[0].rect.width, 200)

    def test_intended_rotation_is_checked_as_a_transform(self):
        plan = self.plan([2])
        plan["pages"][0].update(rotation=90, rotationEvidence="Fixture supplied with sideways printing.")
        proof = extract_pdf(self.source, plan, self.directory / "rotated.pdf")
        self.assertEqual(proof["pages"][0]["rotation"], 90)

    def test_changed_output_pixels_fail_verification(self):
        output = self.directory / "changed.pdf"
        plan = self.plan([1])
        extract_pdf(self.source, plan, output)
        changed = fitz.open(output)
        changed[0].draw_rect(fitz.Rect(1, 1, 40, 40), fill=(1, 0, 0))
        changed.saveIncr()
        changed.close()
        with self.assertRaises(StudioError) as caught:
            verify_extracted(self.source, plan, output)
        self.assertEqual(caught.exception.code, "pdf_verification")

    def test_visual_comparison_ignores_pdf_metadata_but_detects_missing_pages(self):
        copy = self.directory / "copy.pdf"
        document = fitz.open(self.source_path)
        document.set_metadata({"title": "Different metadata"})
        document.save(copy)
        document.close()
        self.assertTrue(same_pdf_visual_content(self.source_path, copy))
        extract_pdf(self.source, self.plan([1, 2]), self.directory / "missing.pdf")
        self.assertFalse(same_pdf_visual_content(self.source_path, self.directory / "missing.pdf"))

    def test_naming_and_missing_sections_keep_the_booklet_identity(self):
        classification = {"pages": [
            {"pdfPage": 2, "printedPages": ["1"], "labels": ["points", "practice_questions"], "headingEvidence": "見出し", "boundaryEvidence": "境界"},
            {"pdfPage": 3, "printedPages": ["2"], "labels": ["practice_solutions"], "headingEvidence": "解説", "boundaryEvidence": "末尾"},
            {"pdfPage": 8, "printedPages": ["7"], "labels": ["contest_entry", "contest_questions"], "headingEvidence": "学コン", "boundaryEvidence": "末尾"},
        ]}
        plans = plans_from_classification(classification, "2026年5月号_単元 (1).PDF")
        self.assertEqual(plans[0]["name"], "2026年5月号_単元 (1)‗日日の演習.pdf")
        self.assertEqual(plans[1]["name"], "2026年5月号_単元 (1)‗発展演習+学力コンテスト.pdf")
        self.assertEqual(plans[1]["missing"], ["発展演習の掲載なし"])
        self.assertEqual([item["pdfPage"] for item in plans[0]["pages"]], [2, 3])


class APITests(unittest.TestCase):
    @staticmethod
    def completed(response_id="resp_complete"):
        return FakeResponse({"id": response_id, "status": "completed", "output": [
            {"content": [{"type": "output_text", "text": '{"ok":true}'}]}]})

    @staticmethod
    def token_limited(response_id, budget):
        return FakeResponse({"id": response_id, "status": "incomplete", "max_output_tokens": budget,
            "incomplete_details": {"reason": "max_output_tokens"}, "output": [],
            "usage": {"input_tokens": 123, "output_tokens": budget, "total_tokens": budget + 123,
                      "output_tokens_details": {"reasoning_tokens": budget - 100}}})

    def test_background_request_checkpoints_id_then_polls_and_reuses_result(self):
        studio = MemoryStudio()
        session = FakeSession([
            FakeResponse({"id": "resp_fixture", "status": "queued"}),
            FakeResponse({"id": "resp_fixture", "status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": '{"ok":true}'}]}]}),
        ])
        client = ResponsesClient("fake-fixture-key", "selected-model", studio, session, sleeper=lambda _: None)
        schema = obj({"ok": {"type": "boolean"}})
        self.assertEqual(client.structured("case", "Read images", schema), {"ok": True})
        payload = json.loads(session.calls[0][2]["data"])
        self.assertTrue(payload["background"])
        self.assertTrue(payload["store"])
        self.assertEqual(payload["model"], "selected-model")
        self.assertEqual(payload["text"]["format"]["schema"], schema)
        self.assertEqual(studio.active_checks, 2)
        self.assertEqual(client.structured("case", "Read images", schema), {"ok": True})
        self.assertEqual(len(session.calls), 2)

    def test_incomplete_refused_or_invalid_structured_responses_never_pass(self):
        outputs = [
            {"id": "resp_fixture", "status": "incomplete", "output": []},
            {"id": "resp_fixture", "status": "completed", "output": [{"content": [{"type": "refusal", "refusal": "private detail"}]}]},
            {"id": "resp_fixture", "status": "completed", "output": [{"content": [{"type": "output_text", "text": '{"wrong":true}'}]}]},
        ]
        for output in outputs:
            with self.subTest(status=output["status"]), self.assertRaises(StudioError):
                ResponsesClient("fake-fixture-key", "model", MemoryStudio(), FakeSession([FakeResponse(output)]), sleeper=lambda _: None).structured("case", "prompt", obj({"ok": {"type": "boolean"}}))

    def test_terminal_failed_response_can_start_again_on_resume(self):
        studio = MemoryStudio()
        session = FakeSession([
            FakeResponse({"id": "resp_failed", "status": "failed"}),
            FakeResponse({"id": "resp_failed", "status": "failed"}),
            FakeResponse({"id": "resp_success", "status": "completed", "output": [{"content": [{"type": "output_text", "text": '{"ok":true}'}]}]}),
        ])
        client = ResponsesClient("fake-fixture-key", "model", studio, session)
        with self.assertRaises(StudioError):
            client.structured("case", "prompt", obj({"ok": {"type": "boolean"}}))
        self.assertEqual(client.structured("case", "prompt", obj({"ok": {"type": "boolean"}})), {"ok": True})
        self.assertEqual([call[0] for call in session.calls], ["POST", "GET", "POST"])

    def test_token_limit_retries_with_reasoning_space_and_reuses_successful_result(self):
        studio = MemoryStudio()
        session = FakeSession([self.token_limited("resp_small", 25000), self.completed()])
        client = ResponsesClient("fake", "model", studio, session, max_output_tokens_limit=128000)
        schema = obj({"ok": {"type": "boolean"}})
        self.assertEqual(client.structured("lesson-review-case", "prompt", schema, max_tokens=8000), {"ok": True})
        self.assertEqual([json.loads(call[2]["data"])["max_output_tokens"] for call in session.calls], [25000, 50000])
        state = next(iter(studio.values.values()))
        self.assertEqual(state["budgetIncreases"], 1)
        self.assertEqual(state["diagnostics"][0]["reason"], "max_output_tokens")
        self.assertEqual(state["diagnostics"][0]["usage"]["reasoning_tokens"], 24900)
        self.assertEqual(client.structured("lesson-review-case", "prompt", schema, max_tokens=8000), {"ok": True})
        self.assertEqual(len(session.calls), 2)

    def test_adaptive_budget_is_bounded_and_manual_resume_does_not_reset_exhaustion(self):
        studio = MemoryStudio()
        session = FakeSession([self.token_limited("resp_a", 28000), self.token_limited("resp_b", 56000),
                               self.token_limited("resp_c", 112000)])
        client = ResponsesClient("fake", "model", studio, session, max_output_tokens_limit=128000)
        for _ in range(2):
            with self.assertRaises(StudioError) as caught:
                client.structured("case", "prompt", obj({"ok": {"type": "boolean"}}), max_tokens=28000)
            self.assertEqual(caught.exception.code, "model_token_limit")
            self.assertTrue(caught.exception.attention)
        self.assertEqual([json.loads(call[2]["data"])["max_output_tokens"] for call in session.calls], [28000, 56000, 112000])
        self.assertEqual(next(iter(studio.values.values()))["budgetIncreases"], 2)
        self.assertTrue(next(iter(studio.values.values()))["tokenBudgetExhausted"])

    def test_adaptive_budget_never_exceeds_verified_model_capacity(self):
        studio = MemoryStudio()
        session = FakeSession([self.token_limited("resp_a", 28000), self.token_limited("resp_b", 48000)])
        with self.assertRaises(StudioError) as caught:
            ResponsesClient("fake", "model", studio, session, max_output_tokens_limit=48000).structured(
                "case", "prompt", obj({"ok": {"type": "boolean"}}), max_tokens=28000)
        self.assertEqual(caught.exception.code, "model_token_limit")
        self.assertEqual([json.loads(call[2]["data"])["max_output_tokens"] for call in session.calls], [28000, 48000])

    def test_legacy_previous_response_is_retrieved_for_actual_failure_diagnosis(self):
        studio = MemoryStudio()
        schema = obj({"ok": {"type": "boolean"}})
        fingerprint = key_for("ai", ["case", "model", "prompt", schema, []])
        studio.values[fingerprint] = {"previousResponseId": "resp_legacy", "terminalStatus": "incomplete"}
        session = FakeSession([self.token_limited("resp_legacy", 28000), self.completed()])
        result = ResponsesClient("fake", "model", studio, session, max_output_tokens_limit=128000).structured(
            "case", "prompt", schema, max_tokens=28000)
        self.assertEqual(result, {"ok": True})
        self.assertEqual([call[0] for call in session.calls], ["GET", "POST"])
        self.assertEqual(json.loads(session.calls[1][2]["data"])["max_output_tokens"], 56000)
        self.assertEqual(studio.values[fingerprint]["diagnostics"][0]["usage"]["output_tokens"], 28000)

    def test_rollover_before_budget_retry_preserves_the_planned_budget(self):
        studio = MemoryStudio()
        def ensure_active():
            studio.active_checks += 1
            if studio.active_checks == 2:
                raise StudioError("continue_later", "roll over")
        studio.ensure_active = ensure_active
        session = FakeSession([self.token_limited("resp_small", 28000)])
        schema = obj({"ok": {"type": "boolean"}})
        with self.assertRaises(StudioError):
            ResponsesClient("fake", "model", studio, session, max_output_tokens_limit=128000).structured(
                "case", "prompt", schema, max_tokens=28000)
        state = next(iter(studio.values.values()))
        self.assertTrue(state["budgetRetryPending"])
        self.assertEqual(state["budgetIncreases"], 1)
        studio.ensure_active = lambda: None
        resumed = FakeSession([self.completed()])
        ResponsesClient("fake", "model", studio, resumed, max_output_tokens_limit=128000).structured(
            "case", "prompt", schema, max_tokens=28000)
        self.assertEqual([call[0] for call in resumed.calls], ["POST"])
        self.assertEqual(json.loads(resumed.calls[0][2]["data"])["max_output_tokens"], 56000)
        self.assertEqual(next(iter(studio.values.values()))["budgetIncreases"], 1)

    def test_rollover_during_budget_retry_resumes_the_same_response_id(self):
        studio = MemoryStudio()
        def ensure_active():
            studio.active_checks += 1
            if studio.active_checks == 3:
                raise StudioError("continue_later", "roll over")
        studio.ensure_active = ensure_active
        session = FakeSession([self.token_limited("resp_small", 28000),
                               FakeResponse({"id": "resp_large", "status": "queued"})])
        schema = obj({"ok": {"type": "boolean"}})
        with self.assertRaises(StudioError):
            ResponsesClient("fake", "model", studio, session, sleeper=lambda _: None,
                            max_output_tokens_limit=128000).structured("case", "prompt", schema, max_tokens=28000)
        state = next(iter(studio.values.values()))
        self.assertEqual(state["responseId"], "resp_large")
        self.assertEqual(state["budgetIncreases"], 1)
        studio.ensure_active = lambda: None
        resumed = FakeSession([self.completed("resp_large")])
        ResponsesClient("fake", "model", studio, resumed, max_output_tokens_limit=128000).structured(
            "case", "prompt", schema, max_tokens=28000)
        self.assertEqual([call[0] for call in resumed.calls], ["GET"])
        self.assertTrue(resumed.calls[0][1].endswith("/resp_large"))

    def test_diagnostics_reject_arbitrary_provider_text_and_invalid_usage(self):
        secret = "untrusted-private-provider-text"
        diagnostic = response_diagnostic({"status": "incomplete", "incomplete_details": {"reason": secret},
            "error": {"message": secret}, "output": [{"text": secret}], "usage": {"input_tokens": secret,
            "output_tokens": True, "total_tokens": -1, "output_tokens_details": {"reasoning_tokens": 50}, "other": secret}}, 28000)
        self.assertEqual(diagnostic, {"status": "incomplete", "reason": "unknown", "maxOutputTokens": 28000,
                                      "usage": {"reasoning_tokens": 50}})
        self.assertNotIn(secret, json.dumps(diagnostic))

    def test_content_filter_incomplete_is_not_retried_as_a_token_limit(self):
        studio = MemoryStudio()
        session = FakeSession([FakeResponse({"id": "resp_filtered", "status": "incomplete",
                                           "incomplete_details": {"reason": "content_filter"}})])
        with self.assertRaises(StudioError) as caught:
            ResponsesClient("fake", "model", studio, session, max_output_tokens_limit=128000).structured(
                "case", "prompt", obj({"ok": {"type": "boolean"}}))
        self.assertEqual(caught.exception.code, "model_filtered")
        self.assertEqual(len(session.calls), 1)

    def test_provider_errors_never_expose_private_response_or_key(self):
        secret = "deliberately-fake-private-value"
        client = ResponsesClient(secret, "model", MemoryStudio(), FakeSession([FakeResponse({"error": secret}, 500)]))
        with self.assertRaises(StudioError) as caught:
            client.structured("case", "prompt", obj({"ok": {"type": "boolean"}}))
        self.assertNotIn(secret, str(caught.exception))
        self.assertNotIn(secret, caught.exception.public_message)

    def test_studio_run_header_and_runner_conflict(self):
        session = FakeSession([FakeResponse({"error": "runner_conflict"}, 409)])
        client = StudioClient("https://worker.example", "fake-runner-token", "test-job", session)
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "123"}), self.assertRaises(StudioError) as caught:
            client.update(status="running", runId="123")
        self.assertEqual(caught.exception.code, "runner_conflict")
        self.assertEqual(session.calls[0][2]["headers"]["X-Studio-Run-Id"], "123")

    def test_cancellation_is_honoured_while_polling(self):
        studio = MemoryStudio()
        def ensure_active():
            studio.active_checks += 1
            if studio.active_checks == 2:
                raise StudioError("cancelled", "stopped")
        studio.ensure_active = ensure_active
        session = FakeSession([FakeResponse({"id": "resp_fixture", "status": "queued"})])
        with self.assertRaises(StudioError) as caught:
            ResponsesClient("fake", "model", studio, session, sleeper=lambda _: None).structured("case", "prompt", obj({"ok": {"type": "boolean"}}))
        self.assertEqual(caught.exception.code, "cancelled")
        self.assertEqual(len(session.calls), 1)

    def test_run_budget_rollover_preserves_background_response_for_next_runner(self):
        studio = MemoryStudio()
        def ensure_active():
            studio.active_checks += 1
            if studio.active_checks == 2:
                raise StudioError("continue_later", "roll over")
        studio.ensure_active = ensure_active
        session = FakeSession([FakeResponse({"id": "resp_still_running", "status": "queued"})])
        client = ResponsesClient("fake", "model", studio, session, sleeper=lambda _: None)
        with self.assertRaises(StudioError) as caught:
            client.structured("case", "prompt", obj({"ok": {"type": "boolean"}}))
        self.assertEqual(caught.exception.code, "continue_later")
        self.assertEqual(next(iter(studio.values.values()))["responseId"], "resp_still_running")

    def test_ensure_active_checks_lease_and_budget(self):
        session = FakeSession([FakeResponse({"job": {"status": "running", "runId": "123"}})])
        client = StudioClient("https://worker.example", "fake", "job", session)
        client.deadline = 0
        with patch.dict(os.environ, {"GITHUB_RUN_ID": "123"}), self.assertRaises(StudioError) as caught:
            client.ensure_active()
        self.assertEqual(caught.exception.code, "continue_later")

    def test_main_reports_retryable_rollover_and_keeps_validation_failures_manual(self):
        for error, retryable, continuation in [
            (StudioError("continue_later", "roll over"), True, True),
            (StudioError("model_connection", "retry"), True, False),
            (StudioError("lesson_unresolved", "check data", True), False, False),
        ]:
            with self.subTest(error=error.code):
                studio = MemoryStudio()
                studio.job = lambda: {"status": "queued"}
                with patch("run_monthly.StudioClient", return_value=studio), \
                        patch("run_monthly.run_job", side_effect=error), patch("sys.stderr", new_callable=io.StringIO):
                    self.assertEqual(main(["--job-id", "test-job"]), 1)
                update = studio.updates[-1]
                self.assertEqual(update["retryable"], retryable)
                self.assertEqual(update["continuation"], continuation)
                self.assertEqual(update["status"], "needs_attention" if error.attention else "failed")

    def test_main_runner_conflict_or_wrong_operation_exits_without_mutating_status(self):
        for code in ("runner_conflict", "operation_mismatch"):
            with self.subTest(code=code):
                studio = MemoryStudio()
                studio.job = lambda: {"status": "queued"}
                with patch("run_monthly.StudioClient", return_value=studio), \
                        patch("run_monthly.run_job", side_effect=StudioError(code, "stopped")):
                    self.assertEqual(main(["--job-id", "test-job"]), 0)
                self.assertEqual(studio.updates, [])

    def test_worker_operation_guard_survives_http_error_mapping(self):
        session = FakeSession([FakeResponse({"error": "operation_mismatch"}, 409)])
        client = StudioClient("https://worker.example", "fake", "job", session)
        with self.assertRaises(StudioError) as caught:
            client.update(stage="lesson_inventory")
        self.assertEqual(caught.exception.code, "operation_mismatch")
        self.assertEqual(len(session.calls), 1)

    def test_drive_token_is_refreshed_after_unauthorized_without_logging(self):
        studio = MemoryStudio()
        issued = []
        def token_request(*_):
            issued.append(1)
            return {"accessToken": "fake-token-" + str(len(issued)), "expiresIn": 3600}
        studio.request = token_request
        session = FakeSession([FakeResponse({}, 401), FakeResponse({"id": "fixture"})])
        drive = DriveClient(studio, session)
        self.assertEqual(drive.metadata("fixture"), {"id": "fixture"})
        self.assertEqual(len(issued), 2)
        self.assertTrue(session.calls[1][2]["headers"]["Authorization"].endswith("fake-token-2"))

    def test_drive_lists_every_page_and_escapes_names(self):
        studio = MemoryStudio()
        studio.request = lambda *_: {"accessToken": "fake", "expiresIn": 3600}
        session = FakeSession([FakeResponse({"files": [{"id": "first"}], "nextPageToken": "next"}), FakeResponse({"files": [{"id": "second"}]})])
        found = DriveClient(studio, session).find("folder", "name'\\.pdf")
        self.assertEqual([item["id"] for item in found], ["first", "second"])
        self.assertEqual(session.calls[1][2]["params"]["pageToken"], "next")
        self.assertIn("name\\'\\\\.pdf", session.calls[0][2]["params"]["q"])

    def test_resumable_upload_queries_progress_after_timeout_and_reuses_reserved_id(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "file.html"
            path.write_bytes(b"012345678901234567890123456789")
            studio = MemoryStudio()
            drive = DriveClient(studio)
            calls = []
            results = [FakeResponse({"ids": ["reserved"]}), FakeResponse({}, headers={"Location": "https://www.googleapis.com/upload/session"}),
                       StudioError("drive_uncertain", "interrupted"), FakeResponse({}, 308, {"Range": "bytes=0-11"}), FakeResponse({}, 200)]
            def fake_request(method, endpoint, **kwargs):
                calls.append((method, endpoint, kwargs))
                response = results.pop(0)
                if isinstance(response, Exception):
                    raise response
                return response
            drive.request = fake_request
            drive.metadata = lambda *_args, **_kwargs: None
            drive.verify_saved = lambda file_id, *_args: {"id": file_id}
            result = drive.upload(path, "lesson.html", "folder", "text/html", {"mathAppSource": "source", "mathAppKind": "html"})
            self.assertEqual(result["id"], "reserved")
            self.assertTrue(any(value.get("fileId") == "reserved" for value in studio.values.values()))
            self.assertEqual(calls[3][2]["headers"]["Content-Range"], "bytes */30")
            self.assertEqual(calls[4][2]["headers"]["Content-Range"], "bytes 12-29/30")

    def test_reserved_id_does_not_overwrite_a_renamed_or_edited_output(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "lesson.html"
            path.write_bytes(b"new lesson")
            studio = MemoryStudio()
            studio.checkpoint = lambda *_args: {"fileId": "reserved"}
            drive = DriveClient(studio)
            drive.metadata = lambda *_args, **_kwargs: {"id": "reserved", "name": "my-edits.html", "mimeType": "text/html",
                "parents": ["folder"], "md5Checksum": "user-edit", "appProperties": {
                    "mathAppSource": "source", "mathAppKind": "html", "mathAppSavedMd5": "previous"}}
            drive.request = lambda *_args, **_kwargs: self.fail("must not upload over user changes")
            with self.assertRaises(StudioError) as caught:
                drive.upload(path, "lesson.html", "folder", "text/html", {"mathAppSource": "source", "mathAppKind": "html"})
            self.assertEqual(caught.exception.code, "drive_name_conflict")


class IntegrationTests(unittest.TestCase):
    def test_independent_pdf_and_html_jobs_keep_real_js_rendering_and_source_identity(self):
        if not shutil.which("node"):
            self.skipTest("Node.js is required for the real renderer integration test")
        automation = Path(__file__).resolve().parents[1]
        fixture = json.loads((automation / "renderer/fixtures/geometry.json").read_text(encoding="utf-8"))
        for problem in fixture["problems"]:
            problem["sourceImageIds"] = ["source-1"]
        inventory = [{"id": problem["id"], "sectionId": problem["sectionId"], "sectionTitle": problem["sectionId"],
            "number": problem["number"], "title": problem["title"], "pdfPages": [1], "printedPages": ["1"],
            "subquestions": [{"id": sub["id"], "label": sub["label"], "conditions": problem["givens"], "goal": problem["goal"]}
                             for sub in problem["subquestions"]], "officialSolutionPages": [], "unresolvedIssues": []}
            for problem in fixture["problems"]]
        events, saved = [], {}

        class FixtureAI:
            def __init__(self, *_args, **_kwargs): pass
            def structured(self, key, prompt, schema, images=(), max_tokens=None):
                if key == "issue":
                    value = {"year": 2026, "month": 9, "evidence": ["Synthetic fixture"], "unresolvedIssues": []}
                elif key.startswith("classify-review-"):
                    value = {"approved": True, "checkedPdfPages": [1, 2], "issues": []}
                elif key.startswith("classify-"):
                    value = {"pages": [{"pdfPage": page, "printedPages": [str(page)],
                        "labels": labels, "headingEvidence": "Synthetic heading", "boundaryEvidence": "Synthetic boundary",
                        "visuallyChecked": True, "unresolvedIssues": []}
                        for page, labels in [(1, ["points", "practice_questions"]), (2, ["advanced_questions"])]],
                        "issueEvidence": "Synthetic fixture", "unresolvedIssues": []}
                elif key.startswith("inventory-review-"):
                    value = {"approved": True, "checkedPdfPages": [1], "issues": []}
                elif key.startswith("inventory-"):
                    events.append("inventory")
                    value = {"problems": inventory, "solutionLinks": [], "coverage": [{"pdfPage": 1,
                        "questionIds": [problem["id"] for problem in inventory], "noQuestionReason": ""}], "unresolvedIssues": []}
                elif key.startswith("solutions-review-"):
                    value = {"approved": True, "checkedPdfPages": [1], "issues": []}
                elif key.startswith("solutions-"):
                    value = {"links": [], "unpairedPages": [{"pdfPage": 1, "reason": "Synthetic questions only."}],
                             "checkedPdfPages": [1], "unresolvedIssues": []}
                elif key.startswith("lesson-"):
                    problem = next(problem for problem in fixture["problems"] if "-" + problem["id"] + "-" in key)
                    value = ({"approved": True, "checkedSubquestionIds": [sub["id"] for sub in problem["subquestions"]],
                        **{name: problem["verification"][name] for name in ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")},
                        "issues": []} if key.startswith("lesson-review-") else problem)
                else:
                    raise AssertionError("Unmocked model operation: " + key)
                value = copy.deepcopy(value)
                jsonschema.validate(value, schema)
                return value

        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            source_path = directory / "fixture.pdf"
            with fitz.open() as doc:
                for _ in range(2):
                    page = doc.new_page(width=600, height=420)
                    page.insert_image(page.rect, filename=str(automation / "renderer/fixtures/geometry-source.png"))
                doc.save(source_path)
            original = source_path.read_bytes()
            original_booklet = original
            source = {"id": "fixture-source", "name": "2026年9月号_fixture.pdf", "mimeType": "application/pdf",
                      "size": str(len(original)), "md5Checksum": hashlib.md5(original).hexdigest(), "parents": [SOURCE_FOLDER]}
            class FixtureDrive:
                def __init__(self, *_args): pass
                def metadata(self, file_id):
                    return source if file_id == source["id"] else {"id": file_id, "mimeType": "application/vnd.google-apps.folder"}
                def download(self, file_id, target):
                    if file_id != source["id"]: raise AssertionError("Unexpected source")
                    target.write_bytes(original)
                def find(self, *_args): return []
                def upload(self, path, name, folder, mime, properties, existing_id=None):
                    events.append(properties["mathAppKind"])
                    saved[properties["mathAppKind"]] = path.read_bytes()
                    return {"id": "saved-" + properties["mathAppKind"], "name": name, "mimeType": mime,
                            "size": str(path.stat().st_size), "parents": [folder]}
            studio = MemoryStudio()
            job = {"id": studio.job_id, "source": source, "model": "selected-model", "specVersion": "v1", "status": "queued",
                   "folders": {"source": SOURCE_FOLDER, "practice": PRACTICE_FOLDER, "advanced": ADVANCED_FOLDER, "html": PRACTICE_FOLDER}}
            def publish(_studio, html, name, source_id):
                self.assertIn(b"math-app-generated-lesson", html.read_bytes())
                self.assertEqual(source_id, source["id"])
                return {"url": "https://fixture.invalid/lesson", "contentVerified": True}
            with patch("run_monthly.DriveClient", FixtureDrive), patch("run_monthly.ResponsesClient", FixtureAI), \
                    patch("run_monthly.browser_and_visual_qa", return_value={"browserChecksPassed": True}), \
                    patch("run_monthly.generate_verified_lesson", wraps=generate_verified_lesson) as generate, \
                    patch("run_monthly.publish_and_verify", side_effect=publish) as publisher:
                result = run_job(studio, job, "fake-fixture-key", directory)
                generate.assert_not_called()
                publisher.assert_not_called()
            self.assertEqual(result["errors"], [])
            self.assertEqual(events, ["practice", "advanced"])
            self.assertEqual(set(saved), {"practice", "advanced"})
            self.assertEqual(studio.updates[-1]["status"], "completed")
            for kind in ("practice", "advanced"):
                with fitz.open(stream=saved[kind], filetype="pdf") as doc:
                    self.assertEqual(len(doc), 1)
                original = saved[kind]
                source = {"id": "saved-" + kind, "name": next(output["pdf"]["name"] for output in result["outputs"] if output["kind"] == kind),
                          "mimeType": "application/pdf", "size": str(len(original)), "parents": [job["folders"][kind]],
                          "md5Checksum": hashlib.md5(original).hexdigest()}
                html_studio = MemoryStudio()
                html_job = {**job, "operation": "html", "sourceKind": kind, "source": source}
                with patch("run_monthly.DriveClient", FixtureDrive), patch("run_monthly.ResponsesClient", FixtureAI), \
                        patch("run_monthly.browser_and_visual_qa", return_value={"browserChecksPassed": True}), \
                        patch("run_monthly.classify_pdf", side_effect=AssertionError("HTML must not classify")), \
                        patch("run_monthly.extract_pdf", side_effect=AssertionError("HTML must not extract")), \
                        patch("run_monthly.publish_and_verify", side_effect=publish) as publisher:
                    html_result = run_job(html_studio, html_job, "fake-fixture-key", directory)
                self.assertEqual(html_result["errors"], [])
                self.assertEqual(len(html_result["outputs"]), 1)
                self.assertNotIn("pdf", html_result["outputs"][0])
                self.assertEqual(html_result["outputs"][0]["html"]["name"], source["name"][:-4] + "_講義アニメーション.html")
                publisher.assert_called_once()
                html = saved["html-" + kind].decode("utf-8")
                self.assertIn("data:image/jpeg;base64,", html)
                self.assertIn('id="lesson-data"', html)
                self.assertNotIn('<script src=', html)
            self.assertEqual(source_path.read_bytes(), original_booklet)
            self.assertFalse(list(directory.glob("math-app-monthly-*")), "Private intermediate directory must be removed")
            self.assertEqual(studio.updates[-1]["status"], "completed")

    def test_real_renderer_cli_rejects_invalid_reference(self):
        if not shutil.which("node"):
            self.skipTest("Node.js is required for the real renderer integration test")
        automation = Path(__file__).resolve().parents[1]
        fixture = json.loads((automation / "renderer/fixtures/geometry.json").read_text(encoding="utf-8"))
        fixture["problems"][0]["steps"][0]["cues"][0]["state"]["highlightIds"] = ["does-not-exist"]
        with tempfile.TemporaryDirectory() as temporary, self.assertRaises(StudioError) as caught:
            render_lesson(fixture, {}, Path(temporary), automation)
        self.assertEqual(caught.exception.code, "renderer_validation")

    def test_distant_solutions_match_stable_catalog_and_old_answers_stay_unpaired(self):
        with tempfile.TemporaryDirectory() as temporary:
            image = Path(temporary) / "source.jpg"
            image.write_bytes(b"fixture-image")
            problems = [{"id": "practice-5", "officialSolutionPages": [99]}]
            responses = [{"links": [{"problemId": "practice-5", "pdfPages": [8], "evidence": "same section and conditions"}],
                "unpairedPages": [{"pdfPage": 9, "reason": "Past contest answer without its question in this booklet"}],
                "checkedPdfPages": [8, 9], "unresolvedIssues": []},
                {"approved": True, "checkedPdfPages": [8, 9], "issues": []}]
            class AI:
                def structured(self, *_args, **_kwargs): return responses.pop(0)
            reconcile_solution_pages(problems, [8, 9], {8: image, 9: image}, AI(), "practice", "spec")
            self.assertEqual(problems[0]["officialSolutionPages"], [8])


class SafetyTests(unittest.TestCase):
    def test_job_rejects_other_folders_and_generated_sources(self):
        job = {"id": "test", "source": {"id": "source", "name": "2026.pdf", "mimeType": "application/pdf"},
               "model": "selected-model", "specVersion": "v1", "status": "queued",
               "folders": {"source": SOURCE_FOLDER, "practice": PRACTICE_FOLDER, "advanced": ADVANCED_FOLDER, "html": PRACTICE_FOLDER}}
        self.assertEqual(validate_job(job, "test"), job["source"])
        job["folders"]["html"] = "unrelated-folder"
        with self.assertRaises(StudioError):
            validate_job(job, "test")

    def test_incomplete_subquestions_or_wrong_images_block_lesson(self):
        inventory = {"id": "practice-1", "sectionId": "practice", "subquestions": [{"id": "practice-1-a"}, {"id": "practice-1-b"}], "pdfPages": [1]}
        problem = {"id": "practice-1", "sectionId": "practice", "subquestions": [{"id": "practice-1-a"}], "sourceImageIds": ["source-1"]}
        with self.assertRaises(StudioError):
            validate_problem_coverage(problem, inventory)
        problem["subquestions"] = inventory["subquestions"]
        validate_problem_coverage(problem, inventory)
        problem["sourceImageIds"] = ["source-2"]
        with self.assertRaises(StudioError):
            validate_problem_coverage(problem, inventory)

    def test_unknown_or_user_edited_same_name_html_is_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "lesson.html"
            path.write_text("new lesson", encoding="utf-8")
            class Drive:
                def metadata(self, _): return {"mimeType": "application/vnd.google-apps.folder"}
                def find(self, *_): return [{"id": "existing", "mimeType": "text/html", "md5Checksum": "changed", "appProperties": {
                    "mathAppSource": "source", "mathAppKind": "html-practice", "mathAppSavedMd5": "before-edit"}}]
                def upload(self, *_args, **_kwargs): raise AssertionError("must not upload")
            with self.assertRaises(StudioError) as caught:
                save_verified(Drive(), MemoryStudio(), path, "lesson.html", PRACTICE_FOLDER, "text/html",
                              {"id": "source"}, "sourcehash", "html-practice", "v1", Path(temporary))
            self.assertEqual(caught.exception.code, "drive_name_conflict")


if __name__ == "__main__":
    unittest.main()
