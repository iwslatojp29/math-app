const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto').webcrypto;
const Parts = require('../sapix/problem-parts.js');
const Catalog = require('../sapix/generated-problems.js');
const Sync = require('../sapix/record-sync.js');
const html = fs.readFileSync(path.join(__dirname, '../sapix/sapix_sansu_trainer.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function originalData() {
  const start = html.indexOf('var UNITS ='), end = html.indexOf('var LS_REC =', start);
  assert.ok(start > 0 && end > start);
  return vm.runInNewContext(html.slice(start, end) + '; ({problems:PROBLEMS,units:UNITS,tests:TESTS})', {}, {timeout: 3000});
}
function sourceOf(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, name);
  const source = html.slice(start), first = source.slice(0, source.indexOf('\n')).trimEnd();
  if (first.endsWith('}')) return first;
  const end = /^}/m.exec(source);
  assert.ok(end, name);
  return source.slice(0, end.index + 1);
}
function generated() {
  const fileId = 'generated-source';
  const id = `drive-${fileId}-q1`;
  return {schemaVersion: 1,
    sources: [{fileId, name: '追加問題.pdf', modifiedTime: '2026-09-26T04:00:00.000Z', fingerprint: 'f'.repeat(64), problemIds: [id]}],
    problems: [{id, unit: '平面図形', title: '長方形の面積 (1)', src: '追加問題 (1)', stars: 1, tests: ['追加テスト'], question: '縦3cm、横4cmの長方形の面積を求めましょう。',
      subquestions: [], answers: [{label: '(1)', text: '12cm²'}], steps: [{title: '面積', text: '3 × 4 = 12'}], sourceImages: [`assets/drive/${fileId}/${'a'.repeat(64)}.png`]}]
  };
}

test('all actual multi-question parents split: 403 originals become 707 unique, short grading IDs', () => {
  const base = originalData().problems, before = JSON.stringify(base);
  const result = Parts.split(base), children = result.problems.filter(p => p.parentId);
  assert.equal(base.length, 403);
  assert.equal(result.problems.length, 707);
  assert.equal(Object.keys(result.firstByParent).length, 146);
  assert.equal(children.length, 450);
  assert.equal(new Set(result.problems.map(p => p.id)).size, 707);
  assert.equal(Math.max(...result.problems.map(p => p.id.length)), 37);
  assert.equal(Math.max(...result.problems.map(p => String(p.no).length)), 6);
  assert.ok(result.problems.every(p => p.id.length <= 200 && !/[\x00-\x1f\x7f]/.test(p.id)));
  assert.equal(JSON.stringify(base), before);
  for (const original of base) {
    const parts = result.problems.filter(p => p.parentId === original.id);
    if ((original.questions || []).length > 1) assert.ok(parts.length > 1, original.id);
    if (!parts.length) {
      assert.equal(result.problems.find(p => p.id === original.id), original);
      continue;
    }
    assert.equal(result.firstByParent[original.id], parts[0].id);
    assert.ok(!result.problems.some(p => p.id === original.id), original.id);
    const answers = parts.flatMap(p => p.answers);
    assert.equal(answers.length, original.answers.length, original.id);
    for (const answer of original.answers) assert.equal(answers.filter(a => a === answer).length, 1, original.id);
    for (const part of parts) {
      assert.equal(part.questions.length, 1);
      assert.ok(part.answers.length > 0);
      assert.equal(part.body, original.body);
      assert.equal(part.figure, original.figure);
      assert.equal(part.img, original.img);
      assert.deepEqual(part.tests, original.tests);
      assert.deepEqual(part.units, original.units);
    }
  }
});

test('child IDs survive reordered parents, changed display numbers and a second split pass', () => {
  const base = originalData().problems;
  const first = Parts.split(base);
  const changed = base.slice().reverse().map(p => ({...p, no: p.no + 100}));
  assert.deepEqual(Parts.split(changed).problems.map(p => p.id).sort(), first.problems.map(p => p.id).sort());
  const twice = Parts.split(first.problems);
  assert.deepEqual(twice.problems.map(p => p.id), first.problems.map(p => p.id));
  twice.problems.forEach((p, i) => assert.equal(p, first.problems[i]));
});

