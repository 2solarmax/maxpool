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

// Most fixtures here close cycles at synthetic sub-second spans to test CLOSE LOGIC,
// not span validity — the production read floor would reject them as junk. Zero it in
// the harness; the R-lane tests in capacity-ledger.test.js pin the floor itself.
const AM = class extends AccountManager {
  constructor(accounts, th) {
    super(accounts, th);
    this.capacity._readFloorOverride = { ses: 0, wk: 0 };
  }
};

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
  const am = new AM(accounts, 0.90);
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
  const am = new AM([oauth('claude1')], 0.90);
  return am;
}

test('D1: a cycle closes on the CLOCK when its reset stamp passes, without needing a probe', async () => {
  const am = amWithOauth();
  const a = am.accounts[0];
  const b1 = Date.now() - 1000;
  am.capacity.accrue('claude1', { input: 1000, output: 200 }, b1 - 5 * 3600_000);
  a.quota.unified5hReset = b1;   // the 5h window has rolled
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
  const am = new AM([{ name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] }], 0.90);
  const idx = am.accounts.findIndex(a => a.name === 'glm');
  const base = Date.now() - 5 * 3600_000;   // the old window has genuinely been running
  am.applyProviderUsage(idx, { source: 'zai', ses: { utilization: 0.2, resetAt: base } });
  am.accrueCapacity(idx, { input: 400, output: 100 });
  am.applyProviderUsage(idx, { source: 'zai', ses: { utilization: 0.01, resetAt: Date.now() + 5 * 3600_000 } });
  assert.equal(am.capacity.windowStats('glm', 'ses').last, 500, 'the advance closed the cycle at 500 tokens');
  // A re-report of the SAME stamp must not close anything (that would shred one real
  // cycle into one fake cycle per probe tick — every column then reads far too low).
  am.accrueCapacity(idx, { input: 10, output: 0 });
  am.applyProviderUsage(idx, { source: 'zai', ses: { utilization: 0.02, resetAt: base + 10 * 3600_000 } });
  assert.equal(am.capacity.windowStats('glm', 'ses').cycles, 1, 'an unchanged stamp closes nothing');
});

test('D4: a cycle the account was DISABLED during is shown but excluded from the numbers', () => {
  const am = amWithOauth();
  // Distinct boundary stamps, as in production (5h apart) — a same-instant repeat of
  // ONE stamp is the two-closer race, which folds by design (I3).
  const b1 = Date.now() - 5 * 3600_000, b2 = Date.now() - 1;
  am.capacity.accrue('claude1', { input: 500, output: 0 }, b1 - 5 * 3600_000);  // cycle 1 — clean
  am.accounts[0].quota.unified5hReset = b1;
  am.closeExpiredCapacityCycles();
  am.capacity.accrue('claude1', { input: 20, output: 0 }, b2 - 5 * 3600_000);   // cycle 2 — disabled partway
  am.setAccountEnabled(0, false);
  am.accounts[0].quota.unified5hReset = b2;
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
    const b = Date.now() - (i * 5 * 3600_000);
    am.capacity.accrue('claude1', { input: n, output: 0 }, b - 5 * 3600_000);
    am.accounts[0].quota.unified5hReset = b;
    am.closeExpiredCapacityCycles();
    i--;
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
  const am = new AM([{ name: 'glm-legacy', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] }], 0.90);
  am.accounts[0].quota.weeklyAbsent = true;
  am.accrueCapacity(0, { input: 900_000, output: 100_000 });
  const page = renderCapacity(am, { window: 'wk' });
  assert.match(page, /no weekly limit · 7d volume 1\.0M/, 'labelled as a volume with the real figure');
  assert.doesNotMatch(page, /All time\s*$/m);
});

