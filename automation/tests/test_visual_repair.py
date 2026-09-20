"""Bounded visual repair orchestration, without model or browser calls."""
import copy
import io
import json
import sys
import tempfile
import unittest
from contextlib import nullcontext
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_monthly
from studio_common import StudioError


class MemoryStudio:
    def __init__(self):
        self.values, self.updates, self.active_checks = {}, [], 0
        self.job_id = "visual-repair-test"

    def checkpoint(self, key, value=...):
        if value is ...:
            return self.values.get(key)
        self.values[key] = value

    def update(self, **value):
        self.updates.append(value)

    def ensure_active(self):
        self.active_checks += 1


class VisualRepairTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.studio, self.ai = MemoryStudio(), object()
        self.plan = {"kind": "practice", "name": "2026年9月号.pdf", "pages": []}
        self.problem_ids = ["problem-1", "problem-2", "problem-3"]
        self.lessons = []
        self.assets = {"page-1": {"path": str(self.directory / "page.jpg"), "mimeType": "image/jpeg"}}
        self.verified = {"browserChecksPassed": True, "visualImagesReviewed": 10,
                         "actualDeviceTested": False, "actualVoiceAuditioned": False}
        self.html = self.directory / "lesson.html"
        self.html.write_text("<!doctype html><title>Visual repair fixture</title>", encoding="utf-8")

    def generate(self, *args, **kwargs):
        context = kwargs["generation_context"]
        if not self.lessons:
            self.assertEqual(context, {})
            context["inventory"] = [{"id": identifier} for identifier in self.problem_ids]
        else:
            self.assertEqual([item["id"] for item in context["inventory"]], self.problem_ids)
        lesson = {"problems": [{"id": identifier, "revision": len(self.lessons)}
                               for identifier in self.problem_ids]}
        self.lessons.append(lesson)
        return lesson, self.assets

    def rejection(self, suffix="first", *, repairable=True):
        issue = "image-1: 点Aと数値が重なっています。" + suffix
        images = [{"imageId": "image-1", "problemId": "problem-2", "cueId": "cue-2",
                   "viewport": {"width": 390, "height": 844}, "fontSize": "large"}]
        feedback = {"problem-2": [{"issue": issue, "images": images}]}
        return run_monthly.VisualQAError([issue], feedback, repairable=repairable)

    def run_lesson(self, callback=None):
        return run_monthly.generate_verified_lesson(
            self.directory / "source.pdf", self.ai, self.studio, self.plan, self.directory,
            "Keep every problem and subquestion.", "2026年9月号", self.directory / "lesson.schema.json",
            on_visual_issue=callback)

    def assert_generation_inputs(self, generator, renderer):
        original_args = generator.call_args_list[0].args
        context = generator.call_args_list[0].kwargs["generation_context"]
        for call in generator.call_args_list:
            self.assertEqual(call.args, original_args)
            self.assertIs(call.kwargs["generation_context"], context)
        self.assertEqual(renderer.call_count, len(self.lessons))
        for index, call in enumerate(renderer.call_args_list):
            self.assertEqual([problem["id"] for problem in call.args[0]["problems"]], self.problem_ids)
            self.assertIs(call.args[0], self.lessons[index])

    def test_first_pass_success_generates_and_verifies_once(self):
        with patch.object(run_monthly, "generate_lesson", side_effect=self.generate) as generator, \
                patch.object(run_monthly, "render_lesson", return_value=self.html) as renderer, \
                patch.object(run_monthly, "browser_and_visual_qa", return_value=self.verified) as qa:
            html, verification = self.run_lesson()
        self.assertEqual(html, self.html)
        self.assertTrue(verification["browserChecksPassed"])
        self.assertEqual(generator.call_count, 1)
        self.assertEqual(qa.call_count, 1)
        self.assertEqual(qa.call_args.kwargs["cycle"], 0)
        self.assertNotIn("previous_lesson", generator.call_args.kwargs)
        self.assert_generation_inputs(generator, renderer)

    def test_rejected_review_repairs_target_problem_then_reverifies_all(self):
        rejection = self.rejection()
        callback = Mock()

        def review(*args, **kwargs):
            self.assertTrue(callable(kwargs["on_rejection"]))
            if kwargs["cycle"] == 0:
                kwargs["on_rejection"](rejection)
                raise rejection
            return self.verified

        with patch.object(run_monthly, "generate_lesson", side_effect=self.generate) as generator, \
                patch.object(run_monthly, "render_lesson", return_value=self.html) as renderer, \
                patch.object(run_monthly, "browser_and_visual_qa", side_effect=review) as qa:
            html, verification = self.run_lesson(callback)
        self.assertEqual(html, self.html)
        self.assertTrue(verification["browserChecksPassed"])
        self.assertEqual(generator.call_count, 2)
        repaired = generator.call_args_list[1].kwargs
        self.assertIs(repaired["previous_lesson"], self.lessons[0])
        self.assertEqual(repaired["visual_feedback"], rejection.problem_feedback)
        self.assertEqual(repaired["repair_cycle"], 1)
        self.assertEqual([call.kwargs["cycle"] for call in qa.call_args_list], [0, 1])
        callback.assert_called_once_with(rejection, 0)
        self.assert_generation_inputs(generator, renderer)

    def test_repeated_rejection_stops_after_two_repairs_without_returning_html(self):
        rejections = [self.rejection(str(index)) for index in range(3)]
        original_feedback = [copy.deepcopy(error.problem_feedback) for error in rejections]
        with patch.object(run_monthly, "generate_lesson", side_effect=self.generate) as generator, \
                patch.object(run_monthly, "render_lesson", return_value=self.html) as renderer, \
                patch.object(run_monthly, "browser_and_visual_qa", side_effect=rejections) as qa:
            with self.assertRaises(run_monthly.VisualQAError) as caught:
                self.run_lesson()
        self.assertEqual(caught.exception.code, "visual_qa")
        self.assertEqual(generator.call_count, 3)
        self.assertEqual([call.kwargs["cycle"] for call in qa.call_args_list], [0, 1, 2])
        for cycle, call in enumerate(generator.call_args_list[1:], start=1):
            self.assertEqual(call.kwargs["repair_cycle"], cycle)
            self.assertIs(call.kwargs["previous_lesson"], self.lessons[cycle - 1])
            self.assertEqual(call.kwargs["visual_feedback"], original_feedback[cycle - 1])
        self.assert_generation_inputs(generator, renderer)

    def test_nonrepairable_coverage_failure_does_not_regenerate(self):
        rejection = self.rejection(repairable=False)
        with patch.object(run_monthly, "generate_lesson", side_effect=self.generate) as generator, \
                patch.object(run_monthly, "render_lesson", return_value=self.html) as renderer, \
                patch.object(run_monthly, "browser_and_visual_qa", side_effect=rejection) as qa:
            with self.assertRaises(run_monthly.VisualQAError) as caught:
                self.run_lesson()
        self.assertIs(caught.exception, rejection)
        self.assertEqual(generator.call_count, 1)
        self.assertEqual(qa.call_count, 1)
        self.assert_generation_inputs(generator, renderer)

    def test_cancellation_passes_through_without_repair(self):
        cancelled = StudioError("cancelled", "処理は停止されています。")
        with patch.object(run_monthly, "generate_lesson", side_effect=self.generate) as generator, \
                patch.object(run_monthly, "render_lesson", return_value=self.html) as renderer, \
                patch.object(run_monthly, "browser_and_visual_qa", side_effect=cancelled) as qa:
            with self.assertRaises(StudioError) as caught:
                self.run_lesson()
        self.assertIs(caught.exception, cancelled)
        self.assertEqual(generator.call_count, 1)
        self.assertEqual(qa.call_count, 1)
        self.assert_generation_inputs(generator, renderer)

    def browser_result(self):
        qa_directory = self.directory / "browser-qa"
        qa_directory.mkdir()
        screenshot = qa_directory / "private-capture.png"
        screenshot.write_bytes(b"\x89PNG\r\n\x1a\nvisual-review-fixture")
        self.screenshot = screenshot
        report = {"ok": True, "screenshots": [{"path": str(screenshot), "problemId": "problem-2",
                  "cueId": "cue-2", "viewport": {"width": 390, "height": 844}, "fontSize": "large",
                  "displayState": {"visibleIds": ["point-a"]}, "privateNote": "private-metadata-sentinel"}]}
        return Mock(returncode=0, stdout=json.dumps(report))

    def test_review_retries_missing_image_ids_with_explicit_complete_list(self):
        ai = Mock()
        ai.structured.side_effect = [
            {"approved": True, "checkedImages": [], "issues": []},
            {"approved": True, "checkedImages": ["image-1"], "issues": []},
        ]
        with patch.object(run_monthly.subprocess, "run", return_value=self.browser_result()) as browser:
            verification = run_monthly.browser_and_visual_qa(self.html, self.directory, ai, self.studio)
        self.assertTrue(verification["browserChecksPassed"])
        self.assertEqual(verification["visualImagesReviewed"], 1)
        self.assertEqual(browser.call_count, 1)
        self.assertEqual(ai.structured.call_count, 2)
        second_prompt = ai.structured.call_args_list[1].args[1]
        self.assertIn("checkedImagesをこの配列と完全一致させてください:", second_prompt)
        self.assertTrue(second_prompt.endswith('["image-1"]'))

    def test_review_repeated_missing_image_ids_is_not_repairable(self):
        ai = Mock()
        ai.structured.return_value = {"approved": True, "checkedImages": [], "issues": []}
        with patch.object(run_monthly.subprocess, "run", return_value=self.browser_result()):
            with self.assertRaises(run_monthly.VisualQAError) as caught:
                run_monthly.browser_and_visual_qa(self.html, self.directory, ai, self.studio)
        self.assertEqual(ai.structured.call_count, 2)
        self.assertFalse(caught.exception.repairable)
        self.assertEqual(caught.exception.problem_feedback, {})

    def test_denied_review_maps_only_observed_problem_and_redacts_private_data(self):
        ai, on_rejection = Mock(), Mock()
        ai.structured.return_value = {"approved": False, "checkedImages": ["image-1"],
                                      "issues": ["image-1: 点Aの重なり sk-testsecret123"]}
        with patch.object(run_monthly.subprocess, "run", return_value=self.browser_result()):
            with self.assertRaises(run_monthly.VisualQAError) as caught:
                run_monthly.browser_and_visual_qa(self.html, self.directory, ai, self.studio,
                                                 on_rejection=on_rejection)
        error = caught.exception
        self.assertTrue(error.repairable)
        self.assertEqual(set(error.problem_feedback), {"problem-2"})
        self.assertEqual(ai.structured.call_count, 1)
        on_rejection.assert_called_once()
        self.assertEqual(on_rejection.call_args.args[0].details, error.details)
        self.assertIn("[redacted]", error.details[0])
        self.assertNotIn("sk-testsecret123", json.dumps(error.problem_feedback))
        prompt = ai.structured.call_args.args[1]
        self.assertNotIn(str(self.screenshot), prompt)
        self.assertNotIn(self.screenshot.as_posix(), prompt)
        self.assertNotIn(self.screenshot.name, prompt)
        self.assertNotIn("private-metadata-sentinel", prompt)
        self.assertNotIn('"path"', prompt)

    def test_review_retries_first_model_schema_failure_once(self):
        ai = Mock()
        ai.structured.side_effect = [StudioError("model_schema", "検証者の形式を確認できません。"),
                                    {"approved": True, "checkedImages": ["image-1"], "issues": []}]
        with patch.object(run_monthly.subprocess, "run", return_value=self.browser_result()):
            verification = run_monthly.browser_and_visual_qa(self.html, self.directory, ai, self.studio)
        self.assertTrue(verification["browserChecksPassed"])
        self.assertEqual(ai.structured.call_count, 2)
        self.assertTrue(ai.structured.call_args.args[1].endswith('["image-1"]'))

    def test_run_job_keeps_verified_pdf_but_never_saves_or_publishes_rejected_html(self):
        source = {"id": "fixture-source", "name": "2026年9月号.pdf"}
        job = {"id": self.studio.job_id, "model": "fixture-model", "specVersion": "test-v1",
               "status": "queued", "folders": {"practice": "fixture-pdf-folder", "html": "fixture-html-folder"}}
        plan = {**self.plan, "pages": [{"pdfPage": 1}], "missing": []}
        drive = Mock()
        drive.download.side_effect = lambda _identifier, target: target.write_bytes(b"source-pdf-fixture")
        rejection = run_monthly.VisualQAError(["image-1: 点Aの重なり sk-testsecret123"],
                                              {"problem-2": [{"issue": "image-1: 点Aの重なり", "images": []}]})
        saved_pdf = {"id": "saved-pdf", "name": plan["name"]}

        def exhausted(*args, **kwargs):
            kwargs["on_visual_issue"](rejection, 2)
            raise rejection

        with patch.object(run_monthly, "validate_job", return_value=source), \
                patch.object(run_monthly, "check_source"), \
                patch.object(run_monthly, "DriveClient", return_value=drive), \
                patch.object(run_monthly, "ResponsesClient", return_value=Mock()), \
                patch.object(run_monthly, "open_pdf", return_value=nullcontext(object())), \
                patch.object(run_monthly, "classify_pdf", return_value=({"issue": {"year": 2026, "month": 9}}, None)), \
                patch.object(run_monthly, "plans_from_classification", return_value=[plan]), \
                patch.object(run_monthly, "extract_pdf", return_value={"pageCount": 1, "allPagesPixelMatched": True}), \
                patch.object(run_monthly, "save_verified", return_value=saved_pdf) as save, \
                patch.object(run_monthly, "generate_verified_lesson", side_effect=exhausted) as generate, \
                patch.object(run_monthly, "publish_and_verify") as publish:
            result = run_monthly.run_job(self.studio, job, "fixture-unused-key", self.directory)
        save.assert_called_once()
        self.assertEqual(save.call_args.args[5], "application/pdf")
        generate.assert_called_once()
        publish.assert_not_called()
        output = result["outputs"][0]
        self.assertEqual(output["pdf"], saved_pdf)
        self.assertNotIn("html", output)
        self.assertNotIn("htmlVerification", output)
        self.assertNotIn("published", output)
        self.assertEqual(output["error"]["code"], "visual_qa")
        self.assertEqual(output["error"]["details"], rejection.details)
        self.assertIn("[redacted]", output["error"]["details"][0])
        self.assertNotIn("sk-testsecret123", json.dumps(result))
        self.assertEqual(self.studio.updates[-1]["status"], "needs_attention")
        self.assertFalse(self.studio.updates[-1]["retryable"])

    def test_generic_lesson_errors_keep_bounded_private_diagnostics_and_saved_pdf(self):
        source = {"id": "fixture-source", "name": "2026年9月号.pdf"}
        job = {"id": self.studio.job_id, "model": "fixture-model", "specVersion": "test-v1",
               "status": "queued", "folders": {"practice": "fixture-pdf-folder", "html": "fixture-html-folder"}}
        plan = {**self.plan, "pages": [{"pdfPage": 1}], "missing": []}
        saved_pdf = {"id": "saved-pdf", "name": plan["name"]}
        drive = Mock()
        drive.download.side_effect = lambda _identifier, target: target.write_bytes(b"source-pdf-fixture")
        for code in ("inventory_unresolved", "lesson_unresolved"):
            with self.subTest(code=code):
                failure = StudioError(code, "全問の検証に未解決事項があります。", True)
                issue = "problem-2: 対応する点Aが不足しています。\x00 sk-testsecret123"
                failure.details = [issue, issue, None, {"not": "text"}, " ",
                    "Bearer fake-access-value", "https://example.invalid/item?token=fake-signed-value",
                    "長い指摘: " + "あ" * 1700, *[f"追加の指摘 {index}" for index in range(20)]]
                stdout, stderr = io.StringIO(), io.StringIO()
                with patch.object(run_monthly, "validate_job", return_value=source), \
                        patch.object(run_monthly, "check_source"), \
                        patch.object(run_monthly, "DriveClient", return_value=drive), \
                        patch.object(run_monthly, "ResponsesClient", return_value=Mock()), \
                        patch.object(run_monthly, "open_pdf", return_value=nullcontext(object())), \
                        patch.object(run_monthly, "classify_pdf", return_value=({"issue": {"year": 2026, "month": 9}}, None)), \
                        patch.object(run_monthly, "plans_from_classification", return_value=[plan]), \
                        patch.object(run_monthly, "extract_pdf", return_value={"pageCount": 1, "allPagesPixelMatched": True}), \
                        patch.object(run_monthly, "save_verified", return_value=saved_pdf) as save, \
                        patch.object(run_monthly, "generate_verified_lesson", side_effect=failure) as generate, \
                        patch.object(run_monthly, "publish_and_verify") as publish, \
                        patch("sys.stdout", stdout), patch("sys.stderr", stderr):
                    result = run_monthly.run_job(self.studio, job, "fixture-unused-key", self.directory)
                save.assert_called_once()
                self.assertEqual(save.call_args.args[5], "application/pdf")
                generate.assert_called_once()
                publish.assert_not_called()
                output = result["outputs"][0]
                self.assertEqual(output["pdf"], saved_pdf)
                self.assertTrue(output["pdfVerification"]["allPagesPixelMatched"])
                self.assertTrue({"html", "htmlVerification", "published"}.isdisjoint(output))
                self.assertEqual(output["error"]["code"], code)
                details = output["error"]["details"]
                self.assertEqual(len(details), 12)
                self.assertTrue(all(isinstance(detail, str) and len(detail) <= 700 for detail in details))
                self.assertEqual(details[0], "problem-2: 対応する点Aが不足しています。 [redacted]")
                self.assertEqual(details[1:3], ["[redacted]", "[redacted URL]"])
                self.assertEqual(len(details[3]), 700)
                self.assertEqual(self.studio.values["result"]["outputs"][0]["error"]["details"], details)
                self.assertEqual(self.studio.updates[-1]["result"]["outputs"][0]["error"]["details"], details)
                serialized = json.dumps([result, self.studio.values, self.studio.updates])
                for secret in ("sk-testsecret123", "fake-access-value", "fake-signed-value"):
                    self.assertNotIn(secret, serialized)
                self.assertNotIn("details", result["errors"][0])
                self.assertEqual(stdout.getvalue() + stderr.getvalue(), "")
                self.assertEqual(self.studio.updates[-1]["status"], "needs_attention")
                self.assertFalse(self.studio.updates[-1]["retryable"])


if __name__ == "__main__":
    unittest.main()
