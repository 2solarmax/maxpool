// Unit half of the "terminal not reading" fix (2026-11-13). The real-pty half is
// test/reload-terminal-not-reading.test.js; it proves the reload completes, but cannot
// see the pieces below — each one is pinned here against a stand-in terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setEventLogPath, installConsoleMirror, setConsoleNonBlocking, reassertConsoleNonBlocking,
  flushEventLog, __resetEventLogForTest,
} from '../src/event-log.js';
import { reclaimRawMode, TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';
import { runReloadBaton, RELOAD_ROLLED_BACK, MSG_READY, MSG_FAILED, MSG_ROLLED_BACK } from '../src/reload-protocol.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function withProcessStream(name, value, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, name);
  Object.defineProperty(process, name, { value, configurable: true, writable: true });
  return Promise.resolve().then(fn).finally(() => Object.defineProperty(process, name, desc));
}

// ── supervisor console: non-blocking terminal, drop the copy while it is behind ──

test('a non-blocking console drops a line\'s terminal copy while the terminal is behind; the event log keeps it', async () => {
  const realLog = console.log;
  const shown = [];
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-nb-'));
  const logPath = join(dir, 'events.log');
  const blocking = [];
  const term = { fd: 1, writableNeedDrain: false, _handle: { setBlocking: v => blocking.push(v) } };
  console.log = (...a) => shown.push(a.join(' '));
  __resetEventLogForTest();
  try {
    await withProcessStream('stdout', term, async () => {
      setEventLogPath(logPath);
      installConsoleMirror();
      assert.equal(setConsoleNonBlocking({ streams: [term], isTTY: () => true }), 1);
      assert.deepEqual(blocking, [false], 'the terminal stream was switched to non-blocking');
      console.log('[Maxpool] reading');
      term.writableNeedDrain = true;          // the terminal stopped reading
      console.log('[Maxpool] behind');
      term.writableNeedDrain = false;         // it drained
      console.log('[Maxpool] caught up');
      await flushEventLog();
    });
    assert.deepEqual(shown, ['[Maxpool] reading', '[Maxpool] caught up'], 'only the line written while behind was dropped from the terminal');
    const disk = await readFile(logPath, 'utf8');
    for (const l of ['reading', 'behind', 'caught up']) assert.match(disk, new RegExp(`\\[Maxpool\\] ${l}`), `event log kept "${l}"`);
  } finally {
    __resetEventLogForTest();
    console.log = realLog;
  }
});

test('a blocking stream (not switched) is never dropped, even if it reports needDrain', async () => {
  const realLog = console.log;
  const shown = [];
  const pipe = { fd: 1, writableNeedDrain: true, _handle: { setBlocking() {} } };
  console.log = (...a) => shown.push(a.join(' '));
  __resetEventLogForTest();
  try {
    await withProcessStream('stdout', pipe, async () => {
      installConsoleMirror();
      assert.equal(setConsoleNonBlocking({ streams: [pipe], isTTY: () => false }), 0, 'a pipe is left alone');
      console.log('[Maxpool] piped');
    });
    assert.deepEqual(shown, ['[Maxpool] piped']);
  } finally {
    __resetEventLogForTest();
    console.log = realLog;
  }
});

test('reassertConsoleNonBlocking switches the streams non-blocking again (a spawned child reset them)', () => {
  __resetEventLogForTest();
  const calls = [];
  const term = { fd: 1, _handle: { setBlocking: v => calls.push(v) } };
  try {
    setConsoleNonBlocking({ streams: [term], isTTY: () => true });
    reassertConsoleNonBlocking();
    assert.deepEqual(calls, [false, false]);
  } finally { __resetEventLogForTest(); }
});

// ── reclaimRawMode: a deferred reclaim must not depend on 'drain' alone ──

function rawStdin({ throwOnRaw = false } = {}) {
  const calls = [];
  return { calls, isTTY: true,
    setRawMode(v) { if (throwOnRaw && v) { const e = new Error('setRawMode EIO'); e.code = 'EIO'; throw e; } calls.push(v); },
    resume() { calls.push('resume'); } };
}