test('G4: a partial 7d window is disclosed as a floor, not reported as the truth', () => {
  const am = new AM([{ name: 'glm-legacy', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] }], 0.90);
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
  const b = Date.now() - 5 * 3600_000;    // an old window that has been running
  am.noteCapacityWindowAdvance('claude1', 'ses', b, b);
  am.noteCapacityWindowAdvance('claude1', 'ses', b, b - 60_000);         // stamp moved BACKWARD
  assert.equal(am.capacity.windowStats('claude1', 'ses'), null, 'neither closed a cycle');
  am.noteCapacityWindowAdvance('claude1', 'ses', b, b + 5 * 3600_000);   // genuine advance
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
  l.accrue('x', { input: 1_500_000, output: 0 }, boundary - 5 * 3600_000);
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
  l.accrue('x', { input: 1000, output: 0 }, boundary - 5 * 3600_000);
  l.closeCycle('x', 'ses', boundary, { resetAt: boundary });
  l.accrue('x', { input: 700, output: 0 }, boundary);
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
  const am = new AM([
    { name: 'ab', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'a-very-long-account-name', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
  ], 0.90);
  const bj = Date.now() - 5 * 3600_000;
  for (const a of am.accounts) {
    am.capacity.accrue(a.name, { input: 1_000_000, output: 0 }, bj - 5 * 3600_000);
    a.quota.unified5h = 0.9;
    a.quota.unified5hReset = bj;
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
    l.accrue('x', { input: 1_000_000, output: 0 }, boundary - 5 * 3600_000);
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

// ── Lane K: the live-data defect (2026-08-23, 12h after v1.8.0 shipped) ──────
// Every test here was written from REAL poisoned state.json rows. The whole suite
// (41 tests, 4 red-team rounds) was green while production data was wrong, because
// every fixture used clean synthetic stamps. Real OAuth stamps jitter.

test('K1: reset-stamp JITTER is not a window advance; a real window advance is', () => {
  // parseResetHeader derives an OAuth stamp as Date.now() + delay*1000, so the same
  // boundary reads later on every response. Live: mk@dubner.io recorded 9 "cycles"
  // between 01:00 and 06:00 — one real window — the shortest 0.2 minutes long.
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 500_000, output: 0 });
  const boundary = Date.now() - 5 * 3600_000;      // the window has been running 5h
  for (const jitterMs of [180, 940, 1_500, 2_000]) {
    am.noteCapacityWindowAdvance('claude1', 'ses', boundary, boundary + jitterMs);
  }
  assert.equal(am.capacity.windowStats('claude1', 'ses'), null,
    'four jitters closed nothing — they are all the same boundary');
  assert.equal(am.capacity.openCycle('claude1', 'ses').tokensSoFar, 500_000,
    'and the real cycle keeps accumulating');

  am.noteCapacityWindowAdvance('claude1', 'ses', boundary, Date.now() + 5 * 3600_000);
  const st = am.capacity.windowStats('claude1', 'ses');
  assert.equal(st.cycles, 1, 'a genuine 5h advance closes exactly one cycle');
  assert.equal(st.last, 500_000, 'carrying the whole window, not a sliver');
});

test('K2: a WEEKLY jitter never records a cycle dated in the future', () => {
  // Live: max@dubner.io held 9 "weekly" cycles whose endedAt was 2026-08-28/30 —
  // days ahead of the clock. A cycle that has not ended cannot be a measurement.
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 300_000, output: 0 });
  const weekly = Date.now() + 7 * 86400_000;
  am.noteCapacityWindowAdvance('claude1', 'wk', weekly, weekly + 490);
  assert.equal(am.capacity.windowStats('claude1', 'wk'), null, 'no future-dated weekly cycle');
  const closed = am.capacity.serialize().accounts.claude1.wk.closed;
  assert.equal(closed.length, 0, 'nothing was written at all');
});

