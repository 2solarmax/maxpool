import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';
import { RestartController } from '../src/restart-controller.js';

const { strip } = __tuiTest;

// Reported 2026-08-10: "I click restart, then yes, and NOTHING happens" — while ~30
// sessions were 503-ing with "Maxpool is restarting". The restart pauses admission and
// drains for up to 10s; with long requests always in flight the user sits in that
// window every time, sees no progress, and every session shows a retry.

const am = () => new AccountManager([
  { name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
], 0.90);

test('the restart confirm states the real cost when requests are in flight', () => {
  const tui = new TUI({ accountManager: am(), config: {} });
  tui.active = new Map([
    ['1', { sessionKey: 'sA' }],
    ['2', { sessionKey: 'sA' }],
    ['3', { sessionKey: 'sB' }],
  ]);
  const detail = strip(tui._restartConfirmDetail());
  assert.match(detail, /3 requests/, 'names the in-flight count');
  assert.match(detail, /2 sessions/, 'names the session count');
  assert.match(detail, /retry/i, 'warns that new requests retry');
  assert.match(detail, /not lost/, 'reassures that sessions survive');
});

test('the restart confirm says so when nothing is in flight', () => {
  const tui = new TUI({ accountManager: am(), config: {} });
  tui.active = new Map();
  const detail = strip(tui._restartConfirmDetail());
  assert.match(detail, /immediately/, 'an idle restart is instant — say so');
});

test('the drain emits PROGRESS while waiting (not silence)', () => {
  const logs = [];
  let intervalCb = null;
  const rc = new RestartController({
    pauseAdmission: () => {},
    restartNow: () => {},
    log: m => logs.push(m),
    drainTimeoutMs: 10_000,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    setIntervalFn: (cb) => { intervalCb = cb; return 2; },
    clearIntervalFn: () => {},
  });
  rc.requestStarted('r1');
  rc.requestRouted('r1', 'a1');
  rc.requestRestart();
  assert.ok(logs.some(l => /Restart pending/.test(l)), 'the initial line still fires');
  // Tick the progress timer
  intervalCb();
  assert.ok(logs.some(l => /waiting for 1 request/.test(l)),
    `a progress tick must be emitted: ${JSON.stringify(logs)}`);
  assert.ok(logs.some(l => /s left/.test(l)), 'and it counts down');
});

test('an idle restart does NOT emit progress ticks (nothing to wait for)', () => {
  const logs = [];
  const rc = new RestartController({
    pauseAdmission: () => {},
    restartNow: () => {},
    log: m => logs.push(m),
    setIntervalFn: () => { throw new Error('must not arm a progress timer when idle'); },
    clearIntervalFn: () => {},
  });
  rc.requestRestart();   // no in-flight → immediate
  assert.ok(!logs.some(l => /waiting for/.test(l)));
});

// ── drain design: seamless skips the pre-drain; cold path still drains ─────────
// Reported 2026-08-10: "503 Maxpool is restarting — attempt 5/10" across ~30 sessions.
// Root cause: the 10s pre-drain NEVER completed naturally (30-60s requests never
// finish in 10s), so every restart was 10s of guaranteed 503s. But the seamless
// baton path (releaseBatonAndDrain, 60s+) already drains in-flight requests AFTER
// the socket handoff — the pre-drain is redundant with the baton and costs 10s of
// fleet-wide 503s for zero benefit.

test('seamless path skips the pre-drain entirely — no 503 window', () => {
  const logs = [];
  let timer = null;
  const rc = new RestartController({
    pauseAdmission: () => {},
    resumeAdmission: () => {},
    restartNow: () => {},
    log: m => logs.push(m),
    drainTimeoutMs: 10_000,
    setTimeoutFn: (cb) => { timer = cb; return 1; },
    clearTimeoutFn: () => { timer = null; },
    setIntervalFn: () => { throw new Error('progress timer must not arm on seamless skip'); },
    clearIntervalFn: () => {},
    isSeamless: () => true,
  });
  rc.requestStarted('r1');
  rc.requestRouted('r1', 'a1');   // an upstream request IS in flight
  rc.requestRestart();
  // The restart MUST fire immediately — the in-flight request finishes on the
  // old worker post-baton, not via the pre-drain.
  assert.equal(rc.restarting, true, 'seamless restart fires immediately with in-flight requests');
  assert.equal(rc.pending, false, 'never enters the drain/pending state');
  assert.equal(timer, null, 'no drain timer was armed');
  assert.ok(logs.some(l => /in-flight.*finish/i.test(l)),
    `should log that in-flight requests finish on the current version: ${JSON.stringify(logs)}`);
});

test('cold path STILL drains — the pre-drain earns its cost when the socket will close', () => {
  let restarted = false;
  const rc = new RestartController({
    pauseAdmission: () => {},
    resumeAdmission: () => {},
    restartNow: () => { restarted = true; },
    log: () => {},
    drainTimeoutMs: 10_000,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
    setIntervalFn: () => 2,
    clearIntervalFn: () => {},
    isSeamless: () => false,    // cold path
  });
  rc.requestStarted('r1');
  rc.requestRouted('r1', 'a1');
  rc.requestRestart();
  assert.equal(rc.pending, true, 'cold path enters drain');
  assert.equal(restarted, false, 'and waits');
});
