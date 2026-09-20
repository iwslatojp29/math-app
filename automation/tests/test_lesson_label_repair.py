"""Invisible text placeholders get a narrow, independently reviewed repair."""
import copy
import json
import unittest
from unittest.mock import patch

import jsonschema

import test_lesson_visual_regeneration as fixtures
import lesson_pipeline
from studio_common import StudioError


class LessonLabelRepairTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LessonVisualRegenerationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.inventory = self.fixture.inventory[:1]
        self.original = copy.deepcopy(self.fixture.fixture["problems"][0])
        self.labels = [copy.deepcopy(item) for item in self.original["diagram"]["primitives"] if item["id"] in ("a", "b")]
        self.placeholder = lambda identifier: {"kind": "polyline", "id": identifier,
            "points": [{"x": 25, "y": 20}, {"x": 26, "y": 20}], "color": "none", "width": 1,
            "dashed": False, "arrow": "none"}
        self.original["diagram"]["primitives"].append(self.placeholder("a-10"))
        self.original["steps"][0]["cues"][0]["state"]["visibleIds"].append("a-10")
        self.broken = copy.deepcopy(self.original)
        self.broken["diagram"]["primitives"] = [self.placeholder(item["id"]) if item["id"] in ("a", "b") else item
            for item in self.broken["diagram"]["primitives"]]
        self.issue = ('文字を表示すべきprimitiveがkind:labelではなくcolor:"none"のpolylineです。'
            '例はa。点名・数値を図上で照合できません。対象IDを保持して文字要素を定義してください。')
        self.requests, self.mutate = [], lambda stage, count, value: None
        self.counts = {name: 0 for name in ("candidate", "review", "targets", "patch", "patch-review")}

    def structured(self, key, prompt, schema, images=(), max_tokens=None):
        self.requests.append((key, prompt, copy.deepcopy(schema)))
        if key.startswith("lesson-label-targets-"):
            stage = "targets"
            value = {"targets": [{"id": item["id"], "whyTextNeeded": "原問題の点名" + item["text"] + "と発話の対応表示が必要。",
                "cueIds": [cue["id"] for step in self.broken["steps"] for cue in step["cues"]
                           if item["id"] in cue["state"]["visibleIds"]]} for item in self.labels]}
        elif key.startswith("lesson-label-repair-"):
            stage = "patch"
            value = {"labels": copy.deepcopy(self.labels), "verification": copy.deepcopy(self.original["verification"])}
        elif key.startswith("lesson-review-"):
            stage = "patch-review" if key.startswith("lesson-review-label-repair-") else "review"
            value = {"approved": stage == "patch-review", "checkedSubquestionIds": [item["id"] for item in self.original["subquestions"]],
                **{name: self.original["verification"][name] for name in
                   ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")},
                "issues": [] if stage == "patch-review" else [self.issue]}
        else:
            stage, value = "candidate", copy.deepcopy(self.broken)
        self.counts[stage] += 1
        self.mutate(stage, self.counts[stage], value)
        return value

    def generate(self):
        self.fixture.structured = self.structured
        with patch.object(lesson_pipeline, "inventory_questions", return_value=(self.fixture.inventory, self.fixture.images)):
            return self.fixture.generate()

    def assert_blocked(self):
        with self.assertRaises(StudioError) as caught:
            self.generate()
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        self.assertTrue(caught.exception.details)
        return caught.exception

    def test_labels_restore_real_text_and_font_without_changing_anchor_cues_or_mathematics(self):
        (lesson, _) = self.generate()
        repaired = lesson["problems"][0]
        self.assertEqual(self.counts, {"candidate": 4, "review": 4, "targets": 1, "patch": 1, "patch-review": 1})
        self.assertEqual({key: value for key, value in repaired.items() if key != "verification"},
                         {key: value for key, value in self.original.items() if key != "verification"})
        by_id = {item["id"]: item for item in repaired["diagram"]["primitives"]}
        self.assertEqual(by_id["a"]["kind"], "label")
        self.assertEqual(by_id["a"]["text"], "A")
        self.assertGreaterEqual(by_id["a"]["fontSize"], 14)
        self.assertEqual(by_id["a-10"], self.placeholder("a-10"), "The same tiny invisible anchor remains untouched")
        selection = next(request for request in self.requests if request[0].startswith("lesson-label-targets-"))
        self.assertIn('必須ID:["a"]', selection[1], "Mentioning a must not also select a-10")
        patch_request = next(request for request in self.requests if request[0].startswith("lesson-label-repair-"))
        self.assertEqual(patch_request[2]["properties"]["labels"]["items"], {"$ref": "#/$defs/label"})
        self.assertEqual(set(patch_request[2]["$defs"]), {"label", "verification"})
        self.assertEqual(patch_request[2]["$defs"]["label"]["properties"]["kind"]["enum"], ["label"])
        audit = next(request for request in self.requests if request[0].startswith("lesson-review-label-repair-"))
        reviewed = json.loads(audit[1].split("。修復後候補:", 1)[1])
        self.assertEqual(reviewed["diagram"]["primitives"], repaired["diagram"]["primitives"])
        self.assertIn("修復対象識別", audit[1])
        self.assertIn("不可視アンカーを誤って文字化", audit[1])
        self.assertIn("全小問を別に検算", audit[1])
        jsonschema.validate(reviewed, self.requests[0][2])

    def test_selection_rejects_hallucinated_or_omitted_named_id_before_patch(self):
        for mode in ("hallucinated", "omitted", "duplicate", "wrong-cue", "blank-evidence"):
            with self.subTest(mode=mode):
                self.requests.clear()
                self.counts = dict.fromkeys(self.counts, 0)
                def mutate(stage, count, value):
                    if stage != "targets":
                        return
                    if mode == "hallucinated":
                        value["targets"][0]["id"] = "invented-label"
                    elif mode == "omitted":
                        value["targets"] = value["targets"][1:]
                    elif mode == "duplicate":
                        value["targets"].append(copy.deepcopy(value["targets"][0]))
                    elif mode == "wrong-cue":
                        value["targets"][0]["cueIds"] = ["not-a-cue"]
                    else:
                        value["targets"][0]["whyTextNeeded"] = "   "
                self.mutate = mutate
                self.assert_blocked()
                self.assertEqual(self.counts["targets"], 1)
                self.assertEqual(self.counts["patch"], 0)

    def test_patch_rejects_id_tampering_and_requires_real_visible_labels(self):
        for mode in ("missing", "extra", "duplicate", "polyline", "blank", "none", "small"):
            with self.subTest(mode=mode):
                self.requests.clear()
                self.counts = dict.fromkeys(self.counts, 0)
                def mutate(stage, count, value):
                    if stage != "patch":
                        return
                    if mode == "missing":
                        value["labels"] = value["labels"][:1]
                    elif mode == "extra":
                        extra = copy.deepcopy(value["labels"][0])
                        extra["id"] = "a-10"
                        value["labels"].append(extra)
                    elif mode == "duplicate":
                        value["labels"].append(copy.deepcopy(value["labels"][0]))
                    elif mode == "polyline":
                        value["labels"][0] = self.placeholder("a")
                    elif mode == "blank":
                        value["labels"][0]["text"] = " "
                    elif mode == "none":
                        value["labels"][0]["color"] = "none"
                    else:
                        value["labels"][0]["fontSize"] = 10
                self.mutate = mutate
                self.assert_blocked()
                self.assertEqual(self.counts["patch"], 2)
                self.assertEqual(self.counts["patch-review"], 0)

    def test_impossible_mathematics_remains_blocked_after_two_independent_reviews(self):
        def mutate(stage, count, value):
            if stage == "patch-review":
                value["approved"] = False
                value["issues"] = ["相似の対応が成立せず、答えを確定できません。sk-do-not-disclose123"]
        self.mutate = mutate
        error = self.assert_blocked()
        self.assertEqual(self.counts["patch"], 2)
        self.assertEqual(self.counts["patch-review"], 2)
        self.assertIn("相似の対応", " ".join(error.details))
        self.assertNotIn("sk-do-not-disclose123", str(error.details))
        self.assertIn("[redacted]", str(error.details))
        retry = [request for request in self.requests if request[0].startswith("lesson-label-repair-")][1]
        self.assertIn("前回の文字修復候補", retry[1])
        self.assertIn("相似の対応", retry[1])

    def test_independent_review_can_reject_a_wrong_anchor_selection(self):
        def mutate(stage, count, value):
            if stage == "targets":
                value["targets"].append({"id": "a-10", "whyTextNeeded": "点Aの補足表示が必要。",
                    "cueIds": [self.original["steps"][0]["cues"][0]["id"]]})
            elif stage == "patch":
                label = copy.deepcopy(self.labels[0])
                label.update(id="a-10", text="基点")
                value["labels"].append(label)
            elif stage == "patch-review":
                value["approved"] = False
                value["issues"] = ["a-10は文字が必要な対象ではなく正当な不可視アンカーです。選定が誤っています。"]
        self.mutate = mutate
        error = self.assert_blocked()
        self.assertEqual(self.counts["targets"], 1)
        self.assertEqual(self.counts["patch-review"], 2)
        self.assertIn("正当な不可視アンカー", " ".join(error.details))

    def test_label_patch_cannot_bypass_self_verification_or_missing_review_coverage(self):
        for mode in ("self-unresolved", "review-coverage", "review-blank"):
            with self.subTest(mode=mode):
                self.counts = dict.fromkeys(self.counts, 0)
                def mutate(stage, count, value):
                    if mode == "self-unresolved" and stage == "patch":
                        value["verification"]["status"] = "needs_review"
                        value["verification"]["unresolvedIssues"] = ["cueの移動位置を変えないと船名が対応しません。"]
                    if mode == "review-coverage" and stage == "patch-review":
                        value["checkedSubquestionIds"] = []
                    if mode == "review-blank" and stage == "patch-review":
                        value["reasoningCheck"] = " "
                self.mutate = mutate
                self.assert_blocked()
                self.assertEqual(self.counts["patch"], 2)

    def test_no_fallback_for_unrelated_review_or_nonplaceholder_geometry(self):
        self.issue = "辺の対応が不正で答えを確定できません。"
        self.assert_blocked()
        self.assertEqual(self.counts["targets"], 0)
        self.issue = '文字aがkind:labelではなくcolor:"none"のpolylineです。'
        for item in self.broken["diagram"]["primitives"]:
            if item["id"] in ("a", "b"):
                item["points"][1]["x"] = 100
        self.assert_blocked()
        self.assertEqual(self.counts["targets"], 0)


if __name__ == "__main__":
    unittest.main()
