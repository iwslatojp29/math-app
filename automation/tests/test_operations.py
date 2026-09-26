"""Offline separation, resume provenance, and old HTML ownership contracts."""
import copy
import hashlib
import sys
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import pymupdf as fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import run_monthly
from studio_common import (ADVANCED_FOLDER, PRACTICE_FOLDER, SOURCE_FOLDER, DriveClient,
                           StudioError, digest_file, legacy_html_ownership)


class MemoryStudio:
    job_id = "operation-fixture"
    def __init__(self):
        self.values, self.updates = {}, []
    def checkpoint(self, key, value=...):
        if value is ...:
            return copy.deepcopy(self.values.get(key))
        self.values[key] = copy.deepcopy(value)
    def ensure_active(self):
        pass
    def update(self, **changes):
        self.updates.append(copy.deepcopy(changes))


class OperationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        pdf = self.directory / "fixture.pdf"
        with fitz.open() as doc:
            for number in range(3):
                doc.new_page(width=240, height=160).insert_text((15, 30), f"Synthetic page {number + 1}")
            doc.save(pdf)
        self.pdf = pdf.read_bytes()
        self.studio = MemoryStudio()

    def job(self, operation="extract", kind="practice"):
        folder = SOURCE_FOLDER if operation == "extract" else {"practice": PRACTICE_FOLDER, "advanced": ADVANCED_FOLDER}[kind]
        job = {"id": self.studio.job_id, "operation": operation, "sourceKind": kind if operation == "html" else "source",
               "status": "queued", "model": "fixture-model", "modelMaxOutputTokens": 48000, "specVersion": "v1",
               "folders": {"source": SOURCE_FOLDER, "practice": PRACTICE_FOLDER, "advanced": ADVANCED_FOLDER, "html": PRACTICE_FOLDER},
               "source": {"id": "selected-pdf", "name": "2026年9月号_fixture.PDF", "mimeType": "application/pdf",
                          "size": str(len(self.pdf)), "modifiedTime": "2026-09-26T00:00:00Z",
                          "md5Checksum": hashlib.md5(self.pdf).hexdigest(), "parents": [folder]}}
        return job

    def run_patches(self, job):
        stack = ExitStack()
        self.addCleanup(stack.close)
        drive = Mock()
        drive.metadata.side_effect = lambda identifier: copy.deepcopy(job["source"]) if identifier == job["source"]["id"] else {
            "id": identifier, "mimeType": "application/vnd.google-apps.folder"}
        drive.download.side_effect = lambda identifier, target: target.write_bytes(self.pdf)
        drive.find.return_value = []
        drive.upload.side_effect = lambda path, name, folder, mime, properties, **kwargs: {
            "id": "artifact-" + properties["mathAppKind"], "name": name, "mimeType": mime, "parents": [folder]}
        stack.enter_context(patch.object(run_monthly, "DriveClient", return_value=drive))
        ai = stack.enter_context(patch.object(run_monthly, "ResponsesClient", return_value=Mock()))
        classification = {"issue": {"year": 2026, "month": 9, "evidence": ["Synthetic issue"], "unresolvedIssues": []},
            "pages": [{"pdfPage": number, "printedPages": [str(number + 10)], "labels": [label],
                       "headingEvidence": "Fixture", "boundaryEvidence": "Fixture"}
                      for number, label in [(1, "practice_questions"), (2, "practice_solutions"), (3, "advanced_questions")]]}
        classify = stack.enter_context(patch.object(run_monthly, "classify_pdf", return_value=(classification, {})))
        extract = stack.enter_context(patch.object(run_monthly, "extract_pdf", wraps=run_monthly.extract_pdf))
        def lesson(pdf_path, _ai, _studio, plan, directory, *_args, **_kwargs):
            self.assertEqual(pdf_path.read_bytes(), self.pdf)
            self.assertEqual([page["pdfPage"] for page in plan["pages"]], [1, 2, 3])
            self.assertTrue(plan["scanAllSolutionPages"])
            self.assertNotIn("bookletIssue", plan)
            self.assertTrue(all(page["printedPages"] == [] and page["labels"] == [] for page in plan["pages"]))
            target = directory / "lesson.html"
            target.write_text("<!doctype html><title>Synthetic lesson</title>", encoding="utf-8")
            return target, {"browserChecksPassed": True}
        generate = stack.enter_context(patch.object(run_monthly, "generate_verified_lesson", side_effect=lesson))
        publish = stack.enter_context(patch.object(run_monthly, "publish_and_verify", return_value={"contentVerified": True}))
        return SimpleNamespace(drive=drive, ai=ai, classify=classify, extract=extract, generate=generate, publish=publish)

    def test_extraction_and_legacy_resume_never_generate_or_publish(self):
        for legacy in (False, True):
            with self.subTest(legacy=legacy):
                self.studio = MemoryStudio()
                job = self.job()
                if legacy:
                    job.pop("operation")
                    job["stage"] = "lesson_inventory"
                    job["result"] = {"outputs": [{"kind": "practice", "html": {"id": "old-html"}}]}
                    self.studio.values["source-integrity"] = {"sha256": hashlib.sha256(self.pdf).hexdigest(),
                                                              "id": job["source"]["id"], "model": job["model"], "specVersion": "v1"}
                calls = self.run_patches(job)
                result = run_monthly.run_job(self.studio, job, "fake", self.directory)
                self.assertEqual(result["errors"], [])
                self.assertEqual(result["operation"], "extract")
                self.assertEqual(calls.extract.call_count, 2)
                calls.generate.assert_not_called()
                calls.publish.assert_not_called()
                self.assertEqual([call.args[3] for call in calls.drive.upload.call_args_list], ["application/pdf"] * 2)
                self.assertEqual(self.studio.updates[-1]["status"], "completed")
                self.assertTrue(all("html" not in output for output in result["outputs"]))
                self.assertFalse(any(update.get("stage") in ("lesson_inventory", "publishing", "validating") for update in self.studio.updates))

    def test_html_uses_only_selected_complete_pdf_and_publishes_one_html(self):
        for kind in ("practice", "advanced"):
            with self.subTest(kind=kind):
                self.studio = MemoryStudio()
                job = self.job("html", kind)
                calls = self.run_patches(job)
                result = run_monthly.run_job(self.studio, job, "fake", self.directory)
                calls.classify.assert_not_called()
                calls.extract.assert_not_called()
                calls.generate.assert_called_once()
                calls.publish.assert_called_once()
                self.assertEqual(calls.publish.call_args.args[3], job["source"]["id"])
                self.assertEqual(calls.publish.call_args.args[2], "2026年9月号_fixture_講義アニメーション.html")
                self.assertEqual([call.args[0] for call in calls.drive.download.call_args_list], ["selected-pdf"])
                upload = calls.drive.upload.call_args
                self.assertEqual(upload.args[3], "text/html")
                self.assertEqual(upload.args[4]["mathAppSource"], job["source"]["id"])
                self.assertEqual(upload.args[4]["mathAppSourceSha"], hashlib.sha256(self.pdf).hexdigest())
                self.assertEqual(upload.args[4]["mathAppKind"], "html-" + kind)
                self.assertEqual(calls.ai.call_args.kwargs["max_output_tokens_limit"], 48000)
                self.assertEqual(len(result["outputs"]), 1)
                self.assertNotIn("pdf", result["outputs"][0])
                self.assertNotIn("classification", self.studio.values)
                self.assertEqual(self.studio.values["source-integrity"]["operation"], "html")
                self.assertEqual(self.studio.values["source-integrity"]["sourceKind"], kind)

    def test_resume_rejects_changed_operation_source_kind_id_model_spec_or_hash(self):
        for field, value in [("operation", "extract"), ("sourceKind", "advanced"), ("id", "another-pdf"),
                             ("model", "another-model"), ("specVersion", "v2"), ("sha256", "changed")]:
            with self.subTest(field=field):
                self.studio = MemoryStudio()
                job = self.job("html")
                state = {"operation": "html", "sourceKind": "practice", "id": "selected-pdf", "model": "fixture-model",
                         "specVersion": "v1", "sha256": hashlib.sha256(self.pdf).hexdigest()}
                state[field] = value
                self.studio.values["source-integrity"] = state
                calls = self.run_patches(job)
                with self.assertRaises(StudioError):
                    run_monthly.run_job(self.studio, job, "fake", self.directory)
                calls.generate.assert_not_called()
                calls.classify.assert_not_called()
                calls.drive.upload.assert_not_called()
                calls.publish.assert_not_called()

    def test_operation_and_source_folder_fail_closed(self):
        job = self.job("html")
        for operation, source_kind in [("both", "practice"), (None, "practice"), ("html", None), ("html", "source")]:
            with self.subTest(operation=operation, source_kind=source_kind), self.assertRaises(StudioError):
                run_monthly.validate_job({**job, "operation": operation, "sourceKind": source_kind}, job["id"])
        drive = Mock()
        for parents in ([SOURCE_FOLDER], [ADVANCED_FOLDER], ["unrelated"]):
            with self.subTest(parents=parents), self.assertRaises(StudioError):
                drive.metadata.return_value = {**job["source"], "parents": parents}
                run_monthly.check_source(drive, job["source"], operation="html", source_kind="practice")
        drive.metadata.return_value = job["source"]
        with self.assertRaises(StudioError) as error:
            run_monthly.check_source(drive, job["source"])
        self.assertEqual(error.exception.code, "source_is_output")

    def test_no_issue_metadata_is_invented_for_an_unnamed_pdf(self):
        self.assertEqual(run_monthly.filename_issue("日日の演習.PDF"), (None, None, "年月未確認"))


