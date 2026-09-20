"""Source-preserving PDF extraction, visual evidence, and complete page verification."""
from __future__ import annotations

import base64
import hashlib
from pathlib import Path

import pymupdf as fitz

from studio_common import StudioError, require, json_bytes


def obj(properties):
    return {"type": "object", "properties": properties, "required": list(properties), "additionalProperties": False}


def arr(items):
    return {"type": "array", "items": items}


STR = {"type": "string"}
BOOL = {"type": "boolean"}
LABELS = ["points", "practice_questions", "practice_solutions", "advanced_questions", "advanced_solutions",
          "contest_questions", "contest_entry", "contest_solutions", "contest_results", "contest_letters", "other"]
PRACTICE_LABELS = set(LABELS[:3])
ADVANCED_LABELS = set(LABELS[3:-1])
PAGE_SCHEMA = obj({
    "pdfPage": {"type": "integer"}, "printedPages": arr(STR),
    "labels": arr({"type": "string", "enum": LABELS}),
    "headingEvidence": STR, "boundaryEvidence": STR,
    "visuallyChecked": BOOL, "unresolvedIssues": arr(STR),
})
CLASSIFICATION_SCHEMA = obj({"pages": arr(PAGE_SCHEMA), "issueEvidence": STR, "unresolvedIssues": arr(STR)})
REVIEW_SCHEMA = obj({"approved": BOOL, "checkedPdfPages": arr({"type": "integer"}), "issues": arr(STR)})
ISSUE_SCHEMA = obj({"year": {"type": "integer"}, "month": {"type": "integer"}, "evidence": arr(STR), "unresolvedIssues": arr(STR)})


def open_pdf(path):
    try:
        doc = fitz.open(path)
    except Exception:
        raise StudioError("invalid_pdf", "元PDFを開けません。PDF形式または破損を確認してください。", True) from None
    require(doc.is_pdf and not doc.needs_pass and 0 < len(doc) <= 500,
            "invalid_pdf", "PDFの暗号化・ページ数・形式を確認してください。", True)
    return doc


def page_image(doc, page_number, directory: Path, prefix="page", max_edge=2200):
    require(1 <= page_number <= len(doc), "invalid_page", "抽出ページ番号が元PDFの範囲外です。", True)
    page = doc[page_number - 1]
    scale = min(2.5, max_edge / max(page.rect.width, page.rect.height))
    pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), colorspace=fitz.csRGB, alpha=False)
    path = directory / f"{prefix}-{page_number:04d}.jpg"
    pixmap.pil_save(str(path), format="JPEG", quality=92, optimize=True)
    return path


