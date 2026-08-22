// Capacity ledger — INTEGRATION. The unit suite (capacity-ledger.test.js) pins the
// data model; this one pins the SEAMS: real requests through a real proxy against a
// real upstream, the real close hooks, the real restore path, and the real TUI page.
//
// The seams are where this feature dies silently. A ledger that is arithmetically
// perfect but accrues twice, accrues a count_tokens echo, or never closes a cycle
// produces confident wrong numbers — which is worse than an empty page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { CapacityLedger } from '../src/capacity-ledger.js';
import { TUI } from '../src/tui.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => s.close(r));

const oauth = (name = 'a1') => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 });

/** SSE body whose message_delta usage is CUMULATIVE — the real Anthropic shape. */
const CUMULATIVE_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"usage":{"input_tokens":500,"output_tokens":0}}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":10}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":40}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","usage":{"output_tokens":120}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

async function withProxy(upstreamHandler, fn, { accounts = [oauth()] } = {}) {
  const upstream = http.createServer(upstreamHandler);
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: false },
  });
  const port = await listen(proxy);
  try {
    await fn({ am, port });
  } finally {
    await close(proxy);
    await close(upstream);
  }
}

// ── Lane C: accrual seams, exercised through a real request ──────────────────

test('C1: a STREAMING request accrues input + the MAX interim output, never their sum', async () => {
  // Anthropic's interim message_delta usage is CUMULATIVE. Summing them (the obvious
  // implementation) reports 500+10+40+120 = 670 for a request that delivered 620 —
  // an error that GROWS with generation length, so the longest and most expensive
  // requests are the most over-counted. This test fails under add-semantics.
  await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(CUMULATIVE_SSE);
  }, async ({ am, port }) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    const open = am.capacity.openCycle('a1', 'ses');
    assert.ok(open, 'the request opened a 5h cycle');
    assert.equal(open.tokensSoFar, 620, 'input 500 + MAX output 120 (not the 170 sum)');
    assert.equal(am.capacity.openCycle('a1', 'wk').tokensSoFar, 620, 'the weekly cycle accrues the same request');
  });
});

test('C2: a NON-STREAMING request accrues its usage exactly once', async () => {
  await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [], usage: { input_tokens: 300, output_tokens: 70 } }));
  }, async ({ am, port }) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    assert.equal(am.capacity.openCycle('a1', 'ses').tokensSoFar, 370, 'accrued once, not twice');
  });
});

test('C3: a count_tokens request accrues NOTHING (a prompt-size echo is not delivered work)', async () => {
  // Claude Code calls count_tokens constantly. Counting it inflates every cycle by
  // whole prompt sizes — the account would look like it delivers far more than it does.
  await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ input_tokens: 90_000, usage: { input_tokens: 90_000, output_tokens: 0 } }));
  }, async ({ am, port }) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'x' }] }),
    });
    await r.text();
    assert.equal(am.capacity.openCycle('a1', 'ses'), null, 'no cycle opened by a count_tokens call');
  });
});

// ── Lane D: cycle boundaries ─────────────────────────────────────────────────

function amWithOauth() {
  const am = new AccountManager([oauth('claude1')], 0.90);
  return am;
}

test('D1: a cycle closes on the CLOCK when its reset stamp passes, without needing a probe', async () => {
  const am = amWithOauth();
  const a = am.accounts[0];
  am.accrueCapacity(0, { input: 1000, output: 200 });
  a.quota.unified5hReset = Date.now() - 1000;   // the 5h window has rolled
  a.quota.unified7dReset = Date.now() + 86400_000; // the weekly has not
  am.closeExpiredCapacityCycles();
  const ses = am.capacity.windowStats('claude1', 'ses');
  assert.equal(ses.last, 1200, 'the completed 5h cycle IS the measured capacity');
  assert.equal(am.capacity.windowStats('claude1', 'wk'), null, 'the still-open weekly cycle is not a measurement yet');
  assert.equal(am.capacity.openCycle('claude1', 'ses'), null, 'the 5h cycle is closed, not left open');
});

test('D2: post-reset tokens land in a NEW cycle, never back-dated into the closed one', async () => {
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 1000, output: 0 });
  am.accounts[0].quota.unified5hReset = Date.now() - 1;
  am.closeExpiredCapacityCycles();
  am.accrueCapacity(0, { input: 7, output: 3 });
  assert.equal(am.capacity.windowStats('claude1', 'ses').last, 1000, 'the closed cycle keeps its own total');
  assert.equal(am.capacity.openCycle('claude1', 'ses').tokensSoFar, 10, 'the new cycle starts from zero');
});

