import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLesson } from './renderer/validate.mjs';
import { escapeHtml, renderFormula, renderScene } from './renderer/scene.mjs';

export { validateLesson } from './renderer/validate.mjs';
export const MAX_HTML_BYTES = 24 * 1024 * 1024;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);
const MIME_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif' };

export async function resolveAssets(lesson, assets, baseDirectory = process.cwd()) {
  const resolved = new Map();
  for (const source of lesson.sourceImages) {
    if (resolved.has(source.assetId)) continue;
    const asset = assets[source.assetId];
    if (!asset || typeof asset !== 'object') throw new Error('Missing original image asset: ' + source.assetId);
    let mimeType, bytes;
    if (typeof asset.dataUrl === 'string') {
      const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(asset.dataUrl);
      if (!match) throw new Error('Image assets must be local raster images or base64 data URLs');
      mimeType = match[1];
      bytes = Buffer.from(match[2], 'base64');
      if (bytes.toString('base64') !== match[2]) throw new Error('Invalid image base64');
    } else if (typeof asset.path === 'string') {
      const file = resolve(baseDirectory, asset.path);
      mimeType = asset.mimeType || MIME_BY_EXT[extname(file).toLowerCase()];
      bytes = await readFile(file);
    } else throw new Error('Image asset needs path or dataUrl: ' + source.assetId);
    if (!MIME_TYPES.has(mimeType) || bytes.length === 0) throw new Error('Unsupported or empty image: ' + source.assetId);
    const magic = bytes.subarray(0, 16);
    const valid = mimeType === 'image/png' ? magic.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : mimeType === 'image/jpeg' ? magic[0] === 255 && magic[1] === 216 && magic[2] === 255
      : mimeType === 'image/gif' ? /GIF8[79]a/.test(magic.toString('ascii', 0, 6))
      : mimeType === 'image/webp' ? magic.toString('ascii', 0, 4) === 'RIFF' && magic.toString('ascii', 8, 12) === 'WEBP'
      : magic.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(magic.toString('ascii', 8, 16));
    if (!valid) throw new Error('Image file does not match its media type: ' + source.assetId);
    resolved.set(source.assetId, 'data:' + mimeType + ';base64,' + bytes.toString('base64'));
  }
  return resolved;
}

function formulaList(problem, ids) { return ids.map(id => renderFormula(problem.formulas.find(formula => formula.id === id))).join(''); }
function staticProblem(problem) {
  const cues = problem.steps.flatMap(step => step.cues.map(cue => ({ cue, viewBox: step.viewBox })));
  const blocks = problem.staticExplanation.map((block, index) => {
    const scene = cues.find(item => item.cue.id === block.sceneCueId);
    return '<section class="static-block"><h3>' + escapeHtml(block.heading) + '</h3><div class="static-grid"><div class="static-figure">' + renderScene(problem, scene.cue, scene.viewBox, 'static:' + problem.id + ':' + index) + '</div><div><p>' + escapeHtml(block.text) + '</p>' + formulaList(problem, block.formulaIds) + '</div></div></section>';
  }).join('');
  const answers = problem.subquestions.map(sub => '<li><strong>' + escapeHtml(sub.label) + '</strong> ' + escapeHtml(sub.answerText) + (sub.unit ? ' ' + escapeHtml(sub.unit) : '') + (sub.answerFormulaId ? formulaList(problem, [sub.answerFormulaId]) : '') + '</li>').join('');
  return '<article class="problem-static" id="static-' + problem.id + '"><h2>' + escapeHtml(problem.number + ' ' + problem.title) + '</h2><p class="goal">' + escapeHtml(problem.goal) + '</p><ul class="givens">' + problem.givens.map(given => '<li>' + escapeHtml(given) + '</li>').join('') + '</ul><p>' + escapeHtml(problem.opening) + '</p><p class="source-links">' + problem.sourceImageIds.map(id => '<a href="#source-' + id + '" data-source="' + id + '">原問題を開く</a>').join(' · ') + '</p><details class="static-details"><summary>図と式で読み返す</summary>' + blocks + '<h3>答え</h3><ul class="answers">' + answers + '</ul></details></article>';
}

