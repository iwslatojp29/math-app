import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderLesson, resolveAssets, validateLesson, MAX_HTML_BYTES } from '../render-lesson.mjs';
import { renderScene, renderFormula } from './scene.mjs';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/', import.meta.url));
const fixture = JSON.parse(await readFile(new URL('./fixtures/geometry.json', import.meta.url), 'utf8'));
const assets = JSON.parse(await readFile(new URL('./fixtures/assets.json', import.meta.url), 'utf8'));
const options = { assets, assetBaseDirectory:fixtureDirectory };
const clone = () => structuredClone(fixture);

test('schema uses strict objects throughout, including nested diagram alternatives', async () => {
  const schema = JSON.parse(await readFile(new URL('../lesson.schema.json', import.meta.url), 'utf8'));
  function check(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'object') {
      assert.equal(node.additionalProperties,false);
      assert.deepEqual(node.required,Object.keys(node.properties));
    }
    Object.values(node).forEach(value => Array.isArray(value) ? value.forEach(check) : check(value));
  }
  check(schema);
});

test('complete geometry fixture renders standalone with all subquestions, original image and publishing marker', async () => {
  const output = await renderLesson(fixture,options);
  assert.equal(output.problemCount,2); assert.equal(output.subquestionCount,3);
  assert(output.html.startsWith('<!doctype html>'));
  assert(output.html.slice(0,65536).includes('name="math-app-generated-lesson"'));
  assert(output.html.includes('src="data:image/png;base64,'));
  assert(!/<(?:script|link)\b[^>]*(?:src|href)=["']https?:/.test(output.html));
  assert(output.html.includes('id="static-points-5"'));
  assert(output.html.includes('id="static-practice-5"'));
  assert.equal(output.bytes,Buffer.byteLength(output.html));
  assert.equal(MAX_HTML_BYTES,24*1024*1024);
});

test('missing or duplicate coverage, unresolved reviews and missing original images block publication', () => {
  const mutations = [
    lesson => { lesson.coverage.pop(); },
    lesson => { lesson.coverage[1].problemId=lesson.coverage[0].problemId; },
    lesson => { lesson.coverage[0].subquestionIds.pop(); },
    lesson => { lesson.review.mathematicsChecked=false; },
    lesson => { lesson.problems[0].verification.unresolvedIssues.push('An angle is unreadable'); },
    lesson => { lesson.problems[0].sourceImageIds=[]; },
    lesson => { lesson.problems[0].diagram.primitives[0].kind='raw-svg'; },
    lesson => { lesson.problems[0].steps[0].cues[0].state.highlightIds.push('unseen-answer'); },
    lesson => { lesson.problems[0].steps[0].cues[0].formulaIds.push('missing'); }
  ];
  mutations.forEach(mutate => { const lesson=clone(); mutate(lesson); assert.throws(()=>validateLesson(lesson)); });
});

test('duplicate primitive IDs and cyclic facts cannot produce corrupt state', () => {
  const duplicate=clone(); duplicate.problems[0].diagram.primitives.push(duplicate.problems[0].diagram.primitives[0]);
  assert.throws(()=>validateLesson(duplicate),/duplicate/);
  const cycle=clone(); cycle.problems[0].facts[0].dependencies=['shared-height'];
  assert.throws(()=>validateLesson(cycle),/cyclic/);
});

test('typed scene and inline JSON escape markup-shaped lesson strings', async () => {
  const lesson=clone();
  const hostile='</script><script>alert("not-executable")</script><img src=x onerror=alert(1)>';
  lesson.title=hostile;
  lesson.problems[0].diagram.primitives.find(primitive=>primitive.kind==='label').text=hostile;
  lesson.problems[0].steps[0].cues[0].displayText=hostile;
  const output=await renderLesson(lesson,options);
  assert(!output.html.includes('<script>alert("not-executable")'));
  assert(output.html.includes('\\u003c/script\\u003e'));
  assert(output.html.includes('&lt;script&gt;'));
});

test('scene snapshots are deterministic and do not leak future answer labels', () => {
  const problem=fixture.problems[0];
  const first=problem.steps[0].cues[0],last=problem.steps.at(-1).cues[0];
  const a=renderScene(problem,first,problem.steps[0].viewBox,'test');
  renderScene(problem,last,problem.steps.at(-1).viewBox,'test');
  assert.equal(renderScene(problem,first,problem.steps[0].viewBox,'test'),a);
  assert(!a.includes('data-target="adc-answer"'));
  assert(renderScene(problem,last,problem.steps.at(-1).viewBox,'test').includes('data-target="adc-answer"'));
});

test('SVG metadata and primitive IDs occupy separate namespaces', () => {
  const lesson=clone(), problem=lesson.problems[0], cue=problem.steps[0].cues[0];
  for (const id of ['title','arrow','target-title']) {
    problem.diagram.primitives.push({...problem.diagram.primitives[0],id});
    cue.state.visibleIds.push(id);
  }
  const markup=renderScene(problem,cue,problem.steps[0].viewBox,'static:problem:0');
  const ids=Array.from(markup.matchAll(/\bid="([^"]+)"/g),match=>match[1]);
  assert.equal(ids.length,new Set(ids).size);
  assert(markup.includes('aria-labelledby="static:problem:0:title"'));
  assert(markup.includes('id="static:problem:0:target:title"'));
});

test('fractions and powers are displayed using built-in markup without a CDN', () => {
  const formula={description:'4分の3平方センチメートル',parts:[{kind:'fraction',numerator:'3',denominator:'4',text:'',exponent:''},{kind:'power',text:'cm',exponent:'2',numerator:'',denominator:''}]};
  const markup=renderFormula(formula);
  assert(markup.includes('class="fraction"')); assert(markup.includes('<sup>2</sup>'));
});

test('missing files, external images, wrong mime and excessive final size fail explicitly', async () => {
  await assert.rejects(renderLesson(fixture,{assets:{}}),/Missing original image/);
  await assert.rejects(resolveAssets(fixture,{'geometry-original':{dataUrl:'https://example.com/image.png'}}),/local raster/);
  await assert.rejects(resolveAssets(fixture,{'geometry-original':{dataUrl:'data:image/png;base64,'+Buffer.from('<svg/>').toString('base64')}}),/media type/);
  await assert.rejects(renderLesson(fixture,{...options,maxBytes:1024}),/without removing problems/);
});
