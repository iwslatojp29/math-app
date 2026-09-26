"""GitHub Actions entry point. All PDFs/images/intermediate lessons stay in a temporary directory."""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlparse

import requests
import jsonschema

from studio_common import (ADVANCED_FOLDER, PRACTICE_FOLDER, SOURCE_FOLDER, DriveClient, ResponsesClient,
    RETRYABLE_ERRORS, SAFE_ID, StudioClient, StudioError, digest_file, json_bytes, key_for, legacy_html_ownership, mask_secret, require)
from pdf_pipeline import (BOOL, STR, arr, obj, classify_pdf, extract_pdf, image_data, open_pdf,
    plans_from_classification, same_pdf_visual_content)
from lesson_pipeline import generate_lesson, render_lesson

ROOT = Path(__file__).resolve().parent
VISUAL_REVIEW = obj({"approved": BOOL, "checkedImages": arr(STR), "issues": arr(STR)})
MAX_VISUAL_REPAIRS = 2


def safe_visual_issues(values, limit=24):
    """Bound model-authored observations before private checkpoints/owner status.

    These strings are never provider error bodies and never go to public logs.
    Treat them as untrusted text even though the reviewer receives no credentials.
    """
    if not isinstance(values, list):
        return []
    issues = []
    for value in values:
        if not isinstance(value, str) or not value.strip():
            continue
        value = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", value)
        value = re.sub(r"(?i)\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|ya29\.[A-Za-z0-9._-]+)", "[redacted]", value)
        value = re.sub(r"(?i)\b(?:bearer\s+|api[_ -]?key\s*[:=]\s*|access[_ -]?token\s*[:=]\s*|refresh[_ -]?token\s*[:=]\s*)[^\s,;]+", "[redacted]", value)
        value = re.sub(r"https?://[^\s<>]+[?&](?:sig|token|key|credential|access_token)=[^\s<>]+", "[redacted URL]", value, flags=re.I)
        value = value.strip()[:1500]
        if value and value not in issues:
            issues.append(value)
        if len(issues) >= limit:
            break
    return issues


class VisualQAError(StudioError):
    def __init__(self, issues, problem_feedback, *, repairable=True, metadata=None):
        super().__init__("visual_qa", "図・ラベル・説明の実表示に未解決事項があり、公開を保留しました。", True)
        self.details = safe_visual_issues(issues)
        self.problem_feedback = problem_feedback
        self.repairable = repairable and bool(problem_feedback) and bool(self.details)
        self.metadata = (metadata or [])[:24]


def validate_job(job, expected_id):
    require(job.get("id") == expected_id and isinstance(job.get("source"), dict))
    source = job["source"]
    require(bool(SAFE_ID.fullmatch(source.get("id", ""))) and source.get("mimeType") == "application/pdf"
            and isinstance(source.get("name"), str) and source["name"].lower().endswith(".pdf"))
    require(job.get("folders") == {"source": SOURCE_FOLDER, "practice": PRACTICE_FOLDER,
            "advanced": ADVANCED_FOLDER, "html": PRACTICE_FOLDER})
    require(isinstance(job.get("model"), str) and bool(job["model"])
            and isinstance(job.get("specVersion"), str) and bool(job["specVersion"]))
    operation = job.get("operation", "extract")
    require(operation in ("extract", "html"), "invalid_operation", "開始する作業を選び直してください。", True)
    if operation == "html":
        require(job.get("sourceKind") in ("practice", "advanced"), "invalid_source_kind", "解説対象PDFの保存先を確認できません。", True)
    require(not job.get("operationBlocked"), "operation_mismatch", "作業を選び直して再開してください。", True)
    require(job.get("status") != "cancelled", "cancelled", "処理は停止されています。")
    return source