test('K3: two closers straddling ONE boundary second produce one cycle, not a sliver', () => {
  // The exact-stamp fold missed this: the clock-close used the stamp, the advance-close
  // used a stamp 0.5s later, so the boundary sliver was admitted as its own "complete"
  // cycle — the 2228-token / 0.2-minute row in the live data.
  const l = new CapacityLedger({ now: () => Date.now() });
  const b = Date.now();
  l.accrue('x', { input: 260_000, output: 0 }, b - 5 * 3600_000);
  l.closeCycle('x', 'ses', b, { resetAt: b });
  l.accrue('x', { input: 2_228, output: 0 });
  l.closeCycle('x', 'ses', b + 490, { resetAt: b + 490 });
  const st = l.windowStats('x', 'ses');
  assert.equal(st.cycles, 1, 'one boundary, one cycle');
  assert.equal(st.last, 262_228, 'the sliver folded into the window it belongs to');
});

test('K4: two boundaries a real window apart stay TWO cycles (the guard must not over-fold)', () => {
  const l = new CapacityLedger({ now: () => Date.now() });
  const b = Date.now();
  l.accrue('x', { input: 100, output: 0 }, b - 5 * 3600_000);
  l.closeCycle('x', 'ses', b, { resetAt: b });
  l.accrue('x', { input: 700, output: 0 });
  l.closeCycle('x', 'ses', b + 5 * 3600_000, { resetAt: b + 5 * 3600_000 });
  const st = l.windowStats('x', 'ses');
  assert.equal(st.cycles, 2, 'a real second window is its own observation');
  assert.deepEqual([st.prev, st.last], [100, 700]);
});

test('K5: a v1 payload is DROPPED — poisoned history never reaches the averages', () => {
  // The shipped v1 data holds slivers and future-dated cycles. Restoring it would put
  // wrong numbers in every column for weeks; one empty window is the cheaper error.
  const poisoned = { schemaVersion: 1, accounts: { claude1: { ses: { open: null,
    closed: [{ startedAt: 1, endedAt: 2, tokens: 2228, complete: true, disabledDuring: false, resetAt: 2 }] },
    wk: { open: null, closed: [] }, days: {} } } };
  const l = CapacityLedger.fromSerialized(poisoned);
  assert.deepEqual(l.accounts(), [], 'v1 history is not carried forward');
  const am = amWithOauth();
  am.restoreCapacityState(poisoned);
  assert.equal(am.capacity.windowStats('claude1', 'ses'), null, 'and nothing reaches the page');
});

// ── Lane L: the SECOND live defect (2026-08-23, found by the post-fix live walk) ──

test('L1: an ALREADY-EXPIRED stamp from a late probe closes at NOW, never a sliver', () => {
  // Live: the GLM account's probe delivered a resetAt that was already in the past
  // when applied; the clock-close then honored the stale stamp and recorded a
  // 14.6-minute "complete cycle" of 21k tokens. A cycle that short is never real.
  const am = new AM([{ name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] }], 0.90);
  const idx = 0;
  const startedAgo = 5 * 3600_000;
  // Simulate: a real 5h-old open cycle, a probe stamp that expired 30s ago.
  // A real 5h-old open cycle (startedAt back-dated) + a probe stamp that expired 30s ago.
  am.capacity.accrue('glm', { input: 15_000, output: 6_000 }, Date.now() - startedAgo);
  am.noteCapacityWindowAdvance('glm', 'ses', Date.now() - startedAgo, Date.now() - 30_000);
  const st = am.capacity.windowStats('glm', 'ses');
  assert.ok(st, 'the cycle closed — the window really did roll');
  assert.equal(st.last, 21_000, 'carrying the whole cycle');
  const closed = am.capacity.serialize().accounts.glm.ses.closed;
  const durMin = (closed[0].endedAt - closed[0].startedAt) / 60_000;
  assert.ok(durMin > 4 * 60, `closed at NOW (real elapsed ~5h), not the stale stamp (got ${durMin.toFixed(1)} min)`);
  // Load-bearing: never future, never before start, and never more than a probe
  // interval stale (the raw-stamp mutant closed a 14.6-min cycle at the stale stamp —
  // the same shape, 30s here, must stay bounded).
  assert.ok(closed[0].endedAt <= Date.now(), 'never future');
  assert.ok(closed[0].endedAt >= closed[0].startedAt, 'never before start');
  assert.ok(Date.now() - closed[0].endedAt < 60_000, `at most a probe-interval stale (${((Date.now() - closed[0].endedAt)/1000).toFixed(1)}s)`);
});

