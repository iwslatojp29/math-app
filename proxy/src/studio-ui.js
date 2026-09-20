const STYLES = `
:root{color-scheme:light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;color:#18332e;background:#f7f8f4;font-synthesis:none;--green:#17644e;--muted:#61716c;--line:#dbe3dc;--paper:#fff;--danger:#a03629}
*{box-sizing:border-box}body{margin:0;line-height:1.65}button,input,select{font:inherit}button,a,input,select{touch-action:manipulation}button,a{-webkit-tap-highlight-color:transparent}button{cursor:pointer}button:disabled{cursor:default;opacity:.52}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid #e4a349;outline-offset:4px}a{color:var(--green)}[hidden]{display:none!important}.wrap{max-width:1120px;margin:auto;padding:0 24px}.topbar{border-bottom:1px solid var(--line);background:#ffffffb8}.topline{min-height:76px;display:flex;gap:18px;align-items:center;justify-content:space-between}.brand{font-weight:750;letter-spacing:.01em;display:flex;gap:12px;align-items:center}.brand-mark{width:35px;height:35px;display:grid;place-items:center;border-radius:11px;color:white;background:var(--green);font-size:24px}.brand small{display:block;color:var(--muted);font-size:11px;font-weight:500;letter-spacing:.13em}.connection{font-size:12px;display:flex;align-items:center;gap:7px;text-align:right}.dot{width:8px;height:8px;border-radius:50%;background:#a7b4ae;flex:none}.dot.ready{background:#268164}.hero{padding:42px 0 29px;max-width:720px}.eyebrow{font-size:11px;font-weight:750;letter-spacing:.15em;color:var(--green);margin:0 0 8px}.hero h1{font-size:clamp(26px,4.8vw,38px);line-height:1.4;margin:0 0 13px;font-weight:750;letter-spacing:-.025em}.hero p{margin:0;color:var(--muted);font-size:14px}.panel{border:1px solid var(--line);border-radius:20px;background:var(--paper);padding:24px}.gate{max-width:630px;margin:8px 0 35px}.gate h2{font-size:20px;margin:0 0 10px}.gate p{color:var(--muted);font-size:14px;margin:0 0 20px}.primary,.secondary,.quiet,.danger{min-height:44px;border-radius:11px;padding:10px 17px;font-weight:650;border:1px solid transparent;text-decoration:none;display:inline-flex;justify-content:center;align-items:center;gap:8px}.primary{color:white;background:var(--green)}.primary:hover:not(:disabled){background:#104f3c}.secondary{color:var(--green);background:#f1f6f2;border-color:#d5e4d9}.quiet{color:var(--muted);background:transparent;border-color:var(--line)}.danger{color:var(--danger);background:#fff6f2;border-color:#efdbd1}.notice{font-size:13px;border:1px solid #e7d8b5;background:#fff9eb;color:#75571e;border-radius:12px;padding:13px 16px;margin:0 0 20px;white-space:pre-wrap;overflow-wrap:anywhere}.notice.error{border-color:#e9cfc5;background:#fff4ef;color:#883f2d}.notice.good{border-color:#cddfcf;background:#f0f7ef;color:#315d39}.layout{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:24px;align-items:start;padding-bottom:55px}.section-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}.section-head h2{font-size:19px;line-height:1.4;margin:0}.section-head p{font-size:12px;color:var(--muted);margin:5px 0 0}.section-head button{font-size:12px;padding:7px 11px;white-space:nowrap}.search{width:100%;min-height:45px;border:1px solid var(--line);background:#fbfcfa;color:inherit;border-radius:11px;padding:10px 13px;font-size:16px;margin-bottom:15px}.source-list{display:grid;gap:10px;max-height:600px;overflow:auto;padding:3px;margin:-3px}.source-card{width:100%;display:flex;gap:12px;align-items:flex-start;text-align:left;border:1px solid var(--line);border-radius:13px;padding:15px;background:white;color:inherit;transition:border-color .15s,background .15s}.source-card:hover:not(:disabled){border-color:#569376;background:#f6faf5}.pdf-icon{flex:none;background:#f9efe7;color:#99663f;width:38px;height:45px;display:grid;place-items:center;border-radius:7px;font-size:10px;font-weight:800;letter-spacing:.04em}.source-copy{min-width:0;flex:1}.source-title{display:block;font-weight:650;font-size:14px;overflow-wrap:anywhere;line-height:1.6}.source-meta{display:block;color:var(--muted);font-size:11px;margin-top:5px}.source-action{display:block;color:var(--green);font-size:12px;margin-top:9px;font-weight:650}.empty{padding:30px 12px;text-align:center;font-size:13px;color:var(--muted);border:1px dashed var(--line);border-radius:12px;white-space:pre-wrap}.model-settings{border-top:1px solid var(--line);margin-top:20px;padding-top:15px}.model-settings summary{font-size:13px;font-weight:650;cursor:pointer;min-height:35px}.model-settings label{font-size:12px;color:var(--muted);display:block;margin:12px 0 6px}.model-settings select{width:100%;min-height:46px;border:1px solid var(--line);border-radius:10px;background:white;padding:10px;color:inherit;font-size:16px}.fine{color:var(--muted);font-size:11px;line-height:1.8;overflow-wrap:anywhere}.model-notice{margin-top:10px;font-size:12px;color:#805e22;white-space:pre-wrap}.job-list{display:grid;gap:12px}.job-card{border:1px solid var(--line);border-radius:14px;padding:16px;min-width:0}.job-card.active{border-color:#abc9b4;background:#f9fcf7}.job-card.selected{box-shadow:0 0 0 2px #dfebdf}.job-top{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px}.badge{font-size:11px;font-weight:700;background:#eef2ed;color:#52635a;padding:3px 9px;border-radius:20px;white-space:nowrap}.badge.running,.badge.queued{background:#e5f2e5;color:#29623e}.badge.completed{background:#dfefe9;color:#17644e}.badge.failed,.badge.needs_attention{background:#fff0df;color:#915522}.date{font-size:10px;color:var(--muted)}.job-title{border:0;background:transparent;color:inherit;font-weight:700;text-align:left;padding:0;min-height:28px;overflow-wrap:anywhere;line-height:1.6;width:100%;font-size:14px}.job-stage{font-size:12px;color:var(--muted);margin:9px 0 5px;white-space:pre-wrap;overflow-wrap:anywhere}.progress-track{height:5px;background:#e2eae0;border-radius:9px;overflow:hidden;margin:10px 0 12px}.progress-fill{height:100%;background:#66a37c;border-radius:9px;transition:width .3s}.progress-track.indeterminate .progress-fill{width:35%;animation:waiting 1.8s ease-in-out infinite}@keyframes waiting{0%{transform:translateX(-105%)}100%{transform:translateX(390%)}}.job-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.job-actions button,.job-actions a{font-size:12px;min-height:42px;padding:9px 12px}.output{border-top:1px solid var(--line);padding-top:12px;margin-top:12px}.output-name{font-size:12px;font-weight:650;overflow-wrap:anywhere;margin:0 0 6px}.output-links{display:flex;gap:7px;flex-wrap:wrap}.output-links a{font-size:12px;min-height:42px}.summary{font-size:12px;color:var(--muted);white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}.job-error{font-size:12px;color:#963f29;background:#fff3ed;padding:10px;border-radius:9px;white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0}.footer{border-top:1px solid var(--line);color:var(--muted);font-size:11px;padding:20px 0 28px}.sr-only{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0,0,0,0)}.refreshing{opacity:.6}
@media(max-width:780px){.layout{grid-template-columns:1fr}.wrap{padding:0 18px}.hero{padding:29px 0 25px}.panel{padding:19px;border-radius:17px}.source-list{max-height:440px}.topline{min-height:68px}.connection{max-width:140px;font-size:11px}.brand{font-size:14px}.brand small{font-size:10px}.layout{gap:20px}.gate{margin-bottom:28px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

// All remote strings are assigned through textContent. No API value enters markup.
// Keep browser code as source text: Worker bundlers may inject private helpers
// into functions, so serializing a bundled function with toString() is unsafe.
const CLIENT_SCRIPT = String.raw`(function studioClient() {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { authenticated: false, csrf: '', files: [], jobs: [], jobsLoaded: false, models: null, selectedModel: 'auto', selectedJob: '', starting: new Set(), actions: new Set(), timer: null, refreshing: false, sourceError: '', jobsError: '' };
  const labels = { queued: '順番待ち', running: '作成中', needs_attention: '確認が必要', failed: '作成できませんでした', completed: '完成', cancelled: '取り消し済み' };
  const stageLabels = { queued: '作成を待っています', download: 'PDF を取得しています', pdf_review: '冊子のページと切り出し範囲を確認しています', lesson_inventory: '全問題と小問の一覧を確認しています', lesson_generation: '全問題の講義と検算を進めています', publishing: '講義を公開して表示を確認しています', reading: 'PDF を読み込んでいます', downloading: 'PDF を取得しています', analyzing: '内容を整理しています', planning: '教材の構成を考えています', generating: '問題と解説を作成しています', validating: '内容を確認しています', rendering: '教材ファイルを仕上げています', uploading: '完成ファイルを保存しています', completed: '教材が完成しました', needs_attention: '保存できた教材を残して、確認を待っています', failed: '保存済みの段階から再試行できます', interrupted: 'クラウド処理が中断しました', cancelled: '作成を取り消しました' };
  const kindLabels = { practice: '日日の演習', advanced: '発展演習・学力コンテスト' };
  const active = job => job?.status === 'queued' || job?.status === 'running';
  const text = value => typeof value === 'string' ? value : '';
  const clean = value => text(value).replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[opsu]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, '[非表示]').replace(/Bearer\s+\S+/gi, 'Bearer [非表示]').slice(0, 4000);
  const node = (tag, className, content) => { const item = document.createElement(tag); if (className) item.className = className; if (content !== undefined) item.textContent = content; return item; };
  const date = value => { const parsed = new Date(value); return value && Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(parsed) : ''; };
  const fileId = file => text(file?.id || file?.fileId);
  const jobId = job => text(job?.id || job?.jobId);
  const name = file => text(file?.name || file?.fileName) || '名前のない PDF';
  const jobName = job => text(job?.fileName || job?.sourceName || job?.source?.name) || name(state.files.find(file => fileId(file) === job.fileId));
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
    if (state.authenticated && !document.hidden && state.jobs.some(active)) state.timer = setTimeout(refreshJobs, 10000);
    $('poll-note').textContent = state.jobs.some(active) ? '作成状況は 10 秒ごとに更新されます。画面を閉じても作成は続きます。' : '作成履歴はクラウドに保存されます。';
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
  function renderSources() {
    rememberFocus(() => {
      const list = $('sources');
      list.replaceChildren();
      const search = $('search').value.trim().toLocaleLowerCase('ja');
      const files = state.files.filter(file => name(file).toLocaleLowerCase('ja').includes(search));
      $('source-count').textContent = state.files.length ? state.files.length + ' 件の PDF' : 'Google Drive の PDF';
      if (!files.length) { list.append(node('p', 'empty', state.sourceError || (search ? '一致する教材がありません。' : '選択できる PDF がありません。Google Drive の教材フォルダをご確認ください。'))); return; }
      for (const file of files) {
        const id = fileId(file);
        const running = state.jobs.find(job => active(job) && job.fileId === id);
        const pending = state.starting.has(id);
        const busy = state.jobs.some(active) || state.starting.size > 0;
        const button = node('button', 'source-card');
        button.type = 'button';
        button.dataset.focusKey = 'source:' + id;
        button.disabled = !id || busy || !modelReady();
        button.append(node('span', 'pdf-icon', 'PDF'));
        const copy = node('span', 'source-copy');
        copy.append(node('span', 'source-title', name(file)));
        const metadata = [];
        if (file.modifiedTime) metadata.push('更新 ' + date(file.modifiedTime));
        const bytes = Number(file.size);
        if (Number.isFinite(bytes) && bytes > 0) metadata.push((bytes / 1024 / 1024).toFixed(1) + ' MB');
        if (metadata.length) copy.append(node('span', 'source-meta', metadata.join(' · ')));
        copy.append(node('span', 'source-action', pending ? '開始しています…' : running ? '作成中 — 履歴で確認できます' : busy ? '別の号を作成中です' : !state.jobsLoaded ? '作成履歴を確認しています…' : modelReady() ? 'この号で教材を作る →' : 'モデルの確認・選択が必要です'));
        button.append(copy);
        button.addEventListener('click', () => startJob(file));
        list.append(button);
      }
    });
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
  function stageText(job) {
    if (['cancelled', 'failed', 'needs_attention'].includes(job.status)) return stageLabels[job.status];
    if (text(job.message)) return clean(job.message);
    if (typeof job.stage === 'object' && job.stage) return clean(job.stage.label || job.stage.message);
    return (Object.hasOwn(stageLabels, job.stage) ? stageLabels[job.stage] : '') || (Object.hasOwn(stageLabels, job.status) ? stageLabels[job.status] : '');
  }
  function renderJobs() {
    rememberFocus(() => {
      const list = $('jobs');
      list.replaceChildren();
      const ordered = [...state.jobs].sort((a, b) => Number(active(b)) - Number(active(a)) || (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
      if (!ordered.length) { list.append(node('p', 'empty', state.jobsError || '作成した教材がここに並びます。\nまずは作成する号を選んでください。')); return; }
      for (const job of ordered) {
        const id = jobId(job);
        const card = node('article', 'job-card' + (active(job) ? ' active' : '') + (state.selectedJob === id ? ' selected' : ''));
        const top = node('div', 'job-top');
        const status = Object.hasOwn(labels, job.status) ? job.status : '';
        top.append(node('span', 'badge ' + status, labels[status] || '状況を確認中'), node('time', 'date', date(job.createdAt)));
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
        if (failure) card.append(node('p', 'job-error', clean(failure)));
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
          if (outputError) section.append(node('p', 'job-error', outputError));
          for (const missing of Array.isArray(output.missing) ? output.missing : []) if (text(missing)) section.append(node('p', 'fine', clean(missing)));
          card.append(section);
        }
        for (const warning of Array.isArray(result.warnings) ? result.warnings : []) {
          if (text(warning)) card.append(node('p', 'summary', clean(warning).replace(/^(practice|advanced):/, (_, kind) => kindLabels[kind] + '：')));
        }
        for (const error of Array.isArray(result.errors) ? result.errors : []) {
          const message = clean(typeof error === 'string' ? error : error?.message);
          if (!message || outputs.some(output => output.kind === error?.kind && clean(typeof output.error === 'string' ? output.error : output.error?.message) === message)) continue;
          card.append(node('p', 'job-error', (Object.hasOwn(kindLabels, error?.kind) ? kindLabels[error.kind] + '：' : '') + message));
        }
        const actions = node('div', 'job-actions');
        if (active(job) || job.status === 'needs_attention') addAction(actions, job, 'cancel', '取り消す', 'quiet');
        if (['failed', 'needs_attention'].includes(job.status)) addAction(actions, job, 'retry', job.status === 'needs_attention' ? 'もう一度試す' : '再試行する', 'secondary');
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
    button.disabled = !id || state.actions.has(id) || (action === 'retry' && state.jobs.some(active));
    button.addEventListener('click', () => jobAction(job, action));
    parent.append(button);
  }
  function putJob(job) {
    const id = jobId(job);
    if (!id) return;
    const index = state.jobs.findIndex(item => jobId(item) === id);
    if (index < 0) state.jobs.unshift(job); else state.jobs[index] = { ...state.jobs[index], ...job };
  }
  async function selectJob(id) {
    if (!id) return;
    state.selectedJob = id;
    history.replaceState(null, '', location.pathname + location.search + '#job=' + encodeURIComponent(id));
    try { const value = await api('/jobs/' + encodeURIComponent(id)); putJob(value.job); renderJobs(); } catch (error) { notice(error.message, true); }
  }
  async function startJob(file) {
    const id = fileId(file);
    if (!id || state.starting.size || state.jobs.some(active) || !modelReady()) return;
    state.starting.add(id);
    renderSources();
    notice('');
    try {
      const value = await api('/jobs', { fileId: id, model: state.selectedModel });
      if (!jobId(value.job)) throw new Error('開始状況を確認できません。作成履歴を更新してください。');
      putJob(value.job);
      state.selectedJob = jobId(value.job);
      history.replaceState(null, '', location.pathname + location.search + '#job=' + encodeURIComponent(state.selectedJob));
      renderJobs();
      notice(active(value.job) ? '教材の作成を開始しました。画面を閉じても作成は続きます。' : value.job.status === 'completed' ? 'この号は作成済みです。作成履歴から教材を開けます。' : '保存された作成履歴を表示しました。状況を確認して再試行してください。');
      $('history').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    } catch (error) { notice(error.message, true); await refreshJobs(); }
    finally { state.starting.delete(id); renderSources(); }
  }
  async function jobAction(job, action) {
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
      const selected = state.jobs.find(job => jobId(job) === state.selectedJob);
      state.jobs = value.jobs.filter(job => job && jobId(job));
      if (selected) { const item = state.jobs.find(job => jobId(job) === state.selectedJob); if (item && !item.result && selected.result) item.result = selected.result; }
      if (state.selectedJob && state.jobs.some(job => jobId(job) === state.selectedJob)) {
        const detail = await api('/jobs/' + encodeURIComponent(state.selectedJob));
        putJob(detail.job);
      }
      state.jobsLoaded = true;
      state.jobsError = '';
      renderJobs();
      renderSources();
    } catch (error) { state.jobsError = error.message; notice(error.message, true); renderJobs(); }
    finally { state.refreshing = false; $('refresh-jobs').disabled = false; schedule(); }
  }
  async function loadWorkspace() {
    const [sources, models] = await Promise.allSettled([api('/sources'), api('/models')]);
    if (!state.authenticated) return;
    state.sourceError = '';
    if (sources.status === 'fulfilled' && Array.isArray(sources.value.files)) state.files = sources.value.files.filter(file => file && fileId(file));
    else state.sourceError = sources.status === 'rejected' ? sources.reason.message : '教材一覧を読み取れませんでした。';
    state.models = models.status === 'fulfilled' ? models.value : { latestVerified: false, models: [], warning: models.reason.message };
    if (state.models.diagnosticReason) console.info('Model catalog: ' + state.models.diagnosticReason);
    renderModels();
    await refreshJobs();
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
        $('gate-copy').textContent = '教材の PDF を読み込み、完成ファイルを保存するために接続します。接続後は、作成する号を選ぶだけです。';
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
      state.files = []; state.jobs = []; state.models = null; state.jobsLoaded = false;
      $('sources').replaceChildren(); $('jobs').replaceChildren();
      $('connection-label').textContent = 'ログアウト済み';
      $('gate-title').textContent = 'Google に接続して続ける';
      $('gate-copy').textContent = 'ログアウトしました。クラウドの作成履歴は保存されています。';
      notice('');
    } catch (error) { notice(error.message, true); }
    finally { $('logout').disabled = false; }
  }
  $('search').addEventListener('input', renderSources);
  $('model').addEventListener('change', event => { state.selectedModel = event.target.value; renderSources(); });
  $('refresh-jobs').addEventListener('click', refreshJobs);
  $('refresh-all').addEventListener('click', bootstrap);
  $('logout').addEventListener('click', logout);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(state.timer); else if (state.authenticated) refreshJobs(); });
  try { state.selectedJob = new URLSearchParams(location.hash.slice(1)).get('job') || ''; } catch { /* The cloud history remains available without a URL selection. */ }
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
<main class="wrap"><section class="hero"><p class="eyebrow">PDF → 新しい教材</p><h1>教材を選んで、作成をはじめる。</h1><p>Google Drive の号を選ぶと、教材の作成が始まります。<br>完成した教材は、この画面からいつでも開けます。</p></section>
<div class="section-head"><p class="fine" id="account"></p><div class="job-actions"><button class="quiet" id="logout" type="button" hidden>ログアウト</button><button class="quiet" id="refresh-all" type="button">画面を更新</button></div></div>
<div class="notice" id="notice" role="status" aria-live="polite" hidden></div>
<section class="panel gate" id="gate"><h2 id="gate-title">接続を確認しています</h2><p id="gate-copy">保存された接続と作成履歴を読み込みます。</p><a class="primary" id="login" href="/api/studio/google/start" hidden>Google に接続する <span aria-hidden="true">→</span></a></section>
<div class="layout" id="workspace" hidden><section class="panel" aria-labelledby="sources-title"><div class="section-head"><div><h2 id="sources-title">作成する号を選ぶ</h2><p id="source-count">Google Drive の PDF</p></div></div><label class="sr-only" for="search">PDF の名前で絞り込み</label><input class="search" id="search" type="search" placeholder="PDF の名前で探す" autocomplete="off"><div class="source-list" id="sources"><p class="empty">教材を読み込んでいます…</p></div><details class="model-settings" id="model-settings"><summary>モデルを選ぶ（通常は自動）</summary><label for="model">教材作成に使うモデル</label><select id="model" disabled><option>モデルを確認中…</option></select><p class="fine" id="model-note"></p><p class="model-notice" id="model-warning" hidden></p></details><p class="fine">号を選ぶと作成が始まります。作成中の号は重ねて開始できません。</p></section>
<section class="panel" id="history" aria-labelledby="jobs-title"><div class="section-head"><div><h2 id="jobs-title">作成履歴</h2><p>進行中の作業と、完成した教材</p></div><button class="quiet" id="refresh-jobs" type="button">履歴を更新</button></div><div class="job-list" id="jobs"><p class="empty">作成履歴を読み込んでいます…</p></div><p class="fine" id="poll-note">作成履歴はクラウドに保存されます。</p></section></div>
<noscript><p class="notice">教材スタジオを利用するには JavaScript を有効にしてください。</p></noscript></main><footer class="footer"><div class="wrap">math-app · 教材スタジオ</div></footer><script${attribute}>${studioScript()}</script></body></html>`;
}
