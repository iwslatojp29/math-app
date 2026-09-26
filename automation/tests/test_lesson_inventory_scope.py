"""An adjacent question's continuation stays in its own fully verified task."""
import copy
import json
import unittest
from unittest.mock import Mock, patch

import test_lesson_visual_regeneration as fixtures
import test_inventory_repair as inventory_fixtures
from test_issue_repair import MemoryStudio, RecordingAI
from test_generation_repair import RUNTIME_LIMITATIONS
import lesson_pipeline
from studio_common import StudioError


GLOBAL_FINDINGS = [
    "同じ画像の別問題の冒頭が途中で切れている。全PDFでの続きと公式解答対応を未確認。",
    "unpairedPagesを全体管理に保持したいが個別problem schemaに項目がなく未確認。",
]


class LessonInventoryScopeTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LessonVisualRegenerationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        fixture = self.fixture
        fixture.inventory = fixture.inventory[:2]
        fixture.fixture["problems"] = fixture.fixture["problems"][:2]
        self.target = fixture.inventory[0]["id"]
        self.neighbour = fixture.inventory[1]["id"]
        fixture.inventory[1]["pdfPages"] = [1, 2]
        fixture.inventory[1]["officialSolutionPages"] = [2]
        fixture.fixture["problems"][1]["sourceImageIds"] = ["source-1", "source-2"]
        fixture.plan["pages"].append({"printedPages": ["2"]})
        # Only synthetic source material: a distinct continuation image makes
        # a missing or incorrectly ordered image attachment observable.
        with lesson_pipeline.open_pdf(fixture.pdf) as doc:
            doc.new_page(width=240, height=160).insert_text((15, 30), "Synthetic second question continuation and answer")
            fixture.images[2] = lesson_pipeline.page_image(doc, 2, fixture.directory, prefix="scope-fixture")
        self.management = {"solutionPageRecords": [{"checkedPdfPages": [1, 2], "links": [
            {"problemId": self.neighbour, "pdfPages": [2], "evidence": "Synthetic second question answer"}],
            "unpairedPages": [{"pdfPage": 1, "reason": "Synthetic page has no separate official solution."}],
            "unresolvedIssues": []}]}
        fixture.context = {"inventory": fixture.inventory, "images": fixture.images, "page_management": self.management}
        self.requests = []
        self.original_structured = fixture.structured
        self.counts = {"candidate": 0, "review": 0}
        self.mode = "recover"
        fixture.structured = self.structured

    def structured(self, key, prompt, schema, images=(), max_tokens=None):
        self.requests.append([key, prompt, copy.deepcopy(schema), list(images), max_tokens])
        if key.startswith("lesson-reference-repair-"):
            return {"referenceMappings": [{"missingId": "scope-label-b", "existingId": "b", "reason": "Synthetic point B is the same observed label."}],
                "addedPrimitives": [], "verification": copy.deepcopy(self.fixture.fixture["problems"][0]["verification"])}
        value = self.original_structured(key, prompt, schema, images, max_tokens=max_tokens)
        if "-" + self.target + "-" not in key:
            return value
        reviewing = key.startswith("lesson-review-")
        self.counts["review" if reviewing else "candidate"] += 1
        scoped = "inventory-scope" in key
        if not reviewing and (not scoped or self.mode == "still-uncertain"):
            value["verification"]["status"] = "needs_review"
            value["verification"]["unresolvedIssues"] = list(GLOBAL_FINDINGS)
            if self.mode == "runtime-first" and self.counts["candidate"] <= 4:
                value["verification"]["unresolvedIssues"] = list(RUNTIME_LIMITATIONS)
        if reviewing and self.mode == "reject-target":
            value["approved"] = False
            value["issues"] = ["対象問題自身の与件を判読できず、答えを確定できません。"]
        if scoped and not reviewing and self.mode == "wrong-source-images":
            value["sourceImageIds"].append("source-2")
        if scoped and not reviewing and self.mode == "reference-after-scope":
            for step in value["steps"]:
                for cue in step["cues"]:
                    for field in ("visibleIds", "highlightIds"):
                        cue["state"][field] = ["scope-label-b" if item == "b" else item for item in cue["state"][field]]
        return value

    def test_scope_recovery_attaches_registered_neighbour_continuation_to_both_candidate_and_review(self):
        lesson, _ = self.fixture.generate()
        self.assertEqual(self.counts, {"candidate": 5, "review": 1})
        self.assertEqual([item["id"] for item in lesson["problems"]], [self.target, self.neighbour])
        original = self.fixture.fixture["problems"]
        self.assertEqual(lesson["problems"][1], original[1], "The neighbouring problem must still be generated and reviewed")
        for field in ["givens", "goal", "steps", "subquestions", "diagram", "sourceImageIds"]:
            self.assertEqual(lesson["problems"][0][field], original[0][field])
        target_requests = [request for request in self.requests if "-" + self.target + "-" in request[0]]
        self.assertTrue(all(len(item[3]) == 1 and "【全問一覧と今回の1問の担当範囲】" not in item[1] for item in target_requests[:4]))
        for request in target_requests[4:]:
            self.assertEqual(request[3], [lesson_pipeline.image_data(self.fixture.images[page]) for page in [1, 2]])
            metadata = json.loads(request[1].rsplit("管理情報:", 1)[1])
            self.assertEqual(metadata["targetProblemId"], self.target)
            self.assertEqual(metadata["previousScopeFindings"], GLOBAL_FINDINGS)
            self.assertEqual(metadata["allProblemIds"], [self.target, self.neighbour])
            self.assertEqual(metadata["samePageOtherProblems"][0]["pdfPages"], [1, 2])
            self.assertEqual(metadata["samePageOtherProblems"][0]["officialSolutionPages"], [2])
            self.assertEqual(metadata["contextOnlyImagePages"], [2])
            self.assertEqual(metadata["observedUnpairedPages"], self.management["solutionPageRecords"][0]["unpairedPages"])
            self.assertIn("対象問題自身", request[1])
            self.assertIn("approved=false", request[1])

    def test_subsequent_reference_repair_and_its_review_keep_the_same_inventory_scope_and_images(self):
        self.mode = "reference-after-scope"
        lesson, _ = self.fixture.generate()
        self.assertEqual(lesson["problems"][0], self.fixture.fixture["problems"][0])
        repairs = [item for item in self.requests if "reference-repair-" in item[0]]
        self.assertEqual(len(repairs), 2)
        for request in repairs:
            self.assertIn("【全問一覧と今回の1問の担当範囲】", request[1])
            self.assertIn("今回の添付画像の実際の順序はcurrentImagePages", request[1])
            self.assertEqual(request[3], [lesson_pipeline.image_data(self.fixture.images[page]) for page in [1, 2]])
            self.assertEqual(json.loads(request[1].rsplit("管理情報:", 1)[1])["previousScopeFindings"], GLOBAL_FINDINGS)

    def test_later_global_scope_recovery_does_not_replace_six_existing_runtime_attempts(self):
        self.mode = "runtime-first"
        self.fixture.generate()
        self.assertEqual(self.counts, {"candidate": 7, "review": 1})
        target = [item for item in self.requests if "-" + self.target + "-" in item[0]]
        self.assertTrue(target[4][0].endswith("-4"))
        self.assertTrue(target[5][0].endswith("-5"))
        self.assertTrue(target[6][0].endswith("inventory-scope-0"))
        self.assertEqual([len(item[3]) for item in target], [1] * 6 + [2, 2])

    def test_target_math_failure_and_persistent_scope_uncertainty_remain_blocking(self):
        for mode, reviews in [("reject-target", 2), ("still-uncertain", 0), ("wrong-source-images", 0)]:
            with self.subTest(mode=mode):
                self.mode = mode
                self.counts = {"candidate": 0, "review": 0}
                with self.assertRaises(StudioError) as caught:
                    self.fixture.generate()
                self.assertEqual(caught.exception.code, "lesson_unresolved")
                self.assertEqual(self.counts, {"candidate": 6, "review": reviews})
                self.assertTrue(caught.exception.details)

    def test_scope_cannot_invent_missing_images_or_unobserved_unpaired_reasons(self):
        entry = self.fixture.inventory[0]
        candidate = copy.deepcopy(self.fixture.fixture["problems"][0])
        candidate["verification"].update(status="needs_review", unresolvedIssues=GLOBAL_FINDINGS)
        issues = ["候補自身の数学・読みの検証が未解決です。", *GLOBAL_FINDINGS]
        context, _ = lesson_pipeline.inventory_scope_context(candidate, issues, entry, self.fixture.inventory,
            [1], self.fixture.images, {})
        self.assertEqual(json.loads(context.rsplit("管理情報:", 1)[1])["observedUnpairedPages"], [])
        with self.assertRaises(StudioError) as caught:
            lesson_pipeline.inventory_scope_context(candidate, issues, entry, self.fixture.inventory, [1],
                {1: self.fixture.images[1]}, {})
        self.assertEqual(caught.exception.code, "lesson_source_images")
        candidate["verification"]["unresolvedIssues"] = ["対象問題の長さを判読できません。"]
        self.assertIsNone(lesson_pipeline.inventory_scope_context(candidate, issues, entry, self.fixture.inventory,
            [1], self.fixture.images, {}))

    def test_cached_target_failures_and_completed_neighbour_are_reused_without_additional_source_generation(self):
        expected, _ = self.fixture.generate()
        captured = copy.deepcopy(self.requests)
        studio = MemoryStudio()
        seed_values, seed_requests = [], []
        for request in captured:
            key = request[0]
            if "inventory-scope" in key:
                continue
            seed_requests.append(request)
            value = self.original_structured(key, request[1], request[2], request[3], max_tokens=request[4])
            if "-" + self.target + "-" in key:
                value["verification"].update(status="needs_review", unresolvedIssues=GLOBAL_FINDINGS)
            seed_values.append(value)
        seed = RecordingAI(studio, seed_values)
        for key, prompt, schema, images, budget in seed_requests:
            seed.structured(key, prompt, schema, images, max_tokens=budget)
        before = copy.deepcopy(studio.values)
        recovery_values = [self.original_structured(item[0], item[1], item[2], item[3], max_tokens=item[4])
            for item in captured if "inventory-scope" in item[0]]
        client = RecordingAI(studio, recovery_values)

        def generate(ai):
            fixture = self.fixture
            return lesson_pipeline.generate_lesson(fixture.pdf, Mock(structured=ai.structured), studio, fixture.plan,
                fixture.directory, "Retain all questions and mathematical conditions.", "2026年9月号",
                fixture.root / "lesson.schema.json", generation_context=fixture.context)

        actual, _ = generate(client)
        self.assertEqual(actual, expected)
        self.assertEqual(len(client.scripted_session.calls), 2)
        self.assertEqual({key: studio.values[key] for key in before}, before)
        again = RecordingAI(studio, [])
        self.assertEqual(generate(again)[0], expected)
        self.assertEqual(again.scripted_session.calls, [])

    def test_optional_solution_ledger_preserves_existing_return_and_contains_only_accepted_records(self):
        fixture = inventory_fixtures.InventoryRepairTests()
        fixture.setUp()
        self.addCleanup(fixture.doCleanups)
        correct = fixture.solution_candidate()
        wrong = copy.deepcopy(correct)
        wrong["unresolvedIssues"] = ["Synthetic unpaired correspondence is still unknown"]
        ai = inventory_fixtures.FixtureAI([wrong, correct, fixture.review()])
        ledger = []
        result = lesson_pipeline.reconcile_solution_pages([fixture.problem()], [1, 2], fixture.solution_images(),
            ai, "practice", "Fixture specification", page_management=ledger)
        self.assertIsNone(result)
        self.assertEqual(ledger, [correct])
        ledger[0]["unpairedPages"][0]["reason"] = "caller mutation"
        self.assertEqual(correct["unpairedPages"][0]["reason"], fixture.solution_candidate()["unpairedPages"][0]["reason"])


if __name__ == "__main__":
    unittest.main()
