"""Explicit missing-text findings can repair visible polylines without changing arrows."""
import copy
import json
import unittest
from unittest.mock import Mock, patch

import jsonschema
import test_lesson_label_repair as label_fixtures
import test_lesson_inventory_scope as scope_fixtures
from test_issue_repair import MemoryStudio, RecordingAI
import lesson_pipeline
from studio_common import StudioError


class ReviewNamedLabelTests(unittest.TestCase):
    def setUp(self):
        self.case = label_fixtures.LessonLabelRepairTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.case.issue = "必須の文字aはkind=labelではなく水平polylineで、文字表示が不足しています。原画像・発話に基づく文字が必要です。"
        self.arrow = {"kind": "polyline", "id": "a-10", "points": [{"x": 10, "y": 55}, {"x": 90, "y": 55}],
                      "color": "blue", "width": 2, "dashed": False, "arrow": "end"}
        for problem in (self.case.original, self.case.broken):
            problem["diagram"]["primitives"] = [copy.deepcopy(self.arrow) if item["id"] == "a-10" else item
                                                 for item in problem["diagram"]["primitives"]]
        for item in self.case.broken["diagram"]["primitives"]:
            if item["id"] in ("a", "b"):
                item.update(points=[{"x": 20, "y": 20}, {"x": 80, "y": 20}], color="ink", width=2)
        self.requests, self.responses = [], []

    def structured(self, key, prompt, schema, images=(), max_tokens=None):
        self.requests.append([key, prompt, copy.deepcopy(schema), list(images), max_tokens])
        value = self.case.structured(key, prompt, schema, images, max_tokens=max_tokens)
        self.responses.append(copy.deepcopy(value))
        return value

    def generate(self, client=None, studio=None):
        fixture = self.case.fixture
        with patch.object(lesson_pipeline, "inventory_questions", return_value=(fixture.inventory, fixture.images)):
            return lesson_pipeline.generate_lesson(fixture.pdf, Mock(structured=client.structured if client else self.structured),
                studio or fixture.studio, fixture.plan, fixture.directory, "Retain all questions and mathematical conditions.",
                "2026年9月号", fixture.root / "lesson.schema.json")

    def blocked(self):
        with self.assertRaises(StudioError) as caught:
            self.generate()
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        return caught.exception

    def test_visible_horizontal_lines_become_grounded_labels_and_legitimate_arrow_remains(self):
        lesson, _ = self.generate()
        repaired = lesson["problems"][0]
        self.assertEqual(self.case.counts, {"candidate": 4, "review": 4, "targets": 1, "patch": 1, "patch-review": 1})
        self.assertEqual({key: value for key, value in repaired.items() if key != "verification"},
                         {key: value for key, value in self.case.original.items() if key != "verification"})
        self.assertEqual(next(item for item in repaired["diagram"]["primitives"] if item["id"] == "a-10"), self.arrow)
        requests = [item for item in self.requests if "-review-named" in item[0]]
        self.assertEqual(len(requests), 3)
        self.assertIn('必須ID:["a"]', requests[0][1], "a must not accidentally match a-10")
        self.assertIn("正当な矢印・枠線", requests[0][1])
        self.assertIn("文字が不足するpolyline", requests[1][1])
        self.assertIn("正当な矢印・枠線", requests[2][1])
        self.assertIn("全小問を別に検算", requests[2][1])
        properties = requests[1][2]["$defs"]["label"]["properties"]
        self.assertEqual(properties["kind"]["enum"], ["label"])
        self.assertEqual(properties["fontSize"]["minimum"], 14)
        self.assertEqual(properties["text"]["pattern"], r"\S")
        self.assertNotIn("none", properties["color"]["enum"])
        self.assertEqual(properties["id"]["enum"], ["a", "b"])
        self.assertTrue(all(item[3] == self.requests[0][3] for item in requests))
        jsonschema.validate(self.responses[-2], requests[1][2])

    def test_new_gate_needs_explicit_existing_visible_id_text_defect_and_complete_independent_review(self):
        for mode in ("not-named", "id-boundary", "not-text", "not-missing", "not-visible", "incomplete", "blank", "approved"):
            with self.subTest(mode=mode):
                self.case.counts = dict.fromkeys(self.case.counts, 0)
                def mutate(stage, count, value):
                    if stage != "review":
                        return
                    issues = {"not-named": "必須文字がpolylineでありlabelの実装が不足しています。",
                              "id-boundary": "必須文字a-extraがpolylineでありlabelの実装が不足しています。",
                              "not-text": "aの相似対応が不正で数学的根拠が不足しています。",
                              "not-missing": "aのpolylineとlabelの色を変更してください。",
                              "not-visible": "hidden-extraの必須文字がpolylineでありlabelが不足しています。"}
                    if mode in issues:
                        value["issues"] = [issues[mode]]
                    elif mode == "incomplete":
                        value["checkedSubquestionIds"] = []
                    elif mode == "blank":
                        value["officialAnswerCheck"] = " "
                    elif mode == "approved":
                        value["approved"] = True
                self.case.mutate = mutate
                if mode == "not-visible":
                    self.case.broken["diagram"]["primitives"].append({**self.arrow, "id": "hidden-extra"})
                self.blocked()
                self.assertEqual(self.case.counts["targets"], 0)
                self.case.broken["diagram"]["primitives"] = [item for item in self.case.broken["diagram"]["primitives"] if item["id"] != "hidden-extra"]

    def test_selection_must_cover_named_id_with_actual_visible_cues_and_nonempty_evidence(self):
        for mode in ("missing", "invented", "blank", "wrong-cue"):
            with self.subTest(mode=mode):
                self.case.counts = dict.fromkeys(self.case.counts, 0)
                def mutate(stage, count, value):
                    if stage != "targets":
                        return
                    if mode == "missing":
                        value["targets"].pop(0)
                    elif mode == "invented":
                        value["targets"][0]["id"] = "new-id"
                    elif mode == "blank":
                        value["targets"][0]["whyTextNeeded"] = " "
                    else:
                        value["targets"][0]["cueIds"] = ["unseen-cue"]
                self.case.mutate = mutate
                self.blocked()
                self.assertEqual(self.case.counts["targets"], 1)
                self.assertEqual(self.case.counts["patch"], 0)

    def test_strict_text_schema_rejects_fake_small_invisible_or_blank_labels(self):
        for mode in ("polyline", "small", "none", "blank"):
            with self.subTest(mode=mode):
                self.case.counts = dict.fromkeys(self.case.counts, 0)
                def mutate(stage, count, value):
                    if stage != "patch":
                        return
                    if mode == "polyline":
                        value["labels"][0] = {**self.arrow, "id": "a"}
                    elif mode == "small":
                        value["labels"][0]["fontSize"] = 13
                    elif mode == "none":
                        value["labels"][0]["color"] = "none"
                    else:
                        value["labels"][0]["text"] = " \n\t"
                self.case.mutate = mutate
                self.blocked()
                self.assertEqual(self.case.counts["patch"], 2)
                self.assertEqual(self.case.counts["patch-review"], 0)

    def test_self_uncertainty_source_math_rejection_or_missing_final_coverage_remains_blocking(self):
        for mode in ("self", "math", "coverage", "blank"):
            with self.subTest(mode=mode):
                self.case.counts = dict.fromkeys(self.case.counts, 0)
                def mutate(stage, count, value):
                    if mode == "self" and stage == "patch":
                        value["verification"].update(status="needs_review", unresolvedIssues=["原画像の数値を確定できません。"])
                    if stage != "patch-review":
                        return
                    if mode == "math":
                        value.update(approved=False, issues=["原問題からの独立検算で数値の不一致を確認しました。"])
                    elif mode == "coverage":
                        value["checkedSubquestionIds"] = []
                    elif mode == "blank":
                        value["reasoningCheck"] = " "
                self.case.mutate = mutate
                self.blocked()
                self.assertEqual(self.case.counts["patch"], 2)
                self.assertEqual(self.case.counts["patch-review"], 0 if mode == "self" else 2)

    def test_independent_audit_can_reject_overselection_of_legitimate_arrow(self):
        def mutate(stage, count, value):
            if stage == "targets":
                value["targets"].append({"id": "a-10", "whyTextNeeded": "Synthetic incorrect text interpretation.",
                                         "cueIds": [self.case.original["steps"][0]["cues"][0]["id"]]})
            elif stage == "patch":
                value["labels"].append({**self.case.labels[0], "id": "a-10", "text": "分解"})
            elif stage == "patch-review":
                value.update(approved=False, issues=["a-10は正当な分解矢印です。文字化に根拠がありません。"])
        self.case.mutate = mutate
        error = self.blocked()
        self.assertEqual(self.case.counts["patch-review"], 2)
        self.assertIn("正当な分解矢印", " ".join(error.details))

    def test_scope_context_and_actual_neighbour_images_follow_selection_patch_and_audit(self):
        scope = scope_fixtures.LessonInventoryScopeTests()
        scope.setUp()
        self.addCleanup(scope.doCleanups)
        original_structured = scope.structured
        def structured(key, prompt, schema, images=(), max_tokens=None):
            if "-review-named" in key:
                return self.structured(key, prompt, schema, images, max_tokens=max_tokens)
            value = original_structured(key, prompt, schema, images, max_tokens=max_tokens)
            if "-" + scope.target + "-" in key and "inventory-scope" in key:
                if key.startswith("lesson-review-"):
                    value.update(approved=False, issues=[self.case.issue])
                else:
                    value["diagram"] = copy.deepcopy(self.case.broken["diagram"])
                    value["steps"] = copy.deepcopy(self.case.broken["steps"])
            return value
        scope.fixture.structured = structured
        lesson, _ = scope.fixture.generate()
        self.assertEqual([item["id"] for item in lesson["problems"]], [scope.target, scope.neighbour])
        self.assertEqual(lesson["problems"][0]["sourceImageIds"], ["source-1"])
        self.assertEqual(len(self.requests), 3)
        for request in self.requests:
            self.assertIn("【全問一覧と今回の1問の担当範囲】", request[1])
            metadata = json.loads(request[1].rsplit("管理情報:", 1)[1])
            self.assertEqual(metadata["contextOnlyImagePages"], [2])
            self.assertEqual(request[3], [lesson_pipeline.image_data(scope.fixture.images[page]) for page in [1, 2]])

    def test_eight_previous_requests_are_reused_then_three_new_requests_and_zero_on_next_resume(self):
        expected, _ = self.generate()
        pairs = list(zip(copy.deepcopy(self.requests), copy.deepcopy(self.responses)))
        previous = [(request, response) for request, response in pairs if "-review-named" not in request[0]]
        new = [(request, response) for request, response in pairs if "-review-named" in request[0]]
        self.assertEqual(len(previous), 8)
        self.assertEqual(len(new), 3)
        studio = MemoryStudio()
        seed = RecordingAI(studio, [value for _, value in previous])
        for (key, prompt, schema, images, budget), _ in previous:
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