test('D3: a probe observing a FRESHER reset stamp closes the provider cycle (stamp-advance)', () => {
  // The clock-close needs a stamp it already knows. A provider whose old stamp was
  // never learned closes only here — without it the cycle runs forever and the page
  // stays empty on exactly the account the user cares most about.
  const am = new AccountManager([{ name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] }], 0.90);
  const idx = am.accounts.findIndex(a => a.name === 'glm');
  am.applyProviderUsage(idx, { source: 'zai', ses: { utilization: 0.2, resetAt: 1_000_000 } });
  am.accrueCapacity(idx, { input: 400, output: 100 });
  am.applyProviderUsage(idx, { source: 'zai', ses: { utilization: 0.01, resetAt: 2_000_000 } });
  assert.equal(am.capacity.windowStats('glm', 'ses').last, 500, 'the advance closed the cycle at 500 tokens');
  // A re-report of the SAME stamp must not close anything (that would shred one real
  // cycle into one fake cycle per probe tick — every column then reads far too low).
  am.accrueCapacity(idx, { input: 10, output: 0 });
  am.applyProviderUsage(idx, { source: 'zai', ses: { utilization: 0.02, resetAt: 2_000_000 } });
  assert.equal(am.capacity.windowStats('glm', 'ses').cycles, 1, 'an unchanged stamp closes nothing');
});

test('D4: a cycle the account was DISABLED during is shown but excluded from the numbers', () => {
  const am = amWithOauth();
  // Distinct boundary stamps, as in production (5h apart) — a same-instant repeat of
  // ONE stamp is the two-closer race, which folds by design (I3).
  am.accrueCapacity(0, { input: 500, output: 0 });        // cycle 1 — clean
  am.accounts[0].quota.unified5hReset = Date.now() - 5 * 3600_000;
  am.closeExpiredCapacityCycles();
  am.accrueCapacity(0, { input: 20, output: 0 });         // cycle 2 — disabled partway
  am.setAccountEnabled(0, false);
  am.accounts[0].quota.unified5hReset = Date.now() - 1;
  am.closeExpiredCapacityCycles();
  const st = am.capacity.windowStats('claude1', 'ses');
  assert.equal(st.cycles, 1, 'the disabled-during cycle is not a capacity observation');
  assert.equal(st.last, 500, 'and it does not become the headline "last" number');
});

// ── Lane E: persistence across a restart / a reload drain ────────────────────

test('E1: downtime flags the cycle partial; a brief restart or an idle ACCOUNT does not', () => {
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 800, output: 200 });
  const payload = am.capacity.serialize();

  // Seamless reload (state handed over live): downtime null → the cycle keeps
  // qualifying, and an account that has simply been IDLE for hours is not punished
  // (idle ≠ maxpool down — red-team F3).
  const reloaded = amWithOauth();
  reloaded.restoreCapacityState(payload, Date.now() + 3 * 3600_000, null);
  reloaded.accounts[0].quota.unified5hReset = Date.now() - 1;
  reloaded.closeExpiredCapacityCycles();
  assert.equal(reloaded.capacity.windowStats('claude1', 'ses').cycles, 1,
    'a long-idle account with no measured downtime keeps its observation');

  // Cold restart after real downtime: maxpool was not running for part of the
  // cycle, so its total under-reports capacity. Keep it visible, keep it out of the
  // averages.
  const late = amWithOauth();
  late.restoreCapacityState(payload, Date.now(), 3 * 3600_000);
  late.accounts[0].quota.unified5hReset = Date.now() - 1;
  late.closeExpiredCapacityCycles();
  assert.equal(late.capacity.windowStats('claude1', 'ses'), null, 'a cycle maxpool sat out is not a capacity number');
});

test('E2: the drain-exit merge folds post-flush tokens onto the NEW worker state', () => {
  // The released worker keeps streaming for minutes after its final flush, then exits
  // bare. Without the merge, every token it delivered during that drain is discarded.
  const old = amWithOauth();
  old.accrueCapacity(0, { input: 100, output: 0 });
  const atFlush = old.capacity.serialize();

  const fresh = amWithOauth();
  fresh.restoreCapacityState(atFlush);
  fresh.accrueCapacity(0, { input: 5, output: 0 });        // the new worker's own traffic
  const onDisk = fresh.capacity.serialize();

  old.accrueCapacity(0, { input: 60, output: 0 });         // drain-time work, post-flush
  const merged = CapacityLedger.mergeDelta(onDisk, atFlush, old.capacity.serialize());

  const l = CapacityLedger.fromSerialized(merged);
  assert.equal(l.openCycle('claude1', 'ses').tokensSoFar, 165, '100 flushed + 5 new worker + 60 drained');
});

