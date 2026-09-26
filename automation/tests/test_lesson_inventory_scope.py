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
        self.findings = list(GLOBAL_FINDINGS)
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
            value["verification"]["unresolvedIssues"] = list(self.findings)
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

    def test_whole_material_coverage_finding_gets_inventory_images_and_independent_review(self):
        self.findings = [
            "PDF全体の対象一覧と収録状況は未確認。今回の画像には前問の解説続きと、左右欄にまたがる次問がある。"
            "他の掲載問題を含む教材全体の対象一覧・ページ対応・収録データは個別修正の照合材料に含まれない。"
            "対象問題の確認を教材全体の収録確認の代替にせず、残りページ画像および対象一覧と照合し、"
            "公式解答が対応しないページの根拠も別途記録する必要がある。"
        ]
        lesson, _ = self.fixture.generate()
        self.assertEqual(self.counts, {"candidate": 5, "review": 1})
        self.assertEqual(lesson["problems"], self.fixture.fixture["problems"])
        requests = [item for item in self.requests if "-" + self.target + "-" in item[0]]
        self.assertTrue(all(len(item[3]) == 1 for item in requests[:4]))
        for request in requests[4:]:
            metadata = json.loads(request[1].rsplit("管理情報:", 1)[1])
            self.assertEqual(metadata["previousScopeFindings"], self.findings)
            self.assertEqual(metadata["allProblemIds"], [self.target, self.neighbour])
            self.assertEqual(metadata["contextOnlyImagePages"], [2])
            self.assertEqual(request[3], [lesson_pipeline.image_data(self.fixture.images[page]) for page in [1, 2]])
            self.assertIn("必ずneeds_review/approved=false", request[1])
        self.assertTrue(requests[-1][0].startswith("lesson-review-"))

    def test_document_coverage_synonyms_trigger_but_unrelated_mathematics_does_not(self):
        positive = [
            "PDF全体の対象一覧が未確認。", "pdf全体のページ対応が未確認。", "教材全体の収録データが不足。",
            "冊子全体の問題一覧との照合が未完了。", "全冊子の掲載問題の確認が必要。",
            "全28問一覧の照合が未確認。", "全２８問の収録確認が未完了。", "全二十八問の収録確認が必要。",
            "全問の収録状況が未確認。", "全体対象一覧との照合が未解決。", "全体の対象一覧が未確認。",
            "他の掲載問題の収録データが照合材料に含まれない。", "収録状況は未確認。",
            "問題一覧が照合材料に含まれない。", "ページ対応が未確認。",
        ]
        negative = [
            "図全体の面積が未確認。", "全体の体積比が未解決。", "問題全体の数学的正しさが未確認。",
            "教材全体にある図の面積の計算が未確認。", "PDF全体にある整数の性質が未解決。",
            "対象問題の与件を読めず答えが未確認。", "公式解答の計算と合わず数学的根拠が不足。",
            "PDF全体の対象一覧と収録状況を照合済み。", "問題一覧とページ対応を確認済み。",
            "全28問一覧は照合済み。図全体の面積が未確認。",
            "PDF全体の収録状況は確認済み。対象問題の計算の根拠が不足。",
            "PDF全体の公式解答の計算が対象問題の条件と一致せず未解決。", "全28問の数学的正しさが未確認。",
        ]
        for finding in positive + negative:
            with self.subTest(finding=finding):
                candidate = copy.deepcopy(self.fixture.fixture["problems"][0])
                candidate["verification"].update(status="needs_review", unresolvedIssues=[finding])
                actual = lesson_pipeline.inventory_scope_context(candidate,
                    ["候補自身の数学・読みの検証が未解決です。"], self.fixture.inventory[0], self.fixture.inventory,
                    [1], self.fixture.images, self.management)
                if finding in positive:
                    self.assertIsNotNone(actual)
                    self.assertEqual(actual[1], [1, 2])
                else:
                    self.assertIsNone(actual)

    def test_new_document_wording_does_not_bypass_target_math_rejection(self):
        self.findings = ["PDF全体の対象一覧と収録状況は未確認。"]
        self.mode = "reject-target"
        with self.assertRaises(StudioError) as caught:
            self.fixture.generate()
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        self.assertEqual(self.counts, {"candidate": 6, "review": 2})
        self.assertIn("対象問題自身の与件", " ".join(caught.exception.details))

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


