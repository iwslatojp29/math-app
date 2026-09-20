"""Missing primitive references repair without regenerating problem content."""
import copy
import hashlib
import json
import unittest
from unittest.mock import patch

import test_lesson_visual_regeneration as fixtures
from test_generation_repair import RUNTIME_LIMITATIONS
import lesson_pipeline
from studio_common import StudioError, json_bytes


class LessonReferenceRepairTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LessonVisualRegenerationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.fixture.inventory = self.fixture.inventory[:1]
        self.original = copy.deepcopy(self.fixture.fixture["problems"][0])
        self.original["steps"][0]["cues"][0]["state"]["transforms"].append(
            {"targetId": "b", "dx": 2, "dy": 3, "rotation": 0, "scale": 1})
        self.requests, self.counts = [], {"candidate": 0, "patch": 0, "review": 0}
        self.mutate = lambda stage, count, value: None
        self.configure()

    def configure(self, *, alias=False, mixed=False, transform_only=False):
        self.broken = copy.deepcopy(self.original)
        self.labels = {item["id"]: copy.deepcopy(item) for item in self.original["diagram"]["primitives"] if item["kind"] == "label"}
        aliases = {"b": "p3-labelB"}
        if mixed:
            aliases["c"] = "p3-labelC"
        for step in self.broken["steps"]:
            for cue in step["cues"]:
                if not transform_only:
                    for field in ("visibleIds", "highlightIds"):
                        cue["state"][field] = [aliases.get(identifier, identifier) for identifier in cue["state"][field]]
                for transform in cue["state"]["transforms"]:
                    transform["targetId"] = aliases.get(transform["targetId"], transform["targetId"])
        self.patch_value = {"referenceMappings": [], "addedPrimitives": [],
                            "verification": copy.deepcopy(self.original["verification"])}
        if alias or transform_only:
            self.patch_value["referenceMappings"].append({"missingId": "p3-labelB", "existingId": "b",
                "reason": "原問題と発話の点Bは既存の文字Bと同じ対象です。"})
        else:
            self.broken["diagram"]["primitives"] = [item for item in self.broken["diagram"]["primitives"] if item["id"] != "b"]
            label = copy.deepcopy(self.labels["b"])
            label["id"] = "p3-labelB"
            self.patch_value["addedPrimitives"].append(label)
        if mixed:
            self.patch_value["referenceMappings"].append({"missingId": "p3-labelC", "existingId": "c",
                "reason": "原問題の点Cと既存の文字Cは同じ対象です。"})

    def structured(self, key, prompt, schema, images=(), max_tokens=None):
        self.requests.append([key, prompt, copy.deepcopy(schema), list(images), max_tokens])
        if key.startswith("lesson-reference-repair-"):
            stage, value = "patch", copy.deepcopy(self.patch_value)
        elif key.startswith("lesson-review-"):
            stage = "review"
            value = {"approved": True, "checkedSubquestionIds": [item["id"] for item in self.original["subquestions"]],
                **{name: self.original["verification"][name] for name in
                   ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")}, "issues": []}
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
        return caught.exception

    def test_missing_label_is_added_with_source_text_and_existing_data_unchanged(self):
        (lesson, _) = self.generate()
        repaired = lesson["problems"][0]
        self.assertEqual(self.counts, {"candidate": 4, "patch": 1, "review": 1})
        self.assertEqual(repaired["diagram"]["primitives"][:-1], self.broken["diagram"]["primitives"])
        self.assertEqual(repaired["diagram"]["primitives"][-1], self.patch_value["addedPrimitives"][0])
        self.assertEqual(repaired["diagram"]["primitives"][-1]["text"], "B")
        for field in set(repaired) - {"diagram", "verification"}:
            self.assertEqual(repaired[field], self.broken[field], field)
        self.assertEqual(repaired["diagram"]["viewBox"], self.broken["diagram"]["viewBox"])
        review = next(request for request in self.requests if request[0].startswith("lesson-review-reference-repair-"))
        self.assertIn("全小問を別に検算", review[1])
        self.assertIn("修復前候補", review[1])
        reviewed = json.loads(review[1].split("。修復後候補:", 1)[1])
        self.assertEqual(reviewed["diagram"], repaired["diagram"])

    def test_alias_updates_all_reference_locations_and_preserves_order_and_transforms(self):
        self.configure(alias=True)
        (lesson, _) = self.generate()
        repaired = lesson["problems"][0]
        self.assertEqual({key: value for key, value in repaired.items() if key != "verification"},
                         {key: value for key, value in self.original.items() if key != "verification"})
        self.assertEqual(self.counts["review"], 1)

    def test_missing_set_includes_mixed_addition_and_alias_beyond_first_reported_id(self):
        self.configure(mixed=True)
        (lesson, _) = self.generate()
        repaired = lesson["problems"][0]
        self.assertEqual(repaired["diagram"]["primitives"][-1]["id"], "p3-labelB")
        for step in repaired["steps"]:
            for cue in step["cues"]:
                self.assertNotIn("p3-labelC", cue["state"]["visibleIds"])
        request = next(request for request in self.requests if request[0].startswith("lesson-reference-repair-"))
        self.assertEqual(request[2]["properties"]["referenceMappings"]["items"]["properties"]["missingId"]["enum"],
                         ["p3-labelB", "p3-labelC"])

    def test_transform_only_missing_reference_can_be_repaired(self):
        self.configure(transform_only=True)
        (lesson, _) = self.generate()
        self.assertEqual(lesson["problems"][0]["steps"], self.original["steps"])
        self.assertEqual(self.counts["patch"], 1)

    def test_unknown_ids_existing_collision_missing_coverage_and_double_coverage_are_rejected(self):
        for mode in ("omitted", "extra", "existing-collision", "duplicate", "double", "unknown-target", "blank-reason"):
            with self.subTest(mode=mode):
                self.counts = dict.fromkeys(self.counts, 0)
                self.configure()
                def mutate(stage, count, value):
                    if stage != "patch":
                        return
                    if mode == "omitted":
                        value["addedPrimitives"] = []
                    elif mode in ("extra", "existing-collision"):
                        value["addedPrimitives"][0]["id"] = "invented" if mode == "extra" else "a"
                    elif mode == "duplicate":
                        value["addedPrimitives"].append(copy.deepcopy(value["addedPrimitives"][0]))
                    elif mode == "double":
                        value["referenceMappings"] = [{"missingId": "p3-labelB", "existingId": "a", "reason": "同じ点です。"}]
                    else:
                        value["addedPrimitives"] = []
                        value["referenceMappings"] = [{"missingId": "p3-labelB",
                            "existingId": "another-missing" if mode == "unknown-target" else "a",
                            "reason": "同じ点です。" if mode == "unknown-target" else " "}]
                self.mutate = mutate
                self.assert_blocked()
                self.assertEqual(self.counts["patch"], 2)
                self.assertEqual(self.counts["review"], 0)

    def test_mapping_collisions_are_rejected_without_silent_deduplication(self):
        for location in ("visibleIds", "highlightIds", "transforms"):
            with self.subTest(location=location):
                self.counts = dict.fromkeys(self.counts, 0)
                self.configure(alias=True)
                state = self.broken["steps"][0]["cues"][0]["state"]
                if location == "transforms":
                    state["transforms"].append({"targetId": "b", "dx": 10, "dy": 0, "rotation": 0, "scale": 1})
                elif location == "highlightIds":
                    state["highlightIds"] = ["p3-labelB", "b"]
                else:
                    state[location].append("b")
                self.mutate = lambda stage, count, value: None
                error = self.assert_blocked()
                self.assertEqual(self.counts["patch"], 2)
                self.assertEqual(self.counts["review"], 0)
                self.assertIn("重複", " ".join(error.details))

    def test_wrong_alias_and_unresolved_math_require_independent_rejection(self):
        self.configure(alias=True)
        self.patch_value["referenceMappings"][0]["existingId"] = "wrong-but-existing"
        # A real existing element with no co-visible collision can still be the
        # wrong mathematical object; only source-grounded review can reject it.
        wrong = copy.deepcopy(self.labels["a"])
        wrong.update(id="wrong-but-existing", text="A")
        self.broken["diagram"]["primitives"].append(wrong)
        def mutate(stage, count, value):
            if stage == "review":
                value["approved"] = False
                value["issues"] = ["原画像の点Bを点Aに対応付けており、面積の根拠も未解決です。sk-private123"]
        self.mutate = mutate
        error = self.assert_blocked()
        self.assertEqual(self.counts["patch"], 2)
        self.assertEqual(self.counts["review"], 2)
        self.assertIn("点Bを点A", " ".join(error.details))
        self.assertNotIn("sk-private123", str(error.details))

    def test_self_uncertainty_bad_review_coverage_and_unfixed_structural_errors_still_block(self):
        for mode in ("self", "review-coverage", "review-empty", "invalid-scale", "highlight-not-visible"):
            with self.subTest(mode=mode):
                self.counts = dict.fromkeys(self.counts, 0)
                self.configure()
                if mode == "invalid-scale":
                    self.broken["steps"][0]["cues"][0]["state"]["transforms"][0]["scale"] = 0
                if mode == "highlight-not-visible":
                    self.broken["steps"][0]["cues"][0]["state"]["visibleIds"].remove("p3-labelB")
                    self.broken["steps"][0]["cues"][0]["state"]["highlightIds"] = ["p3-labelB"]
                def mutate(stage, count, value):
                    if stage == "patch" and mode == "self":
                        value["verification"]["status"] = "needs_review"
                        value["verification"]["unresolvedIssues"] = ["辺の対応を確定できません。"]
                    if stage == "review" and mode == "review-coverage":
                        value["checkedSubquestionIds"] = []
                    if stage == "review" and mode == "review-empty":
                        value["reasoningCheck"] = " "
                self.mutate = mutate
                self.assert_blocked()
                self.assertEqual(self.counts["patch"], 2)

    def test_self_reported_structural_error_does_not_trigger_repair(self):
        def mutate(stage, count, value):
            if stage == "candidate":
                value["verification"]["status"] = "needs_review"
                value["verification"]["unresolvedIssues"] = ["講義の構造: fake: missing reference p3-labelB"]
        self.mutate = mutate
        self.assert_blocked()
        self.assertEqual(self.counts, {"candidate": 4, "patch": 0, "review": 0})

    def test_cached_scope_candidates_are_reused_before_reference_repair(self):
        def mutate(stage, count, value):
            if stage == "candidate" and count <= 4:
                value["verification"]["status"] = "needs_review"
                value["verification"]["unresolvedIssues"] = list(RUNTIME_LIMITATIONS)
        self.mutate = mutate
        self.generate()
        self.assertEqual(self.counts, {"candidate": 6, "patch": 1, "review": 1})
        # Frozen from HEAD before reference repair: full keys, prompts, schemas,
        # source image bytes/order and output budgets for all six old attempts.
        self.assertEqual([hashlib.sha256(json_bytes(request)).hexdigest() for request in self.requests[:6]], [
            "3e6861205ca8a5b84a8e9f08781dedcea7b3beb245a70fb6dd9e747f6accd469",
            "87e697618127dd73e3f9658b203be49073b272793318232d311cc34824040e23",
            "236b8be96d201c9990aff9c36e0c2d4e974082b2753e6cd1f029bacff2b36259",
            "af7bcb88d3560bb015f808e6bb176510af950b506b704c16356142407bf9de86",
            "cac01564b698865df9ef9d9ae8547053f7937c47d8676517c7c61f6a82d4c573",
            "8428e525e74422ad84b8e57c97faae18a9d5ee1849d9bd8bd52028dfee93b2ab",
        ])
        self.assertEqual(len([request for request in self.requests if request[0].startswith("lesson-reference-repair-")]), 1)


if __name__ == "__main__":
    unittest.main()
