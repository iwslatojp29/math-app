"""Optional mock-browser regression for extraction, Chat handoff and HTML import.

Run only in an environment that permits Playwright browser testing. Codex
CUA-only sessions should use test/studio.test.mjs and CUA instead.

Run with Python + Playwright and Node installed:
  python test/studio-ui.browser.py --node node --output-dir ../../work/studio-qa
An optional --browser path selects an already installed Chromium executable.
Every request is fulfilled or blocked by Playwright. No account, provider,
existing job, Drive file, AI call, or public deployment is accessed.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
from urllib.parse import urlsplit, parse_qs

from playwright.sync_api import sync_playwright, expect


ORIGIN = "https://studio.example.test"
CSRF = "fake-browser-test-csrf"
DATE = "2026-09-20T00:00:00Z"
MONTHLY = {"id": "monthly", "name": "2026年9月号.pdf", "size": "14000000", "modifiedTime": DATE}
CUT = {"id": "cut-pdf", "name": "2026年9月号_日日の演習.pdf", "size": "2400000", "modifiedTime": DATE, "sourceKind": "practice"}
ADVANCED = {**CUT, "id": "advanced-pdf", "name": "2026年9月号_発展演習・学力コンテスト.pdf", "sourceKind": "advanced"}
CATALOG = {"latestVerified": True, "defaultModel": "gpt-test", "verifiedAt": DATE,
           "models": [{"id": "gpt-test", "label": "最新モデル（テスト）"}, {"id": "gpt-other", "label": "別モデル（テスト）"}]}


def job(identifier, operation=None, **values):
    source = CUT if operation == "html" else MONTHLY
    value = {"id": identifier, "fileId": source["id"], "fileName": source["name"], "status": "completed",
             "stage": "completed", "createdAt": DATE, "updatedAt": DATE, **values}
    if operation:
        value["operation"] = operation
    return value


class Fixture:
    def __init__(self, html):
        self.html = html
        self.calls = []
        self.unexpected = []
        self.errors = []
        self.authenticated = True
        self.source_expired = False
        self.models = dict(CATALOG)
        self.sources = {"extract": [MONTHLY, {**MONTHLY, "id": "old-monthly", "name": "2026年8月号.pdf"}],
                        "html": [CUT, ADVANCED]}
        self.jobs = [job("legacy", result={"outputs": [{"kind": "practice", "pdf": {"name": CUT["name"], "url": "https://drive.example.test/pdf"},
                      "html": {"name": "既存の解説.html", "url": "https://drive.example.test/html"}, "published": {"url": "https://lesson.example.test/old.html"}}]}),
                     job("old-html", "html", result={"outputs": [{"kind": "practice", "html": {"name": "作成済み.html", "url": "https://drive.example.test/new-html"}}]})]

    @property
    def mutations(self):
        return [call for call in self.calls if call["method"] != "GET"]

    def route(self, route):
        request = route.request
        url = urlsplit(request.url)
        if url.scheme + "://" + url.netloc != ORIGIN:
            self.unexpected.append(request.url)
            route.abort()
            return
        if url.path == "/studio" and request.method == "GET":
            route.fulfill(status=200, content_type="text/html; charset=utf-8", body=self.html)
            return
        if not url.path.startswith("/api/studio/"):
            self.unexpected.append(request.url)
            route.abort()
            return
        path = url.path.removeprefix("/api/studio")
        body = request.post_data_json if request.post_data else None
        self.calls.append({"path": path, "query": url.query, "method": request.method,
                           "body": body, "csrf": request.headers.get("x-studio-csrf")})
        status = 200
        if request.method != "GET":
            assert request.headers.get("x-studio-csrf") == CSRF
        if path == "/session":
            result = {"authenticated": self.authenticated, "configured": True, "email": "owner@example.test", "csrf": CSRF}
        elif path == "/models":
            result = self.models
        elif path == "/sources":
            operation = parse_qs(url.query).get("operation", [None])[0]
            assert operation in {"extract", "html"}
            result = {"files": self.sources[operation]}
            if self.source_expired:
                status, result = 401, {"error": "drive_reconnect"}
        elif path == "/chat/instructions":
            route.fulfill(status=200, content_type="text/markdown; charset=utf-8", headers={"Content-Disposition": 'attachment; filename="original-instructions.md"', "Cache-Control": "private, no-store"}, body="# Original instruction fixture")
            return
        elif path.startswith("/chat/pdf/"):
            source = next(item for item in self.sources["html"] if item["id"] == path.split("/")[-1])
            assert parse_qs(url.query)["modifiedTime"] == [source["modifiedTime"]]
            route.fulfill(status=200, content_type="application/pdf", headers={"Content-Disposition": 'attachment; filename="selected.pdf"', "Cache-Control": "private, no-store"}, body=b"%PDF-1.4\n% Mock download fixture\n")
            return
        elif path == "/jobs" and request.method == "GET":
            result = {"jobs": self.jobs}
        elif path == "/jobs" and request.method == "POST":
            assert set(body) == {"fileId", "model", "operation"}
            assert body["operation"] == "extract", "Studio must never create an HTML API job"
            source = next(item for item in self.sources[body["operation"]] if item["id"] == body["fileId"])
            created = job("created-" + str(len(self.jobs)), body["operation"], fileId=source["id"], fileName=source["name"],
                          status="queued", stage="queued")
            self.jobs.insert(0, created)
            result = {"job": created}
        elif path.startswith("/jobs/"):
            parts = path.split("/")
            selected = next(item for item in self.jobs if item["id"] == parts[2])
            if len(parts) == 4:
                assert request.method == "POST" and parts[3] in {"retry", "cancel"}
                assert not (parts[3] == "retry" and selected.get("operation") == "html")
                selected.update(status="queued" if parts[3] == "retry" else "cancelled", stage="queued" if parts[3] == "retry" else "cancelled")
            result = {"job": selected}
        elif path == "/logout":
            self.authenticated = False
            result = {"ok": True}
        else:
            self.unexpected.append(request.url)
            status, result = 404, {"error": "unexpected_mock_request"}
        route.fulfill(status=status, content_type="application/json", body=json.dumps(result, ensure_ascii=False))

    def attach(self, browser, width=1194):
        context = browser.new_context(viewport={"width": width, "height": 1000}, reduced_motion="reduce")
        context.route("**/*", self.route)
        page = context.new_page()
        page.on("pageerror", lambda error: self.errors.append(str(error)))
        return context, page

    def clean(self):
        assert not self.unexpected, self.unexpected
        assert not self.errors, self.errors


def ready(page, operation="extract"):
    expect(page.locator("#connection-label")).to_have_text("Google 接続済み")
    expect(page.locator("#sources .source-card").first).to_be_visible()
    expect(page.locator("#operation-" + operation)).to_have_attribute("aria-pressed", "true")
    expect(page.locator("#refresh-jobs")).to_be_enabled()


def select(page, identifier):
    page.locator('[data-focus-key="source:' + identifier + '"]').click()


def no_overflow(page):
    dimensions = page.evaluate("({width:innerWidth, document:document.documentElement.scrollWidth, body:document.body.scrollWidth})")
    assert dimensions["document"] <= dimensions["width"] + 1, dimensions
    assert dimensions["body"] <= dimensions["width"] + 1, dimensions


def run(browser, html, output):
    fixture = Fixture(html)
    context, page = fixture.attach(browser)
    page.goto(ORIGIN + "/studio")
    ready(page)
    expect(page.locator("#jobs .job-card")).to_have_count(1)
    expect(page.get_by_role("link", name="講義を開く", exact=True)).to_have_attribute("href", "https://lesson.example.test/old.html")
    select(page, "extract:monthly")
    expect(page.locator("#start-job")).to_be_enabled()
    page.locator("#model-settings summary").click()
    page.locator("#model").select_option("gpt-other")
    page.locator('[data-focus-key="job:legacy"]').click()
    page.locator("#operation-html").click()
    ready(page, "html")
    expect(page.locator("#model-settings")).to_be_hidden()
    expect(page.locator("#start-job")).to_be_hidden()
    expect(page.locator("#jobs .job-card")).to_have_count(1)
    select(page, "html:advanced-pdf")
    expect(page.locator("#chat-ready")).to_be_visible()
    expect(page.locator("#download-instructions")).to_have_attribute("href", "/api/studio/chat/instructions")
    expect(page.locator("#open-chatgpt")).to_have_attribute("href", "https://chatgpt.com/")
    expect(page.locator("#operation-import")).to_have_attribute("href", "https://iwslatojp29.github.io/math-app/math/upload.html")
    assert not fixture.mutations
    assert not any(call["path"].startswith("/chat/") for call in fixture.calls)
    with page.expect_download() as pending:
        page.locator("#download-pdf").click()
    assert pending.value.suggested_filename == "selected.pdf"
    with page.expect_download() as pending:
        page.locator("#download-instructions").click()
    assert pending.value.suggested_filename == "original-instructions.md"
    page.locator("#copy-chat-prompt").click()
    expect(page.locator("#notice")).to_contain_text("文面")
    assert not fixture.mutations
    page.screenshot(path=str(output / "chat-ready-desktop.png"), full_page=True)
    page.locator("#operation-extract").click()
    expect(page.locator('[data-focus-key="source:extract:monthly"]')).to_have_attribute("aria-pressed", "true")
    page.locator("#start-job").click()
    expect(page.locator("#notice")).to_contain_text("PDFの切り出しを開始")
    assert fixture.mutations == [{"path": "/jobs", "query": "", "method": "POST", "body": {"fileId": "monthly", "model": "gpt-other", "operation": "extract"}, "csrf": CSRF}]
    extraction = fixture.jobs[0]
    extraction.update(status="completed", stage="completed", result={"outputs": [{"kind": "practice", "pdf": {"id": "fresh-pdf", "name": "今回切り出した新しいPDF.pdf", "url": "https://drive.example.test/created"}}]})
    fixture.sources["html"].append({**CUT, "id": "fresh-pdf", "name": "今回切り出した新しいPDF.pdf"})
    page.locator("#refresh-jobs").click()
    expect(page.locator("#start-job")).to_be_enabled()
    page.locator("#operation-html").click()
    expect(page.locator('[data-focus-key="source:html:fresh-pdf"]')).to_be_visible()
    page.locator("#operation-extract").click()
    page.locator('[data-focus-key="html-task:' + extraction["id"] + '"]').click()
    expect(page.locator('[data-focus-key="source:html:fresh-pdf"]')).to_have_attribute("aria-pressed", "true")
    assert len(fixture.mutations) == 1
    page.reload()
    ready(page, "html")
    expect(page.locator('[data-focus-key="source:html:fresh-pdf"]')).to_have_attribute("aria-pressed", "true")
    assert len(fixture.mutations) == 1
    fixture.clean()
    context.close()

    # Old failed HTML retains outputs and hands off the original source; no retry.
    history = Fixture(html)
    history.jobs[1].update(status="needs_attention", retryable=True, continuation=True,
                           result={"outputs": [{"kind": "practice", "html": {"url": "https://lesson.example.test/saved.html"}, "error": {"message": "以前の確認指摘", "details": ["数値を確認"]}}]})
    context, page = history.attach(browser)
    page.goto(ORIGIN + "/studio#chat")
    ready(page, "html")
    assert not any(call["path"] == "/models" for call in history.calls)
    expect(page.locator('[data-focus-key="retry:old-html"]')).to_have_count(0)
    expect(page.locator('[data-focus-key="cancel:old-html"]')).to_be_visible()
    page.locator('[data-focus-key="html-task:old-html"]').click()
    expect(page.locator('[data-focus-key="source:html:cut-pdf"]')).to_have_attribute("aria-pressed", "true")
    expect(page.locator("#jobs")).to_contain_text("以前の確認指摘")
    assert not history.mutations
    history.clean()
    context.close()

    for width in [1366, 1194, 1024, 768, 390]:
        layout = Fixture(html)
        context, page = layout.attach(browser, width)
        page.goto(ORIGIN + "/studio")
        ready(page)
        select(page, "extract:monthly")
        no_overflow(page)
        if width == 390:
            page.screenshot(path=str(output / "extract-mobile.png"), full_page=True)
        page.locator("#operation-html").click()
        ready(page, "html")
        select(page, "html:advanced-pdf")
        no_overflow(page)
        if width == 390:
            page.screenshot(path=str(output / "chat-mobile.png"), full_page=True)
        assert not layout.mutations
        layout.clean()
        context.close()

    safety = Fixture(html)
    safety.sources["extract"][0] = {**MONTHLY, "name": '<img src=x onerror="window.remoteCode=true">.pdf'}
    safety.models = {**CATALOG, "latestVerified": False, "defaultModel": None}
    context, page = safety.attach(browser)
    page.goto(ORIGIN + "/studio")
    ready(page)
    select(page, "extract:monthly")
    expect(page.locator("#sources img")).to_have_count(0)
    assert page.evaluate("window.remoteCode") is None
    expect(page.locator("#start-job")).to_be_disabled()
    page.locator("#operation-html").click()
    select(page, "html:cut-pdf")
    expect(page.locator("#download-pdf")).to_have_attribute("aria-disabled", "false")
    assert not safety.mutations
    safety.source_expired = True
    page.locator("#refresh-all").click()
    expect(page.locator("#workspace")).to_be_hidden()
    expect(page.locator("#gate-copy")).to_contain_text("Google Drive")
    expect(page.locator("#login")).to_be_visible()
    assert not safety.mutations
    safety.clean()
    context.close()
    return {"result": "PASS", "widths": [1366, 1194, 1024, 768, 390],
            "checks": ["selection-is-read-only", "extraction-only-job-and-csrf", "explicit-pdf-and-original-md-downloads",
                       "chat-handoff-without-model", "legacy-links", "new-cut-pdf-refresh", "mode-and-source-reload",
                       "no-html-api-retry", "copyable-chat-prompt", "import-link", "text-safety", "drive-reconnect", "no-horizontal-overflow"],
            "screenshots": str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node", default="node")
    parser.add_argument("--browser")
    parser.add_argument("--output-dir", type=Path, default=Path("studio-browser-results"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    html = subprocess.check_output([args.node, "--input-type=module", "-e", "import {studioPage} from './src/studio-ui.js'; process.stdout.write(studioPage());"], cwd=root).decode("utf-8")
    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, **({"executable_path": args.browser} if args.browser else {}))
        try:
            report = run(browser, html, output)
        finally:
            browser.close()
    (output / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    main()
