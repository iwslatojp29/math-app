(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', api.start);
  else api.start();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const API = 'https://math-app-proxy.iwslatojp29.workers.dev';
  const AUTH = 'math_tutor_auth_v1', PKCE = 'math_tutor_pkce_v1';
  function validFilename(name) {
    return typeof name === 'string' && name.length <= 255 && /\.html$/i.test(name)
      && !/[\/\\\x00-\x1f]/.test(name) && !name.includes('..') && !['index.html', 'upload.html', 'delete.html'].includes(name.toLowerCase());
  }
  function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
  function contextFrom(doc) {
    const selection = doc.defaultView?.getSelection()?.toString().trim() || '';
    const lecture = doc.getElementById?.('recorded-lecture-host')?.shadowRoot;
    if (lecture?.querySelector('.shell') && !lecture.querySelector('.shell').hidden) {
      const title = lecture.querySelector('.questions')?.selectedOptions[0]?.textContent || '';
      const conditions = lecture.querySelector('.conditions p')?.textContent || '';
      const caption = lecture.querySelector('.caption')?.textContent || '';
      const equation = lecture.querySelector('.equation')?.textContent || '';
      return `${selection ? '生徒が選択した箇所：\n' + selection.slice(0, 4000) + '\n\n' : ''}いまの講義：${title}\n問題の条件：${conditions}\n表示中の説明：${caption}\n式：${equation}`.slice(0, 23000);
    }
    const viewHeight = doc.defaultView?.innerHeight || 800;
    const candidates = [...doc.querySelectorAll('section, article, .problem, .question, .q')].map(node => {
      const rect = node.getBoundingClientRect();
      return { node, rect, text: node.innerText || '' };
    }).filter(item => item.rect.bottom > 0 && item.rect.top < viewHeight && item.rect.height > 0 && item.text.trim().length > 60);
    candidates.sort((a, b) => Math.abs(a.rect.top - 80) - Math.abs(b.rect.top - 80) || a.text.length - b.text.length);
    const body = doc.body.innerText || '';
    let text = candidates[0]?.text || body;
    if (text.length > 20000) {
      const headings = [...doc.querySelectorAll('h2,h3,h4')].filter(node => node.getBoundingClientRect().top < viewHeight && node.getBoundingClientRect().top > -300);
      const position = body.indexOf(headings[0]?.innerText || '');
      text = body.slice(Math.max(0, position - 1000), Math.max(0, position - 1000) + 20000);
    }
    return `${selection ? '生徒が選択した箇所：\n' + selection.slice(0, 4000) + '\n\nその周辺の解説：\n' : ''}${text.slice(0, selection ? 19000 : 23000)}`.trim();
  }
  function start() {
    if (document.getElementById('math-tutor-host')) return;
    const host = document.createElement('div'); host.id = 'math-tutor-host';
    const ui = host.attachShadow({ mode: 'open' });
    ui.innerHTML = `<style>
      :host{font-family:-apple-system,"Hiragino Sans",sans-serif;color:#233047;font-size:14px;line-height:1.65}
      *{box-sizing:border-box}[hidden]{display:none!important}button,textarea{font:inherit}button,a{touch-action:manipulation}button{cursor:pointer;border:1px solid #ccd8e6;border-radius:9px;background:white;color:#233047;padding:9px 12px;min-height:42px}button:disabled{opacity:.5;cursor:default}button:focus-visible,a:focus-visible,textarea:focus-visible{outline:3px solid #dfa13b;outline-offset:3px}
      .launcher{position:fixed;right:20px;bottom:22px;z-index:2147483001;background:#176ac2;color:white;border:0;box-shadow:0 4px 20px #1c426940;padding:14px 20px;border-radius:28px;font-weight:700}.launcher small{display:block;font-size:10px;font-weight:400;opacity:.9}
      .viewer{position:fixed;inset:0;z-index:2147482998;background:white}.viewer-bar{height:50px;display:flex;align-items:center;gap:16px;padding:6px 14px;border-bottom:1px solid #dce4ee;background:#f5f7fa}.viewer-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.viewer a{color:#176ac2;text-decoration:none;font-size:12px}.viewer iframe{border:0;width:100%;height:calc(100% - 50px);display:block}.viewer.chat-open{right:400px}
      .panel{position:fixed;right:16px;bottom:18px;width:380px;height:min(710px,calc(100dvh - 36px));z-index:2147483002;display:flex;flex-direction:column;background:white;border:1px solid #d6e0ec;border-radius:16px;box-shadow:0 8px 42px #102b4b30;overflow:hidden}.head{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #e1e7ef;background:#f3f7fd}.head strong{font-size:16px}.head button{border:0;background:transparent;font-size:20px;padding:0 8px}.scope{margin:0;padding:10px 16px;font-size:11px;color:#63748a;border-bottom:1px solid #e1e7ef;overflow-wrap:anywhere}.messages{flex:1;overflow:auto;padding:16px;min-height:60px}.message{margin:0 0 14px;padding:12px;border-radius:10px;white-space:pre-wrap;overflow-wrap:anywhere}.user{background:#e9f2fd;margin-left:24px}.assistant{background:#f2f5f9;margin-right:8px}.assistant .read{display:block;margin-top:10px;font-size:11px;padding:4px 8px;min-height:30px}.auth{padding:12px 16px;background:#fff8e9;font-size:12px}.auth p{margin:0 0 8px}.primary{background:#176ac2;color:white;border-color:#176ac2}.compose{padding:12px 14px;border-top:1px solid #e1e7ef}.compose textarea{width:100%;resize:vertical;min-height:68px;max-height:180px;padding:10px;border:1px solid #bdcddd;border-radius:9px;color:#233047;background:white}.actions{display:flex;justify-content:space-between;gap:8px;margin-top:8px}.recording{background:#fff0f0;border-color:#d66868;color:#a32e2e}.status{min-height:20px;margin:7px 0;font-size:12px;color:#5d7085}.privacy{font-size:10px;color:#7a8797;margin:8px 0 0}.logout{padding:0;border:0;background:transparent;text-decoration:underline;min-height:24px;font-size:10px;color:#78869b}
      @media(max-width:760px){.viewer.chat-open{right:0}.panel{inset:auto 8px 8px;width:calc(100% - 16px);height:min(650px,calc(100dvh - 16px))}.launcher{right:14px;bottom:16px}.viewer-title{display:none}}
      @media print{.launcher,.panel,.viewer-bar{display:none!important}.viewer{position:static}.viewer iframe{height:100vh}}
    </style>
    <section class="viewer" hidden aria-label="教材の解説"><div class="viewer-bar"><button class="back" type="button">← 教材一覧</button><span class="viewer-title"></span><a class="original" target="_blank" rel="noopener">元のページを開く ↗</a></div><iframe title="教材の解説" referrerpolicy="same-origin"></iframe></section>
    <button type="button" class="launcher" aria-expanded="false">AIに聞く<small>声でも質問できます</small></button>
    <section class="panel" hidden aria-label="AIに解説を質問"><div class="head"><strong>AIに聞く</strong><button type="button" class="close" aria-label="チャットを閉じる">×</button></div><p class="scope"></p><div class="messages" role="log" aria-live="polite"></div><div class="auth"><p>Googleで接続すると、音声や文字で質問できます。</p><button type="button" class="connect">Googleで接続</button></div><form class="compose"><label for="question">分からないところを聞いてみよう</label><textarea id="question" maxlength="2000" placeholder="例：なぜここで3で割るの？"></textarea><div class="actions"><button type="button" class="mic">🎤 話して質問</button><button type="submit" class="primary send">送信</button></div><p class="status" role="status"></p><button type="button" class="logout" hidden>接続を解除</button><p class="privacy">音声・質問・参照する解説をOpenAIへ送信します。録音は「停止して送信」で質問になります。AIの説明は元の条件と照らし合わせてください。</p></form></section>`;
    document.body.appendChild(host);
    const $ = selector => ui.querySelector(selector);
    const originalOverflow = document.body.style.overflow;
    const frame = $('iframe'); let filename = '', title = '', conversation = [], auth = null, loaded = false;
    function pauseLecture() { try { frame.contentWindow?.dispatchEvent(new Event('math-tutor-question')); } catch {} }
    let busy = false, recorder = null, stream = null, chunks = [], timer = null, discard = false, controller = null, epoch = 0;
    const notice = text => { $('.status').textContent = text; };
    try { const saved = JSON.parse(localStorage.getItem(AUTH)); if (saved?.expiresAt > Date.now() && /^[A-Za-z0-9_-]{43}$/.test(saved.token)) auth = saved; } catch {}
    function controls() {
      $('.auth').hidden = Boolean(auth); $('.logout').hidden = !auth;
      $('.send').disabled = busy || !loaded || !auth || Boolean(recorder);
      $('.mic').disabled = busy || !loaded || !auth;
      $('.scope').textContent = loaded ? `質問する教材：${title}（選択した文章・表示中の範囲を参照）` : '一覧から質問したい教材を開いてください。';
    }
    function openChat() { pauseLecture(); $('.panel').hidden = false; $('.launcher').hidden = true; $('.launcher').setAttribute('aria-expanded', 'true'); $('.viewer').classList.add('chat-open'); controls(); }
    function stopAudio(cancel = false) {
      discard = cancel; clearTimeout(timer);
      if (recorder?.state === 'recording') recorder.stop();
      stream?.getTracks().forEach(track => track.stop()); stream = null;
    }
    $('.launcher').onclick = openChat;
    function cancelWork() { epoch++; stopAudio(true); controller?.abort(); busy = false; }
    $('.close').onclick = () => { cancelWork(); $('.panel').hidden = true; $('.launcher').hidden = false; $('.launcher').setAttribute('aria-expanded', 'false'); $('.viewer').classList.remove('chat-open'); window.speechSynthesis?.cancel(); };
    function message(role, text) {
      const row = document.createElement('div'); row.className = 'message ' + role; row.textContent = text;
      if (role === 'assistant' && 'speechSynthesis' in window) {
        const button = document.createElement('button'); button.className = 'read'; button.type = 'button'; button.textContent = '説明を読み上げる';
        button.onclick = () => { speechSynthesis.cancel(); const speech = new SpeechSynthesisUtterance(text); speech.lang = 'ja-JP'; speechSynthesis.speak(speech); }; row.appendChild(button);
      }
      $('.messages').appendChild(row); row.scrollIntoView({ block: 'nearest' });
    }
    async function request(path, body, mime = 'application/json') {
      const active = new AbortController(); controller = active; const timeout = setTimeout(() => active.abort(), 70000);
      try {
        const response = await fetch(API + path, { method: 'POST', credentials: 'omit', signal: active.signal,
          headers: { 'Content-Type': mime, Authorization: 'Bearer ' + auth.token }, body: mime === 'application/json' ? JSON.stringify(body) : body });
        const value = await response.json();
        if (!response.ok) {
          if (response.status === 401) { auth = null; try { localStorage.removeItem(AUTH); } catch {} controls(); }
          throw Error(value.message || '通信できませんでした。もう一度お試しください。');
        }
        return value;
      } finally { clearTimeout(timeout); if (controller === active) controller = null; }
    }
    async function ask(question) {
      if (!loaded || !auth || busy || !question.trim()) return;
      pauseLecture();
      const context = contextFrom(frame.contentDocument);
      if (!context) { notice('解説の読み込みが終わってから、もう一度質問してください。'); return; }
      const operation = epoch; busy = true; controls(); notice('解説を確かめて、考えています…');
      message('user', question); $('.compose textarea').value = question;
      try {
        const value = await request('/api/math-tutor/ask', { question, context, title, page: 'https://iwslatojp29.github.io/math-app/math/' + encodeURIComponent(filename), history: conversation.slice(-8) });
        if (operation !== epoch) return;
        message('assistant', value.answer); conversation.push({ role: 'user', content: question }, { role: 'assistant', content: value.answer.slice(0, 6000) });
        $('.compose textarea').value = ''; notice('続けて質問できます。');
      } catch (error) { if (operation !== epoch) return; notice(error.name === 'AbortError' ? '質問を停止しました。もう一度送信できます。' : error.message); }
      finally { if (operation === epoch) { busy = false; controls(); } }
    }
    $('.compose').onsubmit = event => { event.preventDefault(); ask($('.compose textarea').value.trim()); };
    $('.mic').onclick = async () => {
      if (recorder) { stopAudio(false); return; }
      if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { notice('このブラウザでは録音を使えません。キーボードの音声入力か文字入力で質問できます。'); $('.compose textarea').focus(); return; }
      const operation = epoch; busy = true; controls();
      pauseLecture();
      try {
        const acquired = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (operation !== epoch || $('.panel').hidden) { acquired.getTracks().forEach(track => track.stop()); return; }
        stream = acquired; busy = false;
        const mime = ['audio/webm;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
        if (!mime) { stopAudio(true); notice('このブラウザの録音形式は使えません。文字で質問してください。'); return; }
        recorder = new MediaRecorder(stream, { mimeType: mime }); chunks = []; discard = false;
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onstop = async () => {
          const audio = new Blob(chunks, { type: mime.split(';')[0] }); chunks = []; recorder = null;
          $('.mic').textContent = '🎤 話して質問'; $('.mic').classList.remove('recording'); controls();
          if (operation !== epoch || discard) { notice('録音を取り消しました。'); return; }
          if (!audio.size || audio.size > 5 * 1024 * 1024) { notice('録音が長すぎるか、音声がありません。短く話してみてください。'); return; }
          busy = true; controls(); notice('音声を文字にしています…');
          try { const value = await request('/api/math-tutor/transcribe', audio, audio.type); if (operation !== epoch) return; busy = false; controls(); $('.compose textarea').value = value.text; await ask(value.text); }
          catch (error) { if (operation === epoch) notice(error.message); }
          finally { if (operation === epoch) { busy = false; controls(); } }
        };
        recorder.start(1000); timer = setTimeout(() => stopAudio(false), 60000);
        $('.mic').textContent = '■ 停止して送信'; $('.mic').classList.add('recording'); notice('録音中です。停止すると質問を送信します（最大60秒）。'); controls();
      } catch { if (operation !== epoch) return; stopAudio(true); recorder = null; notice('マイクを使えませんでした。ブラウザのマイク許可を確認してください。'); }
      finally { if (operation === epoch) { busy = false; controls(); } }
    };
    $('.connect').onclick = async () => {
      try {
        const verifier = base64url(crypto.getRandomValues(new Uint8Array(32))), state = base64url(crypto.getRandomValues(new Uint8Array(24)));
        const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
        sessionStorage.setItem(PKCE, JSON.stringify({ verifier, state, expires: Date.now() + 600000, returnTo: location.pathname + location.search + location.hash }));
        location.assign(API + '/api/sapix/auth/start?' + new URLSearchParams({ challenge, state, returnTo: 'math' }));
      } catch { notice('Google接続を開始できません。ブラウザの保存設定を確認してください。'); }
    };
    $('.logout').onclick = async () => { if (busy || recorder) return; try { await request('/api/math-tutor/logout', {}); } catch {} auth = null; try { localStorage.removeItem(AUTH); } catch {} controls(); notice('接続を解除しました。'); };
    function showLesson() {
      const requested = new URL(location.href).searchParams.get('lesson');
      if (!validFilename(requested)) { document.body.style.overflow = originalOverflow; cancelWork(); $('.viewer').hidden = true; loaded = false; filename = ''; frame.removeAttribute('src'); controls(); return; }
      if (requested === filename) return;
      cancelWork(); loaded = false; filename = requested; title = requested.replace(/\.html$/i, ''); conversation = []; $('.messages').replaceChildren();
      document.body.style.overflow = 'hidden';
      $('.viewer').hidden = false; $('.viewer-title').textContent = title; $('.original').href = './' + encodeURIComponent(filename);
      frame.src = './' + encodeURIComponent(filename); controls();
    }
    frame.onload = () => {
      if (!filename) return;
      try {
        const doc = frame.contentDocument;
        if (!doc?.body || /\/index\.html$/.test(doc.location.pathname)) return;
        title = doc.title || title; loaded = true; $('.viewer-title').textContent = title; controls();
        doc.addEventListener('click', event => {
          const link = event.target.closest('a');
          if (link && /コンテンツ一覧へ戻る|トップへ戻る/.test(link.textContent)) { event.preventDefault(); closeLesson(); }
        });
      } catch { loaded = false; controls(); notice('この教材を読み取れませんでした。元のページを開いて確認してください。'); }
    };
    function closeLesson() { const url = new URL(location.href); url.searchParams.delete('lesson'); history.pushState(null, '', url); showLesson(); }
    $('.back').onclick = closeLesson;
    document.addEventListener('click', event => {
      const link = event.target.closest?.('.card a');
      if (!link || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      let name; try { const url = new URL(link.href); if (url.origin !== location.origin) return; name = decodeURIComponent(url.pathname.split('/').pop()); } catch { return; }
      if (!validFilename(name)) return;
      event.preventDefault(); const url = new URL(location.href); url.searchParams.set('lesson', name); history.pushState(null, '', url); showLesson();
    });
    window.addEventListener('popstate', showLesson); window.addEventListener('pagehide', () => stopAudio(true));
    async function finishAuth() {
      const params = new URLSearchParams(location.hash.slice(1));
      if (!params.has('sapix_code') && !params.has('sapix_error')) return false;
      openChat();
      try {
        const saved = JSON.parse(sessionStorage.getItem(PKCE)); sessionStorage.removeItem(PKCE);
        if (!saved || saved.expires < Date.now() || params.get('sapix_state') !== saved.state || params.has('sapix_error')) throw Error('Google接続を完了できませんでした。もう一度接続してください。');
        const response = await fetch(API + '/api/sapix/auth/exchange', { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: params.get('sapix_code'), verifier: saved.verifier }) });
        if (!response.ok) throw Error('接続の確認に失敗しました。もう一度Googleで接続してください。');
        auth = await response.json(); localStorage.setItem(AUTH, JSON.stringify(auth));
        const target = new URL(saved.returnTo, location.origin);
        if (target.origin !== location.origin || target.pathname !== location.pathname) throw Error('戻り先を確認できませんでした。');
        history.replaceState(null, '', target); window.dispatchEvent(new HashChangeEvent('hashchange')); showLesson(); controls(); notice('Googleで接続しました。教材を開いて質問できます。');
      } catch (error) { history.replaceState(null, '', location.pathname + location.search); notice(error.message); }
      return true;
    }
    showLesson(); controls(); finishAuth();
  }
  return { start, validFilename, contextFrom };
});
