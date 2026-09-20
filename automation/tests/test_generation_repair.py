"""Malformed model candidates repair within a bounded budget, never bypass review."""
import copy
import hashlib
import unittest
from unittest.mock import patch

import test_lesson_visual_regeneration as fixtures
import lesson_pipeline
from studio_common import StudioError, json_bytes


RUNTIME_LIMITATIONS = [
    "ブラウザ実行環境がないため、実描画、画面幅別のラベル重なり、操作、途中移動時の状態復元は実機能として未検証。座標と完全状態の文字上の照合のみ実施した。",
    "音声再生環境がないため、実音声の試聴、速度変更、終了イベントと図の同期は未検証。speechTextと表示文の意味・読みの文字点検は実施した。",
]


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

    def test_repeated_missing_reference_exhausts_scoped_repair_without_math_review(self):
        def mutate(kind, count, value):
            if kind == "candidate":
                value["steps"][0]["cues"][0]["state"]["highlightIds"] = ["missing-point"]
        with self.assertRaises(StudioError) as caught:
            self.run_candidates(mutate)
        self.assertEqual(self.counts, {"candidate": 4, "review": 0})
        self.assertEqual(len(self.requests), 6)
        self.assertTrue(all(request[0].startswith("lesson-reference-repair-") for request in self.requests[-2:]))
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
        # All four generation AND review bodies frozen before scope recovery:
        # keys, prompts, schemas, images/content/order and output budgets.
        self.assertEqual([hashlib.sha256(json_bytes(request)).hexdigest() for request in self.requests], [
            "3e6861205ca8a5b84a8e9f08781dedcea7b3beb245a70fb6dd9e747f6accd469",
            "9e18395922303c5aa7377f79a8c706d24c9f774ccb34ed7a8825a2d75ee0c9a8",
            "8d5d13428ab98c8f8ad24fefb65cdd31cf8d1d6bb1d6c44d29fead50069d8b96",
            "da156a0a26d77e1076e693e6de5f4a37c2f762b812573d18a51fd57b3d6060d4",
            "a2c270ba1fba9c8cb13f451aeb391c66de29138e95acaa74ce1b316cb833bdbf",
            "a23efd9a466ee1c5b5d9b2dbacdab6c4ab32a65df878073a6b5b0bf6be5152e5",
            "ffeb1e8f34ee8567b9bba2fdf8bffc6114ab221b9051b86a392f3cc39837fc5b",
            "3ce8c8dff2b748c19ddf833d9f1a7167e864580bb8d249217f5edca66c12ed95",
        ])

    def test_late_runtime_scope_recovery_preserves_first_four_requests_and_requires_review(self):
        def mutate(kind, count, value):
            if kind == "candidate" and count <= 4:
                value["verification"]["status"] = "needs_review"
                value["verification"]["unresolvedIssues"] = list(RUNTIME_LIMITATIONS)

        (lesson, _), counts = self.run_candidates(mutate)
        self.assertEqual(counts, {"candidate": 5, "review": 1})
        self.assertEqual([hashlib.sha256(json_bytes(request)).hexdigest() for request in self.requests[:4]], [
            "3e6861205ca8a5b84a8e9f08781dedcea7b3beb245a70fb6dd9e747f6accd469",
            "d530a7e0438be3f396501063e33d88687e0ae98e365e2d400922adb822114faf",
            "26241ed035eb596ebd5f815cbd8bfb4e4b809b76ec5c9ceb60f9f6e58963c703",
            "026367be91ffffecbacb9c0a13a17a680d2eb1f2abbc31911776c821dd738505",
        ])
        self.assertTrue(self.requests[4][0].endswith("-4"))
        self.assertIn("修正対象の前回候補", self.requests[4][1])
        for issue in RUNTIME_LIMITATIONS:
            self.assertIn(issue, self.requests[4][1])
        for request in self.requests[4:]:
            for scope in ("【検証段階の範囲】", "模擬音声終了イベント", "代表cue", "実施済みとは書かない",
                          "原画像が読めない", "候補はneeds_review", "独立検証はapproved=false"):
                self.assertIn(scope, request[1])
        self.assertTrue(self.requests[5][0].startswith("lesson-review-"))
        repaired = lesson["problems"][0]
        for field in ("givens", "goal", "subquestions", "steps", "diagram"):
            self.assertEqual(repaired[field], self.fixture.fixture["problems"][0][field])
        self.assertEqual(repaired["verification"]["status"], "verified")

    def test_scope_recovery_exhausts_two_extra_candidates_without_clearing_runtime_findings(self):
        def mutate(kind, count, value):
            if kind == "candidate":
                value["verification"]["status"] = "needs_review"
                value["verification"]["unresolvedIssues"] = list(RUNTIME_LIMITATIONS)
        with self.assertRaises(StudioError) as caught:
            self.run_candidates(mutate)
        self.assertEqual(self.counts, {"candidate": 6, "review": 0})
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        for issue in RUNTIME_LIMITATIONS:
            self.assertIn(issue, " ".join(caught.exception.details))

    def test_scope_recovery_does_not_override_later_mathematical_uncertainty(self):
        def mutate(kind, count, value):
            if kind == "candidate" and count <= 4:
                value["verification"]["status"] = "needs_review"
                value["verification"]["unresolvedIssues"] = list(RUNTIME_LIMITATIONS)
            elif kind == "review":
                value["approved"] = False
                value["issues"] = ["原画像の長さが読めず、対応する辺と面積を確定できません。"]
        with self.assertRaises(StudioError) as caught:
            self.run_candidates(mutate)
        self.assertEqual(self.counts, {"candidate": 6, "review": 2})
        self.assertIn("原画像の長さが読めず", " ".join(caught.exception.details))
        self.assertIn("修正対象の前回候補", self.requests[6][1])

    def test_concrete_browser_defect_does_not_trigger_scope_recovery(self):
        def mutate(kind, count, value):
            if kind == "candidate":
                value["verification"]["status"] = "needs_review"
                value["verification"]["unresolvedIssues"] = ["ブラウザで図の点Aが欠ける座標になっています。"]
        with self.assertRaises(StudioError):
            self.run_candidates(mutate)
        self.assertEqual(self.counts, {"candidate": 4, "review": 0})

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
