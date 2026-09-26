const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '../sapix/sapix_sansu_trainer.html'), 'utf8');
function sourceOf(name) {
  const start = html.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const rest = html.slice(start), first = rest.slice(0, rest.indexOf('\n')).trimEnd();
  if (first.endsWith('}')) return first;
  const end = /^}/m.exec(rest);
  assert.ok(end);
  return rest.slice(0, end.index + 1);
}
function boot() {
  let clock = 100000, nextId = 0;
  const intervals = new Map(), cues = [], nodes = new Map();
  for (const id of ['ring', 'bar', 'tdisp', 'tlbl', 'pauseBtn', 'elapsedDisplay']) {
    const classes = new Set();
    nodes.set(id, { textContent: '', innerHTML: '', disabled: false, style: {}, attrs: {}, classes,
      classList: { toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
      setAttribute(name, value) { this.attrs[name] = value; }
    });
  }
  const ctx = vm.createContext({ Date: { now: () => clock }, $: id => nodes.get(id),
    setInterval(fn, ms) { assert.equal(ms, 100); const id = ++nextId; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    beep: kind => cues.push({ kind, elapsed: ctx.elapsedSec() }), ICON_PAUSE: 'pause', ICON_PLAY: 'play'
  });
  const begin = html.indexOf('var CIRC ='), end = html.indexOf('var actx =', begin);
  assert.ok(begin >= 0 && end > begin);
  vm.runInContext(sourceOf('fmtSec') + '\n' + html.slice(begin, end), ctx);
  return { ctx, nodes, cues, intervals, advance(ms) { clock += ms; }, tickAt(seconds) { clock = 100000 + seconds * 1000; ctx.tick(); } };
}

test('active seconds and pause are captured at the click even if no interval has run', () => {
  const h = boot(); h.ctx.timerInit(60);
  h.advance(12567);
  assert.equal(h.ctx.elapsedSec(), 12.567);
  h.ctx.timerPause();
  assert.equal(h.ctx.elapsedSec(), 12.567);
  assert.ok(Math.abs(h.ctx.T.remain - 47.433) < 1e-9);
  assert.equal(h.nodes.get('elapsedDisplay').textContent, '13秒');
  assert.equal(h.nodes.get('pauseBtn').attrs['aria-label'], '再開');
  assert.equal(h.intervals.size, 0);
});

test('pause time is excluded and repeated start never creates another interval', () => {
  const h = boot(); h.ctx.timerInit(60); h.advance(8750); h.ctx.timerPause();
  h.advance(90000);
  assert.equal(h.ctx.elapsedSec(), 8.75);
  h.ctx.timerStart(); h.ctx.timerStart();
  assert.equal(h.intervals.size, 1);
  h.advance(1234); h.ctx.timerPause();
  assert.equal(h.ctx.elapsedSec(), 9.984);
  h.advance(90000);
  assert.equal(h.ctx.elapsedSec(), 9.984);
});

test('stop freezes the exact answer time and cannot resume until reset', () => {
  const h = boot(); h.ctx.timerInit(60); h.advance(18777); h.ctx.timerStop();
  assert.equal(h.ctx.elapsedSec(), 18.777);
  assert.equal(Math.round(h.ctx.elapsedSec()), 19);
  assert.equal(h.ctx.T.stopped, true);
  assert.equal(h.nodes.get('pauseBtn').disabled, true);
  assert.equal(h.intervals.size, 0);
  h.advance(50000); h.ctx.timerStart(); h.ctx.tick();
  assert.equal(h.ctx.elapsedSec(), 18.777);
  assert.equal(h.intervals.size, 0);
});

test('overtime remains active, displays a negative countdown and can pause and resume', () => {
  const h = boot(); h.ctx.timerInit(60); h.tickAt(80.9);
  assert.equal(h.ctx.elapsedSec(), 80.9);
  assert.equal(h.ctx.T.remain, 0);
  assert.equal(h.ctx.T.over, true);
  assert.equal(h.ctx.T.running, true);
  assert.equal(h.nodes.get('tdisp').textContent, '-0:20');
  assert.equal(h.nodes.get('elapsedDisplay').textContent, '1分21秒');
  assert.match(h.nodes.get('tlbl').textContent, /制限超過/);
  assert.equal(h.nodes.get('pauseBtn').disabled, false);
  h.ctx.timerPause(); h.advance(100000);
  assert.equal(h.ctx.elapsedSec(), 80.9);
  h.ctx.timerStart(); h.advance(5600); h.ctx.timerStop();
  assert.equal(h.ctx.elapsedSec(), 86.5);
  assert.equal(h.ctx.T.over, true);
  assert.equal(h.nodes.get('tdisp').textContent, '-0:26');
});

test('20 and 40 seconds beep once, the 60-second limit beeps twice, and 80 beeps once', () => {
  const h = boot(); h.ctx.timerInit(60);
  for (const second of [19.9, 20, 20.1, 40, 60, 60.1, 80]) h.tickAt(second);
  assert.deepEqual(h.cues, [
    { kind: 'tick', elapsed: 20 }, { kind: 'tick', elapsed: 40 },
    { kind: 'limit', elapsed: 60 }, { kind: 'tick', elapsed: 80 }
  ]);
  assert.equal(h.intervals.size, 1);
});

test('a limit between 20-second boundaries gets its own double cue', () => {
  const h = boot(); h.ctx.timerInit(30);
  for (const second of [20, 29.9, 30, 40]) h.tickAt(second);
  assert.deepEqual(h.cues.map(c => c.kind), ['tick', 'limit', 'tick']);
  const other = boot(); other.ctx.timerInit(90);
  for (const second of [20, 40, 60, 80, 90, 100]) other.tickAt(second);
  assert.deepEqual(other.cues.map(c => c.kind), ['tick', 'tick', 'tick', 'tick', 'limit', 'tick']);
});

test('a delayed tick emits one cue with limit priority and never bursts missed periodic sounds', () => {
  const h = boot(); h.ctx.timerInit(60); h.tickAt(85);
  assert.deepEqual(h.cues, [{ kind: 'limit', elapsed: 85 }]);
  h.ctx.drawTimer(); h.ctx.tick(); h.tickAt(99);
  assert.equal(h.cues.length, 1);
  h.tickAt(100);
  assert.deepEqual(h.cues[1], { kind: 'tick', elapsed: 100 });
  const beforeLimit = boot(); beforeLimit.ctx.timerInit(180); beforeLimit.tickAt(65);
  assert.deepEqual(beforeLimit.cues, [{ kind: 'tick', elapsed: 65 }]);
});

test('pause and stop at a crossed boundary notify once; resume never repeats the cue', () => {
  const h = boot(); h.ctx.timerInit(60); h.advance(20000); h.ctx.timerPause();
  assert.equal(h.cues.length, 1);
  h.advance(100000); h.ctx.timerStart(); h.ctx.drawTimer();
  assert.equal(h.cues.length, 1);
  h.advance(40000); h.ctx.timerStop();
  assert.deepEqual(h.cues.map(c => c.kind), ['tick', 'limit']);
  h.ctx.drawTimer(); h.ctx.timerStop();
  assert.equal(h.cues.length, 2);
});

test('reset and a new problem clear active time, overtime and cue state and replace the interval', () => {
  const h = boot(); h.ctx.timerInit(60); h.tickAt(85);
  const oldInterval = h.ctx.T.iv;
  h.ctx.timerInit(30);
  assert.equal(h.ctx.elapsedSec(), 0);
  assert.equal(h.ctx.T.over, false);
  assert.equal(h.ctx.T.stopped, false);
  assert.equal(h.ctx.T.cueStep, 0);
  assert.equal(h.nodes.get('tdisp').textContent, '0:30');
  assert.equal(h.nodes.get('elapsedDisplay').textContent, '0秒');
  assert.equal(h.intervals.size, 1);
  assert.equal(h.intervals.has(oldInterval), false);
  h.advance(20000); h.ctx.tick();
  assert.equal(h.cues.at(-1).kind, 'tick');
  h.advance(10000); h.ctx.tick();
  assert.equal(h.cues.at(-1).kind, 'limit');
});

test('a backward wall-clock adjustment cannot reduce elapsed time or replay a cue', () => {
  const h = boot(); h.ctx.timerInit(60); h.tickAt(65); h.tickAt(55);
  assert.equal(h.ctx.elapsedSec(), 65);
  assert.equal(h.nodes.get('tdisp').textContent, '-0:05');
  assert.equal(h.cues.length, 1);
  h.ctx.timerPause(); h.advance(10000); h.ctx.timerStart(); h.advance(1000);
  assert.equal(h.ctx.elapsedSec(), 66);
});

test('beep creates one short tone for periodic/default previews and two for the limit', () => {
  const notes = [];
  class AudioContext {
    constructor() { this.state = 'running'; this.currentTime = 3; this.destination = {}; }
    createOscillator() {
      const note = { frequency: {} }; notes.push(note);
      note.connect = () => {}; note.start = t => { note.startAt = t; }; note.stop = t => { note.stopAt = t; };
      return note;
    }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  const ctx = vm.createContext({ window: { AudioContext }, state: { settings: { sound: true } } });
  vm.runInContext('var actx = null;\n' + sourceOf('unlockAudio') + '\n' + sourceOf('beep'), ctx);
  ctx.beep(); assert.equal(notes.length, 1);
  ctx.beep('tick'); assert.equal(notes.length, 2);
  ctx.beep('limit'); assert.equal(notes.length, 4);
  assert.ok(Math.abs(notes[3].startAt - notes[2].startAt - 0.16) < 1e-9);
  for (const note of notes) assert.ok(note.stopAt - note.startAt < 0.1);
  ctx.actx.state = 'suspended'; ctx.actx.resume = () => Promise.resolve();
  ctx.beep('tick'); ctx.beep('limit');
  assert.equal(notes.length, 4, 'browser-blocked audio must not queue old cues for the next tap');
  ctx.actx.state = 'running'; ctx.beep('tick');
  assert.equal(notes.length, 5, 'audio resumes with the current cue only');
  ctx.state.settings.sound = false; ctx.beep('limit');
  assert.equal(notes.length, 5);
});
