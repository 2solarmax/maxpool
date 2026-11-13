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

test('a deferred reclaim waits for our queue to EMPTY — a mere shrink never switches on the serving thread', async () => {
  // Red-team round 2: a whole-write shrink fired tcsetattr(TCSADRAIN) on the serving
  // thread while a bursty terminal still held several bursts of ours.
  const stdin = rawStdin();
  const stdout = Object.assign(new EventEmitter(), { writableLength: 30_000 });
  await reclaimRawMode({ stdin, stdout, flush: async () => false, pollMs: 10 });
  stdout.writableLength = 45_000;           // more frames queued, nothing read: still behind
  await sleep(40);
  assert.deepEqual(stdin.calls, [], 'a growing queue is not progress');
  stdout.writableLength = 15_000;           // a whole frame landed: the terminal reads, in bursts
  await sleep(40);
  assert.deepEqual(stdin.calls, [], 'a shrink is not enough');
  stdout.writableLength = 0;                // the terminal took everything of ours
  await sleep(40);
  assert.deepEqual(stdin.calls, [false, true, 'resume']);
});

test('a deferred reclaim goes ahead on \'drain\' (a busy dashboard stops at the high-water mark and drains)', async () => {
  const stdin = rawStdin();
  const stdout = Object.assign(new EventEmitter(), { writableLength: 30_000 });
  await reclaimRawMode({ stdin, stdout, flush: async () => false, pollMs: 10 });
  stdout.writableLength = 500;              // the owed frame went out right in the drain
  stdout.emit('drain');
  assert.deepEqual(stdin.calls, [false, true, 'resume']);
});