def check_source(drive, expected, *, operation="extract", source_kind=None):
    actual = drive.metadata(expected["id"])
    require(actual and actual.get("mimeType") == "application/pdf" and not actual.get("trashed"),
            "source_unavailable", "選択した元PDFを取得できません。", True)
    for field in ("name", "size", "modifiedTime", "md5Checksum"):
        if expected.get(field) is not None:
            require(str(expected[field]) == str(actual.get(field)), "source_changed", "選択後に元PDFが変更されました。新しいジョブとして選び直してください。", True)
    if operation == "html":
        folder = {"practice": PRACTICE_FOLDER, "advanced": ADVANCED_FOLDER}.get(source_kind)
        require(folder and folder in actual.get("parents", []), "source_folder",
                "解説対象PDFが選択した切り出し済みPDFの保存先にありません。", True)
        return actual
    require(operation == "extract", "invalid_operation", "開始する作業を選び直してください。", True)
    # Confirm ancestry without entering generated output folders or unrelated trees.
    parents, seen = list(actual.get("parents", [])), set()
    allowed = False
    while parents and len(seen) < 30:
        parent = parents.pop()
        if parent == SOURCE_FOLDER:
            allowed = True
            break
        require(parent not in (PRACTICE_FOLDER, ADVANCED_FOLDER), "source_is_output", "切り出し済みPDFを冊子の元PDFとして処理できません。", True)
        if parent in seen:
            continue
        seen.add(parent)
        metadata = drive.metadata(parent)
        parents.extend(metadata.get("parents", []))
    require(allowed, "source_folder", "元PDFが指定された月間号フォルダ内にありません。", True)
    return actual


def verify_folder(drive, folder):
    metadata = drive.metadata(folder)
    require(metadata.get("mimeType") == "application/vnd.google-apps.folder" and not metadata.get("trashed"),
            "destination_folder", "指定されたGoogle Drive保存先を確認できません。", True)


def safe_saved_file(metadata, action):
    return {"id": metadata["id"], "name": metadata["name"], "mimeType": metadata["mimeType"],
            "size": metadata.get("size"), "modifiedTime": metadata.get("modifiedTime"),
            "parents": metadata.get("parents", []), "action": action,
            "url": "https://drive.google.com/file/d/" + metadata["id"] + "/view"}


def save_verified(drive, studio, path, name, folder, mime, source, source_sha, kind, spec_version, directory, *, legacy_provenance=None):
    studio.ensure_active()
    verify_folder(drive, folder)
    candidates = drive.find(folder, name)
    require(len(candidates) <= 1, "drive_duplicate_names", "同名ファイルが複数あるため、対象を特定できません。", True)
    md5 = digest_file(path, "md5")
    existing_id = None
    if candidates:
        existing = candidates[0]
        require(existing.get("mimeType") == mime, "drive_name_conflict", "同名の別形式ファイルがあるため、上書きを保留しました。", True)
        if existing.get("md5Checksum") == md5:
            verified = drive.verify_saved(existing["id"], name, folder, mime, path)
            return safe_saved_file(verified, "existing")
        if mime == "application/pdf":
            existing_path = directory / "existing-comparison.pdf"
            drive.download(existing["id"], existing_path)
            require(not existing.get("md5Checksum") or digest_file(existing_path, "md5") == existing["md5Checksum"],
                    "drive_changed", "比較中に既存PDFが変更されました。再開してください。")
            if same_pdf_visual_content(existing_path, path):
                current = drive.metadata(existing["id"])
                require(current.get("md5Checksum") == existing.get("md5Checksum") and name == current.get("name")
                        and folder in current.get("parents", []), "drive_changed", "既存PDFが変更されました。再開してください。")
                return safe_saved_file(current, "existing")
        props = existing.get("appProperties", {})
        require((props.get("mathAppSource") == source["id"] or legacy_html_ownership(existing, name, folder, mime,
                    {"mathAppSource": source["id"], "mathAppKind": kind}, legacy_provenance)) and props.get("mathAppKind") == kind
                and props.get("mathAppSavedMd5") == existing.get("md5Checksum"),
                "drive_name_conflict", "同名の既存ファイルは内容や編集者を特定できず、上書きを保留しました。", True)
        existing_id = existing["id"]
    properties = {"mathAppSource": source["id"], "mathAppKind": kind,
                  "mathAppSavedMd5": md5, "mathAppSourceSha": source_sha, "mathAppSpec": spec_version}
    upload_options = {"existing_id": existing_id}
    if legacy_provenance is not None:
        upload_options["legacy_provenance"] = legacy_provenance
    metadata = drive.upload(path, name, folder, mime, properties, **upload_options)
    return safe_saved_file(metadata, "updated" if existing_id else "created")


