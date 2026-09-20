"""Inventory every printed question, generate per problem, and independently verify before rendering."""
from __future__ import annotations

import copy
import json
import re
import subprocess
from pathlib import Path

import jsonschema

from pdf_pipeline import obj, arr, STR, BOOL, REVIEW_SCHEMA, image_data, open_pdf, page_image
from studio_common import StudioError, require, json_bytes

SUBQUESTION = obj({"id": STR, "label": STR, "conditions": arr(STR), "goal": STR})
INVENTORY_PROBLEM = obj({
    "id": STR, "sectionId": STR, "sectionTitle": STR, "number": STR, "title": STR,
    "pdfPages": arr({"type": "integer"}), "printedPages": arr(STR),
    "subquestions": arr(SUBQUESTION), "officialSolutionPages": arr({"type": "integer"}),
    "unresolvedIssues": arr(STR),
})
INVENTORY_SCHEMA = obj({
    "problems": arr(INVENTORY_PROBLEM),
    "solutionLinks": arr(obj({"problemId": STR, "pdfPages": arr({"type": "integer"}), "evidence": STR})),
    "coverage": arr(obj({"pdfPage": {"type": "integer"}, "questionIds": arr(STR), "noQuestionReason": STR})),
    "unresolvedIssues": arr(STR),
})
PROBLEM_REVIEW = obj({
    "approved": BOOL, "checkedSubquestionIds": arr(STR),
    "independentCheck": STR, "officialAnswerCheck": STR, "reasoningCheck": STR, "readingsCheck": STR,
    "issues": arr(STR),
})
SOLUTION_SCHEMA = obj({
    "links": arr(obj({"problemId": STR, "pdfPages": arr({"type": "integer"}), "evidence": STR})),
    "unpairedPages": arr(obj({"pdfPage": {"type": "integer"}, "reason": STR})),
    "checkedPdfPages": arr({"type": "integer"}), "unresolvedIssues": arr(STR),
})


def reconcile_solution_pages(problems, solution_pages, images, ai, kind, specification):
    """Resolve distant official answers against the complete, stable problem catalog."""
    by_id = {problem["id"]: problem for problem in problems}
    for problem in problems:
        problem["officialSolutionPages"] = []
    catalog = json_bytes(problems).decode()
    for start in range(0, len(solution_pages), 5):
        pages = solution_pages[start:start + 5]
        prompt = (specification + "\n全問一覧が確定したので、公式解答をこの一覧の問題IDに照合してください。"
            "問題番号だけで対応付けず、欄・年月・条件・小問を照合する。対象画像はPDFページ" + str(pages)
            + "の順。linksはこのPDFに問題があるものだけ。別月問題の解答のみで問題本文がない場合は"
            "unpairedPagesへ根拠を記し、当月の同番号へ結び付けない。各ページはlinksまたはunpairedPagesで必ず説明する。"
            "一覧に対応するか不確かな場合はunresolvedIssuesへ。checkedPdfPagesは対象全件。全問一覧:" + catalog)
        inputs = [image_data(images[page]) for page in pages]
        accepted, feedback = None, ""
        for attempt in range(2):
            links = ai.structured(f"solutions-{kind}-{start}-{attempt}", prompt + feedback,
                                  SOLUTION_SCHEMA, inputs, max_tokens=10000)
            require(links["checkedPdfPages"] == pages,
                    "solution_pages", "公式解答の全ページ確認に欠落があります。", True)
            addressed = set()
            for link in links["links"]:
                require(link["problemId"] in by_id and link["pdfPages"] and link["evidence"].strip()
                        and set(link["pdfPages"]) <= set(pages),
                        "solution_pages", "公式解答と対象問題の対応を確認できません。", True)
                addressed.update(link["pdfPages"])
            for item in links["unpairedPages"]:
                require(item["pdfPage"] in pages and item["reason"].strip(),
                        "solution_pages", "解答のみのページの根拠を確認できません。", True)
                addressed.add(item["pdfPage"])
            require(addressed == set(pages), "solution_pages", "公式解答の参照ページに欠落があります。", True)
            audit = ai.structured(f"solutions-review-{kind}-{start}-{attempt}",
                "独立した照合です。原画像の公式解答が、一覧の同じ欄・年月・条件・小問へ対応しているか検証。"
                "別月・別欄の同番号を混同していないか、一覧の対象問題にある解答を見落としていないか確認。"
                "対象PDFページ:" + str(pages) + "。checkedPdfPagesは対象全件。全問一覧:" + catalog
                + "。対応案:" + json_bytes(links).decode(), REVIEW_SCHEMA, inputs, max_tokens=8000)
            if audit["approved"] and not audit["issues"] and audit["checkedPdfPages"] == pages and not links["unresolvedIssues"]:
                accepted = links
                break
            feedback = "\n前回検証の指摘:" + json_bytes(audit).decode()
        require(accepted is not None, "solution_unresolved", "公式解答の対応に未解決事項があります。公開を保留しました。", True)
        for link in accepted["links"]:
            target = by_id[link["problemId"]]
            target["officialSolutionPages"] = sorted(set(target["officialSolutionPages"] + link["pdfPages"]))