test('E3: a corrupt or future-schema payload degrades to empty, never to a crash', () => {
  const am = amWithOauth();
  am.restoreCapacityState({ schemaVersion: 999, accounts: { claude1: { ses: { open: { tokensSoFar: 5 } } } } });
  assert.deepEqual(am.capacity.accounts(), [], 'an unknown schema is ignored');
  am.restoreCapacityState(null);
  assert.deepEqual(am.capacity.accounts(), []);
  am.accrueCapacity(0, { input: 1, output: 1 });
  assert.ok(am.capacity.openCycle('claude1', 'ses'), 'and the ledger still works afterwards');
});

// ── Lane G: the TUI page the user actually reads ─────────────────────────────

function renderCapacity(am, { window = 'ses', width = 120 } = {}) {
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });
  tui.capacityWindow = window;
  return tui._renderCapacityPage(width).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

test('G1: the page shows a per-account row with the six columns once cycles exist', () => {
  const am = amWithOauth();
  // Three consecutive real windows — distinct boundary stamps, 5h apart.
  let i = 3;
  for (const n of [1000, 2000, 3000]) {
    am.accrueCapacity(0, { input: n, output: 0 });
    am.accounts[0].quota.unified5hReset = Date.now() - (i-- * 5 * 3600_000);
    am.closeExpiredCapacityCycles();
  }
  const page = renderCapacity(am);
  for (const col of ['Last', 'Prev', 'Prev-1', 'Avg 3', 'Avg 10', 'All time']) {
    assert.ok(page.includes(col), `column "${col}" is on the page`);
  }
  assert.match(page, /claude1/, 'the account is listed');
  assert.match(page, /3k/, 'the last cycle reads 3k tokens');
  assert.match(page, /2k/, 'the average of 1k/2k/3k reads 2k');
});

test('G2: a fresh install says WHY the page is empty instead of showing zeros', () => {
  // Zeros would read as "this account delivers nothing", which is the opposite of true.
  const page = renderCapacity(amWithOauth());
  assert.match(page, /No completed cycles yet/);
  assert.match(page, /no completed cycle yet/, 'and each account row says so too');
  assert.doesNotMatch(page, /\b0\s+0\s+0\b/, 'no fake zero row');
});

test('G3: the no-weekly account shows a 7d VOLUME, never an invented weekly capacity', () => {
  // The legacy z.ai plan has no weekly tank. A "weekly capacity" number for it would
  // be a fiction; what it actually moved in 7 days is the honest, useful figure.
  const am = new AccountManager([{ name: 'glm-legacy', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] }], 0.90);
  am.accounts[0].quota.weeklyAbsent = true;
  am.accrueCapacity(0, { input: 900_000, output: 100_000 });
  const page = renderCapacity(am, { window: 'wk' });
  assert.match(page, /no weekly limit · 7d volume 1\.0M/, 'labelled as a volume with the real figure');
  assert.doesNotMatch(page, /All time\s*$/m);
});

test('G4: a partial 7d window is disclosed as a floor, not reported as the truth', () => {
  const am = new AccountManager([{ name: 'glm-legacy', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] }], 0.90);
  am.accounts[0].quota.weeklyAbsent = true;
  am.accrueCapacity(0, { input: 10_000, output: 0 });
  am.capacity.markDayPartial('glm-legacy', new Date().toISOString().slice(0, 10));
  assert.match(renderCapacity(am, { window: 'wk' }), /≤ observed/, 'says the figure is a floor');
});

// ── Lane H: the mutants that survived the first suite (red-team F6, 2026-08-22) ──
// Each test below exists because a specific mutation of the code it covers passed
// 27/27 before it was written. A guard nobody pins is a guard that gets refactored out.

