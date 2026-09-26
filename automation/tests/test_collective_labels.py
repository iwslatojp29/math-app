"""Collection-level missing-text findings select a justified subset, not every line."""
import copy
import unittest
from unittest.mock import Mock, patch

import test_lesson_visual_regeneration as fixtures
from test_issue_repair import MemoryStudio, RecordingAI
import lesson_pipeline
from studio_common import StudioError


class CollectiveLabelTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LessonVisualRegenerationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.inventory = self.fixture.inventory[:1]
        self.original = copy.deepcopy(self.fixture.fixture["problems"][0])
        self.labels = [{"id": f"number-{index + 1}", "kind": "label", "text": str(index + 1),
                        "x": 35 + (index % 6) * 60, "y": 35 + (index // 6) * 45,
                        "fontSize": 20, "color": "ink", "anchor": "middle"} for index in range(30)]
        self.arrow = {"id": "flow-arrow", "kind": "polyline", "points": [{"x": 25, "y": 300}, {"x": 450, "y": 300}],
                      "color": "blue", "width": 2, "dashed": False, "arrow": "end"}
        self.original["diagram"]["primitives"] = [*copy.deepcopy(self.labels), copy.deepcopy(self.arrow)]
        ids = [item["id"] for item in self.original["diagram"]["primitives"]]
        for step in self.original["steps"]:
            for cue in step["cues"]:
                cue["state"].update(visibleIds=list(ids), highlightIds=[ids[0]], transforms=[])
        self.broken = copy.deepcopy(self.original)
        self.broken["diagram"]["primitives"] = [
            {"id": item["id"], "kind": "polyline", "points": [{"x": 25, "y": item["y"]}, {"x": 450, "y": item["y"]}],
             "color": "ink", "width": 2, "dashed": False, "arrow": "none"} for item in self.labels] + [copy.deepcopy(self.arrow)]
        self.issue = ("diagram.primitivesの31件はすべてkind=polylineで、各図形は水平線にすぎない。"
                      "kind=label、非空text、fontSizeを備えた文字注釈が1件もなく、個数と順位を図上で読めない。"
                      "必要な注釈を実際のlabelとして実装する必要がある。")
        self.mode = "success"
        self.requests, self.responses = [], []
        self.counts = {stage: 0 for stage in ("candidate", "review", "selection", "patch", "audit")}

    def review(self, approved=True, issues=()):
        return {"approved": approved, "issues": list(issues),
                "checkedSubquestionIds": [item["id"] for item in self.original["subquestions"]],
                **{field: self.original["verification"][field] for field in
                   ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")}}

    def structured(self, key, prompt, schema, images=(), max_tokens=None):
        self.requests.append([key, prompt, copy.deepcopy(schema), list(images), max_tokens])
        if key.startswith("lesson-label-targets-"):
            stage = "selection"
            value = {"targets": [{"id": item["id"], "whyTextNeeded": "Synthetic source number " + item["text"] + " is explained by this cue.",
                                  "cueIds": [self.original["steps"][0]["cues"][0]["id"]]} for item in self.labels]}
            if self.mode == "empty-selection":
                value["targets"] = []
            elif self.mode == "invented-selection":
                value["targets"][0]["id"] = "invented"
            elif self.mode == "blank-evidence":
                value["targets"][0]["whyTextNeeded"] = " "
            elif self.mode == "wrong-cue":
                value["targets"][0]["cueIds"] = ["not-a-cue"]
            elif self.mode == "missing-text":
                value["targets"] = value["targets"][:1]
            elif self.mode == "wrong-arrow":
                value["targets"].append({"id": "flow-arrow", "whyTextNeeded": "Synthetic incorrect text classification.",
                                         "cueIds": [self.original["steps"][0]["cues"][0]["id"]]})
        elif key.startswith("lesson-label-repair-"):
            stage = "patch"
            value = {"labels": copy.deepcopy(self.labels), "verification": copy.deepcopy(self.original["verification"])}
            if self.mode == "missing-text":
                value["labels"] = value["labels"][:1]
            elif self.mode == "wrong-arrow":
                value["labels"].append({**self.labels[0], "id": "flow-arrow", "text": "移動"})
            elif self.mode == "blank-label":
                value["labels"][0]["text"] = " \n\t"
        elif key.startswith("lesson-review-label-repair-"):
            stage = "audit"
            value = self.review()
            if self.mode == "missing-text":
                value.update(approved=False, issues=["必要な文字注釈を取り残しており、図上の説明は未実装です。"])
            elif self.mode == "wrong-arrow":
                value.update(approved=False, issues=["flow-arrowは正当な分解矢印です。文字に置換してはいけません。"])
            elif self.mode == "math":
                value.update(approved=False, issues=["原問題から独立検算すると答えが異なります。"])
            elif self.mode == "audit-coverage":
                value["checkedSubquestionIds"] = []
        elif key.startswith("lesson-review-"):
            stage = "review"
            value = self.review(False, [self.issue])
            if self.mode == "initial-coverage":
                value["checkedSubquestionIds"] = []
        else:
            stage, value = "candidate", copy.deepcopy(self.broken)
        self.counts[stage] += 1
        self.responses.append(copy.deepcopy(value))
        return value

    def generate(self, client=None, studio=None):
        fixture = self.fixture
        with patch.object(lesson_pipeline, "inventory_questions", return_value=(fixture.inventory, fixture.images)):
            return lesson_pipeline.generate_lesson(fixture.pdf, Mock(structured=client.structured if client else self.structured),
                studio or fixture.studio, fixture.plan, fixture.directory, "Retain all questions and mathematical conditions.",
                "2026年9月号", fixture.root / "lesson.schema.json")

    def blocked(self):
        with self.assertRaises(StudioError) as caught:
            self.generate()
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        return caught.exception

    def test_collection_selects_thirty_text_ids_without_making_real_arrow_a_required_label(self):
        lesson, _ = self.generate()
        self.assertEqual(self.counts, {"candidate": 4, "review": 4, "selection": 1, "patch": 1, "audit": 1})
        result = lesson["problems"][0]
        self.assertEqual({key: value for key, value in result.items() if key != "verification"},
                         {key: value for key, value in self.original.items() if key != "verification"})
        requests = [item for item in self.requests if "-review-collection" in item[0]]
        self.assertEqual(len(requests), 3)
        selection = requests[0]
        self.assertIn("個別明示の必須ID:[]", selection[1])
        self.assertIn("全候補を文字と決めつけず", selection[1])
        self.assertEqual(len(selection[2]["properties"]["targets"]["items"]["properties"]["id"]["enum"]), 31)
        self.assertNotIn("flow-arrow", requests[1][2]["$defs"]["label"]["properties"]["id"]["enum"])
        self.assertIn("取り残した必要な文字", requests[-1][1])
        self.assertIn(self.issue, requests[-1][1])
        self.assertTrue(all(item[3] == self.requests[0][3] for item in requests))

    def test_existing_label_partial_finding_or_incomplete_original_review_does_not_open_collection_path(self):
        original = copy.deepcopy(self.broken)
        for mode in ("existing-label", "partial", "count-not-text-zero", "math", "initial-coverage"):
            with self.subTest(mode=mode):
                self.counts = dict.fromkeys(self.counts, 0)
                self.broken = copy.deepcopy(original)
                saved_issue = self.issue
                self.mode = mode
                if mode == "existing-label":
                    self.broken["diagram"]["primitives"][0] = copy.deepcopy(self.labels[0])
                elif mode == "partial":
                    self.issue = "一部のpolylineに必要な文字注釈が不足しています。"
                elif mode == "count-not-text-zero":
                    self.issue = "diagram.primitives30件全てpolylineで、文字注釈が不足しています。"
                elif mode == "math":
                    self.issue = "対象問題の数え分けの数学的根拠が不正です。"
                self.blocked()
                self.assertEqual(self.counts["selection"], 0)
                self.issue = saved_issue

    def test_all_wording_can_select_real_lines_as_well_as_polylines(self):
        self.issue = self.issue.replace("の31件はすべてkind=polyline", "31件全部がline/polyline")
        item = self.broken["diagram"]["primitives"][0]
        self.broken["diagram"]["primitives"][0] = {
            **{key: value for key, value in item.items() if key not in ("kind", "points")},
            "kind": "line", "x1": 25, "y1": 35, "x2": 450, "y2": 35}
        lesson, _ = self.generate()
        self.assertEqual(lesson["problems"][0]["diagram"], self.original["diagram"])
        self.assertEqual(self.counts["selection"], 1)
        self.assertTrue(any("-review-collection" in item[0] for item in self.requests))

    def test_selection_requires_nonempty_source_grounded_targets_with_real_visible_cues(self):
        for mode in ("empty-selection", "invented-selection", "blank-evidence", "wrong-cue"):
            with self.subTest(mode=mode):
                self.mode = mode
                self.counts = dict.fromkeys(self.counts, 0)
                self.blocked()
                self.assertEqual(self.counts["selection"], 1)
                self.assertEqual(self.counts["patch"], 0)

    def test_unselected_missing_text_and_legitimate_arrow_misclassification_are_rejected(self):
        for mode, finding in (("missing-text", "取り残して"), ("wrong-arrow", "正当な分解矢印"), ("math", "独立検算"), ("audit-coverage", "全小問")):
            with self.subTest(mode=mode):
                self.mode = mode
                self.counts = dict.fromkeys(self.counts, 0)
                error = self.blocked()
                self.assertEqual(self.counts["patch"], 2)
                self.assertEqual(self.counts["audit"], 2)
                self.assertIn(finding, " ".join(error.details))

    def test_collection_still_uses_strict_real_label_schema(self):
        self.mode = "blank-label"
        self.blocked()
        self.assertEqual(self.counts["patch"], 2)
        self.assertEqual(self.counts["audit"], 0)
        schema = next(item[2] for item in self.requests if item[0].startswith("lesson-label-repair-"))
        props = schema["$defs"]["label"]["properties"]
        self.assertEqual(props["kind"]["enum"], ["label"])
        self.assertEqual(props["fontSize"]["minimum"], 14)
        self.assertEqual(props["text"]["pattern"], r"\S")
        self.assertNotIn("none", props["color"]["enum"])

    def test_cached_old_candidates_and_audits_are_reused_before_three_new_requests_then_zero(self):
        expected, _ = self.generate()
        old, new = [], []
        for request, value in zip(copy.deepcopy(self.requests), copy.deepcopy(self.responses)):
            (new if "-review-collection" in request[0] else old).append((request, value))
        self.assertEqual(len(old), 8)
        self.assertEqual(len(new), 3)
        studio = MemoryStudio()
        seed = RecordingAI(studio, [value for _, value in old])
        for (key, prompt, schema, images, budget), _ in old:
            seed.structured(key, prompt, schema, images, max_tokens=budget)
        before = copy.deepcopy(studio.values)
        resumed = RecordingAI(studio, [value for _, value in new])
        self.assertEqual(self.generate(resumed, studio)[0], expected)
        self.assertEqual(len(resumed.scripted_session.calls), 3)
        self.assertEqual({key: studio.values[key] for key in before}, before)
        again = RecordingAI(studio, [])
        self.assertEqual(self.generate(again, studio)[0], expected)
        self.assertEqual(again.scripted_session.calls, [])


if __name__ == "__main__":
    unittest.main()
