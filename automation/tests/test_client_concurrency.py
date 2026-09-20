"""Worker client isolation and cooperative-stop tests; all HTTP is in memory."""
import sys
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from studio_common import ResponsesClient, StudioClient, StudioError


SCHEMA = {"type": "object", "properties": {"ok": {"type": "boolean"}},
          "required": ["ok"], "additionalProperties": False}


class Reply:
    status_code, ok = 200, True

    def __init__(self, value):
        self.value = value

    def json(self):
        return self.value


def completed():
    return Reply({"id": "resp_fixture", "status": "completed", "output": [
        {"content": [{"type": "output_text", "text": '{"ok":true}'}]}]})


class Session:
    def __init__(self, replies=()):
        self.replies, self.calls, self.closed = list(replies), [], 0

    def request(self, method, url, **kwargs):
        self.calls.append((method, url, kwargs))
        return self.replies.pop(0)

    def close(self):
        self.closed += 1


class MemoryStudio:
    def __init__(self):
        self.values, self.updates, self.active_checks = {}, [], 0
        self.job_id, self.deadline = "job-fixture", 123.0

    def checkpoint(self, key, value=...):
        if value is ...:
            return self.values.get(key)
        self.values[key] = value

    def ensure_active(self):
        self.active_checks += 1

    def update(self, **changes):
        self.updates.append(changes)


class WorkerClientTests(unittest.TestCase):
    def parent(self, studio=None, session=None):
        return ResponsesClient("fixture-key", "selected-model", studio or MemoryStudio(),
                               session=session or Session(), max_output_tokens_limit=128000)

    def fork(self, parent, stop=None, session=None):
        stop = stop or threading.Event()
        session = session or Session()
        with patch("studio_common.requests.Session", return_value=session):
            return parent.for_worker(stop), stop, session

    def test_workers_have_independent_sessions_and_close_only_their_own(self):
        parent = self.parent()
        first, _, session1 = self.fork(parent)
        second, _, session2 = self.fork(parent)
        self.assertIsNot(session1, session2)
        self.assertIsNot(first.session, parent.session)
        self.assertIsNot(first._session_lock, second._session_lock)
        self.assertEqual((first.key, first.model, first.output_limit),
                         (parent.key, parent.model, parent.output_limit))
        first.close()
        self.assertEqual((session1.closed, session2.closed, parent.session.closed), (1, 0, 0))
        second.close()

    def test_worker_preserves_first_request_and_checkpoint_identity(self):
        baseline = self.parent(session=Session([completed()]))
        parent = self.parent()
        worker, _, session = self.fork(parent, session=Session([completed()]))
        images = ["data:image/png;base64,fixture"]
        expected = baseline.structured("lesson-fixture", "fixture prompt", SCHEMA, images, max_tokens=27000)
        actual = worker.structured("lesson-fixture", "fixture prompt", SCHEMA, images, max_tokens=27000)
        self.assertEqual(actual, expected)
        self.assertEqual(session.calls, baseline.session.calls)
        self.assertEqual(parent.studio.values, baseline.studio.values)
        self.assertEqual(parent.session.calls, [])

    def test_shared_deadline_is_not_restarted_and_expiry_still_stops_worker(self):
        studio = StudioClient("https://fixture.invalid", "fixture-token", "job-fixture",
                              Session([Reply({"job": {"status": "running"}})]))
        studio.deadline = 0.0
        worker, _, _ = self.fork(self.parent(studio))
        self.assertEqual(worker.studio.deadline, 0.0)
        with patch.dict("os.environ", {}, clear=True), self.assertRaises(StudioError) as caught:
            worker.studio.ensure_active()
        self.assertEqual(caught.exception.code, "continue_later")
        studio.deadline = 987.0
        self.assertEqual(worker.studio.deadline, 987.0)
        self.assertEqual(worker.studio.job_id, studio.job_id)

    def test_parent_error_identity_survives_stop_during_active_check(self):
        parent = self.parent()
        stop = threading.Event()
        original = StudioError("runner_conflict", "Fixture lease ended.")

        def ensure_active():
            stop.set()
            raise original

        parent.studio.ensure_active = ensure_active
        worker, _, _ = self.fork(parent, stop)
        with self.assertRaises(StudioError) as caught:
            worker.studio.ensure_active()
        self.assertIs(caught.exception, original)

    def test_stopped_worker_does_not_read_cache_or_start_http(self):
        parent = self.parent()
        worker, stop, session = self.fork(parent)
        stop.set()
        with patch.object(parent.studio, "checkpoint") as checkpoint:
            for operation in (lambda: worker.structured("fixture", "prompt", SCHEMA),
                              lambda: worker._request("GET", "/resp_fixture"),
                              worker.studio.ensure_active):
                with self.assertRaises(StudioError) as caught:
                    operation()
                self.assertEqual(caught.exception.code, "peer_cancelled")
            checkpoint.assert_not_called()
        self.assertEqual(session.calls, [])
        self.assertEqual(parent.studio.active_checks, 0)

    def test_checkpoints_remain_writable_after_stop_but_worker_progress_is_silent(self):
        parent = self.parent()
        worker, stop, _ = self.fork(parent)
        stop.set()
        worker.studio.checkpoint("fixture", {"responseId": "resp_fixture"})
        self.assertEqual(worker.studio.checkpoint("fixture"), {"responseId": "resp_fixture"})
        worker.studio.update(status="running", progress=50)
        self.assertEqual(parent.studio.updates, [])
        parent.studio.update(status="failed")
        self.assertEqual(parent.studio.updates, [{"status": "failed"}])

    def test_poll_sleep_wakes_when_peer_stops(self):
        worker, stop, _ = self.fork(self.parent())
        entered, failures = threading.Event(), []

        def wait_for_poll():
            entered.set()
            try:
                worker.sleeper(10)
            except StudioError as error:
                failures.append(error)

        thread = threading.Thread(target=wait_for_poll)
        thread.start()
        self.assertTrue(entered.wait(1))
        stopped_at = time.monotonic()
        stop.set()
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertLess(time.monotonic() - stopped_at, 1)
        self.assertEqual([error.code for error in failures], ["peer_cancelled"])

    def test_shared_studio_session_never_has_concurrent_requests(self):
        class OverlapSession:
            def __init__(self):
                self.lock, self.active, self.maximum = threading.Lock(), 0, 0
                self.overlap = threading.Event()

            def request(self, method, url, **kwargs):
                with self.lock:
                    self.active += 1
                    self.maximum = max(self.maximum, self.active)
                    if self.active > 1:
                        self.overlap.set()
                self.overlap.wait(0.03)
                with self.lock:
                    self.active -= 1
                return Reply({"job": {"status": "running"}, "value": None})

        session = OverlapSession()
        studio = StudioClient("https://fixture.invalid", "fixture-token", "job-fixture", session)
        parent = self.parent(studio)
        workers = [self.fork(parent)[0] for _ in range(2)]
        start = threading.Barrier(2)

        def work(index):
            start.wait(timeout=2)
            workers[index].studio.ensure_active()
            workers[index].studio.checkpoint("fixture-" + str(index), {"responseId": "resp_fixture"})

        with patch.dict("os.environ", {}, clear=True), ThreadPoolExecutor(max_workers=2) as executor:
            list(executor.map(work, range(2)))
        self.assertEqual(session.maximum, 1)


if __name__ == "__main__":
    unittest.main()