test('L2: an expired-stamp advance within the epsilon window of the previous boundary is jitter, closes nothing', () => {
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 1_000, output: 0 });
  const boundary = Date.now() - 1_000;                 // just rolled
  am.noteCapacityWindowAdvance('claude1', 'ses', boundary, Date.now() - 500);
  assert.equal(am.capacity.windowStats('claude1', 'ses'), null,
    'a 500ms "advance" on a just-rolled boundary is the same boundary');
  assert.equal(am.capacity.openCycle('claude1', 'ses').tokensSoFar, 1_000, 'the cycle keeps accumulating');
});

test('L3: the FIRST cycle after a history-dropping restore is partial, not capacity', () => {
  // Live 2026-08-23: the v1.8.1 migration dropped the poisoned v1 history mid-window,
  // so the next close recorded 21,192 tokens as a "5h window" it had observed for 14.6
  // minutes — and with exactly one cycle on the books, that sliver was every column.
  const am = amWithOauth();
  am.restoreCapacityState({ schemaVersion: 1, accounts: {} });   // unusable payload → dropped
  am.accrueCapacity(0, { input: 21_000, output: 192 });
  am.accounts[0].quota.unified5hReset = Date.now() - 1;
  am.closeExpiredCapacityCycles();

  assert.equal(am.capacity.windowStats('claude1', 'ses'), null,
    'the joined-mid-window cycle is not an observation');
  const closed = am.capacity.serialize().accounts.claude1.ses.closed;
  assert.equal(closed.length, 1, 'but it is still recorded and visible');
  assert.equal(closed[0].complete, false);
  assert.equal(closed[0].partialReason, 'joined-mid-window', 'and it says WHY');

  // The SECOND cycle starts at a boundary we now know → a true observation.
  am.accrueCapacity(0, { input: 1_000_000, output: 0 });
  am.accounts[0].quota.unified5hReset = Date.now() + 5 * 3600_000;   // next real boundary
  am.accounts[0].quota.unified5h = 0.9;
  am.accounts[0].quota.unified5hReset = Date.now() - 1 + 5 * 3600_000;
  am.capacity.closeCycle('claude1', 'ses', Date.now() + 5 * 3600_000, { resetAt: Date.now() + 5 * 3600_000 });
  const st = am.capacity.windowStats('claude1', 'ses');
  assert.equal(st.cycles, 1, 'only the fully-observed cycle counts');
  assert.equal(st.last, 1_000_000);
});

test('L4: a NORMAL restore keeps counting — the mid-window flag is not contagious', () => {
  // The flag must fire ONLY when history was dropped. A healthy restart continues the
  // account's real history and its next cycle is a true observation.
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 500_000, output: 0 });
  const payload = am.capacity.serialize();

  const fresh = amWithOauth();
  fresh.restoreCapacityState(payload);                       // valid v2 payload
  fresh.accrueCapacity(0, { input: 100_000, output: 0 });
  fresh.accounts[0].quota.unified5hReset = Date.now() - 1;
  fresh.closeExpiredCapacityCycles();
  const st = fresh.windowStatsFor?.('claude1', 'ses') ?? fresh.capacity.windowStats('claude1', 'ses');
  assert.ok(st, 'a normal restore still produces real observations');
  assert.equal(st.last, 600_000, 'carrying the restored open cycle plus the new traffic');
});