def image_data(path: Path):
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def classify_pdf(doc, ai, studio, directory, extract_spec):
    """Every page is seen twice; disagreements are repaired once or block publication."""
    images = {number: page_image(doc, number, directory) for number in range(1, len(doc) + 1)}
    cover_pages = list(range(1, min(len(doc), 5) + 1))
    issue = ai.structured("issue", "同じ元冊子の表紙・目次・冒頭です。表紙、本文見出し等の複数根拠で冊子の年/月を特定してください。"
        "過去号の解答年月を冊子年月と誤認しない。目次だけの年誤植は他の根拠と比較し、原文を改変しない。"
        "重要な不確実性はunresolvedIssuesへ。画像の順はPDFページ " + str(cover_pages), ISSUE_SCHEMA,
        [image_data(images[page]) for page in cover_pages], max_tokens=6000)
    require(1900 <= issue["year"] <= 2200 and 1 <= issue["month"] <= 12 and issue["evidence"] and not issue["unresolvedIssues"],
            "issue_unresolved", "表紙・本文から年月号を確定できません。", True)
    classified = []
    for start in range(1, len(doc) + 1, 6):
        pages = list(range(start, min(start + 6, len(doc) + 1)))
        # Include neighbours to inspect continuations at batch boundaries.
        shown = list(range(max(1, start - 1), min(start + 7, len(doc) + 1)))
        inputs = [image_data(images[page]) for page in shown]
        text_hints = [{"pdfPage": page, "textHint": doc[page - 1].get_text()[:4000]} for page in shown]
        prompt = (extract_spec + "\n\nこれは元冊子の全ページ確認を分割した作業です。画像を実際に見て、今回返すページ"
            + str(pages) + "を各1件で分類してください。画像はPDFページ" + str(shown)
            + "の順。隣接ページは続き/境界の確認だけに使用。labelsは掲載された対象の全種類。"
            "学コンフォローノートはotherです。学コンの過去号解答・成績発表・応募頁は対象。"
            "目次の掲載予定だけでは対象ページにしない。見開きの対象と対象外が混在しても本文を欠かさず全ページを選び、boundaryEvidenceに理由を記す。"
            "各ページの印刷番号と見出し、問題/解答切替、続き、直前直後の境界を記す。OCRは補助で画像を優先。"
            "不鮮明で重要条件を読めなければunresolvedIssuesへ。\nOCR補助:" + json_bytes(text_hints).decode())
        approved = None
        feedback = ""
        for attempt in range(2):
            result = ai.structured(f"classify-{start}-{attempt}", prompt + feedback,
                                   CLASSIFICATION_SCHEMA, inputs, max_tokens=12000)
            require([item["pdfPage"] for item in result["pages"]] == pages,
                    "page_coverage", "PDFページ分類に欠落・重複・順序違いがあります。", True)
            require(all(item["labels"] and item["headingEvidence"] and item["boundaryEvidence"] for item in result["pages"]),
                    "page_evidence", "ページ分類の誌面根拠が不足しています。", True)
            review = ai.structured(f"classify-review-{start}-{attempt}",
                extract_spec + "\n独立した検証者として原画像を再確認し、次のページ分類の対象漏れ/誤収録、境界、印刷番号、過去号解答の見落としを検査してください。"
                "画像はPDFページ" + str(shown) + "順、検査対象は" + str(pages)
                + "。対象PDFページ全件をcheckedPdfPagesへ。分類:" + json_bytes(result).decode(),
                REVIEW_SCHEMA, inputs, max_tokens=8000)
            if (review["approved"] and review["checkedPdfPages"] == pages and not review["issues"]
                    and not result["unresolvedIssues"]
                    and all(item["visuallyChecked"] and not item["unresolvedIssues"] for item in result["pages"])):
                approved = result["pages"]
                break
            feedback = "\n前回検証で未解決。次の指摘を原画像で再確認し修正してください:" + json_bytes(review).decode()
        require(approved is not None, "pdf_boundaries_unresolved", "PDFの抽出範囲に未解決事項があります。誤った完成版の保存を保留しました。", True)
        classified.extend(approved)
        studio.update(status="running", stage="pdf_review", message="冊子のページと切り出し範囲を確認しています。",
                      progress=round(5 + 20 * min(start + 5, len(doc)) / len(doc), 1))
    return {"issue": issue, "pages": classified}, images


def plans_from_classification(classification, source_name):
    require(source_name.lower().endswith(".pdf"), "invalid_pdf_name", "元PDFの名前を確認してください。", True)
    base = source_name[:-4]
    outputs = []
    for kind, selected_labels, suffix in [
        ("practice", PRACTICE_LABELS, "‗日日の演習.pdf"),
        ("advanced", ADVANCED_LABELS, "‗発展演習+学力コンテスト.pdf"),
    ]:
        selected = [page for page in classification["pages"] if set(page["labels"]) & selected_labels]
        if not selected:
            outputs.append({"kind": kind, "name": base + suffix, "pages": [], "missing": ["対象コーナーの掲載なし"]})
            continue
        present = set().union(*(set(page["labels"]) for page in selected))
        missing = []
        expected = [("points", "要点の整理"), ("practice_questions", "日日の演習の問題"), ("practice_solutions", "日日の演習の解答解説")] if kind == "practice" else []
        for label, title in expected:
            if label not in present:
                missing.append(title + "の掲載なし")
        if kind == "advanced":
            if not present & {"advanced_questions", "advanced_solutions"}:
                missing.append("発展演習の掲載なし")
            if not present & (ADVANCED_LABELS - {"advanced_questions", "advanced_solutions"}):
                missing.append("学力コンテストの掲載なし")
        outputs.append({"kind": kind, "name": base + suffix, "pages": [
            {"pdfPage": page["pdfPage"], "printedPages": page["printedPages"], "labels": page["labels"],
             "evidence": page["headingEvidence"] + " / " + page["boundaryEvidence"], "crop": None, "rotation": 0}
            for page in selected], "missing": missing})
    return outputs