test('a deferred reclaim never fires while the queue is stuck (the terminal is not reading)', async () => {
  const stdin = rawStdin();
  const stdout = Object.assign(new EventEmitter(), { writableLength: 30_000 });
  await reclaimRawMode({ stdin, stdout, flush: async () => false, pollMs: 10 });
  await sleep(80);
  assert.deepEqual(stdin.calls, []);
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

test('rawWhenDrained + modeSwitcher: a takeover never switches raw mode on its own thread, even with nothing queued', async () => {
  // A frame under the pty's 1 KB kernel queue leaves OUR queue empty while the terminal
  // has not read it; a synchronous switch there stalled the new worker ~1.7s (red-team).
  await withTerminal({ writableLength: 0 }, async ({ tui, stdin }) => {
    const asked = [];
    const modeSwitcher = { setRaw: raw => { asked.push(raw); return new Promise(() => {}); } };
    assert.equal(tui.start({ rawWhenDrained: true, modeSwitcher }), true);
    await sleep(150);
    assert.deepEqual(asked, [true], 'raw mode was requested from the helper');
    assert.deepEqual(stdin.calls.filter(c => c !== 'resume'), [], 'no setRawMode on the serving thread');
  });
});

test('rawWhenDrained + modeSwitcher: without a helper the takeover falls back to waiting for the terminal', async () => {
  await withTerminal({ writableLength: 5000 }, async ({ tui, out, stdin }) => {
    const modeSwitcher = { setRaw: async () => ({ ok: false, error: 'ENXIO', ms: 1 }) };
    assert.equal(tui.start({ rawWhenDrained: true, modeSwitcher }), true);
    await sleep(50);
    assert.deepEqual(stdin.calls.filter(c => c !== 'resume'), [], 'still waiting: the terminal is behind');
    out.writableLength = 0;
    await sleep(250);
    assert.deepEqual(stdin.calls.filter(c => c !== 'resume'), [false, true], 'then the usual reclaim');
  });
});

function fakeHelper(onSend = () => {}) {
  const h = new EventEmitter();
  h.killed = [];
  Object.assign(h, { unref() {}, channel: { unref() {} }, kill(sig) { h.killed.push(sig); }, send(m) { onSend(h, m); } });
  return h;
}

test('terminal-mode: setRaw goes through the helper and reports how long the terminal took', async () => {
  const { createTerminalModeSwitcher } = await import('../src/terminal-mode.js');
  const posted = [];
  const helpers = [];
  const sw = createTerminalModeSwitcher({ makeHelper: () => {
    const h = fakeHelper((self, m) => { posted.push(m); setTimeout(() => self.emit('message', { id: m.id, ok: true }), 30); });
    helpers.push(h);
    return h;
  } });
  const r1 = await sw.setRaw(true, { toggle: true });
  assert.deepEqual(helpers[0].killed, ['SIGKILL'], 'an idle helper is killed (SIGKILL: never a normal exit, which resets the terminal)');
  const r2 = await sw.setRaw(false);
  assert.equal(helpers.length, 2, 'the next switch starts a fresh helper');
  assert.deepEqual(posted.map(m => [m.raw, m.toggle]), [[true, true], [false, false]]);
  assert.equal(r1.ok, true);
  assert.ok(r1.ms >= 25, `ms measured (${r1.ms})`);
  assert.equal(r2.ok, true);
  sw.close();
});

test('terminal-mode: switches queued together share one helper; it is killed only once none is pending', async () => {
  const { createTerminalModeSwitcher } = await import('../src/terminal-mode.js');
  const helpers = [];
  const sent = [];
  const sw = createTerminalModeSwitcher({ makeHelper: () => { const h = fakeHelper((self, m) => sent.push(m)); helpers.push(h); return h; } });
  const a = sw.setRaw(true);
  const b = sw.setRaw(true, { toggle: true });
  assert.equal(helpers.length, 1);
  helpers[0].emit('message', { id: sent[0].id, ok: true });
  await a;
  assert.deepEqual(helpers[0].killed, [], 'still one pending: kept');
  helpers[0].emit('message', { id: sent[1].id, ok: true });
  await b;
  assert.deepEqual(helpers[0].killed, ['SIGKILL']);
  sw.close();
});

test('terminal-mode: close() kills a helper whose switch is still waiting, and fails that switch', async () => {
  const { createTerminalModeSwitcher } = await import('../src/terminal-mode.js');
  const h = fakeHelper();
  const sw = createTerminalModeSwitcher({ makeHelper: () => h });
  const p = sw.setRaw(true);
  const exitListeners = process.listenerCount('exit');
  sw.close();
  assert.deepEqual(h.killed, ['SIGKILL']);
  assert.equal((await p).ok, false);
  assert.equal(process.listenerCount('exit'), exitListeners - 1, 'the exit hook is removed with it');
});

test('terminal-mode: this process exiting kills a helper still waiting (a stale mode never lands later)', async () => {
  const { createTerminalModeSwitcher } = await import('../src/terminal-mode.js');
  const h = fakeHelper();
  const sw = createTerminalModeSwitcher({ makeHelper: () => h });
  void sw.setRaw(true);
  process.emit('exit', 0);
  assert.deepEqual(h.killed, ['SIGKILL']);
  sw.close();
});

test('terminal-mode: a helper that dies fails its pending switches (the caller falls back), and the next call starts a new one', async () => {
  const { createTerminalModeSwitcher } = await import('../src/terminal-mode.js');
  const helpers = [];
  const sw = createTerminalModeSwitcher({ makeHelper: () => { const h = fakeHelper(); helpers.push(h); return h; } });
  const p = sw.setRaw(true);
  helpers[0].emit('error', new Error('boom'));
  assert.deepEqual({ ...(await p), ms: 0 }, { ok: false, error: 'boom', ms: 0 });
  const failing = createTerminalModeSwitcher({ makeHelper: () => { throw new Error('no spawn'); } });
  assert.equal((await failing.setRaw(true)).ok, false, 'a helper that cannot start is a fallback, not a throw');
  void sw.setRaw(true);
  assert.equal(helpers.length, 2, 'a fresh helper after the first one died');
  sw.close();
});

test('terminal-mode: the real helper reports a failure (no controlling terminal) instead of hanging', { timeout: 10_000 }, async () => {
  const { createTerminalModeSwitcher } = await import('../src/terminal-mode.js');
  const { spawnSync } = await import('node:child_process');
  // Run in a child with no controlling terminal (setsid), so /dev/tty cannot open.
  const code = `import(${JSON.stringify(new URL('../src/terminal-mode.js', import.meta.url).href)}).then(async ({ createTerminalModeSwitcher }) => {
    const r = await createTerminalModeSwitcher().setRaw(true);
    console.log(JSON.stringify(r));
  });`;
  const r = spawnSync('python3', ['-c', 'import os,sys; os.setsid(); os.execvp(sys.argv[1], sys.argv[1:])', process.execPath, '-e', code],
    { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.equal(out.ok, false, r.stdout + r.stderr);
  assert.ok(out.error, 'names why');
  void createTerminalModeSwitcher;
});

test('whenTerminalCaughtUp: fires once our queue is empty — not on a mere shrink — and can be cancelled', async () => {
  const { whenTerminalCaughtUp } = await import('../src/tui.js');
  const out = Object.assign(new EventEmitter(), { writableLength: 3000 });
  let fired = 0;
  whenTerminalCaughtUp(() => fired++, { stdout: out, pollMs: 10 });
  out.writableLength = 1000;
  await sleep(40);
  assert.equal(fired, 0, 'a shrink is not caught up');
  out.writableLength = 0;
  await sleep(40);
  out.emit('drain');
  await sleep(20);
  assert.equal(fired, 1, 'fired exactly once');
  const out2 = Object.assign(new EventEmitter(), { writableLength: 3000 });
  let fired2 = 0;
  const cancel = whenTerminalCaughtUp(() => fired2++, { stdout: out2, pollMs: 10 });
  cancel();
  out2.writableLength = 0;
  await sleep(40);
  assert.equal(fired2, 0, 'cancelled');
  let fired3 = 0;
  whenTerminalCaughtUp(() => fired3++, { stdout: Object.assign(new EventEmitter(), { writableLength: 0 }), pollMs: 10 });
  await sleep(5);
  assert.equal(fired3, 1, 'already caught up: fires at once');
});

test('WIRING: an update cold restart waits for the terminal, and the restart never switches the terminal mode', () => {
  const rw = src.match(/const restartWorkerNow = \(\) => \{[\s\S]*?\n {2}\};\n/);
  assert.ok(rw, 'restartWorkerNow found');
  assert.match(rw[0], /if \(supervised\) terminalHandedOff = true;\s*if \(tui\?\.running\) \{ tui\.stop\(supervised \? \{ keepRaw: true \} : \{\}\); \}/);
  const settle = src.match(/const settleRolledBackReload = [\s\S]*?\n {2}\};\n/)[0];
  assert.match(settle, /if \(tui\?\.running && tui\._nb && process\.stdout\.writableLength > 0\) \{[\s\S]{0,300}whenTerminalCaughtUp\(/);
  assert.match(src, /cancelDeferredColdRestart\?\.\(\);/, 'a new reload cancels a waiting update restart');
});

// ── baton: the old worker hears about a rollback before anything is logged ──

function scripted(replies) {
  const sent = [];
  return { sent, send(m) { sent.push(m); }, waitFor() {
    const r = replies.shift();
    return r === 'TIMEOUT' ? Promise.reject(Object.assign(new Error('timed out'), { reason: 'timeout' })) : Promise.resolve(r);
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
  // Both fallback sites (an outcome of FALLBACK, a thrown error) go through fallBack().
  assert.equal((orchestrate.match(/restoreTerminalFromSupervisor\(\{ exiting: false \}\)/g) || []).length, 1, 'the one fallback path uses the non-blocking restore');
  assert.equal((orchestrate.match(/\bfallBack\(\);/g) || []).length, 2, 'both fallback sites use it');
  assert.doesNotMatch(orchestrate, /restoreTerminalFromSupervisor\(\)/);
});

test('WIRING: a takeover announces MSG_PRIMARY before it takes the terminal, which switches raw mode off-thread', () => {
  const bp = src.match(/const becomePrimary = async[\s\S]*?\n {2}\};\n/);
  assert.ok(bp, 'becomePrimary found');
  const primary = bp[0].indexOf('type: MSG_PRIMARY');
  const takeover = bp[0].indexOf('if (viaTakeover) takeTerminal({ viaTakeover });');
  assert.ok(primary > 0 && takeover > primary, 'MSG_PRIMARY is sent before a takeover takes the terminal');
  // A takeover (and a respawn — see below) switches raw mode off the serving thread; the
  // first launch switches it before its first frame (deferring there by drain left a busy
  // terminal's keyboard dead — tui-terminal-pty (b)/(c)).
  assert.match(src, /const takeTerminal = [\s\S]{0,1400}tui\.start\(offThread \? \{ rawWhenDrained: true, modeSwitcher: terminalMode \} : \{\}\)/);
});

test('WIRING: MSG_ROLLED_BACK settles the rollback at once (an id-less one flagged); the self-heal reports a missing answer as such', () => {
  assert.match(src, /msg\?\.type === MSG_ROLLED_BACK\)[\s\S]{0,1200}if \(action === 'settle'\) settleRolledBackReload\(\{ answered: true, reason: msg\.reason \|\| null \}\);\s*else if \(action === 'settle-idless'\) settleRolledBackReload\(\{ answered: true, reason: msg\.reason \|\| null, idless: true \}\);/);
  // No reason is ever recorded for later: the self-heal only ever means "no answer".
  assert.match(src, /reloadWatchdog = setTimeout\(\(\) => \{\s*reloadWatchdog = null;\s*settleRolledBackReload\(\{ answered: false \}\);/);
  assert.doesNotMatch(src, /lastRollbackReason/);
  assert.match(src, /!answered \? 'the supervisor did not answer'/);
});

test('WIRING: every worker exit path kills the terminal helper first (a pending switch never holds the exit)', () => {
  const rw = src.match(/const restartWorkerNow = \(\) => \{[\s\S]*?\n {2}\};\n/)[0];
  assert.match(rw, /draining = true;[\s\S]{0,200}terminalMode\.close\(\);/);
  assert.ok(rw.indexOf('terminalMode.close()') < rw.indexOf('process.exit('), 'restartWorkerNow: before its exit');
  assert.match(src, /process\.on\('uncaughtException'[\s\S]{0,800}\{ terminalMode\.close\(\); process\.exit\(SERVER_RESTART_EXIT_CODE\); \}/);
  assert.match(src, /const exitAfterMergeFlush = \(\) => \{\s*terminalMode\.close\(\);/);
  const sg = src.match(/const shutdownGracefully = [\s\S]*?\n {2}\};\n/)[0];
  assert.match(sg, /terminalMode\.close\(\);\s[\s\S]{0,700}if \(supervised\) terminalHandedOff = true;\s*if \(tui\?\.running\) tui\.stop\(supervised \? \{ keepRaw: true \} : \{\}\);/);
});

test('WIRING: a TUI worker turns stderr non-blocking; a respawned cold worker switches raw mode off-thread', () => {
  assert.match(src, /if \(useTUI\) setConsoleNonBlocking\(\{ streams: \[process\.stderr\] \}\);/);
  assert.match(src, /const offThread = viaTakeover \|\| isRespawnedWorker;\s*if \(tui\) \{\s*if \(tui\.start\(offThread \? \{ rawWhenDrained: true, modeSwitcher: terminalMode \} : \{\}\)\)/);
  assert.match(src, /const worker = spawnWorker\(\{ reload: false, respawn: coldSpawns\+\+ > 0 \}\);/);
  assert.match(src, /if \(respawn\) env\[SERVER_RESPAWNED_WORKER_ENV\] = '1';/);
});

test('WIRING: the reload worker is muzzled before its first possible console line', () => {
  const fn = src.match(/async function serverWorkerCommand\(\) \{[\s\S]*?const config = await loadOrCreateConfig\(\);/);
  assert.ok(fn, 'serverWorkerCommand prologue found');
  assert.match(fn[0], /if \(isReloadWorker && useTUI\) \{\s*installConsoleMirror\(\);\s*setConsoleStdoutSuppressed\(true\);/);
});
