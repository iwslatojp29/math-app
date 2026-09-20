"""Page-evidence repair and cached resumption, with real PDF images and no APIs."""
import copy
import hashlib
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout, redirect_stderr
from pathlib import Path
from unittest.mock import patch

import pymupdf as fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pdf_pipeline
import run_monthly
from studio_common import (ADVANCED_FOLDER, PRACTICE_FOLDER, SOURCE_FOLDER,
                           ResponsesClient, StudioError)


class MemoryStudio:
    def __init__(self):
        self.values, self.writes, self.updates = {}, [], []
        self.job_id, self.active_checks = "classification-test", 0

    def checkpoint(self, key, value=...):
        if value is ...:
            return copy.deepcopy(self.values.get(key))
        self.values[key] = copy.deepcopy(value)
        self.writes.append((key, copy.deepcopy(value)))

    def ensure_active(self):
        self.active_checks += 1

    def update(self, **changes):
        self.updates.append(copy.deepcopy(changes))


class CompletedResponse:
    status_code, ok = 200, True

    def __init__(self, response_id, result):
        self.value = {"id": response_id, "status": "completed", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": json.dumps(result)}]}]}

    def json(self):
        return self.value


class ScriptedSession:
    """Only exact scripted Responses POSTs are permitted; no network is available."""
    def __init__(self, results):
        self.results, self.calls = list(results), []

    def request(self, method, url, **kwargs):
        if method != "POST" or url != "https://api.openai.com/v1/responses":
            raise AssertionError("Unexpected API operation")
        self.calls.append(json.loads(kwargs["data"]))
        if not self.results:
            raise AssertionError("Unexpected additional model generation")
        return CompletedResponse("resp_fixture_" + str(len(self.calls)), self.results.pop(0))


class RecordingAI(ResponsesClient):
    def __init__(self, studio, results):
        self.scripted_session = ScriptedSession(results)
        self.task_keys = []
        super().__init__("fake-fixture-key", "fixture-model", studio, self.scripted_session)

    def structured(self, task_key, *args, **kwargs):
        self.task_keys.append(task_key)
        return super().structured(task_key, *args, **kwargs)


class ClassificationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.doc = fitz.open()
        self.addCleanup(self.doc.close)
        self.doc.new_page(width=240, height=160).insert_text((15, 30), "2026-09 synthetic booklet cover")
        self.doc.new_page(width=240, height=160).insert_text((15, 30), "Synthetic practice question: 3 + 4 = ?")
        self.studio = MemoryStudio()

    @staticmethod
    def issue():
        return {"year": 2026, "month": 9, "evidence": ["Synthetic cover and heading"], "unresolvedIssues": []}

    @staticmethod
    def page(number, label="other"):
        return {"pdfPage": number, "printedPages": [], "labels": [label],
                "headingEvidence": "見出しはなく、画像から確認した表紙または継続する誌面。",
                "boundaryEvidence": "前後の誌面と本文の続き、または冊子の端を画像で確認。",
                "visuallyChecked": True, "unresolvedIssues": []}

    def classification(self, numbers=(1, 2)):
        return {"pages": [self.page(number, "other" if number == 1 else "practice_questions") for number in numbers],
                "issueEvidence": "Synthetic booklet", "unresolvedIssues": []}

    @staticmethod
    def approved(pages=(1, 2)):
        return {"approved": True, "checkedPdfPages": list(pages), "issues": []}

    def classify(self, ai):
        return pdf_pipeline.classify_pdf(self.doc, ai, self.studio, self.directory, "Fixture extraction specification")

    def diagnostic_writes(self):
        return [value for key, value in self.studio.writes if key.startswith("page-classification-diagnostics-")]

    def test_other_pages_accept_observed_absence_of_a_heading_and_page_boundaries(self):
        value = self.classification()
        value["pages"] = [self.page(1), self.page(2)]
        value["pages"][0].update(headingEvidence="表紙には冊子名と年月だけがあり、対象本文はない。",
                                 boundaryEvidence="冊子の先頭で、前ページは存在しない。")
        value["pages"][1].update(headingEvidence="全面白紙で、文字や見出しはない。",
                                 boundaryEvidence="冊子末尾の白紙で、後続ページは存在しない。")
        self.assertEqual(pdf_pipeline.classification_issues(value, [1, 2]), [])
        ai = RecordingAI(self.studio, [self.issue(), value, self.approved()])
        classification, _ = self.classify(ai)
        self.assertEqual(classification["pages"], value["pages"])
        self.assertEqual(ai.task_keys, ["issue", "classify-1-0", "classify-review-1-0"])

    def test_other_pages_still_require_evidence_and_an_explicit_label(self):
        value = self.classification()
        value["pages"][0].update(labels=[], headingEvidence="", boundaryEvidence="")
        issues = pdf_pipeline.classification_issues(value, [1, 2])
        self.assertEqual(issues, [{"code": "page_evidence", "pdfPage": 1,
                                  "fields": ["labels", "headingEvidence", "boundaryEvidence"]}])

    def test_whitespace_does_not_count_as_source_evidence_for_any_page_kind(self):
        for label in ("other", "practice_questions"):
            with self.subTest(label=label):
                value = self.classification()
                value["pages"][0].update(labels=[label], headingEvidence=" \t\n　", boundaryEvidence="\r\n ")
                issues = pdf_pipeline.classification_issues(value, [1, 2])
                self.assertEqual(issues[0]["fields"], ["headingEvidence", "boundaryEvidence"])

    def test_missing_duplicate_or_reordered_pdf_pages_cannot_be_approved(self):
        for numbers in ([1], [1, 1], [2, 1], [1, 2, 3]):
            with self.subTest(numbers=numbers):
                issues = pdf_pipeline.classification_issues(self.classification(numbers), [1, 2])
                self.assertEqual(issues[0]["code"], "page_coverage")
                self.assertEqual(issues[0]["pdfPages"], [1, 2])

    def test_unchecked_images_and_unresolved_content_remain_blocking(self):
        private_text = "PRIVATE source condition must not enter diagnostics"
        value = self.classification()
        value["pages"][0]["visuallyChecked"] = False
        value["pages"][1]["unresolvedIssues"] = [private_text]
        value["unresolvedIssues"] = [private_text]
        issues = pdf_pipeline.classification_issues(value, [1, 2])
        self.assertEqual(len(issues), 3)
        self.assertTrue(all(item["code"] == "pdf_boundaries_unresolved" for item in issues))
        self.assertNotIn(private_text, json.dumps(issues))
        ai = RecordingAI(self.studio, [self.issue(), value, self.classification(), self.approved()])
        self.classify(ai)
        self.assertNotIn("classify-review-1-0", ai.task_keys)
        self.assertIn("classify-review-1-1", ai.task_keys)
        repair_prompt = ai.scripted_session.calls[2]["input"][0]["content"][0]["text"]
        self.assertIn(private_text, repair_prompt, "The repairer must see the unresolved condition")
        self.assertNotIn(private_text, json.dumps(self.diagnostic_writes()))

    def test_cached_empty_evidence_is_repaired_then_every_result_is_reused_on_resume(self):
        incomplete = self.classification()
        incomplete["pages"][0].update(labels=[], headingEvidence="", boundaryEvidence="")
        correct = self.classification()
        ai = RecordingAI(self.studio, [self.issue(), incomplete, correct, self.approved()])
        classification, images = self.classify(ai)
        self.assertEqual(classification["pages"], correct["pages"])
        self.assertTrue(all(path.exists() for path in images.values()))
        expected_keys = ["issue", "classify-1-0", "classify-1-1", "classify-review-1-1"]
        self.assertEqual(ai.task_keys, expected_keys)
        repair_prompt = ai.scripted_session.calls[2]["input"][0]["content"][0]["text"]
        self.assertIn("headingEvidence", repair_prompt)
        self.assertIn("boundaryEvidence", repair_prompt)
        self.assertIn("other", repair_prompt)
        self.assertEqual(len(ai.scripted_session.calls), 4)
        # Use the actual ResponsesClient checkpoint implementation, including the
        # cached schema-valid but semantically incomplete initial classification.
        self.assertTrue(any(item.get("result") == incomplete for item in self.studio.values.values()))
        repeated, _ = self.classify(ai)
        self.assertEqual(repeated, classification)
        self.assertEqual(ai.task_keys, expected_keys * 2)
        self.assertEqual(len(ai.scripted_session.calls), 4, "Resume must not bill either cached attempt again")

    def test_valid_structure_still_requires_independent_review_after_repair(self):
        rejected = {"approved": False, "checkedPdfPages": [1, 2], "issues": ["PRIVATE boundary diagnosis"]}
        correct = self.classification()
        ai = RecordingAI(self.studio, [self.issue(), correct, rejected, correct, self.approved()])
        result, _ = self.classify(ai)
        self.assertEqual(result["pages"], correct["pages"])
        self.assertEqual(ai.task_keys, ["issue", "classify-1-0", "classify-review-1-0",
                                        "classify-1-1", "classify-review-1-1"])
        repair_prompt = ai.scripted_session.calls[3]["input"][0]["content"][0]["text"]
        self.assertIn("PRIVATE boundary diagnosis", repair_prompt)
        self.assertNotIn("PRIVATE boundary diagnosis", json.dumps(self.diagnostic_writes()))

    def test_review_that_omits_a_page_must_be_repaired_even_when_marked_approved(self):
        correct = self.classification()
        ai = RecordingAI(self.studio, [self.issue(), correct, self.approved([1]), correct, self.approved()])
        self.classify(ai)
        self.assertEqual(len(ai.scripted_session.calls), 5)
        self.assertEqual(self.diagnostic_writes()[0]["issues"][0]["fields"], ["independentReview"])

    def test_only_failed_batch_is_repaired_and_neighbours_do_not_become_output_pages(self):
        for number in range(3, 8):
            self.doc.new_page(width=240, height=160).insert_text((15, 30), "Synthetic page " + str(number))
        first = self.classification(range(1, 7))
        invalid_last = self.classification([7])
        invalid_last["pages"][0]["boundaryEvidence"] = ""
        fixed_last = self.classification([7])
        ai = RecordingAI(self.studio, [self.issue(), first, self.approved(range(1, 7)),
                                      invalid_last, fixed_last, self.approved([7])])
        result, _ = self.classify(ai)
        self.assertEqual([page["pdfPage"] for page in result["pages"]], list(range(1, 8)))
        expected = ["issue", "classify-1-0", "classify-review-1-0",
                    "classify-7-0", "classify-7-1", "classify-review-7-1"]
        self.assertEqual(ai.task_keys, expected)
        last_request = ai.scripted_session.calls[3]["input"][0]["content"]
        self.assertEqual(sum(item["type"] == "input_image" for item in last_request), 2,
                         "The final batch must still see the previous page")
        self.classify(ai)
        self.assertEqual(len(ai.scripted_session.calls), 6)
        self.assertEqual(ai.task_keys, expected * 2)

    def test_three_failed_classifications_stop_before_extraction_saving_or_publication(self):
        private_text = "PRIVATE BOOKLET MATERIAL — never a diagnostic"
        invalid = self.classification()
        invalid["issueEvidence"] = private_text
        invalid["pages"][0].update(labels=[], headingEvidence="", boundaryEvidence=private_text)
        ai = RecordingAI(self.studio, [self.issue(), invalid, invalid, invalid])
        original = self.doc.tobytes()
        source = {"id": "fixture-source", "name": "2026年9月号.pdf", "mimeType": "application/pdf",
                  "size": str(len(original)), "md5Checksum": hashlib.md5(original).hexdigest(), "parents": [SOURCE_FOLDER]}
        job = {"id": self.studio.job_id, "source": source, "model": "fixture-model", "specVersion": "v1", "status": "queued",
               "folders": {"source": SOURCE_FOLDER, "practice": PRACTICE_FOLDER, "advanced": ADVANCED_FOLDER, "html": PRACTICE_FOLDER}}

        class FixtureDrive:
            def metadata(self, file_id):
                if file_id != source["id"]:
                    raise AssertionError("No destination should be touched before page verification")
                return copy.deepcopy(source)

            def download(self, file_id, target):
                if file_id != source["id"]:
                    raise AssertionError("Unexpected download")
                target.write_bytes(original)

        with patch.object(run_monthly, "DriveClient", return_value=FixtureDrive()), \
                patch.object(run_monthly, "ResponsesClient", return_value=ai), \
                patch.object(run_monthly, "extract_pdf") as extract, \
                patch.object(run_monthly, "save_verified") as save, \
                patch.object(run_monthly, "generate_verified_lesson") as lessons, \
                patch.object(run_monthly, "publish_and_verify") as publish, \
                patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), redirect_stdout(io.StringIO()) as logs:
            with self.assertRaises(StudioError) as caught:
                run_monthly.run_job(self.studio, job, "fake-fixture-key", self.directory)
        self.assertTrue(caught.exception.attention)
        self.assertEqual(caught.exception.code, "page_evidence")
        self.assertIn("1", caught.exception.public_message)
        self.assertIn("2", caught.exception.public_message)
        self.assertNotIn(private_text, caught.exception.public_message)
        self.assertNotIn(private_text, logs.getvalue())
        self.assertNotIn(private_text, json.dumps(self.diagnostic_writes()))
        self.assertEqual(ai.task_keys, ["issue", "classify-1-0", "classify-1-1", "classify-1-2"])
        self.assertEqual([item["attempt"] for item in self.diagnostic_writes()], [1, 2, 3])
        for operation in (extract, save, lessons, publish):
            operation.assert_not_called()
        self.assertFalse(list(self.directory.glob("math-app-monthly-*")))

    def test_owner_sees_bounded_sanitized_reasons_but_public_logs_do_not(self):
        error = StudioError("pdf_boundaries_unresolved", "PDF 49〜54ページを確認できません。", True)
        private_reason = "PDF 49ページ: 続きの参照先を確認できません。"
        token = "sk-" + "fixtureOnlyNotARealKey123456"
        error.details = [private_reason, "access_token=" + token, "x" * 2000] + ["reason " + str(i) for i in range(8)]
        self.studio.job = lambda: {}
        with patch.object(run_monthly, "StudioClient", return_value=self.studio), \
                patch.object(run_monthly, "run_job", side_effect=error), \
                redirect_stderr(io.StringIO()) as logs:
            self.assertEqual(run_monthly.main(["--job-id", self.studio.job_id]), 1)
        owner = self.studio.updates[-1]
        self.assertEqual(owner["status"], "needs_attention")
        self.assertIn(private_reason, owner["error"])
        self.assertNotIn(token, owner["error"])
        self.assertLess(len(owner["error"]), 1800)
        self.assertNotIn("reason 7", owner["error"])
        self.assertNotIn(private_reason, logs.getvalue())
        self.assertNotIn(token, logs.getvalue())
        self.assertEqual(logs.getvalue().strip(), "monthly runner: pdf_boundaries_unresolved")

    def test_context_uses_verified_section_heading_without_printed_page_offset(self):
        classified = [self.page(n, "other" if n < 42 else
                                "advanced_questions" if n < 46 else "advanced_solutions")
                      for n in range(1, 49)]
        for item in classified:
            item["printedPages"] = [str(item["pdfPage"] + 500)]
        context = pdf_pipeline.classification_context_pages(classified, list(range(48, 56)))
        self.assertIn(42, context)
        self.assertIn(46, context)
        self.assertLessEqual(len(context), 10)
        self.assertEqual(context, sorted(set(context)))
        self.assertTrue(all(1 <= n < 48 for n in context))

    def test_repair_and_independent_review_both_receive_prior_heading_image(self):
        for number in range(3, 8):
            self.doc.new_page(width=240, height=160).insert_text((15, 30), "Synthetic page " + str(number))
        first = self.classification(range(1, 7))
        pending = self.classification([7])
        pending["pages"][0]["unresolvedIssues"] = ["The beginning heading is outside the shown images."]
        fixed = self.classification([7])
        ai = RecordingAI(self.studio, [self.issue(), first, self.approved(range(1, 7)),
                                      pending, fixed, self.approved([7])])
        self.classify(ai)
        heading_image = pdf_pipeline.image_data(self.directory / "page-0002.jpg")
        first_images = ai.scripted_session.calls[3]["input"][0]["content"][1:]
        self.assertNotIn(heading_image, [image["image_url"] for image in first_images])
        for index in (4, 5):
            content = ai.scripted_session.calls[index]["input"][0]["content"]
            self.assertIn(heading_image, [image["image_url"] for image in content[1:]])
            self.assertIn(pdf_pipeline.CLASSIFICATION_SCOPE, content[0]["text"])
        final_record = self.diagnostic_writes()[-1]
        self.assertIn(2, final_record["contextPdfPages"])
        self.assertEqual(final_record["status"], "approved")

    def test_distant_continuation_uses_verified_printed_mapping_and_article_start(self):
        classified = [self.page(n, "other" if 50 <= n <= 53 else
                                "contest_questions" if n % 2 else "contest_solutions") for n in range(1, 79)]
        for item in classified:
            item["printedPages"] = [str(item["pdfPage"] + 200)]
        # Deliberately use nonuniform offsets: printed51->PDF53, printed81->PDF83.
        classified[52]["printedPages"] = ["51"]
        classified[52]["boundaryEvidence"] = "長文の演習の解説末尾に（p.81に続く）と明記。"
        pending = self.classification(range(79, 85))
        target = pending["pages"][4]
        target.update(labels=[], printedPages=["81"], boundaryEvidence="p.51のつづきとあるが見出しなし。",
                      unresolvedIssues=["印刷51ページおよび所属コーナーの見出しを確認する必要。"])
        context = pdf_pipeline.classification_context_pages(classified, list(range(78, 86)), pending)
        self.assertIn(50, context)
        self.assertIn(53, context)
        self.assertNotIn(51, context, "Do not treat printed51 as PDF51")
        self.assertLessEqual(len(context), 10)
        # Even if the model only notes an unknown source, the already-reviewed
        # source page's forward continuation reference must resolve the link.
        target.update(boundaryEvidence="本文の続き。", unresolvedIssues=["帰属が不明。"])
        context = pdf_pipeline.classification_context_pages(classified, list(range(78, 86)), pending)
        self.assertIn(50, context)
        self.assertIn(53, context)

    def test_printed_reference_parsing_avoids_years_and_accepts_japanese_notation(self):
        self.assertEqual(pdf_pipeline.printed_page_references("2026年10月号 p.81、印刷51ページ、誌面40、44頁"),
                         {81, 51, 40, 44})


if __name__ == "__main__":
    unittest.main()
