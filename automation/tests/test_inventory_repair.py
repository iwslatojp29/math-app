"""Bounded inventory/answer repair with real private images and cached responses."""
import copy
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
import lesson_pipeline
from studio_common import ResponsesClient, StudioError


class MemoryStudio:
    def __init__(self):
        self.values, self.job_id = {}, "inventory-fixture"

    def checkpoint(self, key, value=...):
        if value is ...:
            return copy.deepcopy(self.values.get(key))
        self.values[key] = copy.deepcopy(value)

    def ensure_active(self):
        pass


class ScriptedSession:
    def __init__(self, responses):
        self.responses, self.calls = list(responses), []

    def request(self, method, url, **kwargs):
        if method != "POST" or url != "https://api.openai.com/v1/responses":
            raise AssertionError("Unexpected operation; network is unavailable")
        self.calls.append(json.loads(kwargs["data"]))
        if not self.responses:
            raise AssertionError("Unexpected extra generation")
        result = self.responses.pop(0)
        value = {"id": f"resp_inventory_fixture_{len(self.calls)}", "status": "completed", "output": [
            {"type": "message", "content": [{"type": "output_text", "text": json.dumps(result)}]}]}
        class Response:
            ok, status_code = True, 200
            def json(self):
                return value
        return Response()


class FixtureAI(ResponsesClient):
    def __init__(self, responses):
        self.session_fixture, self.tasks = ScriptedSession(responses), []
        super().__init__("fake-fixture-key", "fixture-model", MemoryStudio(), self.session_fixture)

    def structured(self, task, *args, **kwargs):
        self.tasks.append(task)
        return super().structured(task, *args, **kwargs)

    def prompt(self, index):
        return self.session_fixture.calls[index]["input"][0]["content"][0]["text"]


class InventoryRepairTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.doc = fitz.open()
        self.addCleanup(self.doc.close)
        self.add_pages(2)

    def add_pages(self, total):
        while len(self.doc) < total:
            self.doc.new_page(width=240, height=160).insert_text((15, 30), f"Synthetic question page {len(self.doc)}")

    @staticmethod
    def problem(identifier="practice-1", pages=(1,)):
        return {"id": identifier, "sectionId": "practice", "sectionTitle": "日日の演習", "number": "1",
                "title": "Synthetic addition", "pdfPages": list(pages), "printedPages": [str(page) for page in pages],
                "subquestions": [{"id": identifier + "-main", "label": "1", "conditions": ["3 + 4"], "goal": "Find the sum"}],
                "officialSolutionPages": [], "unresolvedIssues": []}

    @staticmethod
    def batch(problems, pages=(1, 2), previous=()):
        return {"problems": copy.deepcopy(problems), "solutionLinks": [], "coverage": [
            {"pdfPage": page, "questionIds": [problem["id"] for problem in [*previous, *problems] if page in problem["pdfPages"]],
             "noQuestionReason": "本文の問題はなく解答または説明だけ。" if not any(page in problem["pdfPages"] for problem in [*previous, *problems]) else ""}
            for page in pages], "unresolvedIssues": []}

    @staticmethod
    def review(pages=(1, 2), issues=()):
        return {"approved": not issues, "checkedPdfPages": list(pages), "issues": list(issues)}

    def inventory(self, ai):
        plan = {"kind": "practice", "pages": [
            {"printedPages": [str(page)], "labels": ["practice_questions"]} for page in range(1, len(self.doc) + 1)]}
        return lesson_pipeline.inventory_questions(self.doc, ai, plan, self.directory, "Fixture specification")

    def test_duplicate_candidate_is_repaired_and_cached_attempts_are_reused(self):
        correct = self.batch([self.problem()])
        duplicate = self.batch([self.problem(), self.problem()])
        ai = FixtureAI([duplicate, correct, self.review()])
        problems, _ = self.inventory(ai)
        self.assertEqual([problem["id"] for problem in problems], ["practice-1"])
        expected = ["inventory-practice-1-0", "inventory-practice-1-1", "inventory-review-practice-1-1"]
        self.assertEqual(ai.tasks, expected, "Invalid structure must be repaired before independent review")
        self.assertIn("前回の候補:", ai.prompt(1))
        self.assertIn("問題ID practice-1", ai.prompt(1))
        self.assertIn("重複", ai.prompt(1))
        repeated, _ = self.inventory(ai)
        self.assertEqual(repeated, problems)
        self.assertEqual(ai.tasks, expected * 2)
        self.assertEqual(len(ai.session_fixture.calls), 3, "Resume must reuse even the invalid cached first candidate")

    def test_page_outside_pdf_is_repaired_with_exact_bad_reference(self):
        correct = self.batch([self.problem()])
        invalid = copy.deepcopy(correct)
        invalid["problems"][0]["pdfPages"] = [1, 99]
        invalid["problems"][0]["officialSolutionPages"] = [100]
        ai = FixtureAI([invalid, correct, self.review()])
        result, _ = self.inventory(ai)
        self.assertEqual(result[0]["pdfPages"], [1])
        self.assertIn("pdfPages=[1, 99]", ai.prompt(1))
        self.assertIn("officialSolutionPages=[100]", ai.prompt(1))

    def test_coverage_omission_unknown_id_and_missing_no_question_reason_get_repaired(self):
        correct = self.batch([self.problem()])
        for kind in ("missing_page", "unknown_id", "missing_reason"):
            with self.subTest(kind=kind):
                invalid = copy.deepcopy(correct)
                if kind == "missing_page":
                    invalid["coverage"].pop()
                elif kind == "unknown_id":
                    invalid["coverage"][0]["questionIds"] = ["ghost-1"]
                else:
                    invalid["coverage"][1]["noQuestionReason"] = " \t　"
                ai = FixtureAI([invalid, correct, self.review()])
                result, _ = self.inventory(ai)
                self.assertEqual(len(result), 1)
                self.assertEqual(ai.tasks[-1], "inventory-review-practice-1-1")
                self.assertIn("inventory_coverage", ai.prompt(1))

    def test_neighbour_continuation_uses_existing_id_without_registering_problem_twice(self):
        self.add_pages(6)
        problem = self.problem(pages=(5, 6))
        first = self.batch([problem], range(1, 6))
        duplicate = self.batch([problem], [6])
        fixed = self.batch([], [6], previous=[problem])
        ai = FixtureAI([first, self.review(range(1, 6)), duplicate, fixed, self.review([6])])
        result, _ = self.inventory(ai)
        self.assertEqual(result, [problem])
        self.assertIn("inventory-practice-6-1", ai.tasks)
        self.assertNotIn("inventory-review-practice-6-0", ai.tasks)
        self.assertIn("今回problemsへ返すのは開始ページ", ai.prompt(3))
        self.assertIn("既に確定した問題", ai.prompt(4))
        self.assertIn('"pdfPages":[5,6]', ai.prompt(4))

    def test_subquestion_duplicate_is_fixed_before_accepting_inventory(self):
        correct = self.batch([self.problem()])
        invalid = copy.deepcopy(correct)
        invalid["problems"][0]["subquestions"] *= 2
        ai = FixtureAI([invalid, correct, self.review()])
        result, _ = self.inventory(ai)
        self.assertEqual(len(result[0]["subquestions"]), 1)
        self.assertIn("subquestions", ai.prompt(1))

    def test_real_unresolved_conditions_remain_blocking_and_private_after_two_repairs(self):
        reason = "PRIVATE: 原画像の三角形の辺長条件が矛盾しており確定できない。"
        invalid = self.batch([self.problem()])
        invalid["problems"][0]["unresolvedIssues"] = [reason]
        ai = FixtureAI([invalid, invalid, invalid])
        with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()) as err:
            with self.assertRaises(StudioError) as caught:
                self.inventory(ai)
        self.assertEqual(ai.tasks, [f"inventory-practice-1-{attempt}" for attempt in range(3)])
        self.assertEqual(caught.exception.code, "inventory_unresolved")
        self.assertTrue(caught.exception.attention)
        self.assertIn(reason, " ".join(caught.exception.details))
        self.assertNotIn(reason, caught.exception.public_message + str(caught.exception) + out.getvalue() + err.getvalue())
        for index in (1, 2):
            self.assertIn(reason, ai.prompt(index))
            self.assertIn("真の未解決事項を削除して通してはいけません", ai.prompt(index))
        with self.assertRaises(StudioError):
            self.inventory(ai)
        self.assertEqual(len(ai.session_fixture.calls), 3, "An interrupted/manual retry cannot reset the repair bound")

    def test_independent_audit_failure_includes_previous_candidate_and_precise_feedback(self):
        correct = self.batch([self.problem()])
        wrong = copy.deepcopy(correct)
        wrong["problems"][0]["subquestions"][0]["goal"] = "Wrong original goal"
        reason = "The candidate goal differs from the question image."
        ai = FixtureAI([wrong, self.review(issues=[reason]), correct, self.review()])
        result, _ = self.inventory(ai)
        self.assertEqual(result[0]["subquestions"][0]["goal"], "Find the sum")
        self.assertIn("Wrong original goal", ai.prompt(2))
        self.assertIn(reason, ai.prompt(2))
        self.assertIn("独立検証:", ai.prompt(2))

    def test_incomplete_independent_audit_is_repaired_even_when_marked_approved(self):
        correct = self.batch([self.problem()])
        ai = FixtureAI([correct, self.review([1]), correct, self.review()])
        self.inventory(ai)
        self.assertIn("独立検証checkedPdfPages=[1]", ai.prompt(2))
        self.assertEqual(ai.tasks[-1], "inventory-review-practice-1-1")

    def solution_images(self):
        return {page: lesson_pipeline.page_image(self.doc, page, self.directory) for page in (1, 2)}

    @staticmethod
    def solution_candidate():
        return {"links": [{"problemId": "practice-1", "pdfPages": [1], "evidence": "Same section, issue and condition"}],
                "unpairedPages": [{"pdfPage": 2, "reason": "Past-issue official answer; no problem text is present in this PDF"}],
                "checkedPdfPages": [1, 2], "unresolvedIssues": []}

    def solutions(self, problems, ai):
        return lesson_pipeline.reconcile_solution_pages(problems, [1, 2], self.solution_images(), ai, "practice", "Fixture specification")

    def test_solution_structure_repairs_unknown_id_outside_page_and_coverage_before_review(self):
        correct = self.solution_candidate()
        wrong = copy.deepcopy(correct)
        wrong["links"][0].update(problemId="ghost-1", pdfPages=[99])
        wrong["checkedPdfPages"] = [1]
        problems = [self.problem()]
        ai = FixtureAI([wrong, correct, self.review()])
        self.solutions(problems, ai)
        self.assertEqual(problems[0]["officialSolutionPages"], [1])
        self.assertEqual(ai.tasks, ["solutions-practice-0-0", "solutions-practice-0-1", "solutions-review-practice-0-1"])
        self.assertIn("ghost-1", ai.prompt(1))
        self.assertIn("99", ai.prompt(1))
        self.assertIn("前回の対応案:", ai.prompt(1))
        self.solutions(problems, ai)
        self.assertEqual(len(ai.session_fixture.calls), 3)

    def test_uncertain_solution_cannot_be_silently_marked_unpaired(self):
        reason = "PRIVATE: same-number answer has an unreadable issue date; correspondence is unknown."
        wrong = self.solution_candidate()
        wrong["unresolvedIssues"] = [reason]
        ai = FixtureAI([wrong, wrong, wrong])
        problems = [self.problem()]
        with redirect_stdout(io.StringIO()) as out, redirect_stderr(io.StringIO()) as err:
            with self.assertRaises(StudioError) as caught:
                self.solutions(problems, ai)
        self.assertEqual(caught.exception.code, "solution_unresolved")
        self.assertEqual(problems[0]["officialSolutionPages"], [])
        self.assertIn(reason, caught.exception.details)
        self.assertNotIn(reason, caught.exception.public_message + out.getvalue() + err.getvalue())
        self.assertEqual(len(ai.tasks), 3)
        self.assertTrue(all(not key.startswith("solutions-review") for key in ai.tasks))
        self.assertIn("unpairedPagesへ逃がしたり", ai.prompt(1))

    def test_solution_audit_rejection_rechecks_the_actual_previous_link(self):
        correct = self.solution_candidate()
        wrong = copy.deepcopy(correct)
        wrong["links"][0]["evidence"] = "Unreliable same printed number"
        reason = "Verify month and conditions, not only the number."
        ai = FixtureAI([wrong, self.review(issues=[reason]), correct, self.review()])
        problems = [self.problem()]
        self.solutions(problems, ai)
        self.assertIn("Unreliable same printed number", ai.prompt(2))
        self.assertIn(reason, ai.prompt(2))
        self.assertEqual(problems[0]["officialSolutionPages"], [1])

    def test_fresh_schema_error_enters_bounded_repair_for_both_candidate_types(self):
        for phase in ("inventory", "solutions"):
            with self.subTest(phase=phase):
                correct = self.batch([self.problem()]) if phase == "inventory" else self.solution_candidate()
                ai = FixtureAI([{"unexpected": "PRIVATE malformed provider content"}, correct, self.review()])
                if phase == "inventory":
                    result, _ = self.inventory(ai)
                    self.assertEqual(len(result), 1)
                else:
                    problems = [self.problem()]
                    self.solutions(problems, ai)
                    self.assertEqual(problems[0]["officialSolutionPages"], [1])
                self.assertIn("model_schema", ai.prompt(1))
                self.assertIn(":null", ai.prompt(1))
                self.assertNotIn("PRIVATE malformed provider content", ai.prompt(1))
                self.assertEqual(len(ai.tasks), 3)

    def test_invalid_cached_candidates_and_reviews_are_repaired_without_reposting_cached_requests(self):
        for phase in ("inventory", "solutions"):
            for role in ("candidate", "review"):
                with self.subTest(phase=phase, role=role):
                    correct = self.batch([self.problem()]) if phase == "inventory" else self.solution_candidate()
                    ai = FixtureAI([correct, self.review(), correct, self.review()])
                    def run():
                        if phase == "inventory":
                            return self.inventory(ai)
                        problems = [self.problem()]
                        self.solutions(problems, ai)
                        return problems
                    expected = run()
                    target = correct if role == "candidate" else self.review()
                    matches = [checkpoint for checkpoint in ai.studio.values.values() if checkpoint.get("result") == target]
                    self.assertEqual(len(matches), 1)
                    matches[0]["result"] = {"private": "PRIVATE malformed cached result"}
                    self.assertEqual(run(), expected)
                    self.assertEqual(len(ai.session_fixture.calls), 4)
                    self.assertIn("model_schema", ai.prompt(2))
                    self.assertNotIn("PRIVATE malformed cached result", ai.prompt(2))
                    if role == "candidate":
                        self.assertIn(":null", ai.prompt(2))
                    else:
                        self.assertIn('"problemId":"practice-1"' if phase == "solutions" else '"id":"practice-1"', ai.prompt(2))
                    self.assertEqual(run(), expected)
                    self.assertEqual(len(ai.session_fixture.calls), 4, "The poisoned cache must not repurchase the original request")

    def test_repeated_fresh_schema_failure_stops_after_three_candidates(self):
        for phase in ("inventory", "solutions"):
            with self.subTest(phase=phase):
                ai = FixtureAI([{"private": "PRIVATE invalid data"}] * 3)
                with self.assertRaises(StudioError) as caught:
                    if phase == "inventory":
                        self.inventory(ai)
                    else:
                        self.solutions([self.problem()], ai)
                self.assertEqual(caught.exception.code, "model_schema")
                self.assertTrue(caught.exception.attention)
                self.assertEqual(len(ai.tasks), 3)
                self.assertTrue(all("review" not in task for task in ai.tasks))
                self.assertNotIn("PRIVATE invalid data", json.dumps(caught.exception.details))

    def test_schema_failure_after_a_rejected_candidate_does_not_reuse_stale_content(self):
        correct = self.batch([self.problem()])
        wrong = copy.deepcopy(correct)
        wrong["problems"][0]["subquestions"][0]["goal"] = "Stale rejected goal"
        ai = FixtureAI([wrong, self.review(issues=["Correct the original goal."]), {}, correct, self.review()])
        result, _ = self.inventory(ai)
        self.assertEqual(result[0]["subquestions"][0]["goal"], "Find the sum")
        self.assertIn("Stale rejected goal", ai.prompt(2))
        self.assertIn("前回の候補:null", ai.prompt(3))
        self.assertIn("独立検証:null", ai.prompt(3))
        self.assertNotIn("Stale rejected goal", ai.prompt(3))

    def test_repeated_schema_failure_in_independent_review_cannot_approve_a_candidate(self):
        for phase in ("inventory", "solutions"):
            with self.subTest(phase=phase):
                correct = self.batch([self.problem()]) if phase == "inventory" else self.solution_candidate()
                ai = FixtureAI([correct, {}, correct, {}, correct, {}])
                with self.assertRaises(StudioError) as caught:
                    if phase == "inventory":
                        self.inventory(ai)
                    else:
                        problems = [self.problem()]
                        self.solutions(problems, ai)
                self.assertEqual(caught.exception.code, "model_schema")
                self.assertEqual(len(ai.tasks), 6)
                self.assertEqual(len([task for task in ai.tasks if "review" in task]), 3)
                if phase == "solutions":
                    self.assertEqual(problems[0]["officialSolutionPages"], [])

    def test_control_and_transient_errors_pass_through_all_four_request_sites(self):
        for phase in ("inventory", "solutions"):
            for role in ("candidate", "review"):
                for code in ("cancelled", "continue_later", "model_unavailable"):
                    with self.subTest(phase=phase, role=role, code=code):
                        correct = self.batch([self.problem()]) if phase == "inventory" else self.solution_candidate()
                        class FailingAI(FixtureAI):
                            def structured(inner, task, *args, **kwargs):
                                if ("review" in task) == (role == "review"):
                                    inner.tasks.append(task)
                                    raise StudioError(code, "Fixed failure")
                                return super().structured(task, *args, **kwargs)
                        ai = FailingAI([correct])
                        with self.assertRaises(StudioError) as caught:
                            if phase == "inventory":
                                self.inventory(ai)
                            else:
                                self.solutions([self.problem()], ai)
                        self.assertEqual(caught.exception.code, code)
                        self.assertEqual(len(ai.tasks), 2 if role == "review" else 1)

    def test_progress_logs_only_fixed_categories_and_counts_during_cloud_execution(self):
        correct = self.batch([self.problem()])
        wrong = copy.deepcopy(correct)
        wrong["problems"][0]["unresolvedIssues"] = ["PRIVATE sensitive condition and details"]
        ai = FixtureAI([wrong, correct, self.review()])
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true"}), redirect_stdout(io.StringIO()) as output:
            self.inventory(ai)
        self.assertNotIn("practice-1", output.getvalue())
        self.assertNotIn("PRIVATE", output.getvalue())
        records = [json.loads(line.removeprefix("monthly inventory: ")) for line in output.getvalue().splitlines()]
        self.assertEqual([record["status"] for record in records], ["requested", "repair_needed", "requested", "reviewing", "approved"])
        self.assertEqual(records[-1]["knownProblemCount"], 1)
        self.assertEqual(records[1]["errorCodes"], ["inventory_unresolved"])
        for record in records:
            self.assertEqual(set(record), {"kind", "phase", "firstPdfPage", "lastPdfPage", "attempt", "status", "knownProblemCount", "issueCount", "errorCodes"})
            self.assertEqual(record["kind"], "practice")
            self.assertEqual(record["phase"], "inventory")
            self.assertTrue(all(type(record[key]) is int for key in ("firstPdfPage", "lastPdfPage", "attempt", "knownProblemCount", "issueCount")))
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), redirect_stdout(io.StringIO()) as output:
            self.inventory(ai)
        self.assertEqual(output.getvalue(), "")

    @staticmethod
    def booklet_issue():
        return {"year": 2026, "month": 9, "evidence": ["表紙の2026年9月号", "奥付の同じ号表示"], "unresolvedIssues": []}

    def test_solution_repair_shares_verified_issue_and_next_page_with_independent_review(self):
        self.add_pages(6)
        images = {page: lesson_pipeline.page_image(self.doc, page, self.directory) for page in range(1, 7)}
        first_pages = list(range(1, 6))
        correct = {"links": [{"problemId": "practice-1", "pdfPages": first_pages, "evidence": "Same month, conditions and subquestions"}],
                   "unpairedPages": [], "checkedPdfPages": first_pages, "unresolvedIssues": []}
        pending = copy.deepcopy(correct)
        pending["unresolvedIssues"] = ["解説に09月と日付はあるが年がない。5ページの解説の末尾が次のページへ続いている。"]
        last = {"links": [{"problemId": "practice-1", "pdfPages": [6], "evidence": "Continuation of the same official answer"}],
                "unpairedPages": [], "checkedPdfPages": [6], "unresolvedIssues": []}
        ai = FixtureAI([pending, correct, self.review(first_pages), last, self.review([6])])
        problems = [self.problem()]
        lesson_pipeline.reconcile_solution_pages(problems, list(range(1, 7)), images, ai, "practice", "Fixture specification",
                                                 booklet_issue=self.booklet_issue())
        self.assertEqual(problems[0]["officialSolutionPages"], list(range(1, 7)), "The next page is linked by its own batch")
        self.assertNotIn("元冊子の表紙・奥付", ai.prompt(0), "The initial request must remain cache-compatible")
        self.assertEqual(len(ai.session_fixture.calls[0]["input"][0]["content"]), 6)
        for index in (1, 2):
            content = ai.session_fixture.calls[index]["input"][0]["content"]
            self.assertEqual([item["image_url"] for item in content[1:]],
                             [lesson_pipeline.image_data(images[page]) for page in range(1, 7)])
            self.assertIn('"year":2026,"month":9', content[0]["text"])
            self.assertIn("今回記録する対象PDFページ:[1, 2, 3, 4, 5]", content[0]["text"])
            self.assertIn("照合専用PDFページ:[6]", content[0]["text"])
            self.assertIn("検算は、対応する解答ページを全て集めた後", content[0]["text"])
        self.assertEqual(ai.tasks[-2:], ["solutions-practice-5-0", "solutions-review-practice-5-0"])
        lesson_pipeline.reconcile_solution_pages(problems, list(range(1, 7)), images, ai, "practice", "Fixture specification",
                                                 booklet_issue=self.booklet_issue())
        self.assertEqual(len(ai.session_fixture.calls), 5, "Issue/context repairs must also reuse their checkpoints")

    def test_solution_context_must_not_expand_checked_or_linked_target_pages(self):
        self.add_pages(3)
        images = {page: lesson_pipeline.page_image(self.doc, page, self.directory) for page in (1, 2, 3)}
        correct = self.solution_candidate()
        pending = copy.deepcopy(correct)
        pending["unresolvedIssues"] = ["Need the next page to inspect continuation."]
        wrong = copy.deepcopy(correct)
        wrong["checkedPdfPages"] = [1, 2, 3]
        wrong["links"][0]["pdfPages"] = [1, 3]
        ai = FixtureAI([pending, wrong, correct, self.review()])
        problems = [self.problem()]
        lesson_pipeline.reconcile_solution_pages(problems, [1, 2], images, ai, "practice", "Fixture specification",
                                                 booklet_issue=self.booklet_issue())
        self.assertEqual(problems[0]["officialSolutionPages"], [1])
        self.assertNotIn("solutions-review-practice-0-1", ai.tasks)
        self.assertEqual(ai.tasks[-1], "solutions-review-practice-0-2")
        self.assertIn("checkedPdfPagesは[1, 2]", ai.prompt(2))
        self.assertIn("今回のページ[1, 2]", ai.prompt(2))

    def test_verified_booklet_month_does_not_override_a_conflicting_past_issue_answer(self):
        correct_shape = self.solution_candidate()
        reason = "画像の公式解答は2026年7月の別条件。9月冊子でも当月practice-1には対応しない。"
        ai = FixtureAI([correct_shape, self.review(issues=[reason])] * 3)
        problems = [self.problem()]
        with self.assertRaises(StudioError) as caught:
            lesson_pipeline.reconcile_solution_pages(problems, [1, 2], self.solution_images(), ai, "practice", "Fixture specification",
                                                     booklet_issue=self.booklet_issue())
        self.assertEqual(caught.exception.code, "solution_unresolved")
        self.assertEqual(problems[0]["officialSolutionPages"], [])
        self.assertIn(reason, caught.exception.details)
        self.assertIn("冊子年月で上書きしません", ai.prompt(2))
        self.assertIn(reason, ai.prompt(2))

    def test_solution_context_is_bounded_and_missing_or_unverified_year_is_not_invented(self):
        pages, images = [10, 20, 30, 40, 50], {page: None for page in range(1, 61)}
        extra, context = lesson_pipeline.solution_repair_context(pages, images, 2, None)
        self.assertEqual(len(extra), 10)
        self.assertEqual(extra, sorted(set(extra)))
        self.assertTrue(set(extra).isdisjoint(pages))
        self.assertTrue({9, 11, 49, 51} <= set(extra))
        self.assertTrue(context.endswith(":null"))
        self.assertIn("冊子年月が提供されなければ年を推測しません", context)
        invalid = self.booklet_issue()
        invalid["unresolvedIssues"] = ["Publication year has not been established."]
        with self.assertRaises(StudioError) as caught:
            lesson_pipeline.solution_repair_context(pages, images, 1, invalid)
        self.assertEqual(caught.exception.code, "issue_unresolved")

    def test_inventory_forwards_confirmed_booklet_metadata_only_to_solution_matching(self):
        plan = {"kind": "practice", "bookletIssue": self.booklet_issue(), "pages": [
            {"printedPages": [str(page)], "labels": ["practice_questions"]} for page in (1, 2)]}
        ai = FixtureAI([self.batch([self.problem()]), self.review()])
        with patch.object(lesson_pipeline, "reconcile_solution_pages") as reconcile:
            lesson_pipeline.inventory_questions(self.doc, ai, plan, self.directory, "Fixture specification")
        self.assertEqual(reconcile.call_args.kwargs, {"booklet_issue": self.booklet_issue()})
        self.assertNotIn("bookletIssue", ai.prompt(0))
        self.assertNotIn('"year":2026', ai.prompt(0))

    def advanced_plan(self):
        return {"kind": "advanced", "bookletIssue": self.booklet_issue(), "pages": [
            {"printedPages": [str(page + 39)], "labels": ["advanced_questions" if page < 5 else "advanced_solutions"]}
            for page in range(1, len(self.doc) + 1)]}

    def test_inventory_repair_distinguishes_complete_questions_from_later_official_answer_continuation(self):
        self.add_pages(8)
        problems = [self.problem(f"advanced-{n}", [n]) for n in range(1, 5)]
        problems[2]["pdfPages"] = [3, 4]
        problems[3]["officialSolutionPages"] = [7, 8]
        correct = self.batch(problems, range(1, 6))
        pending = copy.deepcopy(correct)
        pending["problems"][3]["unresolvedIssues"] = ["本文条件と設問はPDF4で読めるが、公式解説はPDF7下端から未提示のPDF8へ続く。"]
        pending["unresolvedIssues"] = ["advanced-3の全選択肢はPDF3で完結し、PDF4冒頭の解答欄と難易度は同じ問題の付属情報。新規問題はadvanced-4だけ。"]
        last = self.batch([], [6, 7, 8], previous=problems)
        ai = FixtureAI([pending, correct, self.review(range(1, 6)), last, self.review([6, 7, 8])])
        with patch.object(lesson_pipeline, "reconcile_solution_pages") as reconcile:
            result, images = lesson_pipeline.inventory_questions(self.doc, ai, self.advanced_plan(), self.directory, "Fixture specification")
        self.assertEqual(result, problems, "A complete question or its subquestions must not be discarded")
        self.assertEqual(reconcile.call_args.args[1], [5, 6, 7, 8], "Full official answers still undergo their later matching stage")
        self.assertEqual(len(ai.session_fixture.calls[0]["input"][0]["content"]), 8)
        self.assertNotIn("inventory-review-advanced-1-0", ai.tasks)
        for index in (1, 2):
            content = ai.session_fixture.calls[index]["input"][0]["content"]
            self.assertEqual([item["image_url"] for item in content[1:]], [lesson_pipeline.image_data(images[n]) for n in range(1, 9)])
            self.assertIn(lesson_pipeline.INVENTORY_SCOPE, content[0]["text"])
            self.assertIn("補助PDFページ[8]", content[0]["text"])
            self.assertIn("対象PDFページ:[1, 2, 3, 4, 5]", content[0]["text"])
            self.assertIn('"year":2026,"month":9', content[0]["text"])
        self.assertIn(pending["unresolvedIssues"][0], ai.prompt(1), "The model must reassess the actual previous note")
        with patch.object(lesson_pipeline, "reconcile_solution_pages"):
            repeated, _ = lesson_pipeline.inventory_questions(self.doc, ai, self.advanced_plan(), self.directory, "Fixture specification")
        self.assertEqual(repeated, problems)
        self.assertEqual(len(ai.session_fixture.calls), 5)

    def test_expanded_inventory_images_can_supply_actual_question_continuation_but_not_new_start_pages(self):
        self.add_pages(8)
        problem = self.problem(pages=(5, 6, 7, 8))
        batch = self.batch([problem], range(1, 6))
        last = self.batch([], [6, 7, 8], previous=[problem])
        ai = FixtureAI([batch, batch, self.review(range(1, 6)), last, self.review([6, 7, 8])])
        result, _ = self.inventory(ai)
        self.assertEqual(result[0]["pdfPages"], [5, 6, 7, 8])
        self.assertNotIn("inventory-review-practice-1-0", ai.tasks)
        self.assertIn("inventory-review-practice-1-1", ai.tasks)
        outside_start = self.batch([self.problem(pages=(8,))], range(1, 6))
        issues = lesson_pipeline.inventory_issues(outside_start, list(range(1, 6)), list(range(1, 9)), [], range(1, 9))
        self.assertTrue(any(issue["code"] == "inventory_duplicate" for issue in issues), "Expanded context does not expand the registration target")

    def test_real_question_uncertainty_remains_blocking_after_both_context_expansions(self):
        self.add_pages(10)
        problem = self.problem("advanced-4", [4])
        reason = "問題本文の図の角度条件が不鮮明で、選択肢の区別を確定できない。"
        problem["unresolvedIssues"] = [reason]
        pending = self.batch([problem], range(1, 6))
        ai = FixtureAI([pending, pending, pending])
        with patch.object(lesson_pipeline, "reconcile_solution_pages") as reconcile:
            with self.assertRaises(StudioError) as caught:
                lesson_pipeline.inventory_questions(self.doc, ai, self.advanced_plan(), self.directory, "Fixture specification")
        reconcile.assert_not_called()
        self.assertEqual(caught.exception.code, "inventory_unresolved")
        self.assertIn(reason, " ".join(caught.exception.details))
        self.assertEqual([len(call["input"][0]["content"]) - 1 for call in ai.session_fixture.calls], [7, 8, 9])
        self.assertTrue(all("review" not in task for task in ai.tasks))
        for index in (1, 2):
            self.assertIn(reason, ai.prompt(index))
            self.assertIn("未解決事項を機械的に削除するのではなく", ai.prompt(index))

    def test_inventory_repair_keeps_explicit_past_issue_conflicts_blocking(self):
        wrong = self.batch([self.problem("contest-2026-09-1")])
        reason = "原画像は7月学コン問題の再掲なのに、候補IDが9月の当月問題になっている。"
        ai = FixtureAI([wrong, self.review(issues=[reason])] * 3)
        plan = self.advanced_plan()
        with patch.object(lesson_pipeline, "reconcile_solution_pages") as reconcile:
            with self.assertRaises(StudioError) as caught:
                lesson_pipeline.inventory_questions(self.doc, ai, plan, self.directory, "Fixture specification")
        reconcile.assert_not_called()
        self.assertEqual(caught.exception.code, "inventory_unresolved")
        self.assertIn(reason, caught.exception.details)
        for index in (2, 3, 4, 5):
            self.assertIn("別年月・過去号・別欄は冊子年月で上書きせず", ai.prompt(index))
            self.assertIn('"year":2026,"month":9', ai.prompt(index))


if __name__ == "__main__":
    unittest.main()
