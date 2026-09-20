"""Visual repairs retain coverage and independently reviewed unaffected problems."""
import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import fitz
import jsonschema

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lesson_pipeline
from studio_common import StudioError


class LessonVisualRegenerationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.root = Path(__file__).resolve().parents[1]
        self.pdf = self.directory / "source.pdf"
        with fitz.open() as document:
            document.new_page()
            document.save(self.pdf)
        self.fixture = json.loads((self.root / "renderer/fixtures/geometry.json").read_text(encoding="utf-8"))
        for problem in self.fixture["problems"]:
            problem["sourceImageIds"] = ["source-1"]
        self.inventory = [{"id": problem["id"], "sectionId": problem["sectionId"],
            "sectionTitle": problem["sectionId"], "number": problem["number"], "title": problem["title"],
            "pdfPages": [1], "printedPages": ["1"], "subquestions": [
                {"id": item["id"], "label": item["label"], "conditions": problem["givens"], "goal": problem["goal"]}
                for item in problem["subquestions"]], "officialSolutionPages": [], "unresolvedIssues": []}
            for problem in self.fixture["problems"]]
        self.images = {1: self.root / "renderer/fixtures/geometry-source.png"}
        self.context, self.calls, self.studio = {}, [], Mock()
        self.plan = {"kind": "practice", "name": "fixture.pdf", "pages": [{"printedPages": ["1"]}]}
        self.deny_repair = False

    def structured(self, key, prompt, schema, images=(), max_tokens=None):
        self.calls.append((key, prompt))
        problem = next(problem for problem in self.fixture["problems"] if "-" + problem["id"] + "-" in key)
        if key.startswith("lesson-review-"):
            denied = self.deny_repair and "visual-repair" in key
            value = {"approved": not denied, "checkedSubquestionIds": [item["id"] for item in problem["subquestions"]],
                **{name: problem["verification"][name] for name in
                   ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")},
                "issues": ["独立検算で未解決"] if denied else []}
        else:
            value = copy.deepcopy(problem)
            if "visual-repair" in key:
                value["title"] += "（表示修正）"
        jsonschema.validate(value, schema)
        return copy.deepcopy(value)

    def generate(self, **kwargs):
        return lesson_pipeline.generate_lesson(self.pdf, Mock(structured=self.structured), self.studio,
            self.plan, self.directory, "Retain all questions and mathematical conditions.", "2026年9月号",
            self.root / "lesson.schema.json", generation_context=self.context, **kwargs)

    def feedback(self):
        return {self.fixture["problems"][0]["id"]: [{"issue": "image-1: ラベルが重なっています。",
            "images": [{"imageId": "image-1", "problemId": self.fixture["problems"][0]["id"]}]}]}

    def test_only_affected_problem_regenerates_and_receives_independent_review(self):
        with patch.object(lesson_pipeline, "inventory_questions", return_value=(self.inventory, self.images)) as inventory:
            original, _ = self.generate()
            initial_calls = len(self.calls)
            repaired, _ = self.generate(previous_lesson=original, visual_feedback=self.feedback(), repair_cycle=1)
        inventory.assert_called_once()
        self.assertEqual([item["id"] for item in repaired["problems"]], [item["id"] for item in original["problems"]])
        self.assertEqual(repaired["problems"][1:], original["problems"][1:])
        self.assertNotEqual(repaired["problems"][0]["title"], original["problems"][0]["title"])
        self.assertEqual(repaired["coverage"], original["coverage"])
        repair_calls = self.calls[initial_calls:]
        self.assertEqual(len(repair_calls), 2)
        self.assertTrue(repair_calls[1][0].startswith("lesson-review-"))
        self.assertTrue(all(key.endswith("-visual-repair-1") for key, _ in repair_calls))
        self.assertIn("ラベルが重なっています", repair_calls[0][1])

    def test_visual_repair_cannot_bypass_independent_math_rejection(self):
        with patch.object(lesson_pipeline, "inventory_questions", return_value=(self.inventory, self.images)):
            original, _ = self.generate()
            initial_calls = len(self.calls)
            self.deny_repair = True
            with self.assertRaises(StudioError) as caught:
                self.generate(previous_lesson=original, visual_feedback=self.feedback(), repair_cycle=1)
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        self.assertEqual(len(self.calls[initial_calls:]), 8)


if __name__ == "__main__":
    unittest.main()
