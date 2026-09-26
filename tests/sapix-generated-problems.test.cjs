const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Catalog = require('../sapix/generated-problems.js');

const html = fs.readFileSync(path.join(__dirname, '../sapix/sapix_sansu_trainer.html'), 'utf8');
const fileId = 'Source_a-123';
const imagePath = `assets/drive/${fileId}/${'a'.repeat(64)}.png`;
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  return {
    schemaVersion: 1,
    sources: [{fileId, name: '図形の復習.pdf', modifiedTime: '2026-09-26T03:04:05.000Z', fingerprint: 'f'.repeat(64), problemIds: [`drive-${fileId}-q1`]}],
    problems: [{
      id: `drive-${fileId}-q1`, unit: '平面図形', title: '三角形の面積', src: '図形の復習 (1)', stars: 2, tests: ['9月復習'],
      question: '底辺が6cm、高さが4cmの三角形です。\n面積を求めましょう。\n\n単位も書きましょう。', subquestions: [],
      answers: [{label: '(1)', text: '12cm²'}],
      steps: [{title: '面積の公式', text: '底辺 × 高さ ÷ 2\n6 × 4 ÷ 2 = 12'}], sourceImages: [imagePath]
    }]
  };
}
function originalData() {
  const begin = html.indexOf('var UNITS ='), end = html.indexOf('var LS_REC =', begin);
  assert.ok(begin > 0 && end > begin);
  return vm.runInNewContext(html.slice(begin, end) + '; ({problems:PROBLEMS,units:UNITS,tests:TESTS})', {}, {timeout: 3000});
}
function response(value, ok = true) {
  return {ok, headers: {get() { return null; }}, async text() { return typeof value === 'string' ? value : JSON.stringify(value); }};
}
function sourceOf(name) {
  const begin = html.indexOf(`function ${name}(`);
  assert.ok(begin > 0);
  const source = html.slice(begin), end = /^}/m.exec(source);
  assert.ok(end);
  return source.slice(0, end.index + 1);
}

test('an empty catalog preserves all 403 original problem objects, IDs, order and numbers', () => {
  const base = originalData();
  const before = JSON.stringify(base);
  const empty = {schemaVersion: 1, sources: [], problems: []};
  assert.equal(base.problems.length, 403);
  assert.equal(new Set(base.problems.map(problem => problem.id)).size, 403);
  assert.equal(new Set(base.problems.map(problem => problem.img)).size, 389);
  const result = Catalog.compileCatalog(empty, base);
  assert.equal(result.added, 0);
  assert.equal(result.problems.length, 403);
  result.problems.forEach((problem, index) => assert.equal(problem, base.problems[index]));
  assert.equal(JSON.stringify(base), before);
});

test('the published catalog validates against the original problem IDs', () => {
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '../sapix/problems/generated.json'), 'utf8'));
  assert.doesNotThrow(() => Catalog.validateCatalog(catalog, originalData().problems));
});

test('compiled additions retain stable IDs and append numbering, units and test tags without changing the base', () => {
  const catalog = fixture();
  const original = {id: 'legacy#1', unit: '平面図形', no: 1};
  const options = {problems: [original], units: ['計算', '平面図形'], tests: ['6月マンスリー']};
  const before = JSON.stringify({catalog, options});
  const result = Catalog.compileCatalog(catalog, options);
  assert.equal(result.problems[0], original);
  assert.equal(result.problems[1].id, `drive-${fileId}-q1`);
  assert.equal(result.problems[1].no, 2);
  assert.equal(result.problems[1].img, imagePath);
  assert.deepEqual(result.units, ['計算', '平面図形']);
  assert.deepEqual(result.tests, ['6月マンスリー', '9月復習']);
  assert.equal(JSON.stringify({catalog, options}), before);
  catalog.problems[0].unit = '速さ';
  const addedUnit = Catalog.compileCatalog(catalog, options);
  assert.deepEqual(addedUnit.units, ['計算', '平面図形', '速さ']);
  assert.equal(addedUnit.problems[1].no, 1);
});

