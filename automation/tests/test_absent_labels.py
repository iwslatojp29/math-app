"""Explicit zero-label findings use actual primitive data, not reviewer type names."""
import copy
import unittest

import test_collective_labels as fixtures
from test_issue_repair import MemoryStudio, RecordingAI
import lesson_pipeline


class AbsentLabelTests(unittest.TestCase):
    def setUp(self):
        self.case = fixtures.CollectiveLabelTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.case.issue = (
            "diagram.primitivesにkind='label'が一つもない。number-1、number-2、number-3、"
            "number-4〜10などはすべて線で、余り・数列・個数の表が表示されない。"
            "必要な文字は非空のtext、fontSize>=14、意味のあるx/y、可視色を持つ実際のlabelとして登録する必要がある。"
            "number-11は矢印であり、合計の文字も表示されない。")
        # The reviewer calls these arrows/lines without an English type name.
        # Both are real typed line/polyline data; legitimate flow-arrow remains.
        first = self.case.broken["diagram"]["primitives"][0]
        first.update(arrow="end")
        self.case.broken["diagram"]["primitives"][1] = {
            "id": "number-2", "kind": "line", "x1": 25, "y1": 35, "x2": 450, "y2": 35,
            "color": "ink", "width": 2, "dashed": False, "arrow": "end"}

    def test_real_failure_wording_repairs_only_grounded_text_including_arrow_placeholders(self):
        lesson, _ = self.case.generate()
        result = lesson["problems"][0]
        self.assertEqual(self.case.counts, {"candidate": 4, "review": 4, "selection": 1, "patch": 1, "audit": 1})
        self.assertEqual({key: value for key, value in result.items() if key != "verification"},
                         {key: value for key, value in self.case.original.items() if key != "verification"})
        requests = [item for item in self.case.requests if "-review-absence" in item[0]]
        self.assertEqual(len(requests), 3)
        self.assertIn("全候補を文字と決めつけず", requests[0][1])
        self.assertIn("個別明示の必須ID:[]", requests[0][1])
        self.assertIn("正当な矢印", requests[0][1])
        self.assertNotIn("flow-arrow", requests[1][2]["$defs"]["label"]["properties"]["id"]["enum"])
        self.assertIn("取り残した必要な文字", requests[-1][1])
        self.assertTrue(all(self.case.issue in item[1] for item in requests))
        self.assertTrue(all(item[3] == self.case.requests[0][3] for item in requests))
        props = requests[1][2]["$defs"]["label"]["properties"]
        self.assertEqual(props["fontSize"]["minimum"], 14)
        self.assertEqual(props["text"]["pattern"], r"\S")
        self.assertNotIn("none", props["color"]["enum"])

    def test_direct_zero_label_synonyms_and_unrelated_or_negated_statements(self):
        positives = [
            "diagram.primitivesにkind='label'が一つもない。",
            "diagram.primitivesにlabelが一件もない。",
            "diagram.primitivesの文字注釈が1つもなく、表が読めない。",
            "diagram.primitivesにラベルが無い。", "diagram.primitivesの文字要素：無",
            "図形全体の文字注釈が皆無。", "primitives一覧のlabelはゼロ。",
            "diagram.primitivesのlabelが0件。", "diagram.primitivesに文字が存在しない。",
            "diagram.primitives has no labels.", "diagram.primitives label count is zero.",
        ]
        negatives = [
            "図全体の面積が未確認。", "diagram.primitives30件全て線で、文字が不足。",
            "diagram.primitivesのp2-labelがない。", "diagram.primitivesのlabel検証エラーがない。",
            "原画像の文字が一つもない。", "diagram.primitivesにlabelがないとは言えない。",
            "diagram.primitivesのlabelは0件ではない。", "diagram.primitivesのlabelが無効。",
            "diagram.primitivesの検証は未完了。対象問題の解答がない。",
        ]
        for issue in positives:
            with self.subTest(issue=issue):
                self.assertTrue(lesson_pipeline._diagram_label_absence(issue))
        for issue in negatives:
            with self.subTest(issue=issue):
                self.assertFalse(lesson_pipeline._diagram_label_absence(issue))

    def test_primitive_type_wording_is_not_needed_when_actual_visible_data_and_zero_labels_agree(self):
        self.case.issue = "diagram.primitivesの文字要素が一件もない。必要な数字の表を実装してください。"
        lesson, _ = self.case.generate()
        self.assertEqual(lesson["problems"][0]["diagram"], self.case.original["diagram"])
        self.assertEqual(self.case.counts["selection"], 1)
        self.assertTrue(any("-review-absence" in request[0] for request in self.case.requests))

    def test_actual_existing_label_unseen_primitives_and_incomplete_review_remain_blocking(self):
        original = copy.deepcopy(self.case.broken)
        for mode in ("existing-label", "unseen", "initial-coverage"):
            with self.subTest(mode=mode):
                self.case.counts = dict.fromkeys(self.case.counts, 0)
                self.case.broken = copy.deepcopy(original)
                self.case.mode = mode
                if mode == "existing-label":
                    self.case.broken["diagram"]["primitives"][0] = copy.deepcopy(self.case.labels[0])
                elif mode == "unseen":
                    for step in self.case.broken["steps"]:
                        for cue in step["cues"]:
                            cue["state"].update(visibleIds=[], highlightIds=[], transforms=[])
                self.case.blocked()
                self.assertEqual(self.case.counts["selection"], 0)

    def test_empty_or_unsupported_selection_cannot_replace_any_primitive(self):
        for mode in ("empty-selection", "invented-selection", "blank-evidence", "wrong-cue"):
            with self.subTest(mode=mode):
                self.case.counts = dict.fromkeys(self.case.counts, 0)
                self.case.mode = mode
                self.case.blocked()
                self.assertEqual(self.case.counts["selection"], 1)
                self.assertEqual(self.case.counts["patch"], 0)

    def test_legitimate_arrow_remaining_missing_text_math_and_incomplete_audit_stay_denied(self):
        for mode, finding in (("wrong-arrow", "正当な分解矢印"), ("missing-text", "取り残して"),
                              ("math", "独立検算"), ("audit-coverage", "全小問")):
            with self.subTest(mode=mode):
                self.case.counts = dict.fromkeys(self.case.counts, 0)
                self.case.mode = mode
                error = self.case.blocked()
                self.assertEqual(self.case.counts["patch"], 2)
                self.assertEqual(self.case.counts["audit"], 2)
                self.assertIn(finding, " ".join(error.details))

    def test_old_requests_reused_then_three_new_requests_and_no_calls_on_resume(self):
        expected, _ = self.case.generate()
        pairs = list(zip(copy.deepcopy(self.case.requests), copy.deepcopy(self.case.responses)))
        old = [(request, value) for request, value in pairs if "-review-absence" not in request[0]]
        new = [(request, value) for request, value in pairs if "-review-absence" in request[0]]
        self.assertEqual(len(old), 8)
        self.assertEqual(len(new), 3)
        studio = MemoryStudio()
        seed = RecordingAI(studio, [value for _, value in old])
        for (key, prompt, schema, images, budget), _ in old:
            seed.structured(key, prompt, schema, images, max_tokens=budget)
        before = copy.deepcopy(studio.values)
        resumed = RecordingAI(studio, [value for _, value in new])
        self.assertEqual(self.case.generate(resumed, studio)[0], expected)
        self.assertEqual(len(resumed.scripted_session.calls), 3)
        self.assertEqual({key: studio.values[key] for key in before}, before)
        again = RecordingAI(studio, [])
        self.assertEqual(self.case.generate(again, studio)[0], expected)
        self.assertEqual(again.scripted_session.calls, [])


if __name__ == "__main__":
    unittest.main()