def extract_pdf(source, plan, output: Path):
    pages = plan["pages"]
    numbers = [page["pdfPage"] for page in pages]
    require(numbers and numbers == sorted(set(numbers)) and all(1 <= page <= len(source) for page in numbers),
            "invalid_extraction_plan", "抽出ページの範囲・順序・重複を確認できません。", True)
    out = fitz.open()
    toc, previous_labels = [], None
    try:
        for item in pages:
            source_page = source[item["pdfPage"] - 1]
            out.insert_pdf(source, from_page=item["pdfPage"] - 1, to_page=item["pdfPage"] - 1)
            page = out[-1]
            crop = item.get("crop")
            if crop:
                require(bool(item.get("cropEvidence")) and source_page.rotation == 0,
                        "crop_unverified", "見開き切り出しの領域・根拠を確認できません。", True)
                rect = fitz.Rect(crop)
                require(not rect.is_empty and source_page.rect.contains(rect), "crop_unverified", "切り出し領域が誌面の外です。", True)
                page.set_cropbox(rect)
            rotation = item.get("rotation", 0)
            require(rotation in (0, 90, 180, 270), "invalid_rotation", "ページの回転指定を確認できません。", True)
            if rotation:
                require(bool(item.get("rotationEvidence")), "rotation_unverified", "回転補正の根拠を確認できません。", True)
                page.set_rotation((source_page.rotation + rotation) % 360)
            labels = item.get("labels", [])
            if labels != previous_labels:
                titles = {"points": "要点の整理", "practice_questions": "日日の演習 問題", "practice_solutions": "日日の演習 解答解説",
                          "advanced_questions": "発展演習 問題", "advanced_solutions": "発展演習 解答解説", "contest_questions": "学力コンテスト 当月問題",
                          "contest_entry": "学力コンテスト 応募", "contest_solutions": "学力コンテスト 過去号解答", "contest_results": "学力コンテスト 成績発表", "contest_letters": "学力コンテスト 通信"}
                title = "・".join(titles[label] for label in labels if label in titles)
                if title:
                    toc.append([1, title, len(out)])
                previous_labels = labels
        if toc:
            out.set_toc(toc)
        # No rasterization, resampling or image recompression occurs in the PDF.
        out.save(output, garbage=0, deflate=False)
    finally:
        out.close()
    return verify_extracted(source, plan, output)


def pixel_signature(page, clip=None):
    pixmap = page.get_pixmap(matrix=fitz.Matrix(2, 2), clip=clip, colorspace=fitz.csRGB, alpha=False)
    return pixmap.width, pixmap.height, hashlib.sha256(pixmap.samples).hexdigest()


def verify_extracted(source, plan, output):
    records = []
    with open_pdf(output) as generated:
        require(len(generated) == len(plan["pages"]), "pdf_verification", "切り出し後のページ数が一致しません。", True)
        for index, item in enumerate(plan["pages"]):
            source_page = source[item["pdfPage"] - 1]
            if item.get("rotation"):
                # Render the explicitly intended transform as the reference.
                reference = fitz.open()
                reference.insert_pdf(source, from_page=item["pdfPage"] - 1, to_page=item["pdfPage"] - 1)
                if item.get("crop"):
                    reference[0].set_cropbox(fitz.Rect(item["crop"]))
                reference[0].set_rotation((source_page.rotation + item["rotation"]) % 360)
                expected = pixel_signature(reference[0])
                reference.close()
            else:
                expected = pixel_signature(source_page, fitz.Rect(item["crop"]) if item.get("crop") else None)
            actual = pixel_signature(generated[index])
            require(expected == actual, "pdf_verification", "切り出しPDFの画像が原誌面と一致しません。保存を保留しました。", True)
            records.append({"sourcePdfPage": item["pdfPage"], "outputPdfPage": index + 1,
                            "pixelSha256": actual[2], "crop": item.get("crop"), "rotation": item.get("rotation", 0)})
    return {"pageCount": len(records), "allPagesPixelMatched": True, "pages": records}


def same_pdf_visual_content(first: Path, second: Path):
    try:
        with open_pdf(first) as left, open_pdf(second) as right:
            return len(left) == len(right) and all(pixel_signature(left[i]) == pixel_signature(right[i]) for i in range(len(left)))
    except StudioError:
        return False
