"""Real threads, bounded dispatch and deterministic, fail-closed lesson assembly."""
import copy
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor as RealExecutor
from unittest.mock import patch

import test_lesson_visual_regeneration as fixtures
import lesson_pipeline
from studio_common import StudioError


class ParentStudio:
    def __init__(self):
        self.parent = threading.get_ident()
        self.updates, self.active_checks = [], 0

    def ensure_active(self):
        assert threading.get_ident() == self.parent
        self.active_checks += 1

    def update(self, **value):
        assert threading.get_ident() == self.parent, "Workers must never write UI status"
        self.updates.append(value)


class RecordingAI:
    def __init__(self, problems, *, overlap=False, failure=False, close_failure=False):
        self.problems = {problem["id"]: problem for problem in problems}
        self.calls, self.completed, self.threads, self.pending_checkpoints = [], [], set(), {}
        self.lock = threading.Lock()
        self.barrier = threading.Barrier(2) if overlap else None
        self.third_started, self.peer_started, self.peer_drained = threading.Event(), threading.Event(), threading.Event()
        self.failure, self.close_failure = failure, close_failure
        self.opened, self.closed, self.active, self.peak_active = 0, 0, 0, 0

    def for_worker(self, stop_event):
        parent = self
        with self.lock:
            self.opened += 1
            self.active += 1
            self.peak_active = max(self.peak_active, self.active)

        class Worker:
            def structured(self, *args, **kwargs):
                if stop_event.is_set():
                    raise StudioError("peer_cancelled", "peer stopped")
                return parent.structured(*args, stop_event=stop_event, **kwargs)

            def close(self):
                with parent.lock:
                    parent.closed += 1
                    parent.active -= 1
                if parent.close_failure:
                    raise RuntimeError("cleanup error must not mask generation error")

        return Worker()

    def structured(self, key, prompt, schema, images=(), max_tokens=None, stop_event=None):
        identifier = next(identifier for identifier in self.problems if "-" + identifier + "-" in key)
        review = key.startswith("lesson-review-")
        with self.lock:
            self.calls.append((key, prompt, copy.deepcopy(schema), list(images), max_tokens))
            self.threads.add(threading.get_ident())
        if self.failure and not review:
            if identifier == "problem-1":
                assert self.peer_started.wait(5), "Second worker did not start"
                raise StudioError("lesson_unresolved", "original math failure", True)
            self.peer_started.set()
            assert stop_event.wait(5), "Peer cancellation was not signalled"
            self.pending_checkpoints[identifier] = "received-response-id"
            self.peer_drained.set()
            raise StudioError("peer_cancelled", "peer stopped")
        if self.barrier:
            if not review and identifier in ("problem-1", "problem-2"):
                self.barrier.wait(timeout=5)
            if review and identifier == "problem-1":
                assert self.third_started.wait(5), "A completed peer did not release a slot"
            if not review and identifier == "problem-3":
                self.third_started.set()
        problem = self.problems[identifier]
        if not review:
            return copy.deepcopy(problem)
        with self.lock:
            self.completed.append(identifier)
        return {"approved": True, "checkedSubquestionIds": [sub["id"] for sub in problem["subquestions"]],
            **{key: problem["verification"][key] for key in
               ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")}, "issues": []}


class SerialAI:
    def __init__(self, recording):
        self.recording = recording

    def structured(self, *args, **kwargs):
        return self.recording.structured(*args, **kwargs)


class LessonConcurrencyTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.LessonVisualRegenerationTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.problems, self.inventory = [], []
        for index in range(1, 5):
            problem = copy.deepcopy(self.fixture.fixture["problems"][0])
            entry = copy.deepcopy(self.fixture.inventory[0])
            problem["id"] = entry["id"] = f"problem-{index}"
            self.problems.append(problem)
            self.inventory.append(entry)

    def generate(self, ai, studio=None, **kwargs):
        fixture = self.fixture
        studio = studio or ParentStudio()
        with patch.object(lesson_pipeline, "inventory_questions", return_value=(self.inventory, fixture.images)):
            return lesson_pipeline.generate_lesson(fixture.pdf, ai, studio, fixture.plan, fixture.directory,
                "Retain all questions and mathematical conditions.", "2026年9月号", fixture.root / "lesson.schema.json", **kwargs)

    def test_two_workers_bound_submitted_futures_and_preserve_request_content_and_result_order(self):
        serial = RecordingAI(self.problems)
        serial_lesson, _ = self.generate(SerialAI(serial))
        ai, studio = RecordingAI(self.problems, overlap=True), ParentStudio()
        submitted, peak_pending = [], []

        class Executor(RealExecutor):
            def submit(self, *args, **kwargs):
                future = super().submit(*args, **kwargs)
                submitted.append(future)
                peak_pending.append(sum(not item.done() for item in submitted))
                return future

        with patch("concurrent.futures.ThreadPoolExecutor", Executor):
            lesson, _ = self.generate(ai, studio)
        self.assertEqual(lesson, serial_lesson)
        self.assertEqual([problem["id"] for problem in lesson["problems"]], [entry["id"] for entry in self.inventory])
        self.assertEqual(ai.completed[0], "problem-2", "A later inventory entry should finish first")
        self.assertEqual(len(ai.threads), 2)
        self.assertNotIn(studio.parent, ai.threads)
        self.assertEqual(max(peak_pending), 2)
        self.assertEqual(ai.peak_active, 2)
        self.assertEqual((ai.opened, ai.closed, ai.active), (4, 4, 0))
        self.assertEqual(sorted(ai.calls), sorted(serial.calls), "Keys, prompts, schemas, images and budgets must be byte-equivalent")
        self.assertEqual(len({call[0] for call in ai.calls}), len(ai.calls))
        self.assertEqual(studio.active_checks, 4)
        self.assertEqual([item["progress"] for item in studio.updates], sorted(item["progress"] for item in studio.updates))
        self.assertIn("4問の講義と検算が完了", studio.updates[-1]["message"])

    def test_peer_failure_stops_refill_drains_checkpoint_and_preserves_original_error(self):
        ai, studio = RecordingAI(self.problems, failure=True, close_failure=True), ParentStudio()
        with self.assertRaises(StudioError) as caught:
            self.generate(ai, studio)
        self.assertEqual(caught.exception.code, "lesson_unresolved")
        self.assertEqual(caught.exception.public_message, "original math failure")
        self.assertEqual(ai.opened, 2)
        self.assertEqual(ai.closed, 2)
        self.assertEqual(ai.active, 0)
        self.assertEqual(len(ai.calls), 2)
        self.assertTrue(ai.peer_drained.is_set())
        self.assertEqual(ai.pending_checkpoints, {"problem-2": "received-response-id"})
        self.assertTrue(all("4問の講義と検算が完了" not in item["message"] for item in studio.updates))
        self.assertFalse(any(thread.name.startswith("lesson_") for thread in threading.enumerate()))

    def test_visual_repair_dispatches_only_affected_candidates(self):
        original, _ = self.generate(SerialAI(RecordingAI(self.problems)))
        ai = RecordingAI(self.problems)
        repaired, _ = self.generate(ai, previous_lesson=original, repair_cycle=1,
            visual_feedback={"problem-2": [{"issue": "visible label overlap"}], "problem-4": [{"issue": "visible label overlap"}]})
        self.assertEqual(repaired, original)
        self.assertEqual(ai.opened, 2)
        self.assertEqual(ai.closed, 2)
        self.assertTrue(all("-problem-2-" in call[0] or "-problem-4-" in call[0] for call in ai.calls))
        self.assertEqual(len(ai.calls), 4)

    def test_duplicate_inventory_ids_block_before_any_worker_or_request(self):
        self.inventory[1]["id"] = self.inventory[0]["id"]
        ai = RecordingAI(self.problems)
        with self.assertRaises(StudioError) as caught:
            self.generate(ai)
        self.assertEqual(caught.exception.code, "lesson_coverage")
        self.assertEqual(ai.opened, 0)
        self.assertEqual(ai.calls, [])


if __name__ == "__main__":
    unittest.main()