test('nested (1)① problems isolate the correct row and answer, retaining their common conditions', () => {
  const original = originalData().problems.find(p => p.id === '計算_41A-07_P13#1');
  const parts = Parts.split([original]).problems;
  assert.equal(parts.length, 10);
  assert.deepEqual(parts.map(p => p.partLabel), ['(1)①','(1)②','(1)③','(1)④','(2)①','(2)②','(2)③','(2)④','(3)①','(3)②']);
  for (const [index, part] of parts.entries()) {
    assert.equal(part.answers.length, 1);
    assert.equal(part.answers[0], original.answers[index]);
    assert.match(part.questions[0].t, /^次の/);
    const row = part.questions[0].t.split(/<br\s*\/?\s*>/i).at(-1);
    assert.ok(row.startsWith(part.partLabel.at(-1)));
  }
  assert.match(parts[0].questions[0].t, /5→Ⓐ→/);
  assert.doesNotMatch(parts[0].questions[0].t, /7→Ⓑ→/);
});

for (const [id, expected] of [
  ['場合の数_41A-12_P16#1', [['ア'], ['イ'], ['ウ']]],
  ['角度_41B-02_P3#1', [['㋐'], ['㋑', '㋒'], ['㋓'], ['㋔'], ['㋕']]],
  ['平面図形_41B-07_P20#1', [['ア', 'イ', 'ウ', 'エ'], ['オ', 'カ', 'キ', 'ク', 'ケ', 'コ', 'サ', 'シ', 'ス', 'セ']]],
  ['約数_41B-11_P15#1', [['(1)'], ['(2)', '', '']]]
]) test(`explicit answer mapping retains exactly the intended blanks: ${id}`, () => {
  const original = originalData().problems.find(p => p.id === id);
  const parts = Parts.split([original]).problems;
  assert.deepEqual(plain(parts.map(p => p.answers.map(a => a.l))), expected);
  parts.forEach((p, i) => assert.equal(p.questions[0].t, original.questions[i].t));
});

test('a diagram with two answers but no explicit question list becomes two separately graded parts', () => {
  const original = originalData().problems.find(p => p.id === '論理推理_H41-04_P7#1');
  const parts = Parts.split([original]).problems;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map(p => p.partLabel), ['(1)', '(2)']);
  for (let i = 0; i < parts.length; i++) {
    assert.equal(parts[i].answers[0], original.answers[i]);
    assert.equal(parts[i].figure, original.figure);
    assert.match(parts[i].questions[0].t, /図の/);
  }
});

test('ambiguous or missing answer mappings preserve the complete parent rather than drop answers', () => {
  const parent = {id: 'test', no: 1, title: 'test', questions: [{l: '(1)', t: 'one'}, {l: '(2)', t: 'two'}], answers: [{l: 'ア', v: 'A'}, {l: 'イ', v: 'B'}]};
  assert.equal(Parts.split([parent]).problems[0], parent);
  parent.answers = [{l: '(1)', v: 'one'}];
  assert.equal(Parts.split([parent]).problems[0], parent);
  parent.answers = [{l: '(1)', v: 'one'}, {l: '(2)', v: 'two'}];
  const collision = {...parent, id: 'test::part:(1)', questions: [], answers: [{l: '', v: 'original'}]};
  const before = JSON.stringify(parent);
  assert.throws(() => Parts.split([parent, collision]), /Duplicate problem part ID/);
  assert.equal(JSON.stringify(parent), before);
});

test('single-subquestion generated catalog remains one stable ID after joining and splitting the legacy corpus', () => {
  const base = originalData(), catalog = generated();
  const merged = Catalog.compileCatalog(catalog, base);
  const compiled = merged.problems.at(-1), result = Parts.split(merged.problems);
  assert.equal(result.problems.length, 708);
  assert.equal(result.problems.at(-1), compiled);
  assert.equal(result.problems.at(-1).id, catalog.problems[0].id);
  assert.equal(result.problems.at(-1).parentId, undefined);
  assert.ok(merged.tests.includes('追加テスト'));
});

test('a valid generated catalog with long labels preserves its gradable parent instead of creating a pid over 200 characters', () => {
  const catalog = generated(), fileId = 'A'.repeat(160), id = `drive-${fileId}-q1`;
  catalog.sources[0].fileId = fileId; catalog.sources[0].problemIds = [id];
  const problem = catalog.problems[0]; problem.id = id;
  problem.sourceImages = [`assets/drive/${fileId}/${'a'.repeat(64)}.png`];
  const labels = ['(123456789012345678901234567890)', '(2)'];
  problem.subquestions = labels.map(label => ({label, text: '問題'}));
  problem.answers = labels.map(label => ({label, text: '1'}));
  const compiled = Catalog.compileCatalog(catalog).problems[0];
  const result = Parts.split([compiled]);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0], compiled);
  assert.ok(result.problems[0].id.length <= 200);
  assert.equal(result.firstByParent[id], undefined);
});

