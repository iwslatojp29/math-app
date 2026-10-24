const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../math/index.html'), 'utf8');
const context = vm.createContext({ document: { addEventListener() {} }, URL, URLSearchParams, Intl, Date });
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
  assert.equal(cards.length, 52);
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
