import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { validateLesson } from './validate.mjs';
import { transformValue } from './scene.mjs';

const viewports = [{width:1024,height:768},{width:1194,height:834},{width:1366,height:1024},{width:768,height:1024},{width:390,height:844}];
function speechMock() {
  class MockUtterance { constructor(text) { this.text = text; } }
  class MockSynthesis extends EventTarget {
    constructor() { super(); this.current = null; this.history = []; }
    getVoices() { return [{ name:'検証用日本語音声', lang:'ja-JP', localService:true, default:true }]; }
    speak(utterance) { this.current = utterance; this.history.push(utterance); queueMicrotask(() => utterance.onstart && utterance.onstart()); }
    cancel() { this.current = null; }
  }
  const synthesis = new MockSynthesis();
  Object.defineProperty(window, 'speechSynthesis', { configurable:true, value:synthesis });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { configurable:true, value:MockUtterance });
  window.__lessonSpeech = synthesis;
}

async function checkGeometry(page, label) {
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const pane = document.querySelector('.content-pane');
    const diagram = document.getElementById('diagram');
    const svg = diagram.querySelector('svg');
    const box = svg.viewBox.baseVal;
    const outside = [];
    for (const target of svg.querySelectorAll('[data-target]')) {
      const bounds = target.getBBox();
      const matrix = target.transform.baseVal.consolidate()?.matrix;
      const corners = [[bounds.x,bounds.y],[bounds.x+bounds.width,bounds.y],[bounds.x,bounds.y+bounds.height],[bounds.x+bounds.width,bounds.y+bounds.height]].map(([x,y]) => matrix ? new DOMPoint(x,y).matrixTransform(matrix) : {x,y});
      if (corners.some(point => point.x < box.x-3 || point.x > box.x+box.width+3 || point.y < box.y-3 || point.y > box.y+box.height+3)) outside.push(target.dataset.target);
    }
    const toolbar = document.querySelector('.toolbar');
    return { pageOverflow:root.scrollWidth>root.clientWidth+1, paneOverflow:pane.scrollWidth>pane.clientWidth+1, diagramOverflow:diagram.scrollWidth>diagram.clientWidth+1, toolbarOverflow:toolbar.scrollWidth>toolbar.clientWidth+1, outside };
  });
  assert(!result.pageOverflow && !result.paneOverflow && !result.diagramOverflow, label + ': horizontal content overflow');
  if (page.viewportSize().width >= 1024) assert(!result.toolbarOverflow, label + ': toolbar does not fit one landscape row');
  assert.deepEqual(result.outside, [], label + ': diagram primitives outside viewBox');
}

async function checkCueState(page, problem, cue) {
  const state = await page.evaluate(() => ({
    id: document.getElementById('diagram').dataset.cueId,
    caption: document.getElementById('caption').textContent,
    visible: Array.from(document.querySelectorAll('#diagram [data-target]'), item => item.dataset.target),
    highlights: Array.from(document.querySelectorAll('#diagram .focused'), item => item.dataset.target),
    transforms: Array.from(document.querySelectorAll('#diagram [data-target]'), item => [item.dataset.target, item.getAttribute('transform')]),
    formulas: Array.from(document.querySelectorAll('#formulas [role="math"]'), item => item.getAttribute('aria-label')),
    facts: Array.from(document.querySelectorAll('#facts li'), item => item.textContent)
  }));
  const label = problem.id + '/' + cue.id;
  assert.equal(state.id, cue.id, label + ': cue position');
  assert.equal(state.caption, cue.displayText, label + ': caption');
  assert.deepEqual(state.visible.slice().sort(), cue.state.visibleIds.slice().sort(), label + ': full visible state');
  assert.deepEqual(state.highlights.slice().sort(), cue.state.highlightIds.slice().sort(), label + ': highlight targets');
  for (const [id, actual] of state.transforms) assert.equal(actual, transformValue(cue.state.transforms.find(item => item.targetId === id)), label + ': transform ' + id);
  assert.deepEqual(state.formulas, cue.formulaIds.map(id => problem.formulas.find(item => item.id === id).description), label + ': formulas');
  assert.deepEqual(state.facts, cue.factIds.map(id => problem.facts.find(item => item.id === id).text), label + ': restored facts');
}