test('old parent grades are not copied to children; sibling grades, correction, undo and reload are independent', () => {
  const parent = originalData().problems.find(p => (p.questions || []).length > 1);
  const parts = Parts.split([parent]).problems;
  const oldGrade = {d: '2026-09-25', r: 'x', s: 91, over: true};
  const legacy = JSON.stringify({[parent.id]: [oldGrade]});
  const map = new Map([[Sync.legacyKey, legacy]]);
  const storage = {getItem: k => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: k => map.delete(k)};
  const make = () => {
    const c = Sync.create({storage, crypto, setTimeout: () => 1, clearTimeout() {}, fetch: async () => { throw Error('offline fixture'); }});
    c.load(); return c;
  };
  const client = make();
  assert.deepEqual(plain(client.getRecords()), {[parent.id]: [oldGrade]});
  assert.equal(client.getRecords()[parts[0].id], undefined);
  const first = client.put(parts[0].id, {d: '2026-09-26', r: 'o', s: 10});
  const second = client.put(parts[1].id, {d: '2026-09-26', r: 't', s: 20});
  client.put(parts[0].id, {d: '2026-09-26', r: 'x', s: 10}, first);
  const reload = make();
  assert.deepEqual(reload.getRecords()[parent.id], [oldGrade]);
  assert.equal(reload.getRecords()[parts[0].id][0].r, 'x');
  assert.equal(reload.getRecords()[parts[1].id][0].r, 't');
  reload.remove([second]);
  const afterUndo = make().getRecords();
  assert.deepEqual(afterUndo[parent.id], [oldGrade]);
  assert.equal(afterUndo[parts[1].id], undefined);
  assert.equal(afterUndo[parts[0].id].length, 1);
  assert.equal(storage.getItem(Sync.legacyKey), legacy);
});

test('actual startup maps a saved parent selection to its first child and preserves a saved child on reload', () => {
  const data = originalData(), parent = data.problems.find(p => (p.questions || []).length > 1);
  const first = Parts.split([parent]).firstByParent[parent.id];
  for (const selected of [parent.id, first]) {
    const node = {value: '', setAttribute() {}};
    const records = {[parent.id]: [{d: '2026-09-25', r: 'x'}]};
    let renderCount = 0;
    const ctx = vm.createContext({SapixProblemParts: Parts, PROBLEMS: data.problems, UNITS: data.units, TESTS: data.tests,
      state: {pid: selected, unit: parent.unit, test: '*', filter: 'all', sort: 'no', settings: {limit: 60, sound: true}, records},
      FILTERS: [{k: 'all'}], $: () => node,
      problemsOf: unit => ctx.PROBLEMS.filter(p => unit === '*' || p.unit === unit),
      visible: () => ctx.PROBLEMS.filter(p => p.unit === ctx.state.unit),
      renderSide() {}, renderProblem() { renderCount++; }, syncReady: false
    });
    vm.runInContext(sourceOf('ensureSelection') + '\n' + sourceOf('startTrainer'), ctx);
    ctx.startTrainer();
    assert.equal(ctx.state.pid, first);
    assert.equal(ctx.state.records, records);
    assert.equal(ctx.state.records[first], undefined);
    assert.equal(renderCount, 1); assert.equal(ctx.syncReady, true);
  }
});

test('actual parent history renders only the old parent record and hides for ungraded parents or unsplit problems', () => {
  const oldRecords = {'parent': [{d: '2026-09-25', r: 'x'}], 'child': [{d: '2026-09-26', r: 'o'}]};
  const box = {hidden: true}, history = {innerHTML: ''};
  const ctx = vm.createContext({$: id => id === 'parentHistory' ? box : id === 'parentHist' ? history : null,
    recs: pid => oldRecords[pid] || [], historyHtml: pid => 'history for ' + pid});
  vm.runInContext(sourceOf('renderParentHistory'), ctx);
  ctx.renderParentHistory({id: 'child', parentId: 'parent'});
  assert.equal(box.hidden, false); assert.equal(history.innerHTML, 'history for parent');
  for (const current of [{id: 'child', parentId: 'unknown'}, {id: 'unsplit'}, null]) {
    ctx.renderParentHistory(current); assert.equal(box.hidden, true); assert.equal(history.innerHTML, '');
  }
});

test('a split answer table exposes only this part and keeps all prompt context available separately', () => {
  const child = Parts.split(originalData().problems).problems.find(p => p.id === '計算_41A-01_P12#1::part:(2)');
  assert.ok(child);
  assert.match(child.after, /<th>\(2\)<\/th>/);
  assert.doesNotMatch(child.after, /<th>\(1\)<\/th>/);
  assert.equal(child.contextQuestions.length, 2);
  assert.equal(child.questions.length, 1);
});

test('split module is available in the browser without a module loader', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../sapix/problem-parts.js'), 'utf8'), ctx);
  assert.equal(typeof ctx.SapixProblemParts.split, 'function');
});