test('L5: the v2→v3 migration KEEPS history and demotes it, rather than dropping it again', () => {
  // v1→v2 dropped history because it was arithmetically poisoned. v2's rows are not
  // poisoned, only UNVERIFIABLE: every one predates the joined-mid-window fix, so each
  // is a tail-only observation labelled complete (live: 14.6/64.3/64.4/74.4 min for 5h
  // windows — all four rows the ledger held). Dropping a second time would train the
  // reader that history evaporates on upgrade; demoting keeps it visible and honest.
  const v2 = { schemaVersion: 2, accounts: { a: {
    ses: { open: { startedAt: Date.now() - 600_000, tokensSoFar: 99, lastAccrualAt: Date.now(), complete: true, disabledDuring: false },
           closed: [{ startedAt: Date.now() - 876_000, endedAt: Date.now(), tokens: 21_192, complete: true, disabledDuring: false, resetAt: Date.now() }] },
    wk: { open: null, closed: [] }, days: { '2026-08-23': { tokens: 21_192, partial: false } } } } };

  const l = CapacityLedger.fromSerialized(v2);
  assert.equal(l.serialize().schemaVersion, 3);
  const closed = l.serialize().accounts.a.ses.closed;
  assert.equal(closed.length, 1, 'the row is KEPT (not dropped like v1)');
  assert.equal(closed[0].complete, false, 'but demoted');
  assert.equal(closed[0].partialReason, 'pre-v3-unverified', 'with a reason the monitor recognizes');
  assert.equal(l.windowStats('a', 'ses'), null, 'so it never reaches an average');
  assert.equal(l.openCycle('a', 'ses').tokensSoFar, 99, 'the in-flight cycle carries on');
  assert.equal(l.rollingThroughput('a', 7).tokens, 21_192, 'day buckets are real traffic — untouched');
});

test('L6: the advance-close NEVER dates a cycle in the future', () => {
  // Live 2026-08-23 15:02Z: a probe reported the NEW window's resetAt (19:54, ~5h out)
  // as evidence the OLD window rolled; the close wrote it as endedAt and the checker
  // caught a cycle "ending" 4.9h in the future. endedAt must be ≤ now, always.
  const am = new AM([{ name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] }], 0.90);
  am.capacity.accrue('glm', { input: 3_000, output: 658 }, Date.now() - 3 * 60_000);
  const prevBoundary = Date.now() - 60_000;                 // the window that just rolled
  am.noteCapacityWindowAdvance('glm', 'ses', prevBoundary, Date.now() + 5 * 3600_000);
  const closed = am.capacity.serialize().accounts.glm.ses.closed;
  assert.equal(closed.length, 1, 'the advance closed the old cycle');
  assert.ok(closed[0].endedAt <= Date.now() + 1_000, `endedAt is NOW, not the future stamp (${new Date(closed[0].endedAt).toISOString()})`);
  assert.ok(closed[0].endedAt >= closed[0].startedAt, 'and not before it started either');
});

test('L7: a FUTURE-dated row is repaired at EVERY schema version, not just on migration', () => {
  // The v1.8.4 advance-close could write endedAt hours ahead (live: 19:54 at 15:02).
  // The v1.8.5 fix prevents NEW ones; the migration must also repair the stored one,
  // or the checker re-alerts on it every 15 minutes until evicted (~50 cycles).
  const v2 = { schemaVersion: 2, accounts: { a: {
    ses: { open: null, closed: [{ startedAt: Date.now() - 5 * 3600_000, endedAt: Date.now() + 4.9 * 3600_000,
      tokens: 3_658, complete: true, disabledDuring: false, resetAt: Date.now() }] },
    wk: { open: null, closed: [] }, days: {} } } };
  for (const version of [2, 3]) {
    // v3 is the case that shipped broken: the repair lived inside the v2->v3 branch,
    // so a future-dated row written BY v3 (the live glm1 row) was never touched and
    // re-alerted every 15 minutes.
    const payload = JSON.parse(JSON.stringify(v2));
    payload.schemaVersion = version;
    const row = CapacityLedger.fromSerialized(payload).serialize().accounts.a.ses.closed[0];
    assert.ok(row, `v${version}: the row survives`);
    assert.equal(row.complete, false, `v${version}: demoted`);
    assert.ok(row.endedAt <= Date.now(), `v${version}: future date clamped (${new Date(row.endedAt).toISOString()})`);
    assert.ok(row.endedAt >= row.startedAt, `v${version}: not before start`);
  }
});