test('fixed templates escape all model-supplied markup while retaining paragraph and line breaks', () => {
  const catalog = fixture(), problem = catalog.problems[0];
  const attack = '<img src=x onerror="window.hacked=1"> & \' </script><svg onload=alert(1)>';
  problem.question = attack + '\nnext\n\nparagraph';
  problem.title = attack;
  problem.answers = [{label: attack, text: attack}];
  problem.subquestions = [{label: attack, text: attack}];
  problem.steps = [{title: attack, text: attack}];
  const result = Catalog.compileCatalog(catalog).problems[0];
  for (const markup of [result.body, result.expl, result.answers[0].l, result.answers[0].v, result.questions[0].l, result.questions[0].t, result.figure]) {
    assert.ok(!markup.includes('<script') && !markup.includes('</script>') && !markup.includes('<svg'));
    assert.ok(!markup.includes('<img src=x'));
    assert.ok(markup.includes('&lt;img src=x onerror=&quot;window.hacked=1&quot;&gt;'));
    assert.ok(markup.includes('&amp;') && markup.includes('&#39;'));
  }
  assert.match(result.body, /<br>next<\/p><p>paragraph<\/p>$/);
  assert.equal((result.figure.match(/<img /g) || []).length, 1);
  assert.ok(result.figure.includes(`src="${imagePath}"`));
  assert.ok(result.figure.includes(`href="${imagePath}"`));
});

test('multiple source images are visible and link to their exact Pages paths', () => {
  const catalog = fixture();
  const second = imagePath.replace('a'.repeat(64) + '.png', 'b'.repeat(64) + '.webp');
  catalog.problems[0].sourceImages.push(second);
  const result = Catalog.compileCatalog(catalog).problems[0];
  assert.equal((result.figure.match(/<img /g) || []).length, 2);
  assert.ok(result.figure.includes(`href="${second}"`));
  assert.equal(result.img, imagePath);
});

const invalidCases = [
  ['schema version', c => c.schemaVersion = '1'],
  ['unknown root property', c => c.script = 'alert(1)'],
  ['unknown source property', c => c.sources[0].model = 'not-in-catalog'],
  ['unknown problem property', c => c.problems[0].html = '<p>extra</p>'],
  ['empty answers', c => c.problems[0].answers = []],
  ['empty explanation', c => c.problems[0].steps[0].text = ' '],
  ['HTML source instead of text', c => c.problems[0].question = {html: '<p>x</p>'}],
  ['invalid stars', c => c.problems[0].stars = 0],
  ['noninteger stars', c => c.problems[0].stars = 1.5],
  ['reserved unit', c => c.problems[0].unit = '__proto__'],
  ['reserved test', c => c.problems[0].tests = ['*']],
  ['duplicate test', c => c.problems[0].tests.push(c.problems[0].tests[0])],
  ['control character in title', c => c.problems[0].title = 'bad\x00title'],
  ['unknown nested field', c => c.problems[0].answers[0].html = 'extra'],
  ['missing nested field', c => delete c.problems[0].answers[0].label],
  ['invalid source time', c => c.sources[0].modifiedTime = '2026-02-30T00:00:00Z'],
  ['unlisted problem', c => c.sources[0].problemIds = [`drive-${fileId}-q2`]],
  ['missing listed problem', c => c.problems = []],
  ['duplicate problem', c => c.problems.push(clone(c.problems[0]))],
  ['duplicate source', c => c.sources.push(clone(c.sources[0]))],
  ['duplicate source reference', c => c.sources[0].problemIds.push(c.sources[0].problemIds[0])],
  ['foreign source ID', c => c.sources[0].fileId = 'Other'],
  ['nonpositive question index', c => { c.problems[0].id = `drive-${fileId}-q0`; c.sources[0].problemIds = [c.problems[0].id]; }]
];
for (const [label, change] of invalidCases) test(`rejects the entire catalog: ${label}`, () => {
  const catalog = fixture(), base = {problems: [{id: 'legacy', unit: '計算', no: 1}], units: ['計算'], tests: []};
  const before = JSON.stringify(base);
  change(catalog);
  assert.throws(() => Catalog.compileCatalog(catalog, base), {code: 'invalid_catalog'});
  assert.equal(JSON.stringify(base), before);
});

test('rejects an ID collision with already registered problems rather than replacing grades or content', () => {
  const catalog = fixture();
  assert.throws(() => Catalog.compileCatalog(catalog, {problems: [{id: catalog.problems[0].id}]}), {code: 'invalid_catalog'});
});

test('image paths reject schemes, traversal, escaping, foreign sources and executable formats', () => {
  for (const path of ['https://drive.google.com/file/a', 'javascript:alert(1)', '/assets/x.png', '../assets/x.png', imagePath + '?x', imagePath + '#x', imagePath.replace('assets/', 'assets\\'), imagePath.replace(fileId, '%2e%2e'), imagePath.replace(fileId, 'Other'), imagePath.replace('.png', '.svg'), imagePath.replace('.png', '.html'), imagePath.replace('a'.repeat(64), 'aa" onerror="alert(1)'), imagePath.toUpperCase()]) {
    const catalog = fixture(); catalog.problems[0].sourceImages = [path];
    assert.throws(() => Catalog.validateCatalog(catalog), {code: 'invalid_catalog'}, path);
  }
});