export async function renderLesson(lesson, { assets = {}, assetBaseDirectory = process.cwd(), maxBytes = MAX_HTML_BYTES } = {}) {
  validateLesson(lesson);
  const images = await resolveAssets(lesson, assets, assetBaseDirectory);
  const [css, sceneModule, runtime] = await Promise.all([
    readFile(new URL('./renderer/styles.css', import.meta.url), 'utf8'),
    readFile(new URL('./renderer/scene.mjs', import.meta.url), 'utf8'),
    readFile(new URL('./renderer/runtime.js', import.meta.url), 'utf8')
  ]);
  const safeData = JSON.stringify(lesson).replace(/[<>&\u2028\u2029]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  const navigation = lesson.sections.map(section => '<section><h2>' + escapeHtml(section.title) + '</h2>' + lesson.problems.filter(problem => problem.sectionId === section.id).map(problem => '<a href="#static-' + problem.id + '" data-problem="' + problem.id + '" aria-label="' + escapeHtml(section.title + ' ' + problem.number) + '">' + escapeHtml(problem.number) + '</a>').join('') + '</section>').join('');
  const answerRows = lesson.problems.flatMap(problem => problem.subquestions.map(sub => '<tr><td>' + escapeHtml(lesson.sections.find(section => section.id === problem.sectionId).title) + '</td><td>' + escapeHtml(problem.number) + '</td><td>' + escapeHtml(sub.label) + '</td><td>' + escapeHtml(sub.answerText + (sub.unit ? ' ' + sub.unit : '')) + '</td></tr>')).join('');
  const sources = lesson.sourceImages.map(source => '<details class="source-original" id="source-' + source.id + '"><summary>' + escapeHtml(source.alt + '（PDF ' + source.pdfPage + 'ページ' + (source.printedPage ? '／紙面 ' + source.printedPage : '') + '）') + '</summary><img id="asset-' + source.id + '" src="' + images.get(source.assetId) + '" alt="' + escapeHtml(source.alt) + '" loading="lazy"/></details>').join('');
  const html = '<!doctype html>\n<html lang="ja"><head><meta charset="utf-8"><meta name="math-app-generated-lesson" content="1.0"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>' + escapeHtml(lesson.title) + '</title><style>' + css + '</style></head><body>\n' +
    '<header class="toolbar" aria-label="講義の操作"><span class="font-tools" aria-label="文字サイズ"><button data-font="small" aria-label="文字を小さく">小</button><button data-font="normal" aria-label="標準の文字サイズ" aria-pressed="true">標準</button><button data-font="large" aria-label="文字を大きく">大</button></span><button id="play" aria-label="再生・一時停止">▶ 再生</button><button id="previous" aria-label="前の説明">前へ</button><button id="next" aria-label="次の説明">次へ</button><button id="repeat" aria-label="今の説明を再生">再聴</button><button id="restart" aria-label="問題の最初から再生">最初</button><label>小問<select id="subquestion" aria-label="小問を選択"></select></label><label>ステップ<select id="step" aria-label="ステップを選択"></select></label><label>速度<select id="speed" aria-label="読み上げ速度">' + [1,1.25,1.5,1.75,2,2.25,2.5,2.75,3].map(rate => '<option value="' + rate + '">' + rate.toFixed(2) + '</option>').join('') + '</select></label><button id="audio" aria-pressed="true">音声ON</button><button id="print" aria-label="全問を印刷">印刷</button></header>\n' +
    '<div class="page-layout"><nav class="problem-nav" aria-label="問題番号">' + navigation + '</nav><main class="content-pane" id="main-content"><h1>' + escapeHtml(lesson.title) + '</h1><p class="document-meta">' + escapeHtml(lesson.yearMonth) + ' · ' + escapeHtml(lesson.pdfName) + '</p><noscript><p>静的な解説を表示しています。講義の再生にはJavaScriptを有効にしてください。</p></noscript><section class="lecture" aria-label="図で見る講義"><div class="lecture-head"><h2 id="lecture-title"></h2><span id="position"></span></div><div class="lecture-grid"><div id="diagram" class="diagram"></div><div class="narration"><h3 id="step-title"></h3><p id="caption" aria-live="polite"></p><div id="formulas"></div><details class="facts"><summary>ここまでに分かっていること</summary><ul id="facts"></ul></details></div></div><p id="playback-status" class="playback-status" role="status">問題番号か再生ボタンで始められます。</p></section><section id="static-explanations">' + lesson.problems.map(staticProblem).join('') + '</section><details class="answer-index"><summary>全小問の答え一覧</summary><table><thead><tr><th>欄</th><th>問題</th><th>小問</th><th>答え</th></tr></thead><tbody>' + answerRows + '</tbody></table></details><section class="sources"><h2>原問題</h2>' + sources + '</section><a class="back-link" href="./index.html">← コンテンツ一覧へ戻る</a></main></div><dialog id="source-dialog"><button id="close-source" autofocus>閉じる</button><div id="source-dialog-body"></div></dialog>\n' +
    '<script type="application/json" id="lesson-data">' + safeData + '</script><script>\n' + sceneModule.replace(/^export /gm, '') + '\n' + runtime + '\n</script></body></html>\n';
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > maxBytes) throw new Error('Generated standalone HTML is ' + bytes + ' bytes; limit is ' + maxBytes + '. Reduce image weight without removing problems or splitting this PDF.');
  return { html, bytes, problemCount: lesson.problems.length, subquestionCount: lesson.problems.reduce((total, problem) => total + problem.subquestions.length, 0) };
}

async function main() {
  const argumentsMap = {};
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index], value = process.argv[index + 1];
    if (!['--input', '--output', '--assets'].includes(name) || !value) throw new Error('Usage: node automation/render-lesson.mjs --input lesson.json --output lesson.html --assets assets.json');
    argumentsMap[name] = value;
  }
  if (!argumentsMap['--input'] || !argumentsMap['--output']) throw new Error('--input and --output are required');
  const lesson = JSON.parse(await readFile(argumentsMap['--input'], 'utf8'));
  const manifestPath = argumentsMap['--assets'] ? resolve(argumentsMap['--assets']) : null;
  const assets = manifestPath ? JSON.parse(await readFile(manifestPath, 'utf8')) : {};
  const result = await renderLesson(lesson, { assets, assetBaseDirectory: manifestPath ? dirname(manifestPath) : dirname(resolve(argumentsMap['--input'])) });
  await mkdir(dirname(resolve(argumentsMap['--output'])), { recursive: true });
  await writeFile(argumentsMap['--output'], result.html, 'utf8');
  console.log(JSON.stringify({ ok: true, bytes: result.bytes, problems: result.problemCount, subquestions: result.subquestionCount }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error('Lesson rendering failed: ' + error.message); process.exitCode = 1; });