def inventory_questions(doc, ai, plan, directory, specification):
    images = {page: page_image(doc, page, directory, prefix=plan["kind"] + "-lesson") for page in range(1, len(doc) + 1)}
    problems, solutions, coverage_records = [], [], []
    seen = set()
    for start in range(1, len(doc) + 1, 5):
        pages = list(range(start, min(start + 5, len(doc) + 1)))
        shown = list(range(max(1, start - 2), min(start + 7, len(doc) + 1)))
        mapping = [{"pdfPage": i + 1, "printedPages": page["printedPages"], "labels": page["labels"]}
                   for i, page in enumerate(plan["pages"])]
        prompt = (specification + "\n\nいまは切り出しPDFの全問一覧を確定する工程です。解説HTMLはまだ作らない。"
            "返すのは問題/例題の開始が対象ページ" + str(pages) + "にある全件。画像順はPDF通算" + str(shown)
            + "。前後ページは続き確認のため含めています。大問に属する全小問/選択肢/図示条件を記録。"
            "解説内の数値例を独立問題として増やさない。公式解答だけのページは元の問題IDへのsolutionLinksを記録。"
            "過去号学コン問題が再掲されている場合は別年/月をIDへ入れ、当月問題と混同しない。"
            "IDは欄+印刷問題番号でASCII英数字とハイフンのみ。points-example-1, practice-1, advanced-1, contest-2026-08-1等。"
            "小問なしの大問にもid=問題ID-mainの小問を1つ置く。複数欄の同番号は異なるID。"
            "coverageには対象PDFページを各1件記し、問題がない頁は理由を書く。判読不能な重要条件は推測せずunresolvedIssuesへ。"
            "ページ対応:" + json_bytes(mapping).decode()
            + "。既に確定した問題IDと内容（続き・解答の照合用）:" + json_bytes(problems).decode())
        feedback = ""
        accepted = None
        for attempt in range(2):
            batch = ai.structured(f"inventory-{plan['kind']}-{start}-{attempt}", prompt + feedback,
                INVENTORY_SCHEMA, [image_data(images[page]) for page in shown], max_tokens=18000)
            require([item["pdfPage"] for item in batch["coverage"]] == pages,
                    "inventory_coverage", "全問一覧のページ確認に欠落があります。", True)
            audit = ai.structured(f"inventory-review-{plan['kind']}-{start}-{attempt}",
                specification + "\n独立した検査です。画像から対象ページ" + str(pages)
                + "の全例題/問題/小問/条件/選択肢を数え直し、次の一覧の不足・重複・誤読・別号混入を検証してください。"
                "画像順は" + str(shown) + "。承認には全小問が必要。checkedPdfPagesは対象ページ全件。\n一覧:"
                + json_bytes(batch).decode(), REVIEW_SCHEMA,
                [image_data(images[page]) for page in shown], max_tokens=8000)
            if audit["approved"] and not audit["issues"] and audit["checkedPdfPages"] == pages and not batch["unresolvedIssues"] and all(not p["unresolvedIssues"] for p in batch["problems"]):
                accepted = batch
                break
            feedback = "\n前回検証指摘を原画像で再確認し修正:" + json_bytes(audit).decode()
        require(accepted is not None, "inventory_unresolved", "全問題・小問の条件に未解決事項があります。完成版の公開を保留しました。", True)
        coverage = {item["pdfPage"]: item for item in accepted["coverage"]}
        coverage_records.extend(accepted["coverage"])
        for problem in accepted["problems"]:
            require(re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", problem["id"])
                    and re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", problem["sectionId"])
                    and problem["id"] not in seen and problem["subquestions"] and problem["pdfPages"]
                    and problem["pdfPages"] == sorted(set(problem["pdfPages"]))
                    and min(problem["pdfPages"]) in pages and set(problem["pdfPages"]) <= set(shown),
                    "inventory_duplicate", "問題一覧の重複・ページ範囲を確認できません。", True)
            require(problem["id"] in coverage[min(problem["pdfPages"])]["questionIds"],
                    "inventory_coverage", "全問一覧と各ページの問題数が一致しません。", True)
            sub_ids = [item["id"] for item in problem["subquestions"]]
            require(len(sub_ids) == len(set(sub_ids)) and all(re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", item) for item in sub_ids),
                    "inventory_duplicate", "小問IDが重複しているか使用できない文字を含みます。", True)
            seen.add(problem["id"])
            problems.append(problem)
        solutions.extend(accepted["solutionLinks"])
    require(bool(problems), "no_problems", "PDF内の対象問題を確定できません。", True)
    by_id = {problem["id"]: problem for problem in problems}
    for record in coverage_records:
        require(record["questionIds"] or record["noQuestionReason"].strip(),
                "inventory_coverage", "問題がないページの確認根拠がありません。", True)
        require(all(identifier in by_id and record["pdfPage"] in by_id[identifier]["pdfPages"] for identifier in record["questionIds"]),
                "inventory_coverage", "ページ別の対象問題と全問一覧が一致しません。", True)
    solution_pages = {index + 1 for index, page in enumerate(plan["pages"])
                      if set(page["labels"]) & {"practice_solutions", "advanced_solutions", "contest_solutions"}}
    solution_pages.update(page for problem in problems for page in problem["officialSolutionPages"])
    solution_pages.update(page for link in solutions for page in link["pdfPages"])
    require(solution_pages <= set(images), "solution_pages", "公式解答の参照ページを確認できません。", True)
    reconcile_solution_pages(problems, sorted(solution_pages), images, ai, plan["kind"], specification)
    return problems, images


def validate_problem_coverage(problem, inventory):
    require(problem.get("id") == inventory["id"] and problem.get("sectionId") == inventory["sectionId"],
            "lesson_coverage", "解説の問題IDが対象一覧と一致しません。", True)
    expected = [item["id"] for item in inventory["subquestions"]]
    actual = [item["id"] for item in problem["subquestions"]]
    require(actual == expected, "lesson_coverage", "解説の全小問が対象一覧と一致しません。", True)
    require(set(problem["sourceImageIds"]) == {"source-" + str(page) for page in inventory["pdfPages"]},
            "lesson_source_images", "問題原画像の参照が一致しません。", True)


def generate_lesson(pdf_path, ai, studio, plan, directory, specification, year_month, schema_path):
    schema = json.loads(schema_path.read_text(encoding="utf-8"))
    problem_schema = copy.deepcopy(schema["$defs"]["problem"])
    problem_schema["$defs"] = copy.deepcopy(schema["$defs"])
    with open_pdf(pdf_path) as doc:
        inventory, images = inventory_questions(doc, ai, plan, directory, specification)
        problems = []
        for index, entry in enumerate(inventory):
            image_pages = sorted(set(entry["pdfPages"] + entry["officialSolutionPages"]))
            inputs = [image_data(images[page]) for page in image_pages]
            prompt = (specification + "\n\n対象一覧の次の1大問だけを全小問分完成させてください。"
                "答え・数値・図・音声文・静的解説を一貫させ、原画像を照合し算数で独立に解いて検算。"
                "既存IDを変更しない。任意HTML/SVG/JS文字列は出力せずschemaのtyped primitive/formulaのみ。"
                "新しいIDは英字で始めASCII英数字とハイフンだけ。すべての参照IDは実在し、図のラベルはfontSize14以上、"
                "図形の寸法・線幅・拡大率とviewBoxの幅高さは正の数。viewBoxは全ラベルと全移動範囲を余白込みで収める。"
                "各cueの図状態はvisibleIds/highlightIds/transformsによる完全状態。未導出値を先に出さない。"
                "sourceImageIdsは対象の各PDFページをsource-{ページ番号}として参照。全subquestionを同順序で返す。"
                "verificationは自分が実施した検算等を具体的に記録し、不明事項があればneeds_review。"
                "画像順はPDFページ" + str(image_pages) + "。公式解答ページ:" + str(entry["officialSolutionPages"])
                + "。一覧:" + json_bytes(entry).decode())
            feedback = ""
            verified = None
            for attempt in range(2):
                candidate = ai.structured(f"lesson-{plan['kind']}-{entry['id']}-{attempt}",
                    prompt + feedback, problem_schema, inputs, max_tokens=28000)
                validate_problem_coverage(candidate, entry)
                review = ai.structured(f"lesson-review-{plan['kind']}-{entry['id']}-{attempt}",
                    specification + "\n独立した数学・教材検証者として、原画像から全小問を別に検算し、以下の候補を点検。"
                    "重要な条件、相似の条件と対応、面積体積比、単位、例外、全式、数の出所、解法選択理由を確認。"
                    "原図の見た目を根拠にしない。図の点名・primitive座標・与件と導出値・発話state・静的解説・答えを照合。"
                    "全cueのかな読みを数値/点名/単位まで読む。公式解答が掲載されていれば全小問を照合し、なければその事実を明記。"
                    "実音声を試聴したとは言わない。全小問IDをcheckedSubquestionIdsへ。未解決ならapproved=false。"
                    "画像順:" + str(image_pages) + "。対象一覧:" + json_bytes(entry).decode()
                    + "。候補:" + json_bytes(candidate).decode(), PROBLEM_REVIEW, inputs, max_tokens=14000)
                expected = [item["id"] for item in entry["subquestions"]]
                if review["approved"] and not review["issues"] and review["checkedSubquestionIds"] == expected:
                    candidate["verification"] = {"status": "verified",
                        **{key: review[key] for key in ("independentCheck", "officialAnswerCheck", "reasoningCheck", "readingsCheck")},
                        "unresolvedIssues": []}
                    verified = candidate
                    break
                feedback = "\n独立検証で以下が未解決です。原画像で修正:" + json_bytes(review).decode()
            require(verified is not None, "lesson_unresolved", "数学・解説・読みの検証に未解決事項があり、完成版を公開していません。", True)
            problems.append(verified)
            studio.update(status="running", stage="lesson_generation", message="全問題の講義と検算を進めています。",
                          progress=round(35 + 45 * (index + 1) / len(inventory), 1))
    sections = []
    for item in inventory:
        if not any(section["id"] == item["sectionId"] for section in sections):
            sections.append({"id": item["sectionId"], "title": item["sectionTitle"]})
    used_pages = sorted(set(page for item in inventory for page in item["pdfPages"]))
    lesson = {"schemaVersion": "1.0", "title": plan["name"][:-4], "pdfName": plan["name"], "yearMonth": year_month,
        "sections": sections, "sourceImages": [{"id": "source-" + str(page), "assetId": "page-" + str(page),
            "alt": f"原問題 PDF {page}ページ", "pdfPage": page,
            "printedPage": "・".join(plan["pages"][page - 1]["printedPages"])} for page in used_pages],
        "problems": problems, "coverage": [{"problemId": item["id"], "sectionId": item["sectionId"],
            "pdfPages": item["pdfPages"], "printedPages": item["printedPages"],
            "subquestionIds": [sub["id"] for sub in item["subquestions"]]} for item in inventory],
        "review": {"coverageChecked": True, "mathematicsChecked": True, "readingsChecked": True, "unresolvedIssues": []}}
    jsonschema.validate(lesson, schema)
    assets = {"page-" + str(page): {"path": str(images[page].resolve()), "mimeType": "image/jpeg"} for page in used_pages}
    return lesson, assets


def render_lesson(lesson, assets, directory, automation_root):
    data_path, asset_path, html_path = directory / "lesson.json", directory / "assets.json", directory / "lesson.html"
    data_path.write_bytes(json_bytes(lesson))
    asset_path.write_bytes(json_bytes(assets))
    result = subprocess.run(["node", str(automation_root / "render-lesson.mjs"), "--input", str(data_path),
        "--assets", str(asset_path), "--output", str(html_path)], capture_output=True, text=True, check=False, timeout=120)
    require(result.returncode == 0 and html_path.exists(), "renderer_validation", "講義データ・図・操作の参照を検証できません。公開を保留しました。", True)
    require(html_path.stat().st_size <= 24 * 1024 * 1024, "html_too_large", "全問HTMLが公開容量の上限を超えました。内容を省略せず公開を保留しました。", True)
    return html_path
