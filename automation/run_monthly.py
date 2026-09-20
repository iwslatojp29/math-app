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

from studio_common import (ADVANCED_FOLDER, PRACTICE_FOLDER, SOURCE_FOLDER, DriveClient, ResponsesClient,
    RETRYABLE_ERRORS, SAFE_ID, StudioClient, StudioError, digest_file, json_bytes, key_for, mask_secret, require)
from pdf_pipeline import (BOOL, STR, arr, obj, classify_pdf, extract_pdf, image_data, open_pdf,
    plans_from_classification, same_pdf_visual_content)
from lesson_pipeline import generate_lesson, render_lesson

ROOT = Path(__file__).resolve().parent
VISUAL_REVIEW = obj({"approved": BOOL, "checkedImages": arr(STR), "issues": arr(STR)})


def validate_job(job, expected_id):
    require(job.get("id") == expected_id and isinstance(job.get("source"), dict))
    source = job["source"]
    require(bool(SAFE_ID.fullmatch(source.get("id", ""))) and source.get("mimeType") == "application/pdf"
            and isinstance(source.get("name"), str) and source["name"].lower().endswith(".pdf"))
    require(job.get("folders") == {"source": SOURCE_FOLDER, "practice": PRACTICE_FOLDER,
            "advanced": ADVANCED_FOLDER, "html": PRACTICE_FOLDER})
    require(isinstance(job.get("model"), str) and bool(job["model"])
            and isinstance(job.get("specVersion"), str) and bool(job["specVersion"]))
    require(job.get("status") != "cancelled", "cancelled", "処理は停止されています。")
    return source


def check_source(drive, expected):
    actual = drive.metadata(expected["id"])
    require(actual and actual.get("mimeType") == "application/pdf" and not actual.get("trashed"),
            "source_unavailable", "選択した元PDFを取得できません。", True)
    for field in ("name", "size", "modifiedTime", "md5Checksum"):
        if expected.get(field) is not None:
            require(str(expected[field]) == str(actual.get(field)), "source_changed", "選択後に元PDFが変更されました。新しいジョブとして選び直してください。", True)
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


def save_verified(drive, studio, path, name, folder, mime, source, source_sha, kind, spec_version, directory):
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
        require(props.get("mathAppSource") == source["id"] and props.get("mathAppKind") == kind
                and props.get("mathAppSavedMd5") == existing.get("md5Checksum"),
                "drive_name_conflict", "同名の既存ファイルは内容や編集者を特定できず、上書きを保留しました。", True)
        existing_id = existing["id"]
    properties = {"mathAppSource": source["id"], "mathAppKind": kind,
                  "mathAppSavedMd5": md5, "mathAppSourceSha": source_sha, "mathAppSpec": spec_version}
    metadata = drive.upload(path, name, folder, mime, properties, existing_id=existing_id)
    return safe_saved_file(metadata, "updated" if existing_id else "created")


def browser_and_visual_qa(html, directory, ai, studio):
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
    for start in range(0, len(screenshots), 6):
        batch = screenshots[start:start + 6]
        labels, images = [], []
        for index, item in enumerate(batch, start=start + 1):
            path = Path(item["path"]).resolve()
            require(path.is_relative_to(qa_dir.resolve()), "browser_qa", "検証画像の保存場所を確認できません。")
            labels.append("image-" + str(index))
            mime = "image/png" if path.suffix.lower() == ".png" else "image/jpeg"
            images.append("data:" + mime + ";base64," + base64.b64encode(path.read_bytes()).decode())
        review = ai.structured("visual-" + html.parent.name + "-" + str(start),
            "教材HTMLの実ブラウザ画面です。図のラベル/数値/補助線/角印の重なりや欠け、小さすぎる字、"
            "図が小さいままの過大余白、字幕切れ、画面横はみ出し、固定操作欄の欠けを画像で確認してください。"
            "これは実機試験や音声試聴ではありません。未確認を検証済みとしない。"
            "画像順とID:" + json_bytes(list(zip(labels, [{k: v for k, v in item.items() if k != "path"} for item in batch]))).decode(),
            VISUAL_REVIEW, images, max_tokens=8000)
        require(review["approved"] and not review["issues"] and review["checkedImages"] == labels,
                "visual_qa", "図・ラベル・説明の実表示に未解決事項があり、公開を保留しました。", True)
    return {"browserChecksPassed": True, "visualImagesReviewed": len(screenshots),
            "actualDeviceTested": False, "actualVoiceAuditioned": False}


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