export async function verifyLesson({ htmlPath, outputDirectory }) {
  const playwrightName = process.env.PLAYWRIGHT_MODULE;
  const imported = playwrightName ? await import(pathToFileURL(resolve(playwrightName)).href) : await import('playwright');
  const playwright = imported.chromium ? imported : imported.default;
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive:true });
  const browser = await playwright.chromium.launch({ headless:true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const screenshots = [], errors = [], externalRequests = [];
  let checkedStates = 0, checkedSpeechCues = 0, checkedSubquestions = 0;
  try {
    const context = await browser.newContext({ viewport:viewports[0], reducedMotion:'reduce' });
    await context.addInitScript(speechMock);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    const htmlUrl = pathToFileURL(resolve(htmlPath)).href;
    page.on('request', request => { if (request.url() !== htmlUrl && !/^data:/.test(request.url())) externalRequests.push(request.url()); });
    await page.goto(htmlUrl);
    await page.waitForSelector('html.js');
    const lesson = await page.evaluate(() => JSON.parse(document.getElementById('lesson-data').textContent));
    validateLesson(lesson);
    assert.equal(await page.evaluate(() => window.__lessonSpeech.history.length), 0, 'The lesson must not speak on opening');
    assert.equal(await page.locator('#speed option').count(), 9);

    for (const problem of lesson.problems) {
      const cues = problem.steps.flatMap(step => step.cues);
      await page.locator('[data-problem="' + problem.id + '"]').click();
      for (const cue of cues) {
        await checkCueState(page, problem, cue);
        const state = await page.evaluate(() => ({ speech:window.__lessonSpeech.current?.text, cue:document.getElementById('diagram').dataset.cueId, caption:document.getElementById('caption').textContent }));
        assert.equal(state.cue, cue.id, 'Cue must begin with its own figure');
        assert.equal(state.caption, cue.displayText);
        assert.equal(state.speech, cue.speechText);
        checkedSpeechCues++;
        await page.evaluate(() => window.__lessonSpeech.current.onend());
      }
      assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false', 'Playback must stop at the end of the problem');
      for (const sub of problem.subquestions) {
        if (problem.subquestions.length <= 1) continue;
        await page.locator('#subquestion').selectOption(sub.id);
        const entry = cues.findIndex(cue => cue.id === sub.entryCueId);
        const laterEntries = problem.subquestions.map(item => cues.findIndex(cue => cue.id === item.entryCueId)).filter(index => index > entry);
        const end = laterEntries.length ? Math.min(...laterEntries) : cues.length;
        const path = [...new Set([...sub.prerequisiteCueIds, ...cues.slice(entry,end).map(cue=>cue.id)])];
        for (const cueId of path) {
          await checkCueState(page, problem, cues.find(cue => cue.id === cueId));
          await page.evaluate(() => window.__lessonSpeech.current.onend());
        }
        assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
        checkedSubquestions++;
      }
    }

    await page.locator('[data-problem]').first().click();
    await page.evaluate(() => { window.__obsoleteUtterance = window.__lessonSpeech.current; });
    await page.locator('[data-problem]').last().click();
    const activeCue = await page.locator('#diagram').getAttribute('data-cue-id');
    await page.evaluate(() => window.__obsoleteUtterance.onend());
    assert.equal(await page.locator('#diagram').getAttribute('data-cue-id'), activeCue, 'Old speech events must not advance a new problem');
    await page.locator('#play').click();
    assert.equal(await page.locator('#diagram').getAttribute('data-cue-id'), activeCue);
    assert.equal(await page.evaluate(() => window.__lessonSpeech.current), null, 'Pause must stop the old utterance');
    await page.locator('#play').click();
    const activeProblem = lesson.problems.at(-1);
    const activeProblemCues = activeProblem.steps.flatMap(step => step.cues);
    await checkCueState(page, activeProblem, activeProblemCues[0]);
    await page.locator('#repeat').click();
    assert.equal(await page.evaluate(() => window.__lessonSpeech.current.text), activeProblemCues[0].speechText, 'Replay speaks the current cue');
    for (const rate of ['1','1.25','1.5','1.75','2','2.25','2.5','2.75','3']) {
      await page.locator('#speed').selectOption(rate);
      assert.equal(await page.evaluate(() => window.__lessonSpeech.current.rate), Number(rate));
      assert.equal(await page.locator('#diagram').getAttribute('data-cue-id'), activeCue);
    }
    await page.locator('#play').click();
    await page.locator('#speed').selectOption('1');
    if (activeProblemCues.length > 1) {
      await page.locator('#next').click();
      await checkCueState(page, activeProblem, activeProblemCues[1]);
      await page.locator('#previous').click();
      await checkCueState(page, activeProblem, activeProblemCues[0]);
    }
    await page.locator('#restart').click();
    await checkCueState(page, activeProblem, activeProblemCues[0]);
    await page.locator('#play').click();

    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      for (const fontSize of ['normal','large']) {
        await page.locator('[data-font="' + fontSize + '"]').click();
        for (const problem of lesson.problems) {
          await page.locator('[data-problem="' + problem.id + '"]').click();
          await page.locator('#play').click();
          const cues = problem.steps.flatMap(step => step.cues);
          const representative = cues.reduce((best, cue) => cue.state.visibleIds.length + cue.displayText.length / 20 > best.state.visibleIds.length + best.displayText.length / 20 ? cue : best, cues[0]);
          for (let index=0; index<cues.length; index++) {
            const cue = cues[index];
            await checkCueState(page, problem, cue);
            await checkGeometry(page, problem.id + '/' + cue.id + '/' + viewport.width + '/' + fontSize);
            checkedStates++;
            if (cue.id === representative.id) {
              const screenshotPath = resolve(output, problem.id + '-' + viewport.width + '-' + fontSize + '.png');
              await page.screenshot({ path:screenshotPath, fullPage:true });
              const displayState = await page.evaluate(() => {
                const regions = {};
                for (const [name, selector] of Object.entries({ toolbar:'.toolbar', content:'.content-pane', narration:'.narration' })) {
                  const element = document.querySelector(selector), style = getComputedStyle(element);
                  regions[name] = { scrollLeft:element.scrollLeft, scrollTop:element.scrollTop,
                    clientWidth:element.clientWidth, scrollWidth:element.scrollWidth,
                    clientHeight:element.clientHeight, scrollHeight:element.scrollHeight,
                    overflowX:style.overflowX, overflowY:style.overflowY };
                }
                return { capture:'viewport-with-independent-scroll-regions', regions,
                  caption:document.getElementById('caption').textContent,
                  visibleIds:Array.from(document.querySelectorAll('#diagram [data-target]'), item=>item.dataset.target),
                  highlightIds:Array.from(document.querySelectorAll('#diagram .focused'), item=>item.dataset.target) };
              });
              screenshots.push({ path:screenshotPath, problemId:problem.id, cueId:cue.id, viewport, fontSize, displayState });
            }
            if (index + 1 < cues.length) await page.locator('#next').click();
          }
          // Restoring the first step must reproduce the original scene, independent of the visit history.
          for (const step of problem.steps.slice().reverse()) {
            await page.locator('#step').selectOption(step.id);
            await checkCueState(page, problem, step.cues[0]);
          }
        }
      }
    }

    await page.setViewportSize(viewports[1]);
    await page.locator('[data-font="normal"]').click();
    await page.locator('.problem-static:not([hidden]) [data-source]').first().click();
    await page.waitForFunction(() => document.querySelector('#source-dialog-body img')?.naturalWidth > 0);
    await page.locator('#close-source').click();
    const duplicateIds = await page.evaluate(() => { const ids=Array.from(document.querySelectorAll('[id]'),el=>el.id); return ids.filter((id,index)=>ids.indexOf(id)!==index); });
    assert.deepEqual(duplicateIds, [], 'HTML and SVG IDs must be unique');
    const originalDetails = await page.locator('details').evaluateAll(items => items.map(item => item.open));
    await page.evaluate(() => { window.dispatchEvent(new Event('beforeprint')); window.dispatchEvent(new Event('beforeprint')); });
    await page.emulateMedia({ media:'print' });
    const visiblePrintProblems = await page.locator('.problem-static').evaluateAll(items => items.filter(item => getComputedStyle(item).display !== 'none').length);
    assert.equal(visiblePrintProblems, lesson.problems.length, 'Print must include all problems');
    assert.equal(await page.locator('details:not([open])').count(), 0, 'Print must open all static explanations');
    await page.pdf({ path:resolve(output,'print-all.pdf'), format:'A4', printBackground:true });
    await page.emulateMedia({ media:'screen' });
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    assert.deepEqual(await page.locator('details').evaluateAll(items => items.map(item => item.open)), originalDetails, 'Print must restore all collapsed sections');

    // A synchronous engine failure must be as recoverable as an error event.
    await page.evaluate(() => { window.__savedSpeak = window.__lessonSpeech.speak; window.__lessonSpeech.speak = () => { throw new Error('Test voice failure'); }; });
    await page.locator('[data-problem]').first().click();
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
    assert.match(await page.locator('#playback-status').textContent(), /音声を再生できません/);
    await page.evaluate(() => { window.__lessonSpeech.speak = window.__savedSpeak; });

    // A missing Japanese voice must stop gracefully and keep manual navigation available.
    await page.evaluate(() => { window.__lessonSpeech.getVoices = () => []; });
    await page.locator('[data-problem]').first().click();
    await page.waitForFunction(() => document.getElementById('playback-status').textContent.includes('日本語音声がありません'));
    assert.equal(await page.locator('#play').getAttribute('aria-pressed'), 'false');
    if (lesson.problems[0].steps.flatMap(step=>step.cues).length > 1) {
      assert.equal(await page.locator('#next').isEnabled(), true);
      await page.locator('#next').click();
    }
    await page.locator('#audio').click();
    assert.equal(await page.locator('#audio').getAttribute('aria-pressed'), 'false');
    await page.locator('#speed').selectOption('1.75');
    await page.locator('[data-font="large"]').click();
    await page.locator('[data-problem]').last().click();
    assert.equal(await page.locator('#audio').getAttribute('aria-pressed'), 'false', 'Audio preference survives problem changes');
    assert.equal(await page.locator('#speed').inputValue(), '1.75', 'Speed survives problem changes');
    assert.equal(await page.locator('[data-font="large"]').getAttribute('aria-pressed'), 'true', 'Text size survives problem changes');
    await page.locator('#play').click();
    assert.deepEqual(errors, [], 'Browser console/runtime errors');
    assert.deepEqual(externalRequests, [], 'Standalone HTML must not request external resources');
    const result = { ok:true, screenshots, checkedStates, checkedSpeechCues, checkedSubquestions, printProblems:visiblePrintProblems, consoleErrors:errors, externalRequests, actualSpeechAudition:false, physicalIPadTest:false };
    await writeFile(resolve(output,'verification.json'),JSON.stringify(result,null,2)+'\n','utf8');
    return result;
  } finally { await browser.close(); }
}

async function main() {
  const args={};
  for(let index=2;index<process.argv.length;index+=2) args[process.argv[index]]=process.argv[index+1];
  if(!args['--html']||!args['--out']) throw new Error('Usage: node automation/renderer/verify-lesson.mjs --html lesson.html --out qa-directory');
  const result=await verifyLesson({htmlPath:args['--html'],outputDirectory:args['--out']});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) main().catch(error=>{console.error(JSON.stringify({ok:false,error:error.message}));process.exitCode=1;});