test('H1: the PRODUCTION interleaving closes the cycle — the render tick, not just a probe sweep', () => {
  // This is the exact sequence that shipped broken: refreshExpiredQuotas (TUI render
  // tick, every routed request) NULLS the reset stamp the moment the window rolls, so
  // a clock-close gated on that stamp had a ~500ms window to fire in and effectively
  // never did. Any fix that reverts to closing only on a prober sweep fails here.
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 1_200_000, output: 0 });
  am.accounts[0].quota.unified5h = 0.9;
  am.accounts[0].quota.unified5hReset = Date.now() - 1;
  am.refreshExpiredQuotas();                       // the display/request path, not the prober
  assert.equal(am.accounts[0].quota.unified5hReset, null, 'the stamp is gone, as in production');
  const st = am.capacity.windowStats('claude1', 'ses');
  assert.ok(st, 'the cycle closed at the rollover the display noticed');
  assert.equal(st.last, 1_200_000);
});

test('H2: a probe reporting the SAME or an OLDER stamp closes nothing (guard pinned directly)', () => {
  // Without the inner guard, a clock-skewed or repeated probe shreds one real cycle
  // into many tiny fake ones — every column then reads far below the truth.
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 500, output: 0 });
  am.noteCapacityWindowAdvance('claude1', 'ses', 2_000_000, 2_000_000);
  am.noteCapacityWindowAdvance('claude1', 'ses', 2_000_000, 1_000_000);   // stamp moved BACKWARD
  assert.equal(am.capacity.windowStats('claude1', 'ses'), null, 'neither closed a cycle');
  am.noteCapacityWindowAdvance('claude1', 'ses', 2_000_000, 3_000_000);
  assert.equal(am.capacity.windowStats('claude1', 'ses').cycles, 1, 'only a genuine advance closes');
});

test('H3: a window that ROLLED during the drain does not dump its delta into the new cycle', async () => {
  // The merge is scoped to the SAME cycle by startedAt. Drop that check and a drain
  // spanning a reset credits the old window's tokens to the fresh one — inflating the
  // very next capacity reading by a whole window's traffic.
  const old = amWithOauth();
  old.accrueCapacity(0, { input: 100, output: 0 });
  const atFlush = old.capacity.serialize();

  const fresh = amWithOauth();
  fresh.restoreCapacityState(atFlush);
  fresh.accounts[0].quota.unified5hReset = Date.now() - 1;
  fresh.closeExpiredCapacityCycles();              // the window rolled on the new worker
  await new Promise(r => setTimeout(r, 5));        // the new cycle starts at a distinct ms
  fresh.accrueCapacity(0, { input: 5, output: 0 }); // brand-new cycle
  const onDisk = fresh.capacity.serialize();

  old.accrueCapacity(0, { input: 60, output: 0 }); // drain-time work, OLD cycle
  const merged = CapacityLedger.mergeDelta(onDisk, atFlush, old.capacity.serialize());
  const l = CapacityLedger.fromSerialized(merged);
  assert.equal(l.openCycle('claude1', 'ses').tokensSoFar, 5,
    "the new cycle keeps only its own 5 — the old window's 60 is not back-credited");
});

test('H4: a stream that DIES mid-flight still records the tokens it delivered', async () => {
  // The longest generations are the ones that hit idle/upstream failures. Skipping
  // their accrual under-counts exactly the requests that matter most for capacity.
  await withProxy((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":400,"output_tokens":0}}}\n\n');
    res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":90}}\n\n');
    setTimeout(() => res.socket.destroy(), 30);   // upstream dies mid-stream (after chunks landed)
  }, async ({ am, port }) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    }).catch(() => null);
    if (r) await r.text().catch(() => {});
    if (!am.capacity.openCycle('a1', 'ses')) {
      // A retry may have consumed the ledger — give the async finally a tick.
      await new Promise(res => setTimeout(res, 50));
    }
    const open = am.capacity.openCycle('a1', 'ses');
    assert.ok(open, 'a died stream still opened/accrued a cycle');
    assert.equal(open.tokensSoFar, 490, 'the 400 in + 90 delivered out are real capacity');
  });
});

test('H5: an operator-DISABLED cycle is excluded on its own axis, not by borrowing "partial"', () => {
  // Collapsing the two flags made disabledDuring query-redundant and untested.
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 700, output: 0 });
  am.setAccountEnabled(0, false);
  const open = am.capacity.openCycle('claude1', 'ses');
  assert.equal(open.disabledDuring, true);
  assert.equal(open.complete, true, 'maxpool was up throughout — only the disable excludes it');
  am.accounts[0].quota.unified5hReset = Date.now() - 1;
  am.closeExpiredCapacityCycles();
  assert.equal(am.capacity.windowStats('claude1', 'ses'), null, 'and it is excluded');
});

