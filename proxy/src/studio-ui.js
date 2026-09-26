const STYLES = `
:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;color:#18332e;background:#f7f8f4;font-synthesis:none;--green:#17644e;--muted:#61716c;--line:#dbe3dc;--paper:#fff;--danger:#a03629}
*{box-sizing:border-box}body{margin:0;line-height:1.65}button,input,select{font:inherit}button,a,input,select{touch-action:manipulation}button,a{-webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{cursor:default;opacity:.52}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #e4a349;outline-offset:4px}a{color:var(--green)}[hidden]{display:none!important}.wrap{max-width:1120px;margin:auto;padding:0 24px}.topbar{border-bottom:1px solid var(--line);background:#ffffffb8}.topline{min-height:76px;display:flex;gap:18px;align-items:center;justify-content:space-between}.brand{font-weight:750;letter-spacing:.01em;display:flex;gap:12px;align-items:center}.brand-mark{width:35px;height:35px;display:grid;place-items:center;border-radius:11px;color:white;background:var(--green);font-size:24px}.brand small{display:block;color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.13em}.connection{font-size:12px;display:flex;align-items:center;gap:7px;text-align:right}.dot{width:8px;height:8px;border-radius:50%;background:#a7b4ae;flex:none}.dot.ready{background:#268164}.hero{padding:42px 0 29px;max-width:720px}.eyebrow{font-size:11px;font-weight:750;letter-spacing:.15em;color:var(--green);margin:0 0 8px}.hero h1{font-size:clamp(26px,4.8vw,38px);line-height:1.4;margin:0 0 13px;font-weight:750;letter-spacing:-.025em}.hero p{margin:0;color:var(--muted);font-size:14px}.panel{border:1px solid var(--line);border-radius:20px;background:var(--paper);padding:24px}.gate{max-width:630px;margin:8px 0 35px}.gate h2{font-size:20px;margin:0 0 10px}.gate p{color:var(--muted);font-size:14px;margin:0 0 20px}.primary,.secondary,.quiet,.danger{min-height:44px;border-radius:11px;padding:10px 17px;font-weight:650;border:1px solid transparent;text-decoration:none;display:inline-flex;justify-content:center;align-items:center;gap:8px}.primary{color:white;background:var(--green)}.primary:hover:not(:disabled){background:#104f3c}.secondary{color:var(--green);background:#f1f6f2;border-color:#d5e4d9}.quiet{color:var(--muted);background:transparent;border-color:var(--line)}.danger{color:var(--danger);background:#fff6f2;border-color:#efdbd1}.notice{font-size:13px;border:1px solid #e7d8b5;background:#fff9eb;color:#75571e;border-radius:12px;padding:13px 16px;margin:0 0 20px;white-space:pre-wrap;overflow-wrap:anywhere}.notice.error{border-color:#e9cfc5;background:#fff4ef;color:#883f2d}.notice.good{border-color:#cddfcf;background:#f0f7ef;color:#315d39}.layout{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:24px;align-items:start;padding-bottom:55px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.section-head h2{font-size:19px;line-height:1.4;margin:0}.section-head p{font-size:12px;color:var(--muted);margin:5px 0 0}.section-head button{font-size:12px;padding:7px 11px;white-space:nowrap}.search{width:100%;min-height:45px;border:1px solid var(--line);background:#fbfcfa;color:inherit;border-radius:11px;padding:10px 13px;font-size:16px;margin-bottom:15px}.source-list{display:grid;gap:10px;max-height:600px;overflow:auto;padding:3px;margin:-3px}.source-card{width:100%;display:flex;gap:12px;align-items:flex-start;text-align:left;border:1px solid var(--line);border-radius:13px;padding:15px;background:white;color:inherit;transition:border-color .15s,background .15s}.source-card:hover:not(:disabled){border-color:#569376;background:#f6faf5}.pdf-icon{flex:none;background:#f9efe7;color:#99663f;width:38px;height:45px;display:grid;place-items:center;border-radius:7px;font-size:10px;font-weight:800;letter-spacing:.04em}.source-copy{min-width:0;flex:1}.source-title{display:block;font-weight:650;font-size:14px;overflow-wrap:anywhere;line-height:1.6}.source-meta{display:block;color:var(--muted);font-size:11px;margin-top:5px}.source-action{display:block;color:var(--green);font-size:12px;margin-top:9px;font-weight:650}.empty{padding:30px 12px;text-align:center;font-size:13px;color:var(--muted);border:1px dashed var(--line);border-radius:12px;white-space:pre-wrap}.model-settings{border-top:1px solid var(--line);margin-top:20px;padding-top:15px}.model-settings summary{font-size:13px;font-weight:650;cursor:pointer;min-height:35px}.model-settings label{font-size:12px;color:var(--muted);display:block;margin:12px 0 6px}.model-settings select{width:100%;min-height:46px;border:1px solid var(--line);border-radius:10px;background:white;padding:10px;color:inherit;font-size:16px}.fine{color:var(--muted);font-size:11px;line-height:1.8;overflow-wrap:anywhere}.model-notice{margin-top:10px;font-size:12px;color:#805e22;white-space:pre-wrap}.job-list{display:grid;gap:12px}.job-card{border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}.job-card.active{border-color:#abc9b4;background:#f9fcf7}.job-card.selected{box-shadow:0 0 0 2px #dfebdf}.job-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}.badge{font-size:11px;font-weight:700;background:#eef2ed;color:#52635a;padding:3px 9px;border-radius:20px;white-space:nowrap}.badge.running,.badge.queued{background:#e5f2e5;color:#29623e}.badge.completed{background:#dfefe9;color:#17644e}.badge.failed,.badge.needs_attention{background:#fff0df;color:#915522}.date{font-size:10px;color:var(--muted)}.job-title{border:0;background:transparent;color:inherit;font-weight:700;text-align:left;padding:0;min-height:28px;overflow-wrap:anywhere;line-height:1.6;width:100%;font-size:14px}.job-stage{font-size:12px;color:var(--muted);margin:9px 0 5px;white-space:pre-wrap;overflow-wrap:anywhere}.progress-track{height:5px;background:#e2eae0;border-radius:9px;overflow:hidden;margin:10px 0 12px}.progress-fill{height:100%;background:#66a37c;border-radius:9px;transition:width .3s}.progress-track.indeterminate .progress-fill{width:35%;animation:waiting 1.8s ease-in-out infinite}@keyframes waiting{0%{transform:translateX(-105%)}100%{transform:translateX(390%)}}.job-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.job-actions button,.job-actions a{font-size:12px;min-height:42px;padding:9px 12px}.output{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.output-name{font-size:12px;font-weight:650;overflow-wrap:anywhere;margin:0 0 6px}.output-links{display:flex;gap:7px;flex-wrap:wrap}.output-links a{font-size:12px;min-height:42px}.summary{font-size:12px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}.job-error{font-size:12px;color:#963f29;background:#fff3ed;padding:10px;border-radius:9px;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}.footer{border-top:1px solid var(--line);color:var(--muted);font-size:11px;padding:20px 0 28px}.sr-only{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0)}.refreshing{opacity:.6}
@media(max-width:780px){.layout{grid-template-columns:1fr}.wrap{padding:0 18px}.hero{padding:29px 0 25px}.panel{padding:19px;border-radius:17px}.source-list{max-height:440px}.topline{min-height:68px}.connection{max-width:140px;font-size:11px}.brand{font-size:14px}.brand small{font-size:10px}.layout{gap:20px}.gate{margin-bottom:28px}}

.operation-tabs{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;position:sticky;top:0;z-index:10;padding:10px 0 18px;background:#f7f8f4f5;backdrop-filter:blur(6px);margin-bottom:10px}.operation-tab{display:flex;align-items:center;gap:13px;min-width:0;border:1px solid var(--line);background:white;border-radius:16px;color:#657a70;padding:17px 19px;text-align:left;transition:background .15s,border-color .15s}.operation-tab>span:nth-child(2){flex:1;min-width:0}.operation-tab strong{display:block;color:#345b4d;font-size:16px;line-height:1.5}.operation-tab small{display:block;color:var(--muted);font-size:12px;margin-top:5px;line-height:1.6}.operation-tab.selected{background:#eaf3e9;border-color:#8bb798;box-shadow:inset 0 0 0 1px #c5dac7}.operation-tab.selected strong{color:#175c43}.operation-tab:hover:not(:disabled){border-color:#8bb798}.operation-mark{width:39px;height:43px;border:1px solid #d7e2d8;background:#f6faf3;color:#5f856a;border-radius:9px;display:grid;place-items:center;flex:none;font-size:10px;font-weight:750;letter-spacing:.02em}.operation-arrow{font-size:20px;flex:none;color:#7a9a82}.source-card.selected{background:#eef6eb;border-color:#83ac8b;box-shadow:inset 0 0 0 1px #d1e3cc}.source-card.selected .source-action{font-weight:750;color:#17644e}.start-panel{margin-top:20px;padding:19px;border:1px solid #d3e2d3;border-radius:15px;background:#f5f9f1}.start-label{font-size:11px;font-weight:700;letter-spacing:.05em;color:#789077;margin:0 0 6px}.selected-source{font-size:14px;font-weight:700;line-height:1.8;overflow-wrap:anywhere;margin:0 0 12px;color:#284f3e}.operation-disclosure{font-size:12px;line-height:1.9;color:#6b7b68;margin:0 0 17px}.start-button{width:100%;font-size:15px;min-height:49px;padding:12px 16px}.start-state{margin:12px 0 0;font-size:12px}.start-panel>.quiet{margin-top:12px;width:100%;font-size:13px}.source-list{max-height:410px}.source-meta{font-size:12px}.fine{font-size:12px}.hero{max-width:none}.job-actions .secondary{white-space:normal}.job-card{scroll-margin-top:118px}#sources-title,#history{scroll-margin-top:118px}
@media(max-width:780px){.operation-tabs{gap:10px}.operation-tab{padding:14px 12px;gap:10px}.operation-tab strong{font-size:14px}.operation-tab small{font-size:11px}.operation-mark{width:31px;height:38px;font-size:9px}.operation-arrow{display:none}.source-list{max-height:340px}.start-panel{padding:16px}.source-meta{font-size:12px}}
@media(max-width:520px){.operation-tabs{grid-template-columns:1fr;gap:8px;padding:8px 0 14px}.operation-tab{padding:12px 14px;border-radius:12px}.operation-tab small{display:none}.operation-tab strong{font-size:14px}.operation-mark{width:33px;height:32px}.operation-arrow{display:block;font-size:18px}.hero h1{font-size:27px}.hero{padding:28px 0 18px}.section-head{flex-wrap:wrap}.section-head h2{font-size:18px}.start-button{font-size:14px}.source-title,.job-title{font-size:14px}.operation-disclosure{font-size:12px}.job-card,#sources-title,#history{scroll-margin-top:145px}}

.previous-issue{border:1px solid var(--line);background:#f1f4ef;color:var(--muted);padding:10px 12px;border-radius:9px;margin-top:12px}.previous-issue-title{font-size:12px;font-weight:650;margin:0 0 5px}.previous-issue .summary{margin:6px 0 0}
.previous-api-issue{margin-top:12px;border:1px solid var(--line);border-radius:9px;padding:10px 12px;background:#f7f9f5}.previous-api-issue>summary{font-size:12px;font-weight:650;color:var(--muted);cursor:pointer}.previous-api-issue .summary{margin-top:9px}
.operation-tabs{grid-template-columns:repeat(3,minmax(0,1fr))}.operation-tab{text-decoration:none}.operation-tab strong{font-size:15px}.handoff-panel{margin-top:18px}.handoff-panel h3{font-size:16px;margin:0 0 8px}.handoff-panel p{font-size:13px;color:var(--muted);line-height:1.9}.handoff-downloads{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin:16px 0}.handoff-downloads a{font-size:13px}.handoff-downloads a[aria-disabled="true"]{opacity:.5;pointer-events:none}.chat-prompt{width:100%;min-height:155px;padding:12px;border:1px solid var(--line);border-radius:10px;background:#fff;color:inherit;font:inherit;font-size:14px;line-height:1.8;resize:vertical}.handoff-panel label{display:block;font-size:13px;font-weight:650;margin:18px 0 7px}.handoff-actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.handoff-actions>*{font-size:13px}.handoff-import{border-top:1px solid var(--line);padding-top:16px;margin-top:20px}.job-card,#sources-title,#history{scroll-margin-top:150px}
@media(max-width:780px){.operation-tabs{grid-template-columns:1fr;gap:7px}.operation-tab{padding:11px 14px}.operation-tab small{display:none}.operation-mark{height:31px}.operation-arrow{display:block}.operation-tab strong{font-size:14px}.job-card,#sources-title,#history{scroll-margin-top:205px}}
@media(max-width:420px){.handoff-downloads{grid-template-columns:1fr}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

// All remote strings are assigned through textContent. No API value enters markup.
// Keep browser code as source text: Worker bundlers may inject private helpers
// into functions, so serializing a bundled function with toString() is unsafe.
const CLIENT_SCRIPT = String.raw`(function studioClient() {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { operation: 'extract', sources: { extract: [], html: [] }, sourceLoaded: { extract: false, html: false }, sourceRequests: {}, selectedFiles: { extract: '', html: '' }, selectedJobs: { extract: '', html: '' }, authenticated: false, csrf: '', files: [], jobs: [], jobsLoaded: false, models: null, selectedModel: 'auto', selectedJob: '', starting: new Set(), actions: new Set(), timer: null, refreshing: false, sourceError: '', jobsError: '', pdfDownloading: false };
  const labels = { queued: '順番待ち', running: '作成中', needs_attention: '確認が必要', failed: '作成できませんでした', completed: '完成', cancelled: '取り消し済み' };
  const stageLabels = { queued: '作成を待っています', download: 'PDF を取得しています', pdf_review: '冊子のページと切り出し範囲を確認しています', lesson_inventory: '全問題と小問の一覧を確認しています', lesson_generation: '全問題の講義と検算を進めています', publishing: '講義を公開して表示を確認しています', reading: 'PDF を読み込んでいます', downloading: 'PDF を取得しています', analyzing: '内容を整理しています', planning: '教材の構成を考えています', generating: '問題と解説を作成しています', validating: '内容を確認しています', rendering: '教材ファイルを仕上げています', uploading: '完成ファイルを保存しています', completed: '教材が完成しました', needs_attention: '保存できた教材を残して、確認を待っています', failed: '保存済みの段階から再試行できます', interrupted: 'クラウド処理が中断しました', cancelled: '作成を取り消しました' };
  const kindLabels = { practice: '日日の演習', advanced: '発展演習・学力コンテスト' };
  const operationLabels = { extract: 'PDFを切り出す', html: 'Chatに渡す' };
  const chatPrompt = '添付したPDFと作成指示書（MD）に従い、全問題を対象にアニメーション付きの解答解説HTMLを作成してください。指示書の検算・出典確認も行ってください。保存・公開はアプリで行うので、完成HTMLはダウンロードできるファイルとして渡してください。';
  const jobOperation = job => job?.operation === 'html' ? 'html' : 'extract';
  const active = job => job?.status === 'queued' || job?.status === 'running';
  const recovering = job => jobOperation(job) !== 'html' && ['failed', 'needs_attention'].includes(job?.status) && (job.retryable === true || job.dispatchUncertain === true);
  const text = value => typeof value === 'string' ? value : '';
  const clean = value => text(value).replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[非表示]').replace(/Bearer\s+\S+/gi, 'Bearer [非表示]').slice(0, 4000);
  const node = (tag, className, content) => { const item = document.createElement(tag); if (className) item.className = className; if (content !== undefined) item.textContent = content; return item; };
  const date = value => { const parsed = new Date(value); return value && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(parsed) : ''; };
  const fileId = file => text(file?.id || file?.fileId);
  const jobId = job => text(job?.id || job?.jobId);
  const name = file => text(file?.name || file?.fileName) || '名前のない PDF';
  const jobName = job => text(job?.fileName || job?.sourceName || job?.source?.name) || name([...state.sources.extract, ...state.sources.html].find(file => fileId(file) === job.fileId));
  function notice(message, error = false) { $('notice').textContent = clean(message); $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
  function focusKey(key) { const item = [...document.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === key); if (item && !item.disabled) item.focus({ preventScroll: true }); }
  function rememberFocus(render) { const key = document.activeElement?.dataset.focusKey; render(); if (key) focusKey(key); }
  function expired(reason = 'expired') {
    state.authenticated = false;
    state.csrf = '';
    clearTimeout(state.timer);
    $('workspace').hidden = true;
    $('gate').hidden = false;
    $('login').hidden = false;
    $('logout').hidden = true;
    $('account').textContent = '';
    $('gate-title').textContent = 'Google にもう一度接続してください';
    $('gate-copy').textContent = reason === 'drive_reconnect' ? 'Google Drive への接続を確認できません。もう一度接続すると、保存された作成履歴から続けられます。' : 'ログインの有効期限が切れました。再接続すると、保存された作成履歴を続けて確認できます。';
    $('connection-label').textContent = '再接続が必要';
    $('connection-dot').classList.remove('ready');
  }
  function errorMessage(payload) {
    const code = typeof payload?.error === 'string' ? payload.error : payload?.error?.code || payload?.code;
    const messages = { csrf_invalid: '画面の有効期限が切れました。ページを再読み込みしてください。', invalid_csrf: '画面の有効期限が切れました。ページを再読み込みしてください。', already_running: 'この教材は作成中です。作成履歴をご確認ください。', job_already_running: 'この教材は作成中です。作成履歴をご確認ください。', latest_unverified: '最新モデルを確認できません。モデルを選択するか、時間をおいて再試行してください。', model_unavailable: 'このモデルは現在利用できません。別のモデルを選択してください。', rate_limited: 'ただいま混み合っています。少し待って再試行してください。', not_found: '対象が見つかりません。画面を更新してください。' };
    return messages[code] || clean(payload?.publicMessage || payload?.message) || '操作を完了できませんでした。時間をおいて再試行してください。';
  }
  async function api(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25000);
    try {
      const options = { credentials: 'same-origin', signal: controller.signal, headers: { Accept: 'application/json' } };
      if (body !== undefined) {
        if (!state.csrf) throw new Error('画面を再読み込みして、もう一度お試しください。');
        options.method = 'POST';
        options.headers['Content-Type'] = 'application/json';
        options.headers['x-studio-csrf'] = state.csrf;
        options.body = JSON.stringify(body);
      }
      const response = await fetch('/api/studio' + path, options);
      let value;
      try { value = await response.json(); } catch { throw new Error('サーバーから応答を読み取れませんでした。再試行してください。'); }
      if (response.status === 401) { expired(value?.error); throw new Error('Google への再接続が必要です。'); }
      if (!response.ok) throw new Error(errorMessage(value));
      return value;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('応答に時間がかかっています。作成履歴を確認してから再試行してください。');
      if (error instanceof TypeError) throw new Error('通信できませんでした。接続を確認して再試行してください。');
      throw error;
    } finally { clearTimeout(timer); }
  }
  function schedule() {
    clearTimeout(state.timer);
    const watching = state.jobs.some(job => active(job) || recovering(job));
    if (state.authenticated && !document.hidden && watching) state.timer = setTimeout(refreshJobs, 10000);
    $('poll-note').textContent = state.jobs.some(recovering) ? '自動再開を待っています。状況は 10 秒ごとに更新されます。画面を閉じてもクラウドで再開します。' : watching ? '作成状況は 10 秒ごとに更新されます。画面を閉じても作成は続きます。' : '作成履歴はクラウドに保存されます。';
  }
  function modelReady() {
    if (!state.models || !state.authenticated || !state.jobsLoaded) return false;
    return state.selectedModel === 'auto' ? state.models.latestVerified === true && Boolean(state.models.defaultModel) : state.models.models?.some(model => model.id === state.selectedModel);
  }
  function renderModels() {
    const select = $('model');
    select.replaceChildren();
    const catalog = state.models;
    const automatic = node('option', '', catalog?.latestVerified ? '最新モデルを自動選択' : '最新モデル（確認できていません）');
    automatic.value = 'auto';
    select.append(automatic);
    for (const model of Array.isArray(catalog?.models) ? catalog.models : []) {
      if (!text(model.id)) continue;
      const option = node('option', '', text(model.label) || model.id);
      option.value = model.id;
      select.append(option);
    }
    if (![...select.options].some(option => option.value === state.selectedModel)) state.selectedModel = 'auto';
    select.value = state.selectedModel;
    select.disabled = !catalog;
    $('model-note').textContent = catalog?.latestVerified ? '現在の最新モデル：' + catalog.defaultModel + (catalog.verifiedAt ? ' ／ 確認 ' + date(catalog.verifiedAt) : '') : catalog?.verifiedAt ? '前回の確認：' + date(catalog.verifiedAt) : '最新モデルの確認が必要です。';
    const warning = clean(catalog?.warning) + (!catalog?.latestVerified ? '\nモデルを選択するか、画面を更新してください。' : '');
    $('model-warning').textContent = warning.trim();
    $('model-warning').hidden = !warning.trim();
    if (!catalog?.latestVerified) $('model-settings').open = true;
    renderSources();
  }
  function updateLocation() {
    const params = new URLSearchParams(state.operation === 'html' ? 'chat' : 'operation=extract');
    if (state.selectedJob) params.set('job', state.selectedJob);
    if (state.operation === 'html' && state.selectedFiles.html) params.set('file', state.selectedFiles.html);
    history.replaceState(null, '', location.pathname + location.search + '#' + params.toString().replace(/^chat=/, 'chat'));
    try { localStorage.setItem('math-studio-operation', state.operation); } catch { /* Operation tabs also work with storage disabled. */ }
  }
  function renderOperation() {
    const html = state.operation === 'html';
    for (const operation of ['extract', 'html']) {
      const tab = $('operation-' + operation);
      tab.setAttribute('aria-pressed', String(state.operation === operation));
      tab.classList.toggle('selected', state.operation === operation);
      tab.disabled = state.starting.size > 0;
    }
    $('operation-title').textContent = html ? 'PDFと指示書を、ChatGPTへ。' : '切り出して、Chatへ渡し、HTMLを取り込む。';
    $('operation-intro').textContent = html ? '2つのファイルをダウンロードしてChatGPTに添付します。完成した解答解説HTMLは、取込画面から保存・公開できます。' : 'まず月間号から必要なPDFを切り出します。解答解説はPDFと指示書をChatGPTに添付して作り、完成HTMLを取り込みます。';
    $('sources-title').textContent = html ? 'Chatに渡すPDFを選ぶ' : '切り出す月間号を選ぶ';
    $('jobs-title').textContent = html ? '以前のHTML作成履歴' : 'PDF切り出しの履歴';
    $('jobs-description').textContent = html ? '保存済みの結果を開けます。新しい解説はChatGPTで作成します。' : 'PDFの作成状況と、保存したファイル';
    $('operation-disclosure').textContent = html ? '選択したPDFと、元の解答解説作成指示書（MD）を手元に保存します。2つのファイルは、ご自身でChatGPTに添付してください。' : '実行ボタンを押すと、選択した月間号をAIで読み取り、日日系と発展・学コン系の範囲を判定してPDFを切り出し、Driveへ保存します。AIの利用料金が発生します。解答解説HTMLの生成は行いません。';
    $('model-settings').hidden = html;
    $('start-job').hidden = html;
    $('chat-panel').hidden = !html;
    $('start-job').textContent = operationLabels[state.operation];
    renderStart();
  }
  function renderStart() {
    const selected = state.files.find(file => fileId(file) === state.selectedFiles[state.operation]);
    const running = state.jobs.find(active);
    const pending = state.starting.size > 0;
    $('selected-source').textContent = selected ? name(selected) : 'PDFが選択されていません';
    if (state.operation === 'html') {
      $('start-job').disabled = true;
      $('show-running').hidden = true;
      $('start-state').textContent = selected ? 'PDFと指示書を保存してから、ChatGPTに添付してください。' : 'まず一覧からChatに渡すPDFを選択してください。';
      $('chat-ready').hidden = !selected || !state.authenticated;
      $('chat-prompt').value = chatPrompt;
      const downloadable = Boolean(selected && text(selected.modifiedTime));
      $('download-pdf').setAttribute('aria-disabled', String(!downloadable || state.pdfDownloading));
      $('download-pdf').setAttribute('aria-busy', String(state.pdfDownloading));
      if (downloadable) $('download-pdf').href = '/api/studio/chat/pdf/' + encodeURIComponent(fileId(selected)) + '?modifiedTime=' + encodeURIComponent(selected.modifiedTime);
      else $('download-pdf').removeAttribute('href');
      if (selected && !downloadable) $('start-state').textContent = 'PDFの更新日時を確認できません。「画面を更新」してからダウンロードしてください。';
      return;
    }
    $('start-job').disabled = !selected || !modelReady() || Boolean(running) || pending || !state.authenticated;
    $('start-state').textContent = pending ? '開始状況を確認しています…' : running ? (jobOperation(running) === 'html' ? '解答解説HTMLを作成中です。' : 'PDFを切り出しています。') + '完了後に次の処理を開始できます。' : !state.jobsLoaded ? '作成履歴を確認しています…' : !selected ? 'まず一覧からPDFを選択してください。選択だけでは処理は始まりません。' : !modelReady() ? '開始するには、利用できるモデルを確認・選択してください。' : 'この実行ボタンを押すまで、AI処理やファイルの保存は始まりません。';
    $('show-running').hidden = !running || jobOperation(running) === state.operation;
    $('start-job').textContent = pending ? '開始しています…' : operationLabels[state.operation];
  }
  function selectSource(file) {
    const id = fileId(file);
    if (!id) return;
    state.selectedFiles[state.operation] = id;
    if (!state.pdfDownloading) $('pdf-download-status').textContent = '';
    updateLocation();
    renderSources();
  }
  function renderSources() {
    rememberFocus(() => {
      const list = $('sources');
      list.replaceChildren();
      const search = $('search').value.trim().toLocaleLowerCase('ja');
      const files = state.files.filter(file => name(file).toLocaleLowerCase('ja').includes(search));
      const folderLabel = state.operation === 'html' ? '日日系・発展/学コン系の保存済みPDF' : 'Google Drive の月間号PDF';
      $('source-count').textContent = state.files.length ? state.files.length + ' 件 · ' + folderLabel : folderLabel;
      if (!files.length) {
        list.append(node('p', 'empty', state.sourceError || (!state.sourceLoaded[state.operation] ? 'PDF一覧を読み込んでいます…' : search ? '一致するPDFがありません。' : state.operation === 'html' ? '切り出し済みのPDFがありません。PDF切り出し画面で先に作成してください。' : '月間号PDFがありません。Google Drive の教材フォルダをご確認ください。')));
      }
      for (const file of files) {
        const id = fileId(file);
        const selected = state.selectedFiles[state.operation] === id;
        const button = node('button', 'source-card' + (selected ? ' selected' : ''));
        button.type = 'button';
        button.dataset.focusKey = 'source:' + state.operation + ':' + id;
        button.setAttribute('aria-pressed', String(selected));
        button.disabled = !id;
        button.append(node('span', 'pdf-icon', 'PDF'));
        const copy = node('span', 'source-copy');
        copy.append(node('span', 'source-title', name(file)));
        const metadata = [];
        if (state.operation === 'html' && Object.hasOwn(kindLabels, file.sourceKind)) metadata.push(kindLabels[file.sourceKind]);
        if (file.modifiedTime) metadata.push('更新 ' + date(file.modifiedTime));
        const bytes = Number(file.size);
        if (Number.isFinite(bytes) && bytes > 0) metadata.push((bytes / 1024 / 1024).toFixed(1) + ' MB');
        if (metadata.length) copy.append(node('span', 'source-meta', metadata.join(' · ')));
        copy.append(node('span', 'source-action', selected ? '✓ 選択中' : 'このPDFを選択'));
        button.append(copy);
        button.addEventListener('click', () => selectSource(file));
        list.append(button);
      }
    });
    renderStart();
  }
  async function loadSources(operation, force = false) {
    if (!state.authenticated) return;
    if (state.sourceLoaded[operation] && !force) {
      if (state.operation === operation) { state.files = state.sources[operation]; renderSources(); }
      return;
    }
    if (state.sourceRequests[operation]) return state.sourceRequests[operation];
    const request = (async () => {
      try {
        const value = await api('/sources?operation=' + operation);
        if (!Array.isArray(value.files)) throw new Error('PDF一覧を読み取れませんでした。');
        state.sources[operation] = value.files.filter(file => file && fileId(file));
        state.sourceLoaded[operation] = true;
        if (state.operation === operation) { state.files = state.sources[operation]; state.sourceError = ''; }
      } catch (error) {
        if (state.operation === operation) { state.sourceError = error.message; notice(error.message, true); }
      } finally {
        delete state.sourceRequests[operation];
        if (state.authenticated && state.operation === operation) renderSources();
      }
    })();
    state.sourceRequests[operation] = request;
    return request;
  }
  async function chooseOperation(operation) {
    if (!Object.hasOwn(operationLabels, operation) || state.starting.size) return;
    const selected = state.jobs.find(job => jobId(job) === state.selectedJob);
    state.selectedJobs[state.operation] = !selected || jobOperation(selected) === state.operation ? state.selectedJob : '';
    state.operation = operation;
    state.selectedJob = state.selectedJobs[operation] || '';
    state.files = state.sources[operation];
    state.sourceError = '';
    $('search').value = '';
    notice('');
    updateLocation(); renderOperation(); renderSources(); renderJobs();
    await loadSources(operation);
    if (operation === 'extract' && !state.models) await loadModels();
  }
  async function openChatForJob(job) {
    await chooseOperation('html');
    await loadSources('html', true);
    const ids = jobOperation(job) === 'html' ? [job.fileId] : (job.result?.outputs || []).map(output => output?.pdf?.id);
    const file = state.sources.html.find(item => ids.includes(fileId(item)));
    if (file) selectSource(file);
    $('sources-title').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  async function copyChatPrompt() {
    try { await navigator.clipboard.writeText($('chat-prompt').value); notice('ChatGPTに貼り付ける文面をコピーしました。PDFと指示書も添付してください。'); }
    catch { $('chat-prompt').focus(); $('chat-prompt').select(); notice('文面を選択しました。コピーしてChatGPTに貼り付けてください。'); }
  }
  async function downloadPdf(event) {
    // Modified clicks retain normal link behavior; ordinary clicks save a checked blob.
    if (event && (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
    event?.preventDefault();
    const file = state.sources.html.find(item => fileId(item) === state.selectedFiles.html);
    if (state.pdfDownloading || !state.authenticated || !file || !text(file.modifiedTime)) return;
    const limit = 100 * 1024 * 1024;
    const filename = name(file).replace(/[\\/\u0000-\u001f\u007f]/g, '_');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 180000);
    state.pdfDownloading = true; renderStart();
    notice('');
    $('pdf-download-status').textContent = '「' + filename + '」を取得しています…';
    try {
      if (Number(file.size) > limit) throw new Error('PDFがダウンロードできる容量（100MiB）を超えています。');
      const response = await fetch('/api/studio/chat/pdf/' + encodeURIComponent(fileId(file)) + '?modifiedTime=' + encodeURIComponent(file.modifiedTime), {
        method: 'GET', credentials: 'same-origin', headers: { Accept: 'application/pdf' }, signal: controller.signal,
      });
      const type = response.headers.get('Content-Type') || '';
      if (!response.ok || type.includes('json')) {
        let value; try { value = await response.json(); } catch { value = null; }
        if (response.status === 401) expired(value?.error);
        throw new Error(errorMessage(value));
      }
      if (!/^application\/pdf(?:;|$)/i.test(type) || !response.body) throw new Error('PDFを取得できませんでした。画面を更新して再度お試しください。');
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      try {
        if (Number(response.headers.get('Content-Length')) > limit) throw new Error('PDFがダウンロードできる容量（100MiB）を超えています。');
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > limit) throw new Error('PDFがダウンロードできる容量（100MiB）を超えています。');
          chunks.push(value);
        }
      } catch (error) { await reader.cancel().catch(() => {}); throw error; }
      finally { reader.releaseLock(); }
      if (!bytes) throw new Error('PDFが空のため保存できませんでした。');
      const objectUrl = URL.createObjectURL(new Blob(chunks, { type: 'application/pdf' }));
      const link = node('a'); link.href = objectUrl; link.download = filename; link.hidden = true;
      document.body.append(link);
      try { link.click(); $('pdf-download-status').textContent = '取得が完了し、「' + filename + '」の保存を開始しました。'; }
      finally { link.remove(); setTimeout(() => URL.revokeObjectURL(objectUrl), 60000); }
    } catch (error) {
      const reason = error.name === 'AbortError' ? '取得に時間がかかっています。再度お試しください。' : error instanceof TypeError ? '通信中に取得を完了できませんでした。画面を更新して再度お試しください。' : error.message;
      const message = 'PDFの取得に失敗しました。' + clean(reason);
      $('pdf-download-status').textContent = message; notice(message, true);
    } finally { clearTimeout(timeout); state.pdfDownloading = false; renderStart(); }
  }
  function safeUrl(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) return null;
    try { const url = new URL(value, location.origin); return !url.username && !url.password && (url.protocol === 'https:' || url.origin === location.origin && url.protocol === 'http:') ? url.href : null; } catch { return null; }
  }
  function outputLink(value, label, primary) {
    const href = safeUrl(value);
    if (!href) return null;
    const link = node('a', primary ? 'primary' : 'secondary', label);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  }
  function appendIssue(parent, job, message, details = []) {
    if (!message && !details.length) return;
    let container = parent;
    const historical = jobOperation(job) === 'html';
    const previous = !historical && (active(job) || recovering(job));
    if (historical) {
      container = node('details', 'previous-api-issue');
      container.open = false;
      container.append(node('summary', '', '以前のAPI生成の記録'));
      parent.append(container);
    } else if (previous) {
      container = node('div', 'previous-issue');
      container.append(node('p', 'previous-issue-title', '前回停止時の指摘（' + (recovering(job) ? '自動再開待ち' : '再開処理中') + '）'));
      parent.append(container);
    }
    if (message) container.append(node('p', previous || historical ? 'summary' : 'job-error', message));
    if (details.length) {
      const list = node('ul', 'summary');
      for (const detail of details) list.append(node('li', '', detail));
      container.append(list);
    }
  }
  function stageText(job) {
    if (jobOperation(job) === 'html' && ['failed', 'needs_attention'].includes(job.status)) return 'このPDFと指示書をChatGPTに添付して、解答解説HTMLを作成できます。';
    if (recovering(job)) return job.dispatchUncertain ? 'クラウド処理の起動を確認しています。状況が確認できると自動で再開します。' : '保存済みの段階からクラウド処理を自動で再開します。再開状況を確認しています。';
    if (['cancelled', 'failed', 'needs_attention'].includes(job.status)) return stageLabels[job.status];
    if (text(job.message)) return clean(job.message);
    if (job.status === 'completed') return jobOperation(job) === 'html' ? '解答解説HTMLを保存し、講義を公開しました' : 'PDFを切り出し、Google Driveへ保存しました';
    if (typeof job.stage === 'object' && job.stage) return clean(job.stage.label || job.stage.message);
    return (Object.hasOwn(stageLabels, job.stage) ? stageLabels[job.stage] : '') || (Object.hasOwn(stageLabels, job.status) ? stageLabels[job.status] : '');
  }
  function renderJobs() {
    rememberFocus(() => {
      const list = $('jobs');
      list.replaceChildren();
      const ordered = state.jobs.filter(job => jobOperation(job) === state.operation).sort((a, b) => Number(active(b)) - Number(active(a)) || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
      if (!ordered.length) { list.append(node('p', 'empty', state.jobsError || (state.operation === 'html' ? '以前のHTML作成履歴はありません。\n新しい解答解説はPDFと指示書をChatGPTに添付して作成します。' : 'PDF切り出しの履歴がここに並びます。\n月間号を選択し、PDF切り出しボタンから開始してください。'))); return; }
      for (const job of ordered) {
        const id = jobId(job);
        const card = node('article', 'job-card' + (active(job) ? ' active' : '') + (state.selectedJob === id ? ' selected' : ''));
        const top = node('div', 'job-top');
        const status = Object.hasOwn(labels, job.status) ? job.status : '';
        top.append(node('span', 'badge ' + status, recovering(job) ? '自動再開待ち' : status === 'completed' ? (jobOperation(job) === 'html' ? 'HTML作成完了' : 'PDF保存完了') : labels[status] || '状況を確認中'), node('time', 'date', date(job.createdAt)));
        const title = node('button', 'job-title', jobName(job));
        title.type = 'button';
        title.dataset.focusKey = 'job:' + id;
        title.addEventListener('click', () => selectJob(id));
        card.append(top, title);
        const stage = stageText(job);
        if (stage) card.append(node('p', 'job-stage', stage));
        if (active(job)) {
          const raw = typeof job.progress === 'object' && job.progress ? job.progress.percent : job.progress;
          const progress = typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : null;
          const track = node('div', 'progress-track' + (progress === null ? ' indeterminate' : ''));
          track.setAttribute('role', 'progressbar');
          track.setAttribute('aria-label', '教材作成の進行状況');
          if (progress !== null) { track.setAttribute('aria-valuenow', String(progress)); track.setAttribute('aria-valuemin', '0'); track.setAttribute('aria-valuemax', '100'); }
          const fill = node('div', 'progress-fill');
          if (progress !== null) fill.style.width = progress + '%';
          track.append(fill);
          card.append(track);
        }
        const model = text(job.model || job.modelId);
        if (model) card.append(node('div', 'fine', 'モデル：' + model));
        const failure = typeof job.error === 'string' ? job.error : job.error?.publicMessage || job.error?.message;
        if (failure) appendIssue(card, job, clean(failure));
        const result = job.result && typeof job.result === 'object' ? job.result : {};
        if (result.summary) card.append(node('p', 'summary', clean(result.summary)));
        const outputs = (Array.isArray(result.outputs) ? result.outputs : []).filter(output => output && typeof output === 'object');
        for (const output of outputs) {
          const open = outputLink(output.published?.url || output.url, '講義を開く', true);
          const pdf = outputLink(output.pdf?.url, 'PDF を開く', false);
          const html = outputLink(output.html?.url || output.driveUrl, '講義 HTML（Drive）', false);
          const outputError = clean(typeof output.error === 'string' ? output.error : output.error?.message);
          const section = node('div', 'output');
          section.append(node('p', 'output-name', text(output.pdf?.name || output.html?.name || output.name) || (Object.hasOwn(kindLabels, output.kind) ? kindLabels[output.kind] : '教材')));
          const links = node('div', 'output-links');
          if (open) links.append(open);
          if (pdf) links.append(pdf);
          if (html) links.append(html);
          if (links.childNodes.length) section.append(links);
          const errorDetails = (Array.isArray(output.error?.details) ? output.error.details : []).slice(0, 8).map(detail => clean(detail).trim().slice(0, 600)).filter(Boolean);
          appendIssue(section, job, outputError, errorDetails);
          for (const missing of Array.isArray(output.missing) ? output.missing : []) if (text(missing)) section.append(node('p', 'fine', clean(missing)));
          card.append(section);
        }
        for (const warning of Array.isArray(result.warnings) ? result.warnings : []) {
          if (text(warning)) card.append(node('p', 'summary', clean(warning).replace(/^(practice|advanced):/, (_, kind) => kindLabels[kind] + '：')));
        }
        for (const error of Array.isArray(result.errors) ? result.errors : []) {
          const message = clean(typeof error === 'string' ? error : error?.message);
          if (!message || outputs.some(output => output.kind === error?.kind && clean(typeof output.error === 'string' ? output.error : output.error?.message) === message)) continue;
          appendIssue(card, job, (Object.hasOwn(kindLabels, error?.kind) ? kindLabels[error.kind] + '：' : '') + message);
        }
        const actions = node('div', 'job-actions');
        if (active(job) || job.status === 'needs_attention') addAction(actions, job, 'cancel', '取り消す', 'quiet');
        if (jobOperation(job) === 'extract' && ['failed', 'needs_attention'].includes(job.status)) addAction(actions, job, 'retry', job.status === 'needs_attention' ? 'もう一度試す' : '再試行する', 'secondary');
        if (!active(job) && (jobOperation(job) === 'html' || outputs.some(output => output.pdf?.url))) {
          const htmlTask = node('button', 'secondary', 'このPDFをChatに渡す');
          htmlTask.type = 'button'; htmlTask.dataset.focusKey = 'html-task:' + id;
          htmlTask.disabled = state.starting.size > 0;
          htmlTask.addEventListener('click', () => openChatForJob(job));
          actions.append(htmlTask);
        }
        if (actions.childNodes.length) card.append(actions);
        list.append(card);
      }
    });
    schedule();
  }
  function addAction(parent, job, action, label, style) {
    const id = jobId(job);
    const button = node('button', style, state.actions.has(id) ? '処理中…' : label);
    button.type = 'button';
    button.dataset.focusKey = action + ':' + id;
    button.disabled = !id || state.actions.has(id) || (action === 'retry' && (state.jobs.some(active) || state.starting.size > 0));
    button.addEventListener('click', () => jobAction(job, action));
    parent.append(button);
  }
  function putJob(job) {
    const id = jobId(job);
    if (!id) return;
    const index = state.jobs.findIndex(item => jobId(item) === id);
    invalidateHtmlSources(index < 0 ? null : state.jobs[index], job);
    if (index < 0) state.jobs.unshift(job); else state.jobs[index] = { ...state.jobs[index], ...job };
  }
  function invalidateHtmlSources(previous, next) {
    if (previous && jobOperation(next) === 'extract' && active(previous) && !active(next)) state.sourceLoaded.html = false;
  }
  async function selectJob(id) {
    if (!id) return;
    state.selectedJob = id;
    state.selectedJobs[state.operation] = id; updateLocation();
    try { const value = await api('/jobs/' + encodeURIComponent(id)); putJob(value.job); renderJobs(); } catch (error) { notice(error.message, true); }
  }
  async function startJob() {
    const operation = state.operation;
    if (operation !== 'extract') return;
    const file = state.files.find(item => fileId(item) === state.selectedFiles[operation]);
    const id = fileId(file);
    if (!id || state.starting.size || state.jobs.some(active) || !modelReady()) return;
    const requestKey = operation + ':' + id;
    state.starting.add(requestKey);
    renderOperation(); renderSources();
    notice('');
    try {
      const value = await api('/jobs', { fileId: id, model: state.selectedModel, operation });
      if (!jobId(value.job)) throw new Error('開始状況を確認できません。作成履歴を更新してください。');
      putJob(value.job);
      state.selectedJob = jobId(value.job);
      state.selectedJobs[operation] = state.selectedJob;
      updateLocation(); renderJobs();
      const task = 'PDFの切り出し';
      notice(active(value.job) ? task + 'を開始しました。画面を閉じても処理は続きます。' : value.job.status === 'completed' ? 'この処理は完了済みです。履歴から保存済みファイルを開けます。' : '保存された履歴を表示しました。状況を確認して再試行してください。');
      $('history').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (error) { notice(error.message, true); await refreshJobs(); }
    finally { state.starting.delete(requestKey); renderOperation(); renderSources(); }
  }
  async function jobAction(job, action) {
    if (action === 'retry' && jobOperation(job) === 'html') { await openChatForJob(job); return; }
    const id = jobId(job);
    if (state.actions.has(id)) return;
    state.actions.add(id);
    renderJobs();
    try {
      const value = await api('/jobs/' + encodeURIComponent(id) + '/' + action, {});
      putJob(value.job);
      notice(action === 'cancel' ? '取り消しを受け付けました。' : '再試行を受け付けました。');
      await refreshJobs();
    } catch (error) { notice(error.message, true); }
    finally { state.actions.delete(id); renderJobs(); renderSources(); }
  }
  async function refreshJobs() {
    if (!state.authenticated || state.refreshing) return;
    state.refreshing = true;
    $('refresh-jobs').disabled = true;
    try {
      const value = await api('/jobs');
      if (!Array.isArray(value.jobs)) throw new Error('作成履歴を読み取れませんでした。再試行してください。');
      const selectedId = state.selectedJob;
      const selected = state.jobs.find(job => jobId(job) === selectedId);
      for (const job of value.jobs) if (job && jobId(job)) invalidateHtmlSources(state.jobs.find(previous => jobId(previous) === jobId(job)), job);
      state.jobs = value.jobs.filter(job => job && jobId(job));
      if (selected) { const item = state.jobs.find(job => jobId(job) === selectedId); if (item && !item.result && selected.result) item.result = selected.result; }
      if (state.selectedJob && state.jobs.some(job => jobId(job) === state.selectedJob)) {
        const detail = await api('/jobs/' + encodeURIComponent(state.selectedJob));
        putJob(detail.job);
      }
      state.jobsLoaded = true;
      state.jobsError = '';
      renderJobs();
      renderSources();
      if (state.operation === 'html' && !state.sourceLoaded.html) await loadSources('html');
    } catch (error) { state.jobsError = error.message; notice(error.message, true); renderJobs(); }
    finally { state.refreshing = false; $('refresh-jobs').disabled = false; schedule(); }
  }
  async function loadModels() {
    let catalog;
    try { catalog = await api('/models'); } catch (error) { catalog = { latestVerified: false, models: [], warning: error.message }; }
    if (!state.authenticated) return;
    state.models = catalog;
    if (state.models.diagnosticReason) console.info('Model catalog: ' + state.models.diagnosticReason);
    renderModels();
  }
  async function loadWorkspace() {
    await Promise.allSettled([loadSources(state.operation, true), state.operation === 'extract' ? loadModels() : Promise.resolve()]);
    if (!state.authenticated) return;
    await refreshJobs();
    const selected = state.jobs.find(job => jobId(job) === state.selectedJob);
    if (selected && jobOperation(selected) !== state.operation) {
      const operation = jobOperation(selected);
      state.selectedJobs[operation] = state.selectedJob;
      await chooseOperation(operation);
    }
  }
  async function bootstrap() {
    clearTimeout(state.timer);
    state.jobsLoaded = false;
    $('refresh-all').disabled = true;
    $('connection-label').textContent = '接続を確認中';
    notice('');
    try {
      const session = await api('/session');
      state.authenticated = session.authenticated === true;
      state.csrf = text(session.csrf);
      $('connection-dot').classList.toggle('ready', state.authenticated && session.configured !== false);
      $('gate').hidden = state.authenticated && session.configured !== false;
      $('workspace').hidden = !state.authenticated || session.configured === false;
      $('login').hidden = session.configured === false;
      $('logout').hidden = !state.authenticated;
      if (!state.authenticated) $('account').textContent = '';
      if (session.configured === false) {
        $('connection-label').textContent = '準備中';
        $('gate-title').textContent = '教材スタジオを準備しています';
        $('gate-copy').textContent = '接続の準備が整うと、Google Drive の教材を選択できるようになります。少し待って画面を更新してください。';
      } else if (!state.authenticated) {
        $('connection-label').textContent = '初回接続が必要';
        $('gate-title').textContent = 'はじめに Google に接続';
        $('gate-copy').textContent = '教材の PDF を読み込み、完成ファイルを保存するために接続します。接続後に資料と処理を選び、実行ボタンから開始します。';
      } else {
        $('connection-label').textContent = 'Google 接続済み';
        $('account').textContent = text(session.email);
        await loadWorkspace();
      }
    } catch (error) { notice(error.message, true); $('connection-label').textContent = '接続を確認できません'; }
    finally { $('refresh-all').disabled = false; }
  }
  async function logout() {
    $('logout').disabled = true;
    try {
      await api('/logout', {});
      expired();
      state.files = []; state.sources = { extract: [], html: [] }; state.sourceLoaded = { extract: false, html: false }; state.selectedFiles = { extract: '', html: '' }; state.selectedJobs = { extract: '', html: '' }; state.selectedJob = ''; state.jobs = []; state.models = null; state.jobsLoaded = false; $('selected-source').textContent = 'PDFが選択されていません';
      $('sources').replaceChildren(); $('jobs').replaceChildren();
      $('connection-label').textContent = 'ログアウト済み';
      $('gate-title').textContent = 'Google に接続して続ける';
      $('gate-copy').textContent = 'ログアウトしました。クラウドの作成履歴は保存されています。';
      notice('');
    } catch (error) { notice(error.message, true); }
    finally { $('logout').disabled = false; }
  }
  $('operation-extract').addEventListener('click', () => chooseOperation('extract'));
  $('operation-html').addEventListener('click', () => chooseOperation('html'));
  $('start-job').addEventListener('click', startJob);
  $('copy-chat-prompt').addEventListener('click', copyChatPrompt);
  $('download-pdf').addEventListener('click', downloadPdf);
  $('show-running').addEventListener('click', () => { const running = state.jobs.find(active); if (running) chooseOperation(jobOperation(running)); });
  $('search').addEventListener('input', renderSources);
  $('model').addEventListener('change', event => { state.selectedModel = event.target.value; renderSources(); });
  $('refresh-jobs').addEventListener('click', refreshJobs);
  $('refresh-all').addEventListener('click', bootstrap);
  $('logout').addEventListener('click', logout);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(state.timer); else if (state.authenticated) refreshJobs(); });
  try {
    const hash = new URLSearchParams(location.hash.slice(1));
    state.selectedJob = hash.get('job') || '';
    let storedOperation = '';
    try { storedOperation = localStorage.getItem('math-studio-operation') || ''; } catch { /* No storage is required. */ }
    state.operation = hash.has('chat') || (hash.get('operation') || storedOperation) === 'html' ? 'html' : 'extract';
    state.selectedFiles.html = hash.get('file') || '';
    state.selectedJobs[state.operation] = state.selectedJob;
  } catch { /* The cloud history remains available without a URL selection. */ }
  renderOperation();
  bootstrap();
})();`;

export function studioScript() {
  return CLIENT_SCRIPT;
}

// A nonce is optional for local preview; production can use it for script/style CSP.
export function studioPage({ nonce = '' } = {}) {
  const attribute = /^[A-Za-z0-9+/_=-]{8,}$/.test(nonce) ? ' nonce="' + nonce + '"' : '';
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><meta name="referrer" content="no-referrer"><meta name="theme-color" content="#17644e"><title>教材スタジオ · math-app</title><style${attribute}>${STYLES}</style></head>
<body><header class="topbar"><div class="wrap topline"><div class="brand"><span class="brand-mark" aria-hidden="true">∑</span><div>教材スタジオ<small>MATH-APP STUDIO</small></div></div><div class="connection"><span class="dot" id="connection-dot"></span><span id="connection-label" role="status">接続を確認中</span></div></div></header>
<main class="wrap"><section class="hero"><p class="eyebrow">MATH MATERIALS WORKSPACE</p><h1 id="operation-title">切り出して、Chatへ渡し、HTMLを取り込む。</h1><p id="operation-intro">PDF切り出し → ChatGPTで解説作成 → 完成HTMLの取込、の3ステップで進めます。</p></section>
<nav class="operation-tabs" aria-label="教材作成の3ステップ"><button type="button" aria-pressed="true" aria-label="PDFを切り出す" class="operation-tab selected" id="operation-extract"><span class="operation-mark" aria-hidden="true">1</span><span><strong>PDFを切り出す</strong><small>月間号から必要なページを保存</small></span><span class="operation-arrow" aria-hidden="true">→</span></button><button type="button" aria-pressed="false" aria-label="Chatに渡す" class="operation-tab" id="operation-html"><span class="operation-mark" aria-hidden="true">2</span><span><strong>Chatに渡す</strong><small>切り出しPDF＋元の指示書を添付</small></span><span class="operation-arrow" aria-hidden="true">→</span></button><a class="operation-tab" id="operation-import" href="https://iwslatojp29.github.io/math-app/math/upload.html" target="_blank" rel="noopener noreferrer"><span class="operation-mark" aria-hidden="true">3</span><span><strong>完成HTMLを取り込む</strong><small>Chatで作ったHTMLを保存・公開</small></span><span class="operation-arrow" aria-hidden="true">↗</span></a></nav>
<div class="section-head"><p class="fine" id="account"></p><div class="job-actions"><button class="quiet" id="logout" type="button" hidden>ログアウト</button><button class="quiet" id="refresh-all" type="button">画面を更新</button></div></div>
<div class="notice" id="notice" role="status" aria-live="polite" hidden></div>
<section class="panel gate" id="gate"><h2 id="gate-title">接続を確認しています</h2><p id="gate-copy">保存された接続と作成履歴を読み込みます。</p><a class="primary" id="login" href="/api/studio/google/start" hidden>Google に接続する <span aria-hidden="true">→</span></a></section>
<div class="layout" id="workspace" hidden><section class="panel" aria-labelledby="sources-title"><div class="section-head"><div><h2 id="sources-title">切り出す月間号を選ぶ</h2><p id="source-count">Google Drive の PDF</p></div></div><label class="sr-only" for="search">PDF の名前で絞り込み</label><input class="search" id="search" type="search" placeholder="PDF の名前で探す" autocomplete="off"><div class="source-list" id="sources"><p class="empty">教材を読み込んでいます…</p></div><details class="model-settings" id="model-settings"><summary>モデルを選ぶ（通常は自動）</summary><label for="model">PDFの範囲判定に使うモデル</label><select id="model" disabled><option>モデルを確認中…</option></select><p class="fine" id="model-note"></p><p class="model-notice" id="model-warning" hidden></p></details><section class="start-panel" aria-labelledby="start-title"><p class="start-label" id="start-title">選択したPDF</p><p class="selected-source" id="selected-source">PDFが選択されていません</p><p class="operation-disclosure" id="operation-disclosure"></p><button class="primary start-button" type="button" id="start-job" disabled>PDFを切り出す</button><p class="fine start-state" id="start-state" role="status">一覧からPDFを選択してください。</p><button class="quiet" type="button" id="show-running" hidden>進行中の作業を表示</button><section class="handoff-panel" id="chat-panel" hidden><div id="chat-ready" hidden><h3>2つのファイルをChatGPTに添付</h3><div class="handoff-downloads"><a class="primary" id="download-pdf" download target="_blank" rel="noopener noreferrer">PDFをダウンロード</a><a class="secondary" id="download-instructions" href="/api/studio/chat/instructions" download target="_blank" rel="noopener noreferrer">元の指示書（MD）をダウンロード</a></div><p class="fine" id="pdf-download-status" role="status" aria-live="polite"></p><label for="chat-prompt">ChatGPTに貼り付ける文面</label><textarea class="chat-prompt" id="chat-prompt" readonly></textarea><div class="handoff-actions"><button class="secondary" type="button" id="copy-chat-prompt">文面をコピー</button><a class="primary" id="open-chatgpt" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">ChatGPTを開く ↗</a></div><p>ChatGPTでPDFとMDを添付し、コピーした文面を送信してください。生成されたHTMLファイルをダウンロードしたら、次の取込画面へ進みます。</p></div><div class="handoff-import"><a class="secondary" href="https://iwslatojp29.github.io/math-app/math/upload.html" target="_blank" rel="noopener noreferrer">完成HTMLを取り込む ↗</a><p>完成したHTMLを選び、プレビューを確認してから保存・公開します。</p></div></section></section></section>
<section class="panel" id="history" aria-labelledby="jobs-title"><div class="section-head"><div><h2 id="jobs-title">PDF切り出しの履歴</h2><p id="jobs-description">PDFの作成状況と、保存したファイル</p></div><button class="quiet" id="refresh-jobs" type="button">履歴を更新</button></div><div class="job-list" id="jobs"><p class="empty">作成履歴を読み込んでいます…</p></div><p class="fine" id="poll-note">作成履歴はクラウドに保存されます。</p></section></div>
<noscript><p class="notice">教材スタジオを利用するには JavaScript を有効にしてください。</p></noscript></main><footer class="footer"><div class="wrap">math-app · 教材スタジオ</div></footer><script${attribute}>${studioScript()}</script></body></html>`;
}