test('loader fetches the static catalog without credentials/cache and compiles it once', async () => {
  let calls = 0;
  const result = await Catalog.load({fetch: async (url, options) => {
    calls++;
    assert.equal(url, './problems/generated.json');
    assert.equal(options.credentials, 'omit'); assert.equal(options.cache, 'no-store');
    assert.ok(options.signal);
    return response(fixture());
  }});
  assert.equal(calls, 1); assert.equal(result.added, 1);
});

test('loader aborts after five seconds even when fetch ignores the signal', async () => {
  let callback, signal, cleared = 0;
  const loading = Catalog.load({
    fetch: (url, options) => { signal = options.signal; return new Promise(() => {}); },
    setTimeout(fn, ms) { assert.equal(ms, 5000); callback = fn; return 7; },
    clearTimeout(id) { assert.equal(id, 7); cleared++; }
  });
  await Promise.resolve(); callback();
  await assert.rejects(loading, {code: 'catalog_timeout'});
  assert.equal(signal.aborted, true); assert.equal(cleared, 1);
});

test('loader timeout covers a stalled body, and late responses cannot mutate the original problem list', async () => {
  let callback, finish;
  const base = [{id: 'old', unit: '計算', no: 1}];
  const loading = Catalog.load({problems: base,
    fetch: async () => ({ok: true, text: () => new Promise(resolve => { finish = resolve; })}),
    setTimeout(fn) { callback = fn; return 1; }, clearTimeout() {}
  });
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  callback();
  await assert.rejects(loading, {code: 'catalog_timeout'});
  finish(JSON.stringify(fixture()));
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(base, [{id: 'old', unit: '計算', no: 1}]);
});

test('network, HTTP and JSON failures are fixed errors rather than model/server content', async () => {
  for (const fetcher of [async () => { throw new Error('private server detail'); }, async () => response('private server detail', false), async () => response('<html>private server detail</html>')]) {
    await assert.rejects(Catalog.load({fetch: fetcher}), error => {
      assert.ok(['invalid_catalog', 'catalog_unavailable'].includes(error.code));
      assert.ok(!error.message.includes('private'));
      return true;
    });
  }
});

test('actual trainer startup connection applies the catalog before starting once, without modifying grades', async () => {
  const base = originalData(), grade = {d: '2026-09-26', r: 'o', s: 25};
  let started = 0;
  const context = vm.createContext({Promise, PROBLEMS: base.problems, UNITS: base.units, TESTS: base.tests,
    state: {records: {[base.problems[0].id]: [grade]}},
    SapixGeneratedProblems: {load: options => Catalog.load({...options, fetch: async () => response(fixture())})},
    $() { throw Error('success should not need an error node'); },
    startTrainer() { started++; assert.equal(context.PROBLEMS.length, 404); }
  });
  vm.runInContext(sourceOf('loadGeneratedProblems'), context);
  await context.loadGeneratedProblems();
  assert.equal(started, 1);
  assert.equal(context.state.records[base.problems[0].id][0], grade);
  assert.equal(context.PROBLEMS[0], base.problems[0]);
});

test('actual trainer startup retains all existing problems and starts once if the catalog/script is unavailable', async () => {
  for (const missingScript of [false, true]) {
    const base = originalData(), status = {hidden: true}, existingIds = base.problems.map(problem => problem.id);
    let started = 0;
    const context = vm.createContext({Promise, PROBLEMS: base.problems, UNITS: base.units, TESTS: base.tests,
      $: id => { assert.equal(id, 'catalogStatus'); return status; }, startTrainer() { started++; }
    });
    if (!missingScript) context.SapixGeneratedProblems = {load: () => Promise.reject(Error('private details'))};
    vm.runInContext(sourceOf('loadGeneratedProblems'), context);
    await context.loadGeneratedProblems();
    assert.equal(started, 1); assert.deepEqual(context.PROBLEMS.map(problem => problem.id), existingIds);
    assert.equal(status.hidden, false); assert.match(status.textContent, /既存の問題はそのまま使えます/);
    assert.ok(!status.textContent.includes('private'));
  }
});

test('browser UMD exposure and every trainer inline script compile', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sapix/generated-problems.js'), 'utf8'), context);
  assert.equal(typeof context.SapixGeneratedProblems.load, 'function');
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(script[1]);
  assert.match(html, /id="updateProblems" href="https:\/\/math-app-proxy\.iwslatojp29\.workers\.dev\/studio\/sapix-import"/);
});
