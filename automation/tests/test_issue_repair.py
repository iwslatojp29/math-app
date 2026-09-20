"""Bounded issue-date repair from real PDF images, without external API calls."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path

import pymupdf as fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pdf_pipeline
from studio_common import ResponsesClient, StudioError


class MemoryStudio:
    def __init__(self):
        self.values, self.updates = {}, []
        self.job_id, self.active_checks = "issue-repair-test", 0

    def checkpoint(self, key, value=...):
        if value is ...:
            return copy.deepcopy(self.values.get(key))
        self.values[key] = copy.deepcopy(value)

    def ensure_active(self):
        self.active_checks += 1

    def update(self, **changes):
        self.updates.append(copy.deepcopy(changes))


class CompletedResponse:
    status_code, ok = 200, True

    def __init__(self, number, result):
        self.value = {"id": "resp_issue_fixture_" + str(number), "status": "completed", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": json.dumps(result)}]}]}

    def json(self):
        return self.value


class ScriptedSession:
    def __init__(self, results):
        self.results, self.calls = list(results), []

    def request(self, method, url, **kwargs):
        if method != "POST" or url != "https://api.openai.com/v1/responses":
            raise AssertionError("Unexpected API operation")
        self.calls.append(json.loads(kwargs["data"]))
        if not self.results:
            raise AssertionError("Unexpected additional generation")
        return CompletedResponse(len(self.calls), self.results.pop(0))


class RecordingAI(ResponsesClient):
    def __init__(self, studio, results):
        self.scripted_session = ScriptedSession(results)
        self.task_keys = []
        super().__init__("fake-fixture-key", "fixture-model", studio, self.scripted_session)

    def structured(self, key, *args, **kwargs):
        self.task_keys.append(key)
        return super().structured(key, *args, **kwargs)


class IssueRepairTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        document = fitz.open()
        for number in range(1, 21):
            text = ("September 2026 ISSUE. Published July 24, 2026." if number == 1 else
                    "Contents: September 2026 ISSUE" if number == 2 else
                    "Imprint: September 2026 ISSUE. Published July 24, 2026." if number == 20 else
                    "Earlier July answers; next October preview." if number == 19 else
                    "Synthetic mathematics page " + str(number))
            document.new_page(width=320, height=180).insert_text((12, 30), text, fontsize=8)
        self.source = self.directory / "ambiguous-publication-date.pdf"
        document.save(self.source)
        document.close()
        self.doc = fitz.open(self.source)
        self.addCleanup(self.doc.close)
        self.images = {number: pdf_pipeline.page_image(self.doc, number, self.directory)
                       for number in range(1, len(self.doc) + 1)}
        self.studio = MemoryStudio()

    @staticmethod
    def issue(year=2026, month=9, evidence=None, unresolved=None):
        return {"year": year, "month": month,
                "evidence": ["PDF 1 cover: September 2026", "PDF 20 imprint: September 2026"]
                if evidence is None else evidence,
                "unresolvedIssues": [] if unresolved is None else unresolved}

    def identify(self, ai):
        return pdf_pipeline.identify_issue(self.doc, ai, self.images, self.studio)

    @staticmethod
    def prompt(call):
        return call["input"][0]["content"][0]["text"]

    @staticmethod
    def inputs(call):
        return [item["image_url"] for item in call["input"][0]["content"] if item["type"] == "input_image"]

    def test_valid_initial_result_retains_original_request_fingerprint_and_needs_no_review(self):
        original = self.issue(evidence=["Cover and contents agree on September 2026"])
        ai = RecordingAI(self.studio, [original])
        # Seed the exact request used before the repair feature. Resuming a valid
        # job must use its existing response, not pay to classify the issue again.
        cover_pages = [1, 2, 3, 4, 5]
        ai.structured("issue", "同じ元冊子の表紙・目次・冒頭です。表紙、本文見出し等の複数根拠で冊子の年/月を特定してください。"
            "過去号の解答年月を冊子年月と誤認しない。目次だけの年誤植は他の根拠と比較し、原文を改変しない。"
            "重要な不確実性はunresolvedIssuesへ。画像の順はPDFページ " + str(cover_pages), pdf_pipeline.ISSUE_SCHEMA,
            [pdf_pipeline.image_data(self.images[page]) for page in cover_pages], max_tokens=6000)
        self.assertEqual(self.identify(ai), original)
        self.assertEqual(ai.task_keys, ["issue", "issue"])
        self.assertEqual(len(ai.scripted_session.calls), 1)

    def test_publication_date_conflict_is_repaired_and_independently_confirmed(self):
        unresolved = self.issue(month=7, unresolved=["Publication date July conflicts with September issue heading"])
        corrected = self.issue()
        ai = RecordingAI(self.studio, [unresolved, corrected, corrected])
        value = self.identify(ai)
        self.assertEqual((value["year"], value["month"]), (2026, 9))
        self.assertEqual(ai.task_keys, ["issue", "issue-repair-1", "issue-review-1"])
        repair_prompt = self.prompt(ai.scripted_session.calls[1])
        self.assertIn("発行", repair_prompt)
        self.assertIn("号", repair_prompt)
        self.assertIn("Publication date July conflicts", repair_prompt)
        # The independent reviewer receives the same original evidence images.
        self.assertEqual(self.inputs(ai.scripted_session.calls[1]), self.inputs(ai.scripted_session.calls[2]))

    def test_repair_and_review_include_real_imprint_images_beyond_first_five(self):
        ai = RecordingAI(self.studio, [self.issue(unresolved=["Need imprint"]), self.issue(), self.issue()])
        self.identify(ai)
        initial = self.inputs(ai.scripted_session.calls[0])
        expanded = self.inputs(ai.scripted_session.calls[1])
        self.assertEqual(initial, [pdf_pipeline.image_data(self.images[n]) for n in range(1, 6)])
        self.assertEqual(len(expanded), len(set(expanded)), "No duplicated images in the expanded evidence")
        for number in [1, 2, 3, 4, 5, 8, 12, 16, 17, 18, 19, 20]:
            self.assertIn(pdf_pipeline.image_data(self.images[number]), expanded)
        self.assertNotIn(pdf_pipeline.image_data(self.images[20]), initial)
        self.assertTrue(any(pdf_pipeline.image_data(self.images[n]) in expanded for n in (10, 11)))

    def test_completed_repair_and_review_are_reused_on_resume_without_new_generation(self):
        ai = RecordingAI(self.studio, [self.issue(unresolved=["Need imprint"]), self.issue(), self.issue()])
        first = self.identify(ai)
        second = self.identify(ai)
        self.assertEqual(first, second)
        self.assertEqual(len(ai.scripted_session.calls), 3)
        self.assertEqual(ai.task_keys, ["issue", "issue-repair-1", "issue-review-1"] * 2)

    def test_independent_month_mismatch_requires_second_repair(self):
        ai = RecordingAI(self.studio, [self.issue(unresolved=["Need imprint"]), self.issue(),
                                      self.issue(month=7), self.issue(), self.issue()])
        value = self.identify(ai)
        self.assertEqual(value["month"], 9)
        self.assertEqual(ai.task_keys, ["issue", "issue-repair-1", "issue-review-1",
                                        "issue-repair-2", "issue-review-2"])

    def test_two_disagreeing_reviews_stop_with_owner_diagnostics_without_accepting_candidate(self):
        ai = RecordingAI(self.studio, [self.issue(unresolved=["Need imprint"]), self.issue(),
                                      self.issue(month=7), self.issue(), self.issue(year=2025)])
        with self.assertRaises(StudioError) as caught:
            self.identify(ai)
        self.assertEqual(caught.exception.code, "issue_unresolved")
        self.assertTrue(caught.exception.attention)
        self.assertTrue(caught.exception.details)
        self.assertEqual(ai.task_keys, ["issue", "issue-repair-1", "issue-review-1",
                                        "issue-repair-2", "issue-review-2"])
        self.assertEqual(len(ai.scripted_session.calls), 5)

    def test_invalid_month_and_year_are_never_fabricated_from_filename_or_current_date(self):
        ai = RecordingAI(self.studio, [self.issue(month=13), self.issue(month=0), self.issue(year=0)])
        with self.assertRaises(StudioError) as caught:
            self.identify(ai)
        self.assertEqual(caught.exception.code, "issue_unresolved")
        self.assertEqual(ai.task_keys, ["issue", "issue-repair-1", "issue-repair-2"])
        self.assertEqual(len(ai.scripted_session.calls), 3)

    def test_blank_or_repeated_repair_evidence_does_not_satisfy_multiple_sources(self):
        ai = RecordingAI(self.studio, [self.issue(evidence=[" \t\n　"]),
                                      self.issue(evidence=["cover", "cover"]),
                                      self.issue(evidence=["cover", "　 "])])
        with self.assertRaises(StudioError) as caught:
            self.identify(ai)
        self.assertEqual(caught.exception.code, "issue_unresolved")
        self.assertEqual(ai.task_keys, ["issue", "issue-repair-1", "issue-repair-2"])

    def test_review_with_unresolved_issue_cannot_approve_matching_candidate(self):
        conflicting = self.issue(unresolved=["PRIVATE source issue is unreadable"])
        ai = RecordingAI(self.studio, [conflicting, self.issue(), conflicting, self.issue(), conflicting])
        with self.assertRaises(StudioError) as caught:
            self.identify(ai)
        self.assertEqual(caught.exception.code, "issue_unresolved")
        self.assertNotIn("PRIVATE", caught.exception.public_message)
        self.assertIn("PRIVATE", json.dumps(caught.exception.details))
        self.assertEqual(len(ai.scripted_session.calls), 5)

    def test_short_document_repair_does_not_reference_nonexistent_pages(self):
        short = fitz.open()
        self.addCleanup(short.close)
        short.new_page(width=240, height=160).insert_text((15, 30), "September 2026")
        images = {1: pdf_pipeline.page_image(short, 1, self.directory, prefix="short")}
        ai = RecordingAI(self.studio, [self.issue(unresolved=["Need clearer inspection"]), self.issue(), self.issue()])
        value = pdf_pipeline.identify_issue(short, ai, images)
        self.assertEqual(value["month"], 9)
        self.assertEqual(len(ai.scripted_session.calls), 3)
        self.assertTrue(all(len(self.inputs(call)) == 1 for call in ai.scripted_session.calls))


if __name__ == "__main__":
    unittest.main()
