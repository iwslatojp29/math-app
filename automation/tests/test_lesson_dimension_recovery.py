"""Repair added invalid dimensions without changing existing lecture data or caches."""
import copy
import json
import unittest
from unittest.mock import Mock, patch

import jsonschema
import test_lesson_reference_repair as reference_fixtures
import lesson_pipeline
from test_issue_repair import MemoryStudio, RecordingAI
from studio_common import json_bytes


class LessonDimensionRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.case = reference_fixtures.LessonReferenceRepairTests()
        self.case.setUp()
        self.addCleanup(self.case.doCleanups)

    def invalid_patch(self, width=0):
        value = copy.deepcopy(self.case.patch_value)
        value["addedPrimitives"] = [{"id": "p3-labelB", "kind": "line", "x1": 20, "y1": 30,
            "x2": 30, "y2": 40, "color": "ink", "width": width, "dashed": False, "arrow": "none"}]
        return value

    def bad_dimensions_then_label(self, stage, count, value):
        if stage == "patch" and count <= 2:
            value.update(self.invalid_patch())

    def test_added_zero_width_earns_scoped_recovery_and_source_review_without_changing_original(self):
        self.case.mutate = self.bad_dimensions_then_label
        lesson, _ = self.case.generate()
        repaired = lesson["problems"][0]
        self.assertEqual(self.case.counts, {"candidate": 4, "patch": 3, "review": 1})
        self.assertEqual(repaired["diagram"]["primitives"][:-1], self.case.broken["diagram"]["primitives"])
        self.assertEqual(repaired["diagram"]["primitives"][-1], self.case.patch_value["addedPrimitives"][0])
        for field in set(repaired) - {"diagram", "verification"}:
            self.assertEqual(repaired[field], self.case.broken[field], field)
        self.assertEqual(repaired["diagram"]["viewBox"], self.case.broken["diagram"]["viewBox"])
        requests = self.case.requests
        recovery = next(item for item in requests if item[0].startswith("lesson-reference-repair-") and item[0].endswith("-2"))
        self.assertIn('"id":"p3-labelB","kind":"line","field":"width","value":0', recovery[1])
        self.assertIn("数値の推測で通過させない", recovery[1])
        self.assertIn("kind=label", recovery[1])
        self.assertTrue(all("【追加した図形の寸法修復】" not in item[1] for item in requests[:6]))
        audit = requests[-1]
        self.assertIn("lesson-review-reference-repair-", audit[0])
        self.assertIn("全小問を別に検算", audit[1])

    def test_two_additional_attempts_are_bounded_and_never_clamp_zero_or_negative_width(self):
        for width in [0, -2]:
            with self.subTest(width=width):
                self.case.counts = dict.fromkeys(self.case.counts, 0)
                self.case.mutate = lambda stage, count, value: value.update(self.invalid_patch(width)) if stage == "patch" else None
                error = self.case.assert_blocked()
                self.assertEqual(self.case.counts, {"candidate": 4, "patch": 4, "review": 0})
                self.assertIn("schemaに一致しません", " ".join(error.details))
                diagnostic = json.loads(next(item.split("参照修復の診断: ", 1)[1] for item in error.details if "参照修復の診断: " in item))
                self.assertEqual(diagnostic["referenceAttempts"], 4)
                self.assertEqual(diagnostic["dimensionRecoveryAttempts"], 2)
                self.assertTrue(all(item["id"] == "p3-labelB" and item["kind"] == "line"
                    and item["field"] == "width" and item["value"] == width for item in diagnostic["invalidAddedDimensions"]))
                self.assertEqual([item["attempt"] for item in diagnostic["invalidAddedDimensions"]], [1, 2, 3, 4])

    def test_only_dimension_recovery_schema_enforces_every_positive_primitive_dimension(self):
        schema_path = self.case.fixture.root / "lesson.schema.json"
        original_schema_bytes = schema_path.read_bytes()
        self.case.mutate = self.bad_dimensions_then_label
        self.case.generate()
        requests = [request for request in self.case.requests if request[0].startswith("lesson-reference-repair-")]
        first, second, recovery = [request[2] for request in requests]
        self.assertEqual(first, second)
        restored = copy.deepcopy(recovery)
        fields = ("width", "height", "radius", "strokeWidth", "scale", "fontSize")
        for alternative in recovery["$defs"]["primitive"]["anyOf"]:
            name = alternative["$ref"].rsplit("/", 1)[-1]
            properties = recovery["$defs"][name]["properties"]
            for field in fields:
                if field in properties:
                    self.assertEqual(properties[field]["exclusiveMinimum"], 0, (name, field))
                    self.assertNotIn("exclusiveMinimum", first["$defs"][name]["properties"][field])
                    restored["$defs"][name]["properties"][field].pop("exclusiveMinimum")
            if name == "label":
                self.assertEqual(properties["fontSize"]["minimum"], 14)
                self.assertNotIn("minimum", first["$defs"][name]["properties"]["fontSize"])
                restored["$defs"][name]["properties"]["fontSize"].pop("minimum")
        self.assertEqual(restored, first, "Only recovery dimension constraints may change")
        self.assertEqual(schema_path.read_bytes(), original_schema_bytes)
        for width in [0, -1]:
            jsonschema.validate(self.invalid_patch(width), first)
            with self.assertRaises(jsonschema.ValidationError):
                jsonschema.validate(self.invalid_patch(width), recovery)
        for size in [0, -1, 13.99]:
            label_patch = copy.deepcopy(self.case.patch_value)
            label_patch["addedPrimitives"][0]["fontSize"] = size
            jsonschema.validate(label_patch, first)
            with self.assertRaises(jsonschema.ValidationError):
                jsonschema.validate(label_patch, recovery)
        label_patch["addedPrimitives"][0]["fontSize"] = 14
        jsonschema.validate(label_patch, recovery)

    def test_dimension_recovery_cannot_skip_independent_math_rejection(self):
        def mutate(stage, count, value):
            self.bad_dimensions_then_label(stage, count, value)
            if stage == "review":
                value["approved"] = False
                value["issues"] = ["原問題の点Bに対応せず、答えの根拠も未解決です。"]
        self.case.mutate = mutate
        error = self.case.assert_blocked()
        self.assertEqual(self.case.counts, {"candidate": 4, "patch": 4, "review": 2})
        self.assertIn("答えの根拠も未解決", " ".join(error.details))

    def test_unrelated_invalid_transform_does_not_earn_dimension_recovery(self):
        self.case.broken["steps"][0]["cues"][0]["state"]["transforms"][0]["scale"] = 0
        self.case.assert_blocked()
        self.assertEqual(self.case.counts, {"candidate": 4, "patch": 2, "review": 0})

    def test_existing_bad_dimension_is_not_modified_by_missing_reference_recovery(self):
        primitive = next(item for item in self.case.broken["diagram"]["primitives"] if "width" in item)
        primitive["width"] = 0
        self.case.assert_blocked()
        self.assertEqual(self.case.counts, {"candidate": 4, "patch": 0, "review": 0})
        self.assertEqual(primitive["width"], 0)

    def test_resume_reuses_original_candidates_and_two_bad_patches_then_only_requests_recovery_and_review(self):
        # Capture the unchanged original requests with a scripted model. Seed
        # the real ResponsesClient cache exactly as the pre-fix job saved it.
        self.case.mutate = self.bad_dimensions_then_label
        expected, _ = self.case.generate()
        requests = copy.deepcopy(self.case.requests)
        studio = MemoryStudio()
        seed = RecordingAI(studio, [copy.deepcopy(self.case.broken) for _ in range(4)]
            + [self.invalid_patch(), self.invalid_patch()])
        for key, prompt, schema, images, budget in requests[:6]:
            seed.structured(key, prompt, schema, images, max_tokens=budget)
        self.assertEqual(len(seed.scripted_session.calls), 6)
        before = copy.deepcopy(studio.values)
        review = {"approved": True, "issues": [],
            "checkedSubquestionIds": [item["id"] for item in self.case.original["subquestions"]],
            **{key: self.case.original["verification"][key] for key in
               ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")}}

        def generate(client):
            fixture = self.case.fixture
            with patch.object(lesson_pipeline, "inventory_questions", return_value=(fixture.inventory, fixture.images)):
                # A serial wrapper keeps this test on the actual Responses
                # checkpoint path without creating real worker HTTP sessions.
                return lesson_pipeline.generate_lesson(fixture.pdf, Mock(structured=client.structured), studio,
                    fixture.plan, fixture.directory, "Retain all questions and mathematical conditions.",
                    "2026年9月号", fixture.root / "lesson.schema.json")

        resumed = RecordingAI(studio, [copy.deepcopy(self.case.patch_value), review])
        actual, _ = generate(resumed)
        self.assertEqual(actual, expected)
        self.assertEqual(len(resumed.scripted_session.calls), 2)
        self.assertEqual(resumed.task_keys, [request[0] for request in requests])
        self.assertEqual({key: studio.values[key] for key in before}, before, "Do not delete or rewrite prior completed responses")
        again = RecordingAI(studio, [])
        repeated, _ = generate(again)
        self.assertEqual(repeated, expected)
        self.assertEqual(again.scripted_session.calls, [], "A later resume must reuse the accepted repair and independent review")

    def test_old_invalid_dimension_recovery_caches_do_not_match_the_new_strict_schema(self):
        # Recreate all old request bodies, including the two exhausted recovery
        # entries, by removing only the new dimension constraints. On the old
        # fourth request the previous finding came from semantic validation.
        self.case.mutate = lambda stage, count, value: value.update(self.invalid_patch()) if stage == "patch" else None
        self.case.assert_blocked()
        old_requests = copy.deepcopy(self.case.requests)
        original_reference_schema = copy.deepcopy(old_requests[4][2])
        self.assertEqual(len(old_requests), 8)
        for request in old_requests[6:]:
            request[2] = copy.deepcopy(original_reference_schema)
            request[1] = request[1].replace(
                json_bytes(["図の参照修復が指定された欠落ID専用schemaに一致しません。"]).decode(),
                json_bytes(["講義の構造: Invalid primitive width"]).decode())
        studio = MemoryStudio()
        seed = RecordingAI(studio, [copy.deepcopy(self.case.broken) for _ in range(4)]
            + [self.invalid_patch() for _ in range(4)])
        for key, prompt, schema, images, budget in old_requests:
            seed.structured(key, prompt, schema, images, max_tokens=budget)
        self.assertEqual(len(seed.scripted_session.calls), 8)
        before = copy.deepcopy(studio.values)
        self.case.requests = []
        self.case.counts = dict.fromkeys(self.case.counts, 0)
        self.case.mutate = self.bad_dimensions_then_label
        expected, _ = self.case.generate()
        review = {"approved": True, "issues": [],
            "checkedSubquestionIds": [item["id"] for item in self.case.original["subquestions"]],
            **{key: self.case.original["verification"][key] for key in
               ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")}}
        resumed = RecordingAI(studio, [copy.deepcopy(self.case.patch_value), review])
        fixture = self.case.fixture

        def generate(client):
            with patch.object(lesson_pipeline, "inventory_questions", return_value=(fixture.inventory, fixture.images)):
                return lesson_pipeline.generate_lesson(fixture.pdf, Mock(structured=client.structured), studio,
                    fixture.plan, fixture.directory, "Retain all questions and mathematical conditions.",
                    "2026年9月号", fixture.root / "lesson.schema.json")

        self.assertEqual(generate(resumed)[0], expected)
        self.assertEqual(len(resumed.scripted_session.calls), 2)
        self.assertEqual({key: studio.values[key] for key in before}, before)
        new_request = resumed.scripted_session.calls[0]
        self.assertEqual(new_request["text"]["format"]["schema"]["$defs"]["line"]["properties"]["width"]["exclusiveMinimum"], 0)
        again = RecordingAI(studio, [])
        self.assertEqual(generate(again)[0], expected)
        self.assertEqual(again.scripted_session.calls, [])


if __name__ == "__main__":
    unittest.main()