def browser_and_visual_qa(html, directory, ai, studio, *, cycle=0, on_rejection=None):
    studio.ensure_active()
    qa_dir = directory / "browser-qa"
    qa_dir.mkdir(exist_ok=True)
    result = subprocess.run(["node", str(ROOT / "renderer" / "verify-lesson.mjs"),
                             "--html", str(html), "--out", str(qa_dir)],
                            capture_output=True, text=True, check=False, timeout=600)
    require(result.returncode == 0, "browser_qa", "表示・音声操作・印刷の自動検証で問題があり、公開を保留しました。", True)
    try:
        qa = json.loads(result.stdout)
    except ValueError:
        raise StudioError("browser_qa", "ブラウザ検証の結果を確認できません。", True) from None
    require(qa.get("ok") is True and qa.get("screenshots"), "browser_qa", "実表示の検証結果を確認できません。", True)
    screenshots = qa["screenshots"]
    html_sha = digest_file(html)
    all_issues, feedback, rejected_images = [], {}, []
    for start in range(0, len(screenshots), 6):
        batch = screenshots[start:start + 6]
        labels, images, image_metadata = [], [], []
        for index, item in enumerate(batch, start=start + 1):
            path = Path(item["path"]).resolve()
            require(path.is_relative_to(qa_dir.resolve()), "browser_qa", "検証画像の保存場所を確認できません。")
            require(isinstance(item.get("problemId"), str) and bool(SAFE_ID.fullmatch(item["problemId"])),
                    "browser_qa", "検証画像の対象問題を確認できません。", True)
            labels.append("image-" + str(index))
            mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
            images.append("data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode())
            image_metadata.append({"imageId": labels[-1], **{key: value for key, value in item.items()
                if key in {"problemId", "cueId", "viewport", "fontSize", "displayState"}}})
        prompt = ("教材HTMLの実ブラウザ画面を、スクリーンショットで立証できる可読性だけ検証してください。"
            "確実な図のラベル/数値/補助線/角印の重なりや欠け、読めない字、図が小さいままの過大余白、"
            "スクロールしても読めない実際の欠けを点検します。寸法・操作・印刷は別のブラウザ自動検証に合格しています。"
            "各画像は指定cueと文字サイズの一時点です。visibleIdsにない図形や後の答え、閉じた詳細の不在は欠落ではありません。"
            "本文・横画面の説明欄は独立スクロールです。画面の下端より先の内容やスクロール可能な字幕を欠けと判定しない。"
            "幅390/768の操作行は横スクロールで、左右端のボタンが同時に見えなくても不具合ではありません。"
            "displayStateのclient/scroll寸法と位置も根拠にします。問題番号一覧や本文の縦スクロールも正常です。"
            "これは実機試験・音声試聴・全cueの意味検証ではありません。これらの未実施はissuesにしない。"
            "好みの配置や確認不能な推測では否認しない。具体的な欠陥のみ画像ID・対象・観測事実をissuesに書く。"
            "各issueは必ずimage-Nを含める。問題がなければapproved=true,issues=[]。"
            "checkedImagesは今回渡した全画像IDを順序どおり正確に返す。画像順とID:"
            + json_bytes(list(zip(labels, image_metadata))).decode())
        review = None
        # Missing review coverage is a reviewer/schema failure, not evidence
        # that correct problem data should be regenerated.
        for review_attempt in range(2):
            try:
                candidate = ai.structured(f"visual-v2-{html.parent.name}-{html_sha[:16]}-{start}-{review_attempt}",
                    prompt + ("\n前回は画像IDの確認範囲または所見の形式が不正でした。全画像を再確認し、checkedImagesをこの配列と完全一致させてください:"
                              + json_bytes(labels).decode() if review_attempt else ""),
                    VISUAL_REVIEW, images, max_tokens=8000)
            except StudioError as error:
                if error.code != "model_schema":
                    raise
                candidate = None
            valid_shape = True
            try:
                jsonschema.validate(candidate, VISUAL_REVIEW)
            except jsonschema.ValidationError:
                valid_shape = False
            if valid_shape and candidate["checkedImages"] == labels:
                observations = safe_visual_issues(candidate["issues"])
                mentioned = [set(re.findall(r"(?<![A-Za-z0-9_-])image-\d+(?![A-Za-z0-9_-])", issue)) for issue in observations]
                grounded = all(ids and ids <= set(labels) for ids in mentioned)
                if grounded and (candidate["approved"] or observations):
                    review = {**candidate, "issues": observations}
                    break
            coverage_error = VisualQAError(
                ["検証者の画像ID確認範囲または観測所見の形式が不足しています。画像の再確認を行います。"], {},
                repairable=False, metadata=image_metadata)
            if on_rejection:
                on_rejection(coverage_error)
        if review is None:
            raise VisualQAError(["検証画像の全件確認を2回の照合で確定できませんでした。教材データを変更せず公開を保留しました。"],
                                {}, repairable=False, metadata=image_metadata)
        if review["approved"] and not review["issues"]:
            continue
        for issue in review["issues"]:
            selected = [image_metadata[index] for index, label in enumerate(labels) if label in re.findall(r"(?<![A-Za-z0-9_-])image-\d+(?![A-Za-z0-9_-])", issue)]
            for problem_id in {item["problemId"] for item in selected}:
                feedback.setdefault(problem_id, []).append({"issue": issue, "images": [item for item in selected if item["problemId"] == problem_id]})
        all_issues.extend(review["issues"])
        rejected_images.extend(image_metadata)
        if on_rejection:
            on_rejection(VisualQAError(all_issues, feedback, metadata=rejected_images))
    if all_issues:
        raise VisualQAError(all_issues, feedback, metadata=rejected_images)
    return {"browserChecksPassed": True, "visualImagesReviewed": len(screenshots),
            "actualDeviceTested": False, "actualVoiceAuditioned": False, "visualRepairCycles": cycle}


def generate_verified_lesson(pdf_path, ai, studio, plan, directory, specification, year_month, schema_path,
                             *, on_visual_issue=None):
    """Repair at most twice; every version passes fresh browser + visual review.

    Model requests keep deterministic task keys, source images and prompts.
    Resuming reuses all approved inventory, unchanged problems and completed
    repair/review checkpoints rather than purchasing the same work again.
    """
    context = {}
    lesson, assets = generate_lesson(pdf_path, ai, studio, plan, directory, specification, year_month, schema_path,
                                    generation_context=context)
    for cycle in range(MAX_VISUAL_REPAIRS + 1):
        html = render_lesson(lesson, assets, directory, ROOT)
        studio.update(stage="validating", message="講義HTMLの表示・音声操作・印刷を検証しています。", progress=85)
        notified = set()

        def rejected(error):
            record = {
                "status": "rejected", "cycle": cycle, "htmlSha256": digest_file(html),
                "issues": error.details, "affectedProblemIds": sorted(error.problem_feedback),
                "images": error.metadata, "repairable": error.repairable}
            fingerprint = key_for("visual", record)
            if fingerprint in notified:
                return
            notified.add(fingerprint)
            studio.checkpoint("visual-diagnostics-" + plan["kind"], record)
            if on_visual_issue:
                on_visual_issue(error, cycle)

        try:
            verification = browser_and_visual_qa(html, directory, ai, studio, cycle=cycle, on_rejection=rejected)
            studio.checkpoint("visual-diagnostics-" + plan["kind"], {
                "status": "approved", "cycle": cycle, "htmlSha256": digest_file(html), "issues": []})
            return html, verification
        except VisualQAError as error:
            rejected(error)
            if not error.repairable or cycle >= MAX_VISUAL_REPAIRS:
                raise
            studio.ensure_active()
            studio.update(stage="visual_repair", message=f"表示の指摘をもとに講義を修正し、再検算しています（{cycle + 1}/{MAX_VISUAL_REPAIRS}回）。", progress=85)
            lesson, assets = generate_lesson(pdf_path, ai, studio, plan, directory, specification, year_month, schema_path,
                generation_context=context, previous_lesson=lesson, visual_feedback=error.problem_feedback,
                repair_cycle=cycle + 1)


def publish_and_verify(studio, html, filename, source_id):
    studio.ensure_active()
    expected_sha = digest_file(html)
    response = studio.request("POST", "/jobs/" + studio.job_id + "/publish",
        {"fileName": filename, "contentBase64": base64.b64encode(html.read_bytes()).decode(), "sourceId": source_id})
    url = response.get("url", "")
    parsed = urlparse(url)
    require(parsed.scheme == "https" and parsed.hostname == "iwslatojp29.github.io" and parsed.path.startswith("/math-app/math/"),
            "publish_response", "公開先の応答を確認できません。")
    for attempt in range(20):
        studio.ensure_active()
        try:
            page = requests.get(url, params={"studio": expected_sha[:16]}, headers={"Cache-Control": "no-cache"}, timeout=(15, 60))
            if page.status_code == 200 and __import__("hashlib").sha256(page.content).hexdigest() == expected_sha:
                return {"url": url, "path": response["path"], "commitSha": response["commitSha"], "contentVerified": True}
        except requests.RequestException:
            pass
        if attempt < 19:
            time.sleep(30)
    raise StudioError("pages_pending", "保存・コミットは完了しましたが、公開ページの反映をまだ確認できません。同じジョブを再開してください。")


def html_plan(source, source_kind, page_count):
    """Keep the selected PDF intact; unknown printed pages/sections stay unknown."""
    require(source_kind in ("practice", "advanced") and page_count > 0)
    return {"kind": source_kind, "name": source["name"], "missing": [],
            "scanAllSolutionPages": True,
            "pages": [{"pdfPage": number, "printedPages": [], "labels": [], "crop": None, "rotation": 0}
                      for number in range(1, page_count + 1)]}


def filename_issue(name):
    """Filename metadata is display context, never verified booklet evidence."""
    match = re.search(r"(?<!\d)((?:19|20|21)\d{2})\s*年\s*(1[0-2]|0?[1-9])\s*月", name)
    if match is None:
        match = re.search(r"(?<!\d)((?:19|20|21)\d{2})[-_](1[0-2]|0?[1-9])(?!\d)", name)
    if match:
        year, month = map(int, match.groups())
        return year, month, f"{year}年{month}月号（PDFファイル名）"
    return None, None, "年月未確認"


def record_output_error(studio, summary, output, error):
    if error.code in RETRYABLE_ERRORS or error.code in ("cancelled", "runner_conflict", "operation_mismatch"):
        raise error
    output["error"] = {"code": error.code, "message": error.public_message}
    details = [detail[:700] for detail in safe_visual_issues(getattr(error, "details", []), limit=12)]
    if details:
        output["error"]["details"] = details
    summary["errors"].append({"kind": output["kind"], "code": error.code, "message": error.public_message})
    studio.checkpoint("result", summary)


def run_job(studio, job, api_key, temp_root=None):
    source = validate_job(job, studio.job_id)
    if job.get("status") == "completed":
        return job.get("result")
    # Old jobs never opt in to HTML generation, including partial one-go runs.
    operation = job.get("operation", "extract")
    source_kind = job.get("sourceKind") if operation == "html" else None
    def verify_source():
        return check_source(drive, source, operation=operation, source_kind=source_kind)

    run_id = os.environ.get("GITHUB_RUN_ID")
    studio.update(status="running", stage="download", message=("選択した月間号PDFを確認しています。" if operation == "extract"
                  else "選択した解説対象PDFを確認しています。"), progress=1,
                  **({"runId": run_id} if run_id else {}))
    drive, ai = DriveClient(studio), ResponsesClient(api_key, job["model"], studio,
        max_output_tokens_limit=job.get("modelMaxOutputTokens") or 28000)
    verify_source()
    with tempfile.TemporaryDirectory(prefix="math-app-monthly-", dir=temp_root) as temporary:
        directory = Path(temporary)
        source_path = directory / "source.pdf"
        drive.download(source["id"], source_path)
        if source.get("md5Checksum"):
            require(digest_file(source_path, "md5") == source["md5Checksum"], "source_changed", "元PDFの取得内容が選択時と一致しません。", True)
        source_sha = digest_file(source_path)
        verify_source()
        checkpoint = studio.checkpoint("source-integrity")
        require(not checkpoint or checkpoint.get("sha256") == source_sha, "source_changed", "再開前後で元PDFが変わっています。新しいジョブを作成してください。", True)
        if checkpoint:
            require(checkpoint.get("operation", "extract") == operation and checkpoint.get("sourceKind") == source_kind,
                    "job_changed", "再開前後で作業種別が変わっています。新しいジョブを作成してください。", True)
            require(all(checkpoint.get(key, value) == value for key, value in
                        (("id", source["id"]), ("model", job["model"]), ("specVersion", job["specVersion"]))),
                    "source_changed", "再開前後で入力または生成設定が変わっています。新しいジョブを作成してください。", True)
        studio.checkpoint("source-integrity", {"id": source["id"], "name": source["name"], "sha256": source_sha,
            "modifiedTime": source.get("modifiedTime"), "specVersion": job["specVersion"], "model": job["model"],
            "operation": operation, "sourceKind": source_kind})
        summary = {"operation": operation, "source": {"id": source["id"], "name": source["name"], "sha256": source_sha},
                   "model": job["model"], "outputs": [], "warnings": [], "errors": []}
        if operation == "extract":
            extract_spec = (ROOT / "specs" / "extract-pdf.md").read_text(encoding="utf-8")
            with open_pdf(source_path) as original:
                classification, _ = classify_pdf(original, ai, studio, directory, extract_spec)
                studio.checkpoint("classification", classification)
                plans = [{**plan, "bookletIssue": classification["issue"]}
                         for plan in plans_from_classification(classification, source["name"])]
                summary.update({
                "model": job["model"], "year": classification["issue"]["year"], "month": classification["issue"]["month"],
                "warnings": ["学力コンテストの解答は、同じ冊子に掲載されたものを収録します（過去号分の場合もあります）。"]})
                for plan in plans:
                    if not plan["pages"]:
                        summary["warnings"].append(plan["kind"] + ": 対象コーナーの掲載なし")
                        continue
                    output = {"kind": plan["kind"], "missing": plan["missing"]}
                    summary["outputs"].append(output)
                    try:
                        studio.ensure_active()
                        part = directory / plan["kind"]
                        part.mkdir()
                        pdf_path = part / "extracted.pdf"
                        proof = extract_pdf(original, plan, pdf_path)
                        studio.checkpoint("pdf-proof-" + plan["kind"], {"plan": plan, "verification": proof})
                        verify_source()
                        output["pdf"] = save_verified(drive, studio, pdf_path, plan["name"], job["folders"][plan["kind"]],
                            "application/pdf", source, source_sha, plan["kind"], job["specVersion"], part)
                        output["pdfVerification"] = {"pageCount": proof["pageCount"], "allPagesPixelMatched": proof["allPagesPixelMatched"]}
                        studio.checkpoint("result", summary)
                        studio.update(stage="pdf_saved", message="確認済みの切り出しPDFを保存しました。", progress=90, result=summary)
                    except StudioError as error:
                        record_output_error(studio, summary, output, error)
        else:
            with open_pdf(source_path) as selected:
                plan = html_plan(source, source_kind, len(selected))
            studio.checkpoint("html-input", {"plan": plan, "sha256": source_sha})
            summary["source"]["pageCount"] = len(plan["pages"])
            summary["year"], summary["month"], year_month = filename_issue(source["name"])
            summary["issueSource"] = "filename" if summary["year"] else "unknown"
            output = {"kind": source_kind, "missing": []}
            summary["outputs"].append(output)
            part = directory / source_kind
            part.mkdir()
            lesson_spec = (ROOT / "specs" / "animation-html.md").read_text(encoding="utf-8")
            lesson_spec += ("\n今回は選択された切り出し済みPDFの全ページが対象です。ページ対応のlabels・printedPagesが空なのは未分類・未確認を意味します。"
                            "問題のないページと公式解答ページも全て画像で確認し、公式解答がないページはunpairedPagesへ根拠を記します。"
                            "ファイル名の年月は表示用情報であり原画像で確認済みの年月ではありません。画像と異なる年月や別号を上書きせず、年を推測しません。")
            try:
                studio.ensure_active()
                studio.update(stage="lesson_inventory", message="選択したPDFの全問題と小問を確認しています。", progress=10, result=summary)
                def report_visual_issue(error, cycle):
                    output["error"] = {"code": error.code,
                        "message": "画面の確認結果をもとに、表示の再確認・修正を行っています。", "details": error.details}
                    studio.checkpoint("result", summary)
                    studio.update(stage="visual_repair" if error.repairable else "validating",
                        message="画面の確認結果を保存し、表示を再確認しています。", progress=85, result=summary)

                html, output["htmlVerification"] = generate_verified_lesson(source_path, ai, studio, plan, part, lesson_spec,
                    year_month, ROOT / "lesson.schema.json", on_visual_issue=report_visual_issue)
                output.pop("error", None)
                html_name = source["name"][:-4] + "_講義アニメーション.html"
                verify_source()
                output["html"] = save_verified(drive, studio, html, html_name, job["folders"]["html"], "text/html",
                    source, source_sha, "html-" + source_kind, job["specVersion"], part,
                    legacy_provenance=job.get("legacyProvenance"))
                studio.checkpoint("result", summary)
                studio.update(stage="publishing", message="講義HTMLを公開し、表示内容を確認しています。", progress=95, result=summary)
                verify_source()
                output["published"] = publish_and_verify(studio, html, html_name, source["id"])
                studio.checkpoint("result", summary)
            except StudioError as error:
                record_output_error(studio, summary, output, error)
        if summary["errors"]:
            studio.update(status="needs_attention", stage="needs_attention", message="保存できた成果物を残し、未解決の処理を保留しました。",
                          result=summary, error="一部の処理に確認が必要です。同じジョブを再開できます。", retryable=False)
            return summary
        studio.update(status="completed", stage="completed", progress=100,
                      message=("切り出しPDFの保存・検証が完了しました。" if summary["outputs"] else "冊子を確認しましたが、対象コーナーの掲載はありませんでした。")
                      if operation == "extract" else "選択したPDFの全問講義HTMLの保存・公開確認が完了しました。",
                      result=summary, error="")
        return summary


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--job-json", type=Path, help="Optional already fetched private job.json; never a repository input.")
    parser.add_argument("--report-failure", action="store_true")
    args = parser.parse_args(argv)
    studio = None
    try:
        token = os.environ.get("STUDIO_RUNNER_TOKEN", "")
        api_key = os.environ.get("OPENAI_API_KEY", "")
        mask_secret(token)
        mask_secret(api_key)
        studio = StudioClient(os.environ.get("STUDIO_URL", "https://math-app-proxy.iwslatojp29.workers.dev"), token, args.job_id)
        if args.report_failure:
            current = studio.job()
            if current.get("status") in ("running", "queued"):
                if not current.get("runId") and os.environ.get("GITHUB_RUN_ID"):
                    studio.update(status="running", runId=os.environ["GITHUB_RUN_ID"])
                studio.update(status="failed", stage="interrupted", retryable=True, continuation=False,
                              error="クラウド実行が中断しました。保存済みの段階から自動で再開します。")
            return 0
        job = json.loads(args.job_json.read_text(encoding="utf-8")) if args.job_json else studio.job()
        result = run_job(studio, job, api_key, os.environ.get("RUNNER_TEMP"))
        return 1 if result and result.get("errors") else 0
    except StudioError as error:
        if error.code in ("cancelled", "runner_conflict", "operation_mismatch"):
            return 0
        if studio and error.code != "cancelled":
            try:
                observations = safe_visual_issues(getattr(error, "details", []), limit=6)
                owner_message = error.public_message + ("\n" + "\n".join(observations) if observations else "")
                studio.update(status="needs_attention" if error.attention else "failed", stage="failed",
                              error=owner_message, message=error.public_message,
                              retryable=error.code in RETRYABLE_ERRORS, continuation=error.code == "continue_later")
            except StudioError:
                pass
        print("monthly runner: " + error.code, file=sys.stderr)
        return 1
    except Exception:
        # Never emit raw exceptions, response bodies, local source paths or credentials.
        if studio:
            try:
                studio.update(status="failed", stage="failed", retryable=False, continuation=False,
                              error="処理を完了できませんでした。保存済みの段階から再開できます。")
            except Exception:
                pass
        print("monthly runner: internal_error", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