test('a deferred reclaim happens once our queue empties, even though no \'drain\' is emitted', async () => {
  const stdin = rawStdin();
  const stdout = Object.assign(new EventEmitter(), { writableLength: 800 });   // below the high-water mark: no 'drain' ever
  let later = 0;
  const done = await reclaimRawMode({ stdin, stdout, flush: async () => false, pollMs: 10, onDeferredReclaim: () => later++ });
  assert.equal(done, false);
  await sleep(40);
  assert.deepEqual(stdin.calls, [], 'still behind: no blocking tcsetattr');
  stdout.writableLength = 0;
  await sleep(40);
  assert.deepEqual(stdin.calls, [false, true, 'resume'], 'reclaimed once the terminal took our output');
  assert.equal(later, 1);
  stdout.emit('drain');
  assert.deepEqual(stdin.calls, [false, true, 'resume'], 'one reclaim, not one per signal');
});

test('a deferred reclaim is skipped when its guard says the terminal is no longer ours', async () => {
  const stdin = rawStdin();
  const stdout = Object.assign(new EventEmitter(), { writableLength: 800 });
  let ours = true;
  await reclaimRawMode({ stdin, stdout, flush: async () => false, pollMs: 10, guard: () => ours });
  ours = false;
  stdout.writableLength = 0;
  await sleep(40);
  assert.deepEqual(stdin.calls, []);
});

// ── TUI.start({ rawWhenDrained }) — the takeover dashboard ──

function fakeTerminalOut(writableLength) {
  const out = new EventEmitter();
  Object.assign(out, { columns: 100, rows: 30, isTTY: true, writableNeedDrain: false, writableLength, writes: 0 });
  out.write = () => { out.writes++; return true; };
  return out;
}

async function withTerminal({ writableLength, throwOnRaw = false }, fn) {
  const out = fakeTerminalOut(writableLength);
  const stdin = Object.assign(new EventEmitter(), rawStdin({ throwOnRaw }), { pause() {}, setEncoding() {} });
  const realErr = console.error;
  console.error = () => {};
  try {
    await withProcessStream('stdout', out, () => withProcessStream('stdin', stdin, async () => {
      const tui = new TUI({ accountManager: new AccountManager([], 0.9), config: {} });
      try { await fn({ tui, out, stdin }); } finally { if (tui.running) tui.stop({ keepRaw: true }); await sleep(50); }
    }));
  } finally { console.error = realErr; }
}

test('rawWhenDrained: a terminal that is behind gets the dashboard now and raw mode once it reads', async () => {
  await withTerminal({ writableLength: 5000 }, async ({ tui, out, stdin }) => {
    assert.equal(tui.start({ rawWhenDrained: true }), true);
    assert.equal(tui.running, true);
    assert.ok(out.writes > 0, 'the dashboard was drawn');
    assert.deepEqual(stdin.calls.filter(c => c !== 'resume'), [], 'no blocking setRawMode while the terminal is behind');
    out.writableLength = 0;               // the terminal read our frame
    await sleep(250);
    assert.deepEqual(stdin.calls.filter(c => c !== 'resume'), [false, true], 'raw mode taken once the terminal drained');
  });
});

test('rawWhenDrained: a terminal that took the frame at once gets raw mode synchronously', async () => {
  await withTerminal({ writableLength: 0 }, async ({ tui, stdin }) => {
    assert.equal(tui.start({ rawWhenDrained: true }), true);
    assert.deepEqual(stdin.calls.filter(c => c !== 'resume'), [true]);
  });
});

test('rawWhenDrained: a terminal that refuses raw mode still falls back to plain logs', async () => {
  await withTerminal({ writableLength: 0, throwOnRaw: true }, async ({ tui }) => {
    assert.equal(tui.start({ rawWhenDrained: true }), false);
    assert.equal(tui.running, false);
  });
});

test('rawWhenDrained: a dashboard stopped before the terminal drained is not put back in raw mode', async () => {
  await withTerminal({ writableLength: 5000 }, async ({ tui, out, stdin }) => {
    tui.start({ rawWhenDrained: true });
    tui.stop({ keepRaw: true });          // handed off before the terminal caught up
    out.writableLength = 0;
    await sleep(250);
    assert.deepEqual(stdin.calls.filter(c => c !== 'resume'), []);
  });
});

// ── baton: the old worker hears about a rollback before anything is logged ──

function scripted(replies) {
  const sent = [];
  return { sent, send(m) { sent.push(m); }, waitFor() {
    const r = replies.shift();
    return r === 'TIMEOUT' ? Promise.reject(new Error('timed out')) : Promise.resolve(r);
  } };
}

