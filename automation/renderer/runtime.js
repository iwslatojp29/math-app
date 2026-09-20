(function () {
  'use strict';
  const lesson = JSON.parse(document.getElementById('lesson-data').textContent);
  const $ = id => document.getElementById(id);
  const synth = window.speechSynthesis;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let problem, flattened = [], position = 0, playlist = [], playlistPosition = 0;
  let playing = false, audioEnabled = true, rate = 1, generation = 0, silentTimer = null;
  let animations = [], lastState = null, voice = null, voiceWait = null, selectedSubquestion = '';
  const allProblemLinks = Array.from(document.querySelectorAll('[data-problem]'));

  function refreshVoice() {
    if (!synth) return null;
    let available;
    try { available = synth.getVoices(); } catch { voice = null; return null; }
    const japanese = available.filter(item => /^ja(?:-|_)/i.test(item.lang) || item.lang === 'ja');
    voice = japanese.find(item => item.default) || japanese.find(item => item.localService) || japanese[0] || null;
    return voice;
  }
  if (synth) { refreshVoice(); synth.addEventListener('voiceschanged', refreshVoice); }

  function stopAudio() {
    generation++;
    clearTimeout(silentTimer); silentTimer = null;
    if (voiceWait) { clearTimeout(voiceWait); voiceWait = null; }
    if (synth) synth.cancel();
    for (const animation of animations) animation.cancel();
    animations = [];
  }
  function setPlaying(value) {
    playing = value;
    $('play').textContent = value ? 'Ⅱ 停止' : '▶ 再生';
    $('play').setAttribute('aria-pressed', String(value));
  }
  function status(message) { $('playback-status').textContent = message; }
  function keepLabelsReadable() {
    document.querySelectorAll('svg text[data-font-size]').forEach(text => {
      const matrix = text.getScreenCTM();
      if (!matrix || !text.getBoundingClientRect().width) return;
      const scale = Math.hypot(matrix.a, matrix.b);
      if (scale > 0) text.setAttribute('font-size', String(Math.max(Number(text.dataset.fontSize), 14 / scale)));
    });
  }
  function current() { return flattened[position]; }
  function makeOption(value, text) {
    const option = document.createElement('option'); option.value = value; option.textContent = text; return option;
  }
  function resetPlaylist() { playlist = flattened.map((_, index) => index); playlistPosition = playlist.indexOf(position); }

  function cssTransform(transform) {
    return transform ? 'translate(' + transform.dx + 'px,' + transform.dy + 'px) rotate(' + transform.rotation + 'deg) scale(' + transform.scale + ')' : 'translate(0px,0px) rotate(0deg) scale(1)';
  }
  function renderCurrent(animate = false) {
    const { cue, step } = current();
    const priorState = lastState;
    $('diagram').innerHTML = renderScene(problem, cue, step.viewBox, 'live-' + problem.id);
    $('diagram').dataset.cueId = cue.id;
    $('caption').textContent = cue.displayText;
    $('caption').dataset.cueId = cue.id;
    document.querySelector('.narration').scrollTop = 0;
    $('step-title').textContent = step.title;
    $('step').value = step.id;
    $('position').textContent = '説明 ' + (position + 1) + ' / ' + flattened.length;
    $('formulas').innerHTML = cue.formulaIds.map(id => renderFormula(problem.formulas.find(formula => formula.id === id))).join('');
    $('facts').replaceChildren(...cue.factIds.map(id => {
      const fact = problem.facts.find(item => item.id === id);
      const li = document.createElement('li');
      li.textContent = fact.text; return li;
    }));
    $('previous').disabled = playlistPosition <= 0;
    $('next').disabled = playlistPosition >= playlist.length - 1;
    $('diagram').setAttribute('aria-label', problem.diagram.description + '。' + cue.displayText);
    keepLabelsReadable();
    if (animate && priorState && !reducedMotion.matches) {
      const previousTransforms = new Map(priorState.transforms.map(item => [item.targetId, item]));
      const nextTransforms = new Map(cue.state.transforms.map(item => [item.targetId, item]));
      const previousVisible = new Set(priorState.visibleIds);
      $('diagram').querySelectorAll('[data-target]').forEach(target => {
        const id = target.dataset.target;
        const oldTransform = cssTransform(previousTransforms.get(id)), nextTransform = cssTransform(nextTransforms.get(id));
        if (oldTransform !== nextTransform) {
          target.style.transformOrigin = '0 0';
          animations.push(target.animate([{ transform: oldTransform }, { transform: nextTransform }], { duration: 420 / rate, easing: 'ease-in-out' }));
        } else if (!previousVisible.has(id)) {
          animations.push(target.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260 / rate }));
        }
      });
    }
    lastState = cue.state;
  }

  function nextInPlaylist(token) {
    if (token !== generation || !playing) return;
    if (playlistPosition + 1 >= playlist.length) {
      stopAudio(); setPlaying(false); status(selectedSubquestion ? 'この小問の講義は終わりです。' : 'この問題の講義は終わりです。'); return;
    }
    playlistPosition++; position = playlist[playlistPosition]; present(true);
  }

  function speakOrWait(token) {
    if (!playing || token !== generation) return;
    const cue = current().cue;
    if (!audioEnabled) {
      status('音声OFF · 字幕と図で進めます。');
      silentTimer = setTimeout(() => nextInPlaylist(token), Math.max(1600, cue.displayText.length * 90) / rate);
      return;
    }
    if (!synth || typeof window.SpeechSynthesisUtterance !== 'function') {
      setPlaying(false); status('この環境では音声を使えません。「次へ」で図と字幕を読めます。'); return;
    }
    if (!refreshVoice()) {
      status('日本語音声を確認しています。');
      voiceWait = setTimeout(() => {
        voiceWait = null;
        if (token !== generation || !playing) return;
        if (refreshVoice()) speakOrWait(token);
        else { setPlaying(false); status('日本語音声がありません。「次へ」で読むか、音声をOFFにしてください。'); }
      }, 700);
      return;
    }
    const utterance = new SpeechSynthesisUtterance(cue.speechText);
    utterance.lang = 'ja-JP'; utterance.voice = voice; utterance.rate = rate;
    utterance.onstart = () => { if (token === generation) status('読み上げ中 · ' + rate.toFixed(2) + '倍'); };
    utterance.onend = () => nextInPlaylist(token);
    utterance.onerror = () => {
      if (token !== generation) return;
      stopAudio(); setPlaying(false); status('音声を再生できませんでした。「次へ」で図と字幕を読めます。');
    };
    try { synth.speak(utterance); }
    catch { utterance.onerror(); }
  }

  function present(autoplay, animate = true) {
    stopAudio(); renderCurrent(animate); setPlaying(autoplay);
    if (autoplay) speakOrWait(generation);
    else status('この説明を表示しています。再生・前へ・次へで見直せます。');
  }
  function selectProblem(id, autoplay) {
    stopAudio(); setPlaying(false);
    problem = lesson.problems.find(item => item.id === id);
    flattened = problem.steps.flatMap(step => step.cues.map(cue => ({ step, cue })));
    position = 0; selectedSubquestion = ''; lastState = null; resetPlaylist();
    $('lecture-title').textContent = problem.number + ' ' + problem.title;
    $('subquestion').replaceChildren(makeOption('', '全体'), ...problem.subquestions.map(sub => makeOption(sub.id, sub.label)));
    $('subquestion').disabled = problem.subquestions.length <= 1;
    $('step').replaceChildren(...problem.steps.map((step, index) => makeOption(step.id, (index + 1) + ' ' + step.title)));
    allProblemLinks.forEach(link => link.setAttribute('aria-current', String(link.dataset.problem === id)));
    document.querySelectorAll('.problem-static').forEach(article => { article.hidden = article.id !== 'static-' + id; });
    document.querySelector('.content-pane').scrollTop = 0;
    present(autoplay, false);
  }

  allProblemLinks.forEach(link => link.addEventListener('click', event => {
    event.preventDefault(); selectProblem(link.dataset.problem, true);
  }));
  $('play').addEventListener('click', () => {
    if (playing) { stopAudio(); setPlaying(false); status('一時停止中。再生すると今の説明の先頭から再開します。'); }
    else present(true, false);
  });
  function move(delta) {
    const next = playlistPosition + delta;
    if (next < 0 || next >= playlist.length) return;
    const autoplay = playing; playlistPosition = next; position = playlist[next]; present(autoplay);
  }
  $('previous').addEventListener('click', () => move(-1));
  $('next').addEventListener('click', () => move(1));
  $('repeat').addEventListener('click', () => present(true, false));
  $('restart').addEventListener('click', () => selectProblem(problem.id, true));
  $('step').addEventListener('change', () => {
    const autoplay = playing;
    selectedSubquestion = ''; $('subquestion').value = '';
    position = flattened.findIndex(item => item.step.id === $('step').value); resetPlaylist(); present(autoplay, false);
  });
  $('subquestion').addEventListener('change', () => {
    selectedSubquestion = $('subquestion').value;
    if (!selectedSubquestion) { position = 0; resetPlaylist(); present(true, false); return; }
    const selected = problem.subquestions.find(sub => sub.id === selectedSubquestion);
    const entry = flattened.findIndex(item => item.cue.id === selected.entryCueId);
    const laterEntries = problem.subquestions.map(sub => flattened.findIndex(item => item.cue.id === sub.entryCueId)).filter(index => index > entry);
    const end = laterEntries.length ? Math.min(...laterEntries) : flattened.length;
    const prerequisiteIndices = selected.prerequisiteCueIds.map(id => flattened.findIndex(item => item.cue.id === id));
    playlist = [...new Set([...prerequisiteIndices, ...Array.from({ length: end - entry }, (_, offset) => entry + offset)])];
    playlistPosition = 0; position = playlist[0]; lastState = null; present(true, false);
  });
  $('speed').addEventListener('change', () => { rate = Number($('speed').value); if (playing) present(true, false); });
  $('audio').addEventListener('click', () => {
    audioEnabled = !audioEnabled;
    $('audio').textContent = audioEnabled ? '音声ON' : '音声OFF';
    $('audio').setAttribute('aria-pressed', String(audioEnabled));
    if (playing) present(true, false);
    else status(audioEnabled ? '音声をONにしました。' : '音声OFF。「次へ」でも字幕と図を見直せます。');
  });
  document.querySelectorAll('[data-font]').forEach(button => button.addEventListener('click', () => {
    const sizes = { small: '16px', normal: '18px', large: '23px' };
    document.documentElement.style.setProperty('--body-size', sizes[button.dataset.font]);
    document.querySelectorAll('[data-font]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
  }));

  const dialog = $('source-dialog');
  document.querySelectorAll('[data-source]').forEach(link => link.addEventListener('click', event => {
    if (typeof dialog.showModal !== 'function') { const original = $('source-' + link.dataset.source); document.querySelector('.sources').style.display = 'block'; original.open = true; return; }
    event.preventDefault();
    const source = $('asset-' + link.dataset.source);
    const copy = document.createElement('img'); copy.src = source.src; copy.alt = source.alt;
    $('source-dialog-body').replaceChildren(copy); dialog.showModal();
  }));
  $('close-source').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  let printDetails = null;
  window.addEventListener('beforeprint', () => {
    stopAudio(); setPlaying(false);
    // Some engines emit beforeprint again when a print preview changes.
    // Preserve the original state until afterprint, even for repeated events.
    if (!printDetails) printDetails = Array.from(document.querySelectorAll('details')).map(details => ({ details, open: details.open }));
    printDetails.forEach(item => { item.details.open = true; });
  });
  window.addEventListener('afterprint', () => { (printDetails || []).forEach(item => { item.details.open = item.open; }); printDetails = null; keepLabelsReadable(); });
  $('print').addEventListener('click', () => window.print());
  window.addEventListener('pagehide', stopAudio);
  window.addEventListener('resize', keepLabelsReadable);
  document.addEventListener('toggle', keepLabelsReadable, true);
  document.documentElement.classList.add('js');
  selectProblem(lesson.problems[0].id, false);
  status('問題番号か再生ボタンで始められます。');
})();