test('M2: the page shows the LIVE ESTIMATE where no cycle has completed (real TUI)', () => {
  // The user's point: the page is empty for a full window per account, but the
  // vendor's fullness reading makes capacity knowable NOW. Rendered through the real
  // TUI class, with a caveat when the reading is not provably same-window.
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 576_708, output: 0 });
  am.accounts[0].quota.unified5h = 0.95;               // the probe path sets this
  am.capacity.noteUtilizationObserved();               // reading arrived after the cycle began
  const tui = new TUI({ accountManager: am, config: {} });
  tui.capacityWindow = 'ses';
  const page = tui._renderCapacityPage(140).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(page, /[≥~]\s*607k est from 95% full/, 'the estimate renders (576,708 ÷ 0.95 ≈ 607k; ≥ when the join is unproven)');
  assert.match(page, /95% full/, 'naming the fullness it came from');
  assert.match(page, /measured after this window completes/, 'and what replaces it');
  assert.doesNotMatch(page, /may be from the previous window/, 'fresh reading → no stale caveat');
});

test('M3: a stale utilization reading carries the caveat, never silent trust', () => {
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 50_000, output: 0 });
  am.accounts[0].quota.unified5h = 0.10;
  // NOTE: no noteUtilizationObserved — the reading predates the cycle
  const tui = new TUI({ accountManager: am, config: {} });
  tui.capacityWindow = 'ses';
  const page = tui._renderCapacityPage(140).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(page, /may be from the previous window/, 'the caveat is on the page');
});

test('M4: a measured cycle still beats the estimate — the estimate never overwrites data', () => {
  const am = amWithOauth();
  const bm = Date.now() - 5 * 3600_000;
  am.capacity.accrue('claude1', { input: 800_000, output: 0 }, bm - 5 * 3600_000);
  am.accounts[0].quota.unified5h = 0.9;
  am.accounts[0].quota.unified5hReset = bm;
  am.refreshExpiredQuotas();                            // closes the real cycle
  am.accounts[0].quota.unified5h = 0.5;
  am.capacity.noteUtilizationObserved();
  am.accrueCapacity(0, { input: 100_000, output: 0 });
  const tui = new TUI({ accountManager: am, config: {} });
  tui.capacityWindow = 'ses';
  const page = tui._renderCapacityPage(140).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(page, /claude1\s+Anthropic\s+800k/, 'the measured column renders');
  assert.doesNotMatch(page, /~\s*200k/, 'no estimate row where data exists');
});

test('M6: a mid-window join renders ≥ (lower bound), the delta renders without it', () => {
  const am = amWithOauth();
  // late join, absolute fallback
  am.accrueCapacity(0, { input: 400_000, output: 0 });
  am.capacity.openCycle('claude1', 'ses').windowStartedAt = Date.now() - 3 * 3600_000;
  am.accounts[0].quota.unified5h = 0.4;
  am.capacity.noteUtilizationObserved(Date.now(), [{ name: 'claude1', window: 'ses', utilization: 0.4 }]);
  let tui = new TUI({ accountManager: am, config: {} });
  tui.capacityWindow = 'ses';
  let page = tui._renderCapacityPage(150).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(page, /≥\s*1\.0M/, 'the absolute-on-late-join renders as a lower bound');
  assert.doesNotMatch(page, /Δ 40% full/, 'not claimed as delta');

  // then a rising reading makes it a delta — no ≥ anymore
  am.accrueCapacity(0, { input: 200_000, output: 0 });
  am.accounts[0].quota.unified5h = 0.6;
  am.capacity.noteUtilizationObserved(Date.now(), [{ name: 'claude1', window: 'ses', utilization: 0.6 }]);
  tui = new TUI({ accountManager: am, config: {} });
  tui.capacityWindow = 'ses';
  page = tui._renderCapacityPage(150).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(page, /~\s*1\.0M/, 'delta: 200k observed between marks ÷ 0.2 = 1.0M');
  assert.match(page, /Δ 60% full/, 'labelled as delta');
  assert.doesNotMatch(page, /≥\s*3\.0M/, 'no lower-bound sign on a delta');
});
