const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../math/index.html'), 'utf8');
const context = vm.createContext({ document: { addEventListener() {} }, URL, URLSearchParams, Intl, Date });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/material-metadata.js'), 'utf8'), context);
vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
const plain = value => JSON.parse(JSON.stringify(value));
const describe = context.describeEntry;

test('exercise types include combined materials in both categories, without matching descriptions', () => {
  const combined = describe('2026年11月 発展演習・学力コンテスト 解答解説');
  assert.deepEqual(plain(combined.types), ['advanced', 'contest']);
  assert.deepEqual(plain(describe('2026年11月 日日の演習・要点整理 解答解説｜発展演習の類題付き').types), ['daily']);
  assert.deepEqual(plain(describe('2026年8月 マンスリー 解答解説').types), ['other']);
  assert.equal(describe('2026年13月 日日の演習').month, 'undated');
});

test('category/month navigation supports direct links and falls back to a month with matching materials', () => {
  const entries = [describe('2026年11月 日日の演習'), describe('2026年7月 学力コンテスト'), describe('2025年11月 学力コンテスト')];
  assert.deepEqual(plain(context.readSelection('', entries)), { type: 'all', month: '202611' });
  assert.deepEqual(plain(context.readSelection('#type=contest&month=202507', entries)), { type: 'contest', month: '202607' });
  assert.deepEqual(plain(context.readSelection('#type=contest&month=202511', entries)), { type: 'contest', month: '202511' });
  assert.deepEqual(plain(context.readSelection('#type=contest&month=all', entries)), { type: 'contest', month: 'all' });
  assert.deepEqual(plain(context.readSelection('#type=__proto__&month=bad', entries)), { type: 'all', month: '202611' });
});

test('filename issue dates support prefixes, full-width digits and common month formats', () => {
  for (const filename of ['2026年12月号_日日の演習.html', '算数_2026年12月_図解と講義.html',
    '算数_２０２６年１２月号.html', '2026_12_日日の演習.html', '2026-12_図形.html', '202612_図形.html']) {
    assert.equal(context.MathAppMaterialMetadata.issueMonth(filename), '202612', filename);
  }
  for (const filename of ['解説.html', '2026年13月号.html', '2026年0月号.html', '2026_123_図形.html', '12026年12月.html']) {
    assert.equal(context.MathAppMaterialMetadata.issueMonth(filename), '', filename);
  }
  assert.equal(describe('旧教材の表示名', '', '算数_2026年12月号.html', '202612').month, '202612');
  // Preserve issue corrections made to legacy labels unless the uploader has
  // explicitly stored the filename's month on the new card.
  assert.equal(describe('2026年8月 学力コンテスト', '', '中数9月号_学コン.html').month, '202608');
});

test('a December upload creates a new sorted month and supports its direct result link', () => {
  const entries = [describe('2026年11月 日日の演習', '2026-11-01T00:00:00Z')];
  assert.deepEqual(plain(context.availableMonths(entries, 'all')), ['202611']);
  entries.push(describe('算数_2026年12月号_日日の演習_図解と講義', '2026-11-03T01:00:00Z', '', '202612'));
  assert.deepEqual(plain(context.availableMonths(entries, 'daily')), ['202612', '202611']);
  const selection = context.readSelection('#type=all&month=202612', entries);
  assert.equal(context.monthLabel(selection.month), '2026年12月');
  assert.equal(context.selectEntries(entries, selection)[0].title, entries[1].title);
  entries.push(describe('別冊_2026年12月_日日の演習', '2026-11-03T02:00:00Z', '', '202612'));
  assert.deepEqual(plain(context.availableMonths(entries, 'all')), ['202612', '202611']);
  assert.deepEqual(plain(context.selectEntries(entries, selection).map(entry => entry.title)), [entries[2].title, entries[1].title]);
});

test('right-hand results filter by both selections and sort by upload time across issues', () => {
  const entries = [
    describe('2026年11月 日日の演習', '2026-09-24T00:00:00Z'),
    describe('2026年7月 日日の演習', '2026-10-24T07:30:00Z'),
    describe('2026年7月 学力コンテスト', '2026-10-24T08:00:00Z'),
    describe('2026年7月 日日の演習・未確認'),
  ];
  const allDaily = context.selectEntries(entries, { type: 'daily', month: 'all' });
  assert.deepEqual(plain(allDaily.map(entry => entry.title)), [entries[1].title, entries[0].title, entries[3].title]);
  assert.deepEqual(plain(context.selectEntries(entries, { type: 'contest', month: '202607' }).map(entry => entry.title)), [entries[2].title]);
  assert.equal(context.selectEntries(entries, { type: 'advanced', month: 'all' }).length, 0);
});

test('upload timestamps display in Japan time, including midnight and year boundaries', () => {
  assert.equal(context.uploadLabel('2026-10-23T15:05:00Z'), '2026/10/24 00:05');
  assert.equal(context.uploadLabel('2025-12-31T15:30:00Z'), '2026/01/01 00:30');
  assert.equal(context.validUploadDate('not a date'), false);
});

test('new uploads resolve to the oldest file commit, including paginated histories', async () => {
  const calls = [];
  const dates = ['2026-10-24T00:00:00Z', '2026-08-01T03:00:00Z'];
  const date = await context.lookupUploadDate('2026年9月 解説.html', async (url, options) => {
    calls.push({ url, options });
    const second = new URL(url).searchParams.get('page') === '2';
    return { ok: true, headers: { get: () => second ? null : '<https://api.github.com/repos/iwslatojp29/math-app/commits?page=2>; rel="last"' },
      json: async () => [{ commit: { committer: { date: dates[second ? 1 : 0] } } }] };
  });
  assert.equal(date, dates[1]);
  assert.equal(new URL(calls[0].url).searchParams.get('path'), 'math/2026年9月 解説.html');
  assert.ok(calls.every(call => call.options.credentials === 'omit'));
  await assert.rejects(context.lookupUploadDate('new.html', async () => ({ ok: false })), /upload_date_unavailable/);
});

test('every existing catalog card includes a real timestamp and both combined categories remain discoverable', () => {
  const cards = [...html.matchAll(/<div class="card" data-uploaded-at="([^"]+)">\s*<a href="([^"]+)">([^<]+)<\/a>\s*<time class="upload-date" datetime="([^"]+)">([^<]+)<\/time>/g)];
  assert.equal(cards.length, 53);
  for (const [, date, href, title, timeDate, label] of cards) {
    assert.equal(date, timeDate);
    assert.equal(context.validUploadDate(date), true);
    assert.equal(label, `アップロード ${context.uploadLabel(date)}`);
    assert.ok(fs.existsSync(path.join(__dirname, '../math', decodeURIComponent(href.slice(2)))));
  }
  const entries = cards.map(([, date, , title]) => describe(title, date));
  assert.ok(context.selectEntries(entries, { type: 'advanced', month: '202611' }).length > 0);
  assert.ok(context.selectEntries(entries, { type: 'contest', month: '202611' }).length > 0);
});
