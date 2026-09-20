"""Malformed model candidates repair within a bounded budget, never bypass review."""
import unittest
from unittest.mock import patch

import test_lesson_visual_regeneration as fixtures
import lesson_pipeline
from studio_common import StudioError


class GenerationRepairTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LessonVisualRegenerationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.inventory = self.fixture.inventory[:1]

    def run_candidates(self, mutate):
        fixture = self.fixture
        original = fixture.structured
        counts = {"candidate": 0, "review": 0}

        def structured(key, *args, **kwargs):
            value = original(key, *args, **kwargs)
            kind = "review" if key.startswith("lesson-review-") else "candidate"
            counts[kind] += 1
            mutate(kind, counts[kind], value)
            return value

        fixture.structured = structured
        with patch.object(lesson_pipeline, "inventory_questions", return_value=(fixture.inventory, fixture.images)):
            try:
                return fixture.generate(), counts
            finally:
                self.counts = counts

    def test_missing_subquestions_use_second_attempt_with_exact_coverage_feedback(self):
        def mutate(kind, count, value):
            if kind == "candidate" and count == 1:
                value["subquestions"] = []
        (lesson, _), counts = self.run_candidates(mutate)
        self.assertEqual(counts, {"candidate": 2, "review": 1})
        self.assertEqual([item["id"] for item in lesson["problems"][0]["subquestions"]],
                         [item["id"] for item in self.fixture.inventory[0]["subquestions"]])
        self.assertIn("必須小問ID", self.fixture.calls[1][1])
        self.assertIn('"subquestions":[]', self.fixture.calls[1][1])
        self.assertTrue(self.fixture.calls[0][0].endswith("-0"))
        self.assertTrue(self.fixture.calls[1][0].endswith("-1"))
        self.assertNotIn("前回候補", self.fixture.calls[0][1])

    def test_schema_failure_repairs_before_independent_review(self):
        def mutate(kind, count, value):
            if kind == "candidate" and count == 1:
                del value["title"]
        _, counts = self.run_candidates(mutate)
        self.assertEqual(counts, {"candidate": 2, "review": 1})
        self.assertIn("required=title", self.fixture.calls[1][1])

    def test_repeated_missing_reference_exhausts_two_attempts_without_math_review(self):
        def mutate(kind, count, value):
            if kind == "candidate":
                value["steps"][0]["cues"][0]["state"]["highlightIds"] = ["missing-point"]
        with self.assertRaises(StudioError) as caught:
            self.run_candidates(mutate)
        self.assertEqual(self.counts, {"candidate": 2, "review": 0})
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        self.assertIn("missing reference missing-point", " ".join(caught.exception.details))
        self.assertIn(self.fixture.inventory[0]["id"], caught.exception.details[0])

    def test_candidate_unresolved_status_is_repaired_not_overwritten(self):
        def mutate(kind, count, value):
            if kind == "candidate" and count == 1:
                value["verification"]["status"] = "needs_review"
                value["verification"]["unresolvedIssues"] = ["面積の条件を確認する必要があります。"]
        (lesson, _), counts = self.run_candidates(mutate)
        self.assertEqual(counts, {"candidate": 2, "review": 1})
        self.assertIn("面積の条件", self.fixture.calls[1][1])
        self.assertEqual(lesson["problems"][0]["verification"]["status"], "verified")

    def test_blank_independent_reasoning_requires_repair_and_second_review(self):
        def mutate(kind, count, value):
            if kind == "review" and count == 1:
                value["reasoningCheck"] = "   "
        _, counts = self.run_candidates(mutate)
        self.assertEqual(counts, {"candidate": 2, "review": 2})
        self.assertIn("修正対象の前回候補", self.fixture.calls[2][1])

    def test_model_schema_failure_retries_without_stale_candidate(self):
        def mutate(kind, count, value):
            if kind == "candidate" and count == 1:
                raise StudioError("model_schema", "構造エラー", True)
        _, counts = self.run_candidates(mutate)
        self.assertEqual(counts, {"candidate": 2, "review": 1})
        self.assertNotIn("修正対象の前回候補", self.fixture.calls[1][1])

    def test_repeated_candidate_unresolved_never_reaches_positive_reviewer(self):
        def mutate(kind, count, value):
            if kind == "candidate":
                value["verification"]["status"] = "needs_review"
                value["verification"]["unresolvedIssues"] = ["対応する辺を確認できません。"]
        with self.assertRaises(StudioError) as caught:
            self.run_candidates(mutate)
        self.assertEqual(self.counts, {"candidate": 2, "review": 0})
        self.assertIn("対応する辺", " ".join(caught.exception.details))

    def test_exhausted_math_review_preserves_redacted_actionable_details(self):
        def mutate(kind, count, value):
            if kind == "review":
                value["approved"] = False
                value["issues"] = ["点Aの対応が一致しません sk-testsecret123", " " ]
        with self.assertRaises(StudioError) as caught:
            self.run_candidates(mutate)
        self.assertEqual(self.counts, {"candidate": 2, "review": 2})
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        self.assertIn("点Aの対応", caught.exception.details[0])
        self.assertNotIn("sk-testsecret123", str(caught.exception.details))
        self.assertIn("[redacted]", caught.exception.details[0])

    def test_real_renderer_error_is_actionable_without_stack_or_path(self):
        lesson = self.fixture.fixture
        lesson["sourceImages"][0]["id"] = "source-1"
        lesson["problems"][0]["steps"][0]["cues"][0]["state"]["highlightIds"] = ["missing-point"]
        with self.assertRaises(StudioError) as caught:
            lesson_pipeline.render_lesson(lesson, {}, self.fixture.directory, self.fixture.root)
        self.assertEqual(caught.exception.code, "renderer_validation")
        self.assertIn("missing reference missing-point", " ".join(caught.exception.details))
        self.assertNotIn(str(self.fixture.directory), str(caught.exception.details))
        self.assertNotIn(" at ", str(caught.exception.details))


if __name__ == "__main__":
    unittest.main()