class SolutionOnlyScopeTests(unittest.TestCase):
    def setUp(self):
        self.base = LessonInventoryScopeTests()
        self.base.setUp()
        self.addCleanup(self.base.doCleanups)
        self.fixture = self.base.fixture
        fixture = self.fixture
        self.target, self.neighbour = self.base.target, self.base.neighbour
        fixture.inventory[0].update(pdfPages=[3, 4], printedPages=["3", "4"], officialSolutionPages=[3, 4])
        fixture.inventory[1].update(pdfPages=[2], printedPages=["2"], officialSolutionPages=[2, 3])
        fixture.fixture["problems"][0]["sourceImageIds"] = ["source-3", "source-4"]
        fixture.fixture["problems"][1]["sourceImageIds"] = ["source-2"]
        fixture.plan["pages"] = [{"printedPages": [str(page)]} for page in range(1, 5)]
        with lesson_pipeline.open_pdf(fixture.pdf) as doc:
            for page in range(2, 5):
                doc.new_page(width=240, height=160).insert_text((15, 30), f"Synthetic source and solution page {page}")
                fixture.images[page] = lesson_pipeline.page_image(doc, page, fixture.directory, prefix="solution-overlap")
        self.finding = (f"前問{self.neighbour}のページ接続照合未完了。全28問一覧では原問題2・公式解答2と3だが、"
                        "今回画像は3と4だけ。ページ3の解説がページ2の本文と解説前半に接続する確認に画像2が必要。")
        self.management = {"solutionPageRecords": [{"checkedPdfPages": [1, 2, 3, 4], "links": [
            {"problemId": self.target, "pdfPages": [3, 4], "evidence": "Synthetic target answer correspondence."},
            {"problemId": self.neighbour, "pdfPages": [2, 3], "evidence": "Synthetic previous answer continues from page 2 to page 3."},
            {"problemId": "earlier-question", "pdfPages": [1, 2], "evidence": "Synthetic unrelated earlier answer."}],
            "unpairedPages": [], "unresolvedIssues": []}]}
        fixture.context["page_management"] = self.management
        self.requests, self.responses = [], []
        self.mode = "recover"
        fixture.structured = self.structured

    def structured(self, key, prompt, schema, images=(), max_tokens=None):
        self.requests.append([key, prompt, copy.deepcopy(schema), list(images), max_tokens])
        value = self.base.original_structured(key, prompt, schema, images, max_tokens=max_tokens)
        if "-" + self.target + "-" in key:
            reviewing = key.startswith("lesson-review-")
            if not reviewing and ("inventory-scope" not in key or self.mode == "still-unresolved"):
                value["verification"].update(status="needs_review", unresolvedIssues=[self.finding])
            if reviewing and self.mode == "deny-source":
                value.update(approved=False, issues=["追加した原画像から接続の矛盾が見つかりました。"])
        self.responses.append(copy.deepcopy(value))
        return value

    def context(self, findings=None, *, inventory=None, images=None, management=None, image_pages=None):
        candidate = copy.deepcopy(self.fixture.fixture["problems"][0])
        candidate["verification"].update(status="needs_review", unresolvedIssues=findings or [self.finding])
        return lesson_pipeline.inventory_scope_context(candidate, ["候補自身の数学・読みの検証が未解決です。"],
            self.fixture.inventory[0], inventory if inventory is not None else self.fixture.inventory,
            image_pages if image_pages is not None else [3, 4], images if images is not None else self.fixture.images,
            management if management is not None else self.management)

    def test_previous_solution_overlap_adds_original_source_in_order_to_generation_and_independent_audit(self):
        lesson, _ = self.fixture.generate()
        target_requests = [item for item in self.requests if "-" + self.target + "-" in item[0]]
        self.assertEqual(len(target_requests), 6, "Four old candidates, one scoped candidate and one independent review")
        expected_original = [lesson_pipeline.image_data(self.fixture.images[page]) for page in [3, 4]]
        self.assertTrue(all(item[3] == expected_original for item in target_requests[:4]))
        for request in target_requests[4:]:
            metadata = json.loads(request[1].rsplit("管理情報:", 1)[1])
            self.assertEqual(metadata["primaryImagePages"], [3, 4])
            self.assertEqual(metadata["currentImagePages"], [3, 4, 2])
            self.assertEqual(metadata["contextOnlyImagePages"], [2])
            self.assertEqual([item["id"] for item in metadata["samePageOtherProblems"]], [self.neighbour])
            self.assertEqual(metadata["observedSolutionLinks"], self.management["solutionPageRecords"][0]["links"][:2])
            self.assertEqual(request[3], [lesson_pipeline.image_data(self.fixture.images[page]) for page in [3, 4, 2]])
            self.assertIn("実画像で確認した対応", request[1])
            self.assertIn("再帰的に拡張しない", request[1])
        self.assertEqual(lesson["problems"], self.fixture.fixture["problems"])
        self.assertEqual(lesson["problems"][0]["sourceImageIds"], ["source-3", "source-4"])
        self.assertEqual([item["id"] for item in lesson["problems"]], [self.target, self.neighbour])

    def test_context_is_one_hop_preserves_primary_order_and_never_invents_solution_evidence(self):
        indirect = copy.deepcopy(self.fixture.inventory[1])
        indirect.update(id="earlier-question", pdfPages=[1], officialSolutionPages=[1, 2])
        inventory = [*self.fixture.inventory, indirect]
        before = copy.deepcopy(self.management)
        context, shown = self.context(inventory=inventory, image_pages=[4, 3])
        metadata = json.loads(context.rsplit("管理情報:", 1)[1])
        self.assertEqual(shown, [4, 3, 2])
        self.assertNotIn(1, shown)
        self.assertIn("earlier-question", metadata["allProblemIds"])
        self.assertNotIn("earlier-question", [item["id"] for item in metadata["samePageOtherProblems"]])
        self.assertEqual(metadata["observedSolutionLinks"], before["solutionPageRecords"][0]["links"][:2])
        self.assertEqual(self.management, before)
        empty, _ = self.context(management={})
        self.assertEqual(json.loads(empty.rsplit("管理情報:", 1)[1])["observedSolutionLinks"], [])

    def test_new_connection_gate_requires_named_real_overlapping_other_problem_and_page_uncertainty(self):
        for finding in (
            "前問missing-idのページ接続照合未完了。画像が必要。",
            f"前問{self.neighbour}-extraのページ接続照合未完了。画像が必要。",
            f"前問{self.target}のページ接続照合未完了。画像が必要。",
            f"前問{self.neighbour}の計算の答えが未確認。",
            f"前問{self.neighbour}の画像は読める。接続の確認は完了。",
            "対象問題の条件を判読できず答えが未解決。",
        ):
            with self.subTest(finding=finding):
                self.assertIsNone(self.context([finding]))
        nonoverlapping = copy.deepcopy(self.fixture.inventory)
        nonoverlapping[1].update(pdfPages=[1], officialSolutionPages=[1, 2])
        self.assertIsNone(self.context(inventory=nonoverlapping))
        self.assertIsNotNone(self.context())
        for relation in ("次問", "次の問題", "後の問題"):
            with self.subTest(relation=relation):
                self.assertEqual(self.context([f"{relation}{self.neighbour}の原画像と解説の接続照合が未完了。"])[1], [3, 4, 2])
        # The original broad scope gate also gains the previously omitted
        # solution-only neighbour, without changing how that gate is detected.
        self.assertEqual(self.context(list(GLOBAL_FINDINGS))[1], [3, 4, 2])

    def test_missing_previous_source_image_and_unresolved_connection_or_audit_deny_still_block(self):
        with self.assertRaises(StudioError) as caught:
            self.context(images={page: image for page, image in self.fixture.images.items() if page != 2})
        self.assertEqual(caught.exception.code, "lesson_source_images")
        for mode, reviews in [("still-unresolved", 0), ("deny-source", 2)]:
            with self.subTest(mode=mode):
                self.mode = mode
                self.requests.clear()
                with self.assertRaises(StudioError) as caught:
                    self.fixture.generate()
                self.assertEqual(caught.exception.code, "lesson_unresolved")
                scoped = [item for item in self.requests if "inventory-scope" in item[0]]
                self.assertEqual(len([item for item in scoped if not item[0].startswith("lesson-review-")]), 2)
                self.assertEqual(len([item for item in scoped if item[0].startswith("lesson-review-")]), reviews)

    def test_prior_candidates_and_completed_other_problem_reuse_cache_before_two_new_calls(self):
        expected, _ = self.fixture.generate()
        previous = [(request, response) for request, response in zip(self.requests, self.responses)
                    if "inventory-scope" not in request[0]]
        scoped_values = [response for request, response in zip(self.requests, self.responses) if "inventory-scope" in request[0]]
        studio = MemoryStudio()
        seed = RecordingAI(studio, [value for _, value in previous])
        for (key, prompt, schema, images, budget), _ in previous:
            seed.structured(key, prompt, schema, images, max_tokens=budget)
        before = copy.deepcopy(studio.values)
        def generate(client):
            fixture = self.fixture
            return lesson_pipeline.generate_lesson(fixture.pdf, Mock(structured=client.structured), studio,
                fixture.plan, fixture.directory, "Retain all questions and mathematical conditions.", "2026年9月号",
                fixture.root / "lesson.schema.json", generation_context=fixture.context)
        resumed = RecordingAI(studio, scoped_values)
        self.assertEqual(generate(resumed)[0], expected)
        self.assertEqual(len(resumed.scripted_session.calls), 2)
        self.assertEqual({key: studio.values[key] for key in before}, before)
        again = RecordingAI(studio, [])
        self.assertEqual(generate(again)[0], expected)
        self.assertEqual(again.scripted_session.calls, [])


if __name__ == "__main__":
    unittest.main()