def run_job(studio, job, api_key, temp_root=None):
    source = validate_job(job, studio.job_id)
    if job.get("status") == "completed":
        return job.get("result")
    run_id = os.environ.get("GITHUB_RUN_ID")
    studio.update(status="running", stage="download", message="選択した月間号PDFを確認しています。", progress=1,
                  **({"runId": run_id} if run_id else {}))
    drive, ai = DriveClient(studio), ResponsesClient(api_key, job["model"], studio,
        max_output_tokens_limit=job.get("modelMaxOutputTokens") or 28000)
    check_source(drive, source)
    extract_spec = (ROOT / "specs" / "extract-pdf.md").read_text(encoding="utf-8")
    lesson_spec = (ROOT / "specs" / "animation-html.md").read_text(encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="math-app-monthly-", dir=temp_root) as temporary:
        directory = Path(temporary)
        source_path = directory / "source.pdf"
        drive.download(source["id"], source_path)
        if source.get("md5Checksum"):
            require(digest_file(source_path, "md5") == source["md5Checksum"], "source_changed", "元PDFの取得内容が選択時と一致しません。", True)
        source_sha = digest_file(source_path)
        check_source(drive, source)
        checkpoint = studio.checkpoint("source-integrity")
        require(not checkpoint or checkpoint.get("sha256") == source_sha, "source_changed", "再開前後で元PDFが変わっています。新しいジョブを作成してください。", True)
        studio.checkpoint("source-integrity", {"id": source["id"], "name": source["name"], "sha256": source_sha,
            "modifiedTime": source.get("modifiedTime"), "specVersion": job["specVersion"], "model": job["model"]})
        with open_pdf(source_path) as original:
            classification, _ = classify_pdf(original, ai, studio, directory, extract_spec)
            studio.checkpoint("classification", classification)
            plans = plans_from_classification(classification, source["name"])
            summary = {"source": {"id": source["id"], "name": source["name"], "sha256": source_sha},
                "model": job["model"], "year": classification["issue"]["year"], "month": classification["issue"]["month"],
                "outputs": [], "warnings": ["学力コンテストの解答は、同じ冊子に掲載されたものを収録します（過去号分の場合もあります）。"], "errors": []}
            prepared = []
            # Finish both source-preserving PDF deliveries before the slower lesson work.
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
                    check_source(drive, source)
                    output["pdf"] = save_verified(drive, studio, pdf_path, plan["name"], job["folders"][plan["kind"]],
                        "application/pdf", source, source_sha, plan["kind"], job["specVersion"], part)
                    output["pdfVerification"] = {"pageCount": proof["pageCount"], "allPagesPixelMatched": proof["allPagesPixelMatched"]}
                    studio.checkpoint("result", summary)
                    studio.update(stage="pdf_saved", message="確認済みの切り出しPDFを保存しました。", progress=30, result=summary)
                    prepared.append((plan, output, part, pdf_path))
                except StudioError as error:
                    if error.code in RETRYABLE_ERRORS or error.code in ("cancelled", "runner_conflict"):
                        raise
                    output["error"] = {"code": error.code, "message": error.public_message}
                    summary["errors"].append({"kind": plan["kind"], "code": error.code, "message": error.public_message})
                    studio.checkpoint("result", summary)
            for plan, output, part, pdf_path in prepared:
                try:
                    studio.ensure_active()
                    studio.update(stage="lesson_inventory", message="全問題と小問の一覧を確認しています。", progress=30, result=summary)
                    lesson, assets = generate_lesson(pdf_path, ai, studio, plan, part, lesson_spec,
                        f"{summary['year']}年{summary['month']}月号", ROOT / "lesson.schema.json")
                    html = render_lesson(lesson, assets, part, ROOT)
                    studio.update(stage="validating", message="講義HTMLの表示・音声操作・印刷を検証しています。", progress=85)
                    output["htmlVerification"] = browser_and_visual_qa(html, part, ai, studio)
                    html_name = plan["name"][:-4] + "_講義アニメーション.html"
                    check_source(drive, source)
                    output["html"] = save_verified(drive, studio, html, html_name, job["folders"]["html"], "text/html",
                        source, source_sha, "html-" + plan["kind"], job["specVersion"], part)
                    studio.checkpoint("result", summary)
                    studio.update(stage="publishing", message="講義HTMLを公開し、表示内容を確認しています。", progress=95, result=summary)
                    output["published"] = publish_and_verify(studio, html, html_name, source["id"])
                    studio.checkpoint("result", summary)
                except StudioError as error:
                    if error.code in RETRYABLE_ERRORS or error.code in ("cancelled", "runner_conflict"):
                        raise
                    output["error"] = {"code": error.code, "message": error.public_message}
                    summary["errors"].append({"kind": plan["kind"], "code": error.code, "message": error.public_message})
                    studio.checkpoint("result", summary)
            if summary["errors"]:
                studio.update(status="needs_attention", stage="needs_attention", message="保存できた成果物を残し、未解決の処理を保留しました。",
                              result=summary, error="一部の処理に確認が必要です。同じジョブを再開できます。", retryable=False)
                return summary
            studio.update(status="completed", stage="completed", progress=100,
                          message="PDF保存と全問講義HTMLの公開確認が完了しました。" if summary["outputs"] else "冊子を確認しましたが、対象コーナーの掲載はありませんでした。",
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
        if error.code in ("cancelled", "runner_conflict"):
            return 0
        if studio and error.code != "cancelled":
            try:
                studio.update(status="needs_attention" if error.attention else "failed", stage="failed",
                              error=error.public_message, message=error.public_message,
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
