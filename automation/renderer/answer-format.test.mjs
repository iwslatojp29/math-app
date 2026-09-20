import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { formatAnswerText } from './answer-format.mjs';
import { renderLesson } from '../render-lesson.mjs';

test('answers already containing the literal unit retain their original text', () => {
  for (const [answer, unit] of [['24cm²', 'cm²'], ['8 cm', 'cm'], ['答えは24（cm²）です。', 'cm²'], ['3個', '個'], [' ２４ｃｍ² ', 'cm²']]) {
    assert.equal(formatAnswerText(answer, unit), answer);
  }
});

test('metric Japanese equivalents work in both directions for length, area and volume', () => {
  for (const [symbol, name] of [['mm', 'ミリメートル'], ['cm', 'センチメートル'], ['m', 'メートル'], ['km', 'キロメートル']]) {
    for (const [power, prefix] of [['', ''], ['²', '平方'], ['³', '立方']]) {
      const japanese = '24' + prefix + name, symbolic = '24' + symbol + power;
      assert.equal(formatAnswerText(japanese, symbol + power), japanese);
      assert.equal(formatAnswerText(symbolic, prefix + name), symbolic);
    }
  }
});

test('incompatible dimensions, prefixes and compound units never suppress a suffix', () => {
  for (const [answer, unit] of [['8cm', 'cm²'], ['8cm²', 'cm'], ['8cm³', 'cm²'], ['8cm', 'm'],
    ['8mm', 'm'], ['8平方センチメートル', 'cm'], ['8立方メートル', 'm²'], ['8cm/s', 'cm'], ['8センチメートル/秒', 'cm'], ['8kg', 'g']]) {
    assert.equal(formatAnswerText(answer, unit), answer + ' ' + unit);
  }
});

test('unit-free answers keep their exact text and unmatched units are appended', () => {
  assert.equal(formatAnswerText(' 24 ', ''), ' 24 ');
  assert.equal(formatAnswerText('24', '   '), '24');
  assert.equal(formatAnswerText('24', 'cm²'), '24 cm²');
  assert.equal(formatAnswerText('6', '通り'), '6 通り');
});

test('both static answers and answer index use the formatter and keep HTML escaping', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/geometry.json', import.meta.url), 'utf8'));
  const assets = JSON.parse(await readFile(new URL('./fixtures/assets.json', import.meta.url), 'utf8'));
  const options = { assets, assetBaseDirectory: fileURLToPath(new URL('./fixtures/', import.meta.url)) };
  const sub = fixture.problems[0].subquestions[0];
  sub.answerText = '24平方センチメートル';
  sub.unit = 'cm²';
  let { html } = await renderLesson(fixture, options);
  assert(!html.includes('24平方センチメートル cm²'));
  assert(html.includes('</strong> 24平方センチメートル'));
  assert(html.includes('<td>24平方センチメートル</td>'));
  sub.answerText = '<img src=x onerror=alert(1)>24';
  sub.unit = '<b>単位</b>';
  ({ html } = await renderLesson(fixture, options));
  const escaped = '&lt;img src=x onerror=alert(1)&gt;24 &lt;b&gt;単位&lt;/b&gt;';
  assert(html.includes('</strong> ' + escaped));
  assert(html.includes('<td>' + escaped + '</td>'));
  assert(!html.includes(sub.answerText));
});