// ── Lane I: round-2 red-team pins (2026-08-22) ────────────────────────────────

test('I1: the WEEKLY rollover closes through the display path too (the H1 twin — the whole 7,784-test suite once passed with that line deleted)', () => {
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 2_000_000, output: 0 });
  am.accounts[0].quota.unified7d = 0.95;
  am.accounts[0].quota.unified7dReset = Date.now() - 1;
  am.refreshExpiredQuotas();
  const st = am.capacity.windowStats('claude1', 'wk');
  assert.ok(st, 'the weekly cycle closed at the rollover the display noticed');
  assert.equal(st.last, 2_000_000);
});

test('I2: a boundary crossing fires the rollover EXACTLY ONCE regardless of which closer notices it (probe sweep, then display tick, then another sweep)', () => {
  // Round-2 F1: the clock-close left the stamp alive, so a second closer re-fired on
  // the same rollover and a straddling request was lazily re-opened into a tiny
  // second "complete" cycle that poisoned the averages.
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 1_500_000, output: 0 });
  am.accounts[0].quota.unified5h = 0.9;
  am.accounts[0].quota.unified5hReset = Date.now() - 1;
  am.closeExpiredCapacityCycles();          // closer #1: the prober sweep
  am.accrueCapacity(0, { input: 3_000, output: 0 });   // a request straddling the boundary
  am.refreshExpiredQuotas();                // closer #2: the TUI tick
  am.closeExpiredCapacityCycles();          // closer #3: another sweep
  const st = am.capacity.windowStats('claude1', 'ses');
  assert.equal(st.cycles, 1, 'one real cycle, never a tiny fabricated second one');
  // The straddling tail folds into the boundary's single cycle. Attributing 3k to the
  // window that just closed is a 0.2% attribution error; the alternative the fold
  // exists to prevent is a 3k "complete cycle" sitting in avg3/avg10 forever, which
  // dragged the average from 2.0M to 1.0M in the round-2 repro.
  assert.equal(st.last, 1_503_000, 'the tail folded into the boundary cycle');
  assert.equal(st.avg3, 1_503_000, 'and the averages see one honest observation');
});

test('I3: two closers on the SAME reset boundary produce ONE cycle, never a tiny second one', () => {
  // Structural backstop for the I2 race: even if a closer regression re-fires on a
  // boundary already closed, its straddling tail folds into that same cycle instead of
  // entering the averages as a fabricated near-empty observation.
  const l = new CapacityLedger({ now: () => Date.now() });
  const boundary = Date.now();
  l.accrue('x', { input: 1_500_000, output: 0 });
  l.closeCycle('x', 'ses', boundary, { resetAt: boundary });
  l.accrue('x', { input: 3_000, output: 0 });                  // straddling tail
  l.closeCycle('x', 'ses', boundary, { resetAt: boundary });   // the regressed second closer
  const st = l.windowStats('x', 'ses');
  assert.equal(st.cycles, 1, 'one boundary, one cycle');
  assert.equal(st.last, 1_503_000, 'the tail folded in rather than becoming a fake cycle');
  assert.equal(st.avg3, 1_503_000, 'and the averages are not dragged down by a phantom');
});

// ── Lane J: round-3 mutant pins (M2/M4/M5 survived the entire 811-test suite) ──

test('J1 (M2): a same-resetAt close at a DIFFERENT endedAt is a DISTINCT cycle', () => {
  // The fold guard keys on BOTH resetAt and endedAt. Drop the endedAt key and any
  // clock-coincident window whose reset stamp repeats is silently folded away —
  // a real observation deleted.
  const l = new CapacityLedger({ now: () => Date.now() });
  const boundary = Date.now();
  l.accrue('x', { input: 1000, output: 0 });
  l.closeCycle('x', 'ses', boundary, { resetAt: boundary });
  l.accrue('x', { input: 700, output: 0 });
  l.closeCycle('x', 'ses', boundary + 5 * 3600_000, { resetAt: boundary }); // same stamp value, later boundary
  const st = l.windowStats('x', 'ses');
  assert.equal(st.cycles, 2, 'two boundaries, two cycles');
  assert.equal(st.last, 700);
  assert.equal(st.prev, 1000);
});