class LegacyOwnershipTests(unittest.TestCase):
    def setUp(self):
        self.proof = {"previousJobId": "old-job", "previousSourceId": "old-monthly", "pdfId": "selected-pdf", "kind": "practice",
                      "htmlFileId": "old-html", "htmlFileName": "lesson.html", "htmlParentId": PRACTICE_FOLDER}
        self.current = {"id": "old-html", "name": "lesson.html", "mimeType": "text/html", "parents": [PRACTICE_FOLDER],
                        "md5Checksum": "a" * 32, "appProperties": {"mathAppSource": "old-monthly", "mathAppKind": "html-practice",
                                                                  "mathAppSavedMd5": "a" * 32}}
        self.properties = {"mathAppSource": "selected-pdf", "mathAppKind": "html-practice"}

    def allowed(self, current=None, proof=None):
        return legacy_html_ownership(current or self.current, "lesson.html", PRACTICE_FOLDER, "text/html", self.properties,
                                     self.proof if proof is None else proof)

    def test_proven_exact_artifact_can_transfer_but_no_other_or_edited_artifact_can(self):
        self.assertTrue(self.allowed())
        for field, value in [("pdfId", "other-pdf"), ("htmlFileId", "other-html"), ("htmlFileName", "other.html"),
                             ("htmlParentId", ADVANCED_FOLDER), ("previousSourceId", "other-source"),
                             ("kind", "advanced"), ("previousJobId", ""), ("previousJobId", None), ("htmlSavedMd5", "b" * 32)]:
            with self.subTest(field=field):
                self.assertFalse(self.allowed(proof={**self.proof, field: value}))
        for field, value in [("md5Checksum", "b" * 32), ("trashed", True), ("parents", [ADVANCED_FOLDER])]:
            with self.subTest(field=field):
                self.assertFalse(self.allowed(current={**self.current, field: value}))
        self.assertFalse(self.allowed(proof={}))

    def test_drive_rechecks_current_content_before_any_upload_and_migrates_source_property(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "lesson.html"
            path.write_text("new lesson", encoding="utf-8")
            properties = {**self.properties, "mathAppSavedMd5": digest_file(path, "md5")}
            for edited in (False, True):
                with self.subTest(edited=edited):
                    drive = DriveClient(MemoryStudio())
                    drive.metadata = Mock(return_value={**self.current, **({"md5Checksum": "b" * 32} if edited else {})})
                    drive.request = Mock(side_effect=[SimpleNamespace(headers={"Location": "https://www.googleapis.com/upload-fixture"}),
                                                     SimpleNamespace(status_code=200)])
                    drive.verify_saved = Mock(return_value={**self.current, "appProperties": properties})
                    if edited:
                        with self.assertRaises(StudioError) as error:
                            drive.upload(path, "lesson.html", PRACTICE_FOLDER, "text/html", properties, "old-html", legacy_provenance=self.proof)
                        self.assertEqual(error.exception.code, "drive_name_conflict")
                        drive.request.assert_not_called()
                    else:
                        drive.upload(path, "lesson.html", PRACTICE_FOLDER, "text/html", properties, "old-html", legacy_provenance=self.proof)
                        self.assertEqual(drive.request.call_args_list[0].args[0], "PATCH")
                        self.assertEqual(drive.request.call_args_list[0].kwargs["json_value"]["appProperties"]["mathAppSource"], "selected-pdf")


if __name__ == "__main__":
    unittest.main()
