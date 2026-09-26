import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderLesson, resolveAssets, validateLesson, MAX_HTML_BYTES } from '../render-lesson.mjs';
import { renderScene, renderFormula, sceneDescription } from './scene.mjs';

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

const dimensionPrimitives = [
  {kind:'line',id:'repair-line',x1:10,y1:10,x2:30,y2:30,color:'ink',width:1,dashed:false,arrow:'none'},
  {kind:'polyline',id:'repair-polyline',points:[{x:10,y:10},{x:30,y:30}],color:'ink',width:1,dashed:false,arrow:'none'},
  {kind:'polygon',id:'repair-polygon',points:[{x:10,y:10},{x:30,y:10},{x:30,y:30}],stroke:'ink',fill:'blue',width:1,dashed:false},
  {kind:'rect',id:'repair-rect',x:10,y:10,width:20,height:20,stroke:'ink',fill:'blue',strokeWidth:1},
  {kind:'circle',id:'repair-circle',cx:20,cy:20,radius:10,stroke:'ink',fill:'blue',width:1},
  {kind:'arc',id:'repair-arc',cx:20,cy:20,radius:10,startAngle:0,endAngle:90,color:'ink',width:1},
  {kind:'angle',id:'repair-angle',x:20,y:20,radius:10,startAngle:0,endAngle:90,rightAngle:false,color:'ink',width:1},
  {kind:'point',id:'repair-point',x:20,y:20,radius:2,color:'ink'},
  {kind:'label',id:'repair-label',x:20,y:20,text:'A',color:'ink',fontSize:14,anchor:'middle'}
];

test('invalid widths retain the cached repair message and identify the exact primitive without changing data', () => {
  for (const example of dimensionPrimitives.filter(primitive=>Object.hasOwn(primitive,'width'))) {
    for (const width of [0,-1]) {
      const lesson=clone(),problem=lesson.problems[0], primitive={...example,width};
      problem.diagram.primitives.push(primitive);
      const before=structuredClone(lesson);
      assert.throws(()=>validateLesson(lesson),error=>{
        assert.equal(error.message,'Invalid primitive width');
        assert.deepEqual(error.details,{problemId:problem.id,primitiveId:primitive.id,kind:primitive.kind,
          field:'width',value:width,minimum:0,exclusive:true});
        return true;
      });
      assert.deepEqual(lesson,before,'validation must not normalize required positive widths');
    }
  }
});

test('all other primitive dimensions retain positivity checks and actionable field diagnostics', () => {
  for (const example of dimensionPrimitives) {
    for (const field of ['radius','fontSize','height','strokeWidth'].filter(key=>Object.hasOwn(example,key))) {
      for (const value of [0,-1]) {
        const lesson=clone(),primitive={...example,[field]:value};
        lesson.problems[0].diagram.primitives.push(primitive);
        assert.throws(()=>validateLesson(lesson),error=>{
          assert.equal(error.message,'Invalid primitive dimension');
          assert.deepEqual(error.details,{problemId:lesson.problems[0].id,primitiveId:primitive.id,kind:primitive.kind,
            field,value,minimum:0,exclusive:true});
          return true;
        });
      }
    }
  }
});

test('null, missing or unrelated width fields remain schema errors instead of invented dimensions', () => {
  for (const mutate of [
    primitive=>{ primitive.width=null; },
    primitive=>{ delete primitive.width; },
    primitive=>{ primitive.width='2'; },
    primitive=>{ primitive.width=Number.NaN; }
  ]) {
    const lesson=clone(),primitive={...dimensionPrimitives[0]};
    mutate(primitive); lesson.problems[0].diagram.primitives.push(primitive);
    assert.throws(()=>validateLesson(lesson),/does not match a supported type/);
  }
  for (const value of [null,0,1]) {
    const lesson=clone();
    lesson.problems[0].diagram.primitives.push({...dimensionPrimitives.at(-1),width:value});
    assert.throws(()=>validateLesson(lesson),/does not match a supported type/,'labels do not accept an unused width');
  }
});

test('a missing label requires a real typed label and valid dimensions while existing geometry stays exact', () => {
  const lesson=clone(),problem=lesson.problems[0],cue=problem.steps[0].cues[0];
  const original=structuredClone(problem.diagram.primitives);
  cue.state.visibleIds.push('points-3-example-title');
  assert.throws(()=>validateLesson(lesson),/missing reference points-3-example-title/);
  const label={...dimensionPrimitives.at(-1),id:'points-3-example-title',text:'3の倍数'};
  problem.diagram.primitives.push(label);
  assert.equal(validateLesson(lesson),lesson);
  label.fontSize=13;
  assert.throws(()=>validateLesson(lesson),error=>{
    assert.equal(error.message,'Diagram labels must start at 14 SVG units or larger');
    assert.deepEqual(error.details,{problemId:problem.id,primitiveId:'points-3-example-title',kind:'label',field:'fontSize',value:13,minimum:14,exclusive:false});
    return true;
  });
  label.fontSize=14;
  const line={...dimensionPrimitives[0],width:0.25};
  problem.diagram.primitives.push(line);cue.state.visibleIds.push(line.id);
  assert.equal(validateLesson(lesson),lesson);
  const markup=renderScene(problem,cue,problem.steps[0].viewBox,'dimension-repair');
  assert(markup.includes('stroke-width="0.25"'));
  assert(markup.includes('>3の倍数</text>'));
  assert.deepEqual(problem.diagram.primitives.slice(0,original.length),original);
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

test('accessible scenes reveal only the current cue and its visible labels', () => {
  const problem=clone().problems[0], first=problem.steps[0].cues[0];
  problem.title='面積を求める';
  problem.diagram.description='制作メモ: 最後に答え4321平方センチメートルを出す';
  first.displayText='はじめに与えられた長さを確認します';
  problem.diagram.primitives.push({...problem.diagram.primitives.find(item=>item.kind==='label'),id:'future-result',text:'4321平方センチメートル'});
  const last=structuredClone(first);
  last.state.visibleIds.push('future-result');
  last.displayText='計算して面積を求めました';
  const initial=sceneDescription(problem,first), final=sceneDescription(problem,last);
  assert(initial.includes(problem.title));
  assert(initial.includes(first.displayText));
  assert(!initial.includes('4321'));
  assert(!initial.includes('制作メモ'));
  assert(final.includes('4321平方センチメートル'));
  assert(!final.includes('制作メモ'));
  const markup=renderScene(problem,first,problem.steps[0].viewBox,'live-test');
  assert(!markup.includes('4321'));
  assert(!markup.includes('制作メモ'));
  assert(markup.includes('<title id="live-test:title">'+initial+'</title>'));
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