test('J2 (M4): at W=80 the page drops trailing columns instead of truncating mid-number', () => {
  // fitLine silently chops what does not fit — at W=80 the full row is 82+ chars and
  // every row lost "All time" and the cycle count with no indication. The COLS loop
  // exists to drop COLUMNS; a test that never checks a narrow width cannot see it.
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 1_000_000, output: 0 });
  am.accounts[0].quota.unified5hReset = Date.now() - 5 * 3600_000;
  am.closeExpiredCapacityCycles();
  const wide = renderCapacity(am, { width: 200 });
  assert.ok(wide.includes('All time'), 'full width shows every column');
  const narrow = renderCapacity(am, { width: 80 });
  assert.ok(narrow.includes('Last'), 'the observations survive at W=80');
  assert.ok(!narrow.includes('All time'), 'and the dropped aggregates do not render truncated');
  // Assert on the HEADER line itself (found by index, never a hard-coded offset — the
  // previous version read the blank spacer at [2] and passed unconditionally).
  const header = narrow.split('\n').find(l => l.includes('Account') && l.includes('Last'));
  assert.ok(header, 'the header renders');
  assert.ok(!/All ti?m?e?\s*$/.test(header), 'no half-rendered header cell at the right edge');
  assert.ok(header.length <= 80, 'the header fits the terminal');
});

test('J3 (M5): mergeDelta never FABRICATES a cycle onto a missing/corrupt base', () => {
  // The drain merge AMENDS an existing open cycle; with no base there is nothing to
  // amend, and inventing one would write a cycle with no start context into the new
  // worker's history. The caller's null-disk bail (index.js) is what preserves the
  // delta's loss loudly; the primitive's job is to never fabricate.
  const old = amWithOauth();
  old.accrueCapacity(0, { input: 100, output: 0 });
  const atFlush = old.capacity.serialize();
  old.accrueCapacity(0, { input: 40, output: 0 });
  const merged = CapacityLedger.mergeDelta(null, atFlush, old.capacity.serialize());
  const l = CapacityLedger.fromSerialized(merged);
  assert.equal(l.openCycle('claude1', 'ses'), null, 'no cycle invented from thin air');
  assert.equal(l.windowStats('claude1', 'ses'), null, 'and no closed history invented');
});

test('J4: every row starts its columns at the SAME position, whatever the name length', () => {
  // The real page against real accounts exposed a pre-existing helper bug: truncate()
  // always appended RESET (4 raw chars), so `.padEnd()` — which counts raw length —
  // produced a 4-column-narrow name field for every name SHORTER than the width, and
  // each row's numbers landed in a different place. Unreadable, and invisible to any
  // test that used a single account name.
  const am = new AccountManager([
    { name: 'ab', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'a-very-long-account-name', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
  ], 0.90);
  for (const a of am.accounts) {
    am.accrueCapacity(a.index, { input: 1_000_000, output: 0 });
    a.quota.unified5h = 0.9;
    a.quota.unified5hReset = Date.now() - 5 * 3600_000;
  }
  am.refreshExpiredQuotas();
  const lines = renderCapacity(am).split('\n').filter(l => / 1\.0M/.test(l));
  assert.equal(lines.length, 2, 'both accounts rendered a number');
  assert.equal(lines[0].indexOf('1.0M'), lines[1].indexOf('1.0M'), 'the columns line up across rows');
});

test('J5: the fold NEVER absorbs a partial or disabled tail over a complete observation', () => {
  // Round-4 finding 1: deleting `&& open.complete && !open.disabledDuring` from the
  // fold condition — a full revert of the RT3-2 fix — survived the entire 814-test
  // suite. Without it, a partial tail's flags overwrite the prior legitimate cycle and
  // erase it from every column.
  for (const taint of ['partial', 'disabled']) {
    const l = new CapacityLedger({ now: () => Date.now() });
    const boundary = Date.now();
    l.accrue('x', { input: 1_000_000, output: 0 });
    l.closeCycle('x', 'ses', boundary, { resetAt: boundary });
    l.accrue('x', { input: 900, output: 0 });                       // the tail
    l.markPartial('x', { disabled: taint === 'disabled' });
    l.closeCycle('x', 'ses', boundary, { resetAt: boundary });      // same boundary
    const st = l.windowStats('x', 'ses');
    assert.ok(st, `${taint}: the prior complete observation survives`);
    assert.equal(st.cycles, 1, `${taint}: the tainted tail is excluded, not merged`);
    assert.equal(st.last, 1_000_000, `${taint}: and its tokens never contaminate the real cycle`);
    assert.equal(st.avg3, 1_000_000, `${taint}: the averages are untouched`);
  }
});
