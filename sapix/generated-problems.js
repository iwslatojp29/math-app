(function(root, factory){
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SapixGeneratedProblems = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  var CATALOG_URL = './problems/generated.json';
  var MAX_BYTES = 8 * 1024 * 1024;
  var SOURCE_KEYS = ['fileId', 'name', 'modifiedTime', 'fingerprint', 'problemIds'];
  var PROBLEM_KEYS = ['id', 'unit', 'title', 'src', 'stars', 'tests', 'question', 'subquestions', 'answers', 'steps', 'sourceImages'];
  var FILE_ID = /^[A-Za-z0-9_-]{1,160}$/;
  var PROBLEM_ID = /^drive-([A-Za-z0-9_-]{1,160})-q([1-9][0-9]{0,8})$/;
  var IMAGE = /^assets\/drive\/([A-Za-z0-9_-]{1,160})\/([a-f0-9]{64})\.(png|jpg|jpeg|webp)$/;

  function fail(code){
    var error = new Error(code === 'catalog_timeout' ? '追加問題の読み込みが時間切れになりました。' : code === 'catalog_unavailable' ? '追加問題を読み込めませんでした。' : '追加問題のデータ形式を確認できませんでした。');
    error.code = code || 'invalid_catalog';
    throw error;
  }
  function object(value, keys){
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    var actual = Object.keys(value);
    if (actual.length !== keys.length || actual.some(function(key){ return keys.indexOf(key) < 0; }) || keys.some(function(key){ return !Object.prototype.hasOwnProperty.call(value, key); })) fail();
  }
  function text(value, max, allowEmpty, multiline){
    if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()) || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) fail();
  }
  function array(value, max, min){ if (!Array.isArray(value) || value.length > max || value.length < (min || 0)) fail(); }
  function label(value, max){
    text(value, max, false, false);
    if (value !== value.trim() || ['*', '__proto__', 'constructor', 'prototype'].indexOf(value) >= 0) fail();
  }
  function uniqueStrings(values, max, maxText){
    array(values, max);
    var seen = new Set();
    values.forEach(function(value){ label(value, maxText); if (seen.has(value)) fail(); seen.add(value); });
  }
  function items(values, keys, max, min){
    array(values, max, min);
    values.forEach(function(value){
      object(value, keys);
      keys.forEach(function(key){ text(value[key], key === 'text' ? 20000 : 300, key !== 'text', key === 'text'); });
    });
  }
  function validateCatalog(catalog, existingProblems){
    object(catalog, ['schemaVersion', 'sources', 'problems']);
    if (catalog.schemaVersion !== 1) fail();
    array(catalog.sources, 2000); array(catalog.problems, 10000);
    var sources = new Map(), expected = new Map(), ids = new Set();
    (existingProblems || []).forEach(function(problem){ ids.add(problem.id); });
    catalog.sources.forEach(function(source){
      object(source, SOURCE_KEYS);
      if (typeof source.fileId !== 'string' || !FILE_ID.test(source.fileId) || sources.has(source.fileId)) fail();
      text(source.name, 500, false, false);
      text(source.modifiedTime, 40, false, false);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(source.modifiedTime) || !Number.isFinite(Date.parse(source.modifiedTime))) fail();
      if (new Date(source.modifiedTime).toISOString().slice(0, 19) !== source.modifiedTime.slice(0, 19)) fail();
      text(source.fingerprint, 256, false, false);
      array(source.problemIds, 10000, 1);
      var sourceIds = new Set();
      source.problemIds.forEach(function(id){
        var match = typeof id === 'string' && PROBLEM_ID.exec(id);
        if (!match || match[1] !== source.fileId || sourceIds.has(id) || expected.has(id)) fail();
        sourceIds.add(id); expected.set(id, source.fileId);
      });
      sources.set(source.fileId, source);
    });
    catalog.problems.forEach(function(problem){
      object(problem, PROBLEM_KEYS);
      var match = typeof problem.id === 'string' && PROBLEM_ID.exec(problem.id);
      if (!match || problem.id.length > 200 || ids.has(problem.id) || expected.get(problem.id) !== match[1]) fail();
      ids.add(problem.id); expected.delete(problem.id);
      label(problem.unit, 80); text(problem.title, 300, false, false); text(problem.src, 500, false, false);
      if (!Number.isInteger(problem.stars) || problem.stars < 1 || problem.stars > 3) fail();
      uniqueStrings(problem.tests, 50, 120);
      text(problem.question, 50000, false, true);
      items(problem.subquestions, ['label', 'text'], 100, 0);
      items(problem.answers, ['label', 'text'], 100, 1);
      items(problem.steps, ['title', 'text'], 100, 1);
      array(problem.sourceImages, 20, 1);
      var images = new Set();
      problem.sourceImages.forEach(function(path){
        var image = typeof path === 'string' && IMAGE.exec(path);
        if (!image || image[1] !== match[1] || images.has(path)) fail();
        images.add(path);
      });
    });
    if (expected.size) fail();
    return catalog;
  }
  function escapeHtml(value){
    return value.replace(/[&<>"']/g, function(character){ return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]; });
  }
  function lines(value){ return escapeHtml(value).replace(/\r\n?/g, '\n').replace(/\n/g, '<br>'); }
  function paragraphs(value){
    return value.replace(/\r\n?/g, '\n').split(/\n[\t ]*\n+/).map(function(part){ return '<p>' + lines(part) + '</p>'; }).join('');
  }
  // Only these fixed templates create HTML. Catalog strings never supply markup or CSS.
  function compileProblem(problem, no){
    return {
      id: problem.id, unit: problem.unit, no: no, title: problem.title, src: problem.src, stars: problem.stars, tests: problem.tests.slice(),
      body: paragraphs(problem.question),
      questions: problem.subquestions.map(function(item){ return {l: escapeHtml(item.label), t: lines(item.text)}; }),
      answers: problem.answers.map(function(item){ return {l: escapeHtml(item.label), v: lines(item.text)}; }),
      expl: problem.steps.map(function(step){ return (step.title ? '<h3>' + escapeHtml(step.title) + '</h3>' : '') + paragraphs(step.text); }).join(''),
      img: problem.sourceImages[0],
      figure: '<div style="width:300px;max-width:100%">' + problem.sourceImages.map(function(path, index){
        return '<a href="' + path + '" style="display:block"><img src="' + path + '" alt="' + escapeHtml(problem.title) + '：問題の元画像 ' + (index + 1) + '" decoding="async" style="display:block;width:100%;height:auto"></a><div class="figcap">元画像 ' + (index + 1) + '（タップで拡大）</div>';
      }).join('') + '</div>'
    };
  }
  function compileCatalog(catalog, options){
    options = options || {};
    var existing = options.problems || [];
    validateCatalog(catalog, existing);
    var units = (options.units || []).slice(), tests = (options.tests || []).slice(), counts = new Map();
    existing.forEach(function(problem){ counts.set(problem.unit, (counts.get(problem.unit) || 0) + 1); });
    var added = catalog.problems.map(function(problem){
      if (units.indexOf(problem.unit) < 0) units.push(problem.unit);
      problem.tests.forEach(function(name){ if (tests.indexOf(name) < 0) tests.push(name); });
      var no = (counts.get(problem.unit) || 0) + 1; counts.set(problem.unit, no);
      return compileProblem(problem, no);
    });
    return {problems: existing.concat(added), units: units, tests: tests, added: added.length};
  }
  function load(options){
    options = options || {};
    var fetcher = options.fetch || (typeof fetch === 'function' && fetch);
    var schedule = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    var Controller = options.AbortController || (typeof AbortController !== 'undefined' && AbortController);
    var controller = Controller ? new Controller() : null, timer;
    var timeout = new Promise(function(resolve, reject){
      timer = schedule(function(){
        var error;
        try { fail('catalog_timeout'); } catch (caught) { error = caught; }
        reject(error);
        if (controller) controller.abort();
      }, options.timeoutMs == null ? 5000 : options.timeoutMs);
    });
    var request = Promise.resolve().then(function(){
      if (!fetcher) fail('catalog_unavailable');
      return fetcher(options.url || CATALOG_URL, {cache:'no-store', credentials:'omit', signal: controller ? controller.signal : undefined});
    }).then(function(response){
      if (!response || !response.ok) fail('catalog_unavailable');
      if (response.headers && Number(response.headers.get('content-length')) > MAX_BYTES) fail();
      return response.text();
    }).then(function(raw){
      if (typeof raw !== 'string' || raw.length > MAX_BYTES || new TextEncoder().encode(raw).length > MAX_BYTES) fail();
      var catalog;
      try { catalog = JSON.parse(raw); } catch (error) { fail(); }
      return compileCatalog(catalog, options);
    });
    return Promise.race([request, timeout]).catch(function(error){
      if (error && ['invalid_catalog', 'catalog_timeout', 'catalog_unavailable'].indexOf(error.code) >= 0) throw error;
      fail('catalog_unavailable');
    }).finally(function(){ cancel(timer); });
  }
  return {validateCatalog: validateCatalog, compileCatalog: compileCatalog, load: load, catalogUrl: CATALOG_URL};
});