for (const [label, reply, reason] of [['readiness timeout', 'TIMEOUT', 'timeout'], ['new worker failed', { type: MSG_FAILED, reason: 'x' }, 'failed']]) {
  test(`baton (${label}): MSG_ROLLED_BACK is sent BEFORE the rollback is logged`, async () => {
    const oldWorker = scripted([]);
    const newWorker = scripted([reply]);
    const sentAtLog = [];
    const outcome = await runReloadBaton({ oldWorker, newWorker, handle: {}, log: () => sentAtLog.push(oldWorker.sent.map(m => m.type)) });
    assert.equal(outcome, RELOAD_ROLLED_BACK);
    assert.deepEqual(sentAtLog, [[MSG_ROLLED_BACK]], 'the old worker was told before the log line');
    assert.equal(oldWorker.sent[0].reason, reason);
  });
}

test('baton: a READY reload is not a rollback (control)', async () => {
  const oldWorker = scripted(['TIMEOUT']);   // then the release wait fails → fallback, no ROLLED_BACK
  const newWorker = scripted([{ type: MSG_READY }]);
  await runReloadBaton({ oldWorker, newWorker, handle: {} });
  assert.ok(!oldWorker.sent.some(m => m.type === MSG_ROLLED_BACK));
});

// ── wiring in index.js that only a fallback/older supervisor reaches ──

const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('WIRING: the supervisor turns its terminal non-blocking and re-asserts it after every worker spawn', () => {
  assert.match(src, /installConsoleMirror\(\);\s*\n\s*setConsoleNonBlocking\(\);/);
  const spawnWorker = src.match(/const spawnWorker = [\s\S]*?\n {2}\};\n/);
  assert.ok(spawnWorker, 'spawnWorker found');
  assert.match(spawnWorker[0], /spawn\([\s\S]*?\);\s*\n[\s\S]{0,200}reassertConsoleNonBlocking\(\);/, 'reassert right after spawn()');
});

test('WIRING: a reload fallback restores the terminal without blocking; only the exit path may block', () => {
  const fn = src.match(/const restoreTerminalFromSupervisor = [\s\S]*?\n {2}\};\n/);
  assert.ok(fn, 'restoreTerminalFromSupervisor found');
  const nonExiting = fn[0].match(/if \(!exiting\) \{[\s\S]*?return;\s*\}/);
  assert.ok(nonExiting, 'a non-exiting branch exists and returns early');
  assert.doesNotMatch(nonExiting[0], /writeTerminalSync|setRawMode/, 'the fallback branch never blocks');
  const orchestrate = src.match(/const orchestrateReload = [\s\S]*?\n {2}\};\n/)[0];
  assert.equal((orchestrate.match(/restoreTerminalFromSupervisor\(\{ exiting: false \}\)/g) || []).length, 2, 'both fallback sites use the non-blocking restore');
  assert.doesNotMatch(orchestrate, /restoreTerminalFromSupervisor\(\)/);
});

test('WIRING: a takeover announces MSG_PRIMARY before it takes the terminal, which defers raw mode', () => {
  const bp = src.match(/const becomePrimary = async[\s\S]*?\n {2}\};\n/);
  assert.ok(bp, 'becomePrimary found');
  const primary = bp[0].indexOf('type: MSG_PRIMARY');
  const takeover = bp[0].indexOf('if (viaTakeover) takeTerminal();');
  assert.ok(primary > 0 && takeover > primary, 'MSG_PRIMARY is sent before a takeover takes the terminal');
  assert.match(src, /const takeTerminal = [\s\S]{0,400}tui\.start\(\{ rawWhenDrained: true \}\)/);
});

test('WIRING: MSG_ROLLED_BACK settles the rollback at once; the self-heal reports a missing answer as such', () => {
  assert.match(src, /msg\?\.type === MSG_ROLLED_BACK\)[\s\S]{0,400}settleRolledBackReload\(\{ answered: true, reason: msg\.reason \|\| null \}\)/);
  assert.match(src, /reloadWatchdog = setTimeout\(\(\) => \{[\s\S]{0,120}settleRolledBackReload\(\{ answered: false \}\)/);
  assert.match(src, /!answered \? 'the supervisor did not answer'/);
});

test('WIRING: the reload worker is muzzled before its first possible console line', () => {
  const fn = src.match(/async function serverWorkerCommand\(\) \{[\s\S]*?const config = await loadOrCreateConfig\(\);/);
  assert.ok(fn, 'serverWorkerCommand prologue found');
  assert.match(fn[0], /if \(isReloadWorker && useTUI\) \{\s*installConsoleMirror\(\);\s*setConsoleStdoutSuppressed\(true\);/);
});
