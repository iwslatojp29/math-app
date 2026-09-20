"""Malformed model candidates repair within a bounded budget, never bypass review."""
import copy
import hashlib
import unittest
from unittest.mock import patch

import test_lesson_visual_regeneration as fixtures
import lesson_pipeline
from studio_common import StudioError, json_bytes


class GenerationRepairTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LessonVisualRegenerationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.inventory = self.fixture.inventory[:1]
        self.requests = []

    def run_candidates(self, mutate):
        fixture = self.fixture
        original = fixture.structured
        counts = {"candidate": 0, "review": 0}

        def structured(key, *args, **kwargs):
            self.requests.append([key, args[0], args[1], list(args[2]), kwargs["max_tokens"]])
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

    def test_repeated_missing_reference_exhausts_four_attempts_without_math_review(self):
        def mutate(kind, count, value):
            if kind == "candidate":
                value["steps"][0]["cues"][0]["state"]["highlightIds"] = ["missing-point"]
        with self.assertRaises(StudioError) as caught:
            self.run_candidates(mutate)
        self.assertEqual(self.counts, {"candidate": 4, "review": 0})
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
        self.assertEqual(self.counts, {"candidate": 4, "review": 0})
        self.assertIn("対応する辺", " ".join(caught.exception.details))

    def test_exhausted_math_review_preserves_redacted_actionable_details(self):
        def mutate(kind, count, value):
            if kind == "review":
                value["approved"] = False
                value["issues"] = ["点Aの対応が一致しません sk-testsecret123", " " ]
        with self.assertRaises(StudioError) as caught:
            self.run_candidates(mutate)
        self.assertEqual(self.counts, {"candidate": 4, "review": 4})
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        self.assertIn("点Aの対応", caught.exception.details[0])
        self.assertNotIn("sk-testsecret123", str(caught.exception.details))
        self.assertIn("[redacted]", caught.exception.details[0])

    def test_third_candidate_repairs_cues_without_changing_first_two_cached_requests(self):
        issue = "points-5-cue-readに複数の視覚的論点が混在しています。cueを分割し、参照と発話数を合わせてください。"

        def mutate(kind, count, value):
            if kind == "review" and count <= 2:
                value["approved"] = False
                value["issues"] = [issue]
            elif kind == "candidate" and count == 3:
                cue = copy.deepcopy(value["steps"][0]["cues"][0])
                cue["id"] += "-split"
                cue["displayText"] = "確認した条件に対応する図の部分を見ます。"
                cue["speechText"] = "かくにんした じょうけんに たいおうする ずの ぶぶんを みます。"
                cue["state"]["highlightIds"] = cue["state"]["highlightIds"][:1]
                value["steps"][0]["cues"].insert(1, cue)
                value["subquestions"][-1]["prerequisiteCueIds"].append(cue["id"])
                count = sum(len(step["cues"]) for step in value["steps"])
                value["verification"]["readingsCheck"] = f"実際の{count}発話とかな読みを照合。"

        (lesson, _), counts = self.run_candidates(mutate)
        self.assertEqual(counts, {"candidate": 3, "review": 3})
        # Frozen from the serial-compatible 2ee54a6 implementation, including
        # task key, full prompt, JSON schema, image order/content and budget.
        expected = [
            "3e6861205ca8a5b84a8e9f08781dedcea7b3beb245a70fb6dd9e747f6accd469",
            "9e18395922303c5aa7377f79a8c706d24c9f774ccb34ed7a8825a2d75ee0c9a8",
            "bffbb0e9bfe59b172ddfe15edd031f6108cd255144bad34ae5646897186b075c",
            "da156a0a26d77e1076e693e6de5f4a37c2f762b812573d18a51fd57b3d6060d4",
        ]
        self.assertEqual([hashlib.sha256(json_bytes(request)).hexdigest() for request in self.requests[:4]], expected)
        prompt = self.requests[4][1]
        self.assertIn("追加修復", prompt)
        self.assertIn(issue, prompt)
        for required in ("highlightIds", "entryCueId", "prerequisiteCueIds", "sceneCueId", "数え直して"):
            self.assertIn(required, prompt)
        repaired = lesson["problems"][0]
        cue_ids = {cue["id"] for step in repaired["steps"] for cue in step["cues"]}
        self.assertTrue(any(identifier.endswith("-split") for identifier in cue_ids))
        self.assertTrue(set(repaired["subquestions"][-1]["prerequisiteCueIds"]) <= cue_ids)
        self.assertIn('-split', self.requests[5][1], "The independent reviewer must receive the repaired candidate")
        self.assertEqual(repaired["verification"]["status"], "verified")

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
