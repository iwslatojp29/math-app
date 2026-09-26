"""New reference placeholders become real labels only after source-grounded selection."""
import copy
import unittest
from unittest.mock import Mock, patch

import jsonschema
import test_lesson_reference_repair as reference_fixtures
from test_issue_repair import MemoryStudio, RecordingAI
import lesson_pipeline
from studio_common import StudioError


class AddedReferenceLabelTests(unittest.TestCase):
    def setUp(self):
        self.case = reference_fixtures.LessonReferenceRepairTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)
        self.original = copy.deepcopy(self.case.original)
        self.old_anchor = {"id": "original-anchor", "kind": "polyline", "points": [{"x": 15, "y": 10}] * 2,
                           "color": "none", "width": 1, "dashed": False, "arrow": "none"}
        self.original["diagram"]["primitives"].append(copy.deepcopy(self.old_anchor))
        self.ids = ["new-annotation-" + str(number) for number in range(1, 28)]
        for step in self.original["steps"]:
            for cue in step["cues"]:
                cue["state"]["visibleIds"].extend(["original-anchor", *self.ids])
                cue["state"]["highlightIds"] = list(self.ids)
        self.requests, self.responses = [], []
        self.counts = {key: 0 for key in ("candidate", "reference", "reference-review", "selection", "labels", "label-review")}
        self.mode = "success"

    def review(self, approved=True, issues=()):
        return {"approved": approved, "issues": list(issues),
            "checkedSubquestionIds": [item["id"] for item in self.original["subquestions"]],
            **{key: self.original["verification"][key] for key in
               ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")}}

    def structured(self, key, prompt, schema, images=(), max_tokens=None):
        self.requests.append([key, prompt, copy.deepcopy(schema), list(images), max_tokens])
        if key.startswith("lesson-reference-repair-"):
            stage = "reference"
            width = 0 if self.counts[stage] < 2 else 1
            value = {"referenceMappings": [], "addedPrimitives": [
                {"id": identifier, "kind": "polyline", "points": [{"x": 20, "y": 20}] * 2,
                 "color": "none", "width": width, "dashed": False, "arrow": "none"} for identifier in self.ids],
                "verification": copy.deepcopy(self.original["verification"])}
            if self.mode == "nonplaceholder":
                value["addedPrimitives"][-1]["points"][1] = {"x": 100, "y": 100}
        elif key.startswith("lesson-review-reference-repair-"):
            stage = "reference-review"
            value = self.review(False, ["追加27要素がすべて不可視・退化したpolylineであり、必要な文字注釈を代替できていない。実際のkind=labelへ修正が必要。"])
            if self.mode == "unrelated-review":
                value["issues"] = ["原画像の相似条件が未確定です。"]
            if self.mode == "incomplete-reference-review":
                value["checkedSubquestionIds"] = []
        elif key.startswith("lesson-label-targets-"):
            stage = "selection"
            value = {"targets": [{"id": identifier, "whyTextNeeded": "Synthetic visible annotation " + str(index + 1) + " must match the source and cue.",
                "cueIds": [self.original["steps"][0]["cues"][0]["id"]]} for index, identifier in enumerate(self.ids)]}
            if self.mode == "omitted-selection":
                value["targets"].pop()
            elif self.mode == "original-anchor-selection":
                value["targets"][0]["id"] = "original-anchor"
            elif self.mode == "blank-selection":
                value["targets"][0]["whyTextNeeded"] = " "
            elif self.mode == "wrong-cue":
                value["targets"][0]["cueIds"] = ["missing-cue"]
        elif key.startswith("lesson-label-repair-"):
            stage = "labels"
            value = {"labels": [{"id": identifier, "kind": "label", "text": str(index + 1), "x": 25 + index * 5,
                "y": 20, "fontSize": 22, "color": "ink", "anchor": "middle"} for index, identifier in enumerate(self.ids)],
                "verification": copy.deepcopy(self.original["verification"])}
            if self.mode == "fake-polyline-label":
                value["labels"][0] = {**self.old_anchor, "id": self.ids[0]}
            elif self.mode == "blank-label":
                value["labels"][0]["text"] = " \n\t"
            elif self.mode == "invisible-label":
                value["labels"][0]["color"] = "none"
            elif self.mode == "small-label":
                value["labels"][0]["fontSize"] = 13
            elif self.mode == "omitted-label":
                value["labels"].pop()
        elif key.startswith("lesson-review-label-repair-"):
            stage = "label-review"
            value = self.review(self.mode != "reject-math",
                ["新しいラベルは原問題の数量と異なり、全小問の答えを支持しません。"] if self.mode == "reject-math" else [])
        else:
            stage, value = "candidate", copy.deepcopy(self.original)
        self.counts[stage] += 1
        self.responses.append(copy.deepcopy(value))
        return value

    def generate(self, client=None, studio=None):
        fixture = self.case.fixture
        with patch.object(lesson_pipeline, "inventory_questions", return_value=(fixture.inventory, fixture.images)):
            return lesson_pipeline.generate_lesson(fixture.pdf, Mock(structured=client.structured if client else self.structured),
                studio or fixture.studio, fixture.plan, fixture.directory, "Retain all questions and mathematical conditions.",
                "2026年9月号", fixture.root / "lesson.schema.json")

    def test_collective_audit_repairs_all_27_added_elements_and_preserves_original_anchor_and_content(self):
        lesson, _ = self.generate()
        self.assertEqual(self.counts, {"candidate": 4, "reference": 4, "reference-review": 2, "selection": 1, "labels": 1, "label-review": 1})
        repaired = lesson["problems"][0]
        original_count = len(self.original["diagram"]["primitives"])
        self.assertEqual(repaired["diagram"]["primitives"][:original_count], self.original["diagram"]["primitives"])
        labels = repaired["diagram"]["primitives"][original_count:]
        self.assertEqual([item["id"] for item in labels], self.ids)
        self.assertTrue(all(item["kind"] == "label" and item["text"].strip() and item["fontSize"] == 22 for item in labels))
        for field in set(self.original) - {"diagram", "verification"}:
            self.assertEqual(repaired[field], self.original[field], field)
        self.assertEqual(repaired["diagram"]["viewBox"], self.original["diagram"]["viewBox"])
        new_requests = [request for request in self.requests if "-reference-added" in request[0]]
        self.assertEqual(len(new_requests), 3)
        self.assertNotIn("original-anchor", new_requests[0][2]["properties"]["targets"]["items"]["properties"]["id"]["enum"])
        self.assertIn("ID名や座標の一致だけでラベルだと推測しない", new_requests[0][1])
        self.assertIn("全小問を別に検算", new_requests[-1][1])
        self.assertTrue(all(request[3] == self.requests[0][3] for request in new_requests))
        label_schema = new_requests[1][2]
        self.assertEqual(label_schema["$defs"]["label"]["properties"]["fontSize"]["minimum"], 14)
        self.assertNotIn("none", label_schema["$defs"]["label"]["properties"]["color"]["enum"])
        self.assertEqual(label_schema["$defs"]["label"]["properties"]["text"]["pattern"], r"\S")
        self.assertEqual(label_schema["$defs"]["label"]["properties"]["id"]["enum"], self.ids)
        jsonschema.validate(self.responses[-2], label_schema)

    def test_no_chain_for_nonplaceholder_geometry_unrelated_findings_or_incomplete_reference_review(self):
        for mode in ("nonplaceholder", "unrelated-review", "incomplete-reference-review"):
            with self.subTest(mode=mode):
                self.mode = mode
                self.counts = dict.fromkeys(self.counts, 0)
                with self.assertRaises(StudioError):
                    self.generate()
                self.assertEqual(self.counts["selection"], 0)
                self.assertEqual(self.counts["labels"], 0)

    def test_selection_requires_every_added_id_real_visible_cue_and_source_evidence(self):
        for mode in ("omitted-selection", "original-anchor-selection", "blank-selection", "wrong-cue"):
            with self.subTest(mode=mode):
                self.mode = mode
                self.counts = dict.fromkeys(self.counts, 0)
                with self.assertRaises(StudioError):
                    self.generate()
                self.assertEqual(self.counts["selection"], 1)
                self.assertEqual(self.counts["labels"], 0)

    def test_label_data_cannot_remain_polyline_blank_invisible_small_or_omit_a_target(self):
        for mode in ("fake-polyline-label", "blank-label", "invisible-label", "small-label", "omitted-label"):
            with self.subTest(mode=mode):
                self.mode = mode
                self.counts = dict.fromkeys(self.counts, 0)
                with self.assertRaises(StudioError):
                    self.generate()
                self.assertEqual(self.counts["labels"], 2)
                self.assertEqual(self.counts["label-review"], 0)

    def test_final_independent_math_rejection_remains_blocking(self):
        self.mode = "reject-math"
        with self.assertRaises(StudioError) as caught:
            self.generate()
        self.assertEqual(self.counts["labels"], 2)
        self.assertEqual(self.counts["label-review"], 2)
        self.assertIn("全小問の答えを支持しません", " ".join(caught.exception.details))

    def test_completed_reference_caches_are_reused_before_three_new_label_requests_and_next_resume_is_free(self):
        expected, _ = self.generate()
        requests, responses = copy.deepcopy(self.requests), copy.deepcopy(self.responses)
        old = [(request, value) for request, value in zip(requests, responses) if "-reference-added" not in request[0]]
        new = [(request, value) for request, value in zip(requests, responses) if "-reference-added" in request[0]]
        self.assertEqual(len(old), 10)
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
