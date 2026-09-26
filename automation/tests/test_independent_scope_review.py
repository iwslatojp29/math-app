"""Late independent scope findings get evidence, never silent approval or data edits."""
import copy
import json
import unittest
from unittest.mock import Mock

import test_lesson_inventory_scope as scope_fixtures
import test_lesson_label_repair as label_fixtures
import test_lesson_reference_repair as reference_fixtures
from test_issue_repair import MemoryStudio, RecordingAI
import lesson_pipeline
from studio_common import StudioError


class IndependentScopeReviewTests(unittest.TestCase):
    def setUp(self):
        self.base = scope_fixtures.SolutionOnlyScopeTests()
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.fixture, self.target = self.base.fixture, self.base.target
        self.findings = ["PDF全体の対象一覧と収録状況が未確認。前問の解説続きも元画像で照合する必要がある。"]
        self.mode, self.audit_mode, self.initial_mode = "ordinary", "approve", "scope"
        self.requests, self.responses = [], []
        self.repair_case = None
        self.fixture.structured = self.structured

    def configure(self, mode):
        self.mode = mode
        self.requests, self.responses = [], []
        self.repair_case = None
        if mode == "ordinary":
            return
        self.repair_case = (label_fixtures.LessonLabelRepairTests() if mode == "label"
                            else reference_fixtures.LessonReferenceRepairTests())
        self.repair_case.setUp()
        self.addCleanup(self.repair_case.doCleanups)
        for problem in (self.repair_case.original, self.repair_case.broken):
            problem["sourceImageIds"] = ["source-3", "source-4"]

    def review(self, approved=True, issues=()):
        original = self.fixture.fixture["problems"][0]
        return {"approved": approved, "issues": list(issues),
            "checkedSubquestionIds": [item["id"] for item in original["subquestions"]],
            **{field: original["verification"][field] for field in
               ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")}}

    def structured(self, key, prompt, schema, images=(), max_tokens=None):
        self.requests.append([key, prompt, copy.deepcopy(schema), list(images), max_tokens])
        scoped = key.startswith("lesson-review-inventory-context-")
        target = "-" + self.target + "-" in key or key.endswith("-" + self.target)
        if scoped:
            value = self.review()
            if self.audit_mode == "math":
                value.update(approved=False, issues=["原画像から計算すると対象の面積式が誤っています。"])
            elif self.audit_mode == "scope":
                value.update(approved=False, issues=list(self.findings))
            elif self.audit_mode == "coverage":
                value["checkedSubquestionIds"] = []
            elif self.audit_mode == "blank":
                value["officialAnswerCheck"] = " "
            elif self.audit_mode == "schema":
                value.pop("reasoningCheck")
        else:
            if target and self.repair_case is not None:
                value = self.repair_case.structured(key, prompt, schema, images, max_tokens=max_tokens)
            else:
                value = self.base.base.original_structured(key, prompt, schema, images, max_tokens=max_tokens)
            reviewing = key.startswith("lesson-review-")
            final_review = (self.mode == "ordinary" or
                            self.mode == "label" and key.startswith("lesson-review-label-repair-") or
                            self.mode == "reference" and key.startswith("lesson-review-reference-repair-"))
            if target and reviewing and final_review:
                value.update(approved=False, issues=list(self.findings))
                if self.initial_mode == "math":
                    value["issues"] = ["原画像の面積計算と一致しません。"]
                elif self.initial_mode == "mixed":
                    value["issues"].append("対象問題の式が誤っています。")
                elif self.initial_mode == "mixed-sentence":
                    value["issues"][0] += "対象問題の面積式が誤っています。"
                elif self.initial_mode == "coverage":
                    value["checkedSubquestionIds"] = []
                elif self.initial_mode == "blank":
                    value["reasoningCheck"] = " "
        self.responses.append(copy.deepcopy(value))
        return value

    def generate(self, client=None, studio=None):
        if client is None:
            return self.fixture.generate()
        fixture = self.fixture
        return lesson_pipeline.generate_lesson(fixture.pdf, Mock(structured=client.structured), studio, fixture.plan,
            fixture.directory, "Retain all questions and mathematical conditions.", "2026年9月号",
            fixture.root / "lesson.schema.json", generation_context=fixture.context)

    def scoped(self):
        return [request for request in self.requests if request[0].startswith("lesson-review-inventory-context-")]

    def blocked(self):
        with self.assertRaises(StudioError) as caught:
            self.generate()
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        return caught.exception

    def assert_unchanged_candidate_and_evidence(self, lesson):
        requests = self.scoped()
        self.assertEqual(len(requests), 1)
        request = requests[0]
        metadata = json.loads(request[1].rsplit("管理情報:", 1)[1])
        self.assertEqual(metadata["previousScopeFindings"], self.findings)
        self.assertEqual(metadata["previousIndependentReview"]["issues"], self.findings)
        self.assertFalse(metadata["previousIndependentReview"]["approved"])
        self.assertEqual(metadata["primaryImagePages"], [3, 4])
        self.assertEqual(metadata["currentImagePages"], [3, 4, 2])
        self.assertEqual(request[3], [lesson_pipeline.image_data(self.fixture.images[page]) for page in [3, 4, 2]])
        self.assertEqual(metadata["observedSolutionLinks"], self.base.management["solutionPageRecords"][0]["links"][:2])
        original = json.JSONDecoder().raw_decode(request[1].split("。変更していない候補:", 1)[1])[0]
        result = lesson["problems"][0]
        self.assertEqual({key: value for key, value in result.items() if key != "verification"},
                         {key: value for key, value in original.items() if key != "verification"})
        self.assertEqual(result["sourceImageIds"], ["source-3", "source-4"])
        self.assertEqual(lesson["problems"][1], self.fixture.fixture["problems"][1])
        self.assertIn("候補は一切修正されていない", request[1])
        self.assertIn("再帰的に拡張しない", request[1])

    def test_final_normal_independent_review_gets_inventory_evidence_after_four_unchanged_candidates(self):
        lesson, _ = self.generate()
        self.assert_unchanged_candidate_and_evidence(lesson)
        old = [item for item in self.requests if "-" + self.target + "-" in item[0] and item not in self.scoped()]
        self.assertEqual(len(old), 8)
        self.assertTrue(all(item[3] == [lesson_pipeline.image_data(self.fixture.images[page]) for page in [3, 4]] for item in old))
        self.assertTrue(self.scoped()[0][0].endswith("-candidate-0"))

    def test_label_and_reference_final_audits_are_rechecked_without_replacing_the_repaired_candidate(self):
        for mode, old_count in (("label", 13), ("reference", 8)):
            with self.subTest(mode=mode):
                self.configure(mode)
                lesson, _ = self.generate()
                self.assert_unchanged_candidate_and_evidence(lesson)
                old = [item for item in self.requests if ("-" + self.target + "-" in item[0] or item[0].endswith("-" + self.target))
                       and item not in self.scoped()]
                self.assertEqual(len(old), old_count)
                self.assertIn(mode + "-repair", self.scoped()[0][0])
                if mode == "label":
                    self.assertEqual(lesson["problems"][0]["diagram"], self.repair_case.original["diagram"])
                else:
                    self.assertIn("p3-labelB", [item["id"] for item in lesson["problems"][0]["diagram"]["primitives"]])

    def test_math_findings_or_incomplete_original_review_do_not_enter_scope_recheck(self):
        for mode in ("math", "mixed", "coverage", "blank"):
            with self.subTest(mode=mode):
                self.initial_mode = mode
                self.requests.clear()
                self.blocked()
                self.assertEqual(self.scoped(), [])

    def test_recheck_denial_or_invalid_review_never_approves_and_only_scope_can_use_second_attempt(self):
        for mode, count in (("math", 1), ("coverage", 1), ("blank", 1), ("schema", 1), ("scope", 2)):
            with self.subTest(mode=mode):
                self.audit_mode = mode
                self.requests.clear()
                error = self.blocked()
                self.assertEqual(len(self.scoped()), count)
                self.assertIn(self.findings[0], " ".join(error.details))
                if mode == "math":
                    self.assertIn("面積式が誤っています", " ".join(error.details))
                if mode == "scope":
                    self.assertIn("追加証拠を提示した前回の独立検証", self.scoped()[1][1])

    def test_mixed_same_issue_is_retained_and_math_denial_does_not_revert_to_older_candidate(self):
        self.initial_mode = "mixed-sentence"
        self.audit_mode = "math"
        for mode in ("ordinary", "label", "reference"):
            with self.subTest(mode=mode):
                self.configure(mode)
                error = self.blocked()
                self.assertEqual(len(self.scoped()), 1)
                self.assertIn("対象問題の面積式が誤っています", self.scoped()[0][1])
                self.assertIn("原画像から計算すると対象の面積式が誤っています", " ".join(error.details))

    def test_missing_context_source_image_stops_before_purchasing_recheck(self):
        del self.fixture.images[2]
        with self.assertRaises(StudioError) as caught:
            self.generate()
        self.assertEqual(caught.exception.code, "lesson_source_images")
        self.assertEqual(self.scoped(), [])

    def test_old_requests_in_every_path_reuse_cache_then_one_new_review_and_zero_on_next_resume(self):
        for mode in ("ordinary", "label", "reference"):
            with self.subTest(mode=mode):
                self.configure(mode)
                expected, _ = self.generate()
                pairs = list(zip(copy.deepcopy(self.requests), copy.deepcopy(self.responses)))
                old = [(request, value) for request, value in pairs if not request[0].startswith("lesson-review-inventory-context-")]
                new = [value for request, value in pairs if request[0].startswith("lesson-review-inventory-context-")]
                studio = MemoryStudio()
                seed = RecordingAI(studio, [value for _, value in old])
                for (key, prompt, schema, images, budget), _ in old:
                    seed.structured(key, prompt, schema, images, max_tokens=budget)
                before = copy.deepcopy(studio.values)
                resumed = RecordingAI(studio, new)
                self.assertEqual(self.generate(resumed, studio)[0], expected)
                self.assertEqual(len(resumed.scripted_session.calls), 1)
                self.assertEqual({key: studio.values[key] for key in before}, before)
                again = RecordingAI(studio, [])
                self.assertEqual(self.generate(again, studio)[0], expected)
                self.assertEqual(again.scripted_session.calls, [])


if __name__ == "__main__":
    unittest.main()
