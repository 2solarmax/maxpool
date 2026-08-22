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
  am.accrueCapacity(0, { input: 500, output: 0 });        // cycle 1 — clean
  am.accounts[0].quota.unified5hReset = Date.now() - 1;
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

test('E1: a restart mid-cycle keeps the open cycle; a long DOWNTIME flags it partial', () => {
  const am = amWithOauth();
  am.accrueCapacity(0, { input: 800, output: 200 });
  const payload = am.capacity.serialize();

  // Restart seconds later — the cycle continues and stays a real observation.
  const quick = amWithOauth();
  quick.restoreCapacityState(payload, Date.now());
  assert.equal(quick.capacity.openCycle('claude1', 'ses').tokensSoFar, 1000, 'the open cycle survived the restart');
  quick.accounts[0].quota.unified5hReset = Date.now() - 1;
  quick.closeExpiredCapacityCycles();
  assert.equal(quick.capacity.windowStats('claude1', 'ses').cycles, 1, 'a brief restart does not disqualify the cycle');

  // Restart HOURS later — maxpool was not running for part of the cycle, so its
  // total under-reports capacity. Keep it visible, keep it out of the averages.
  const late = amWithOauth();
  late.restoreCapacityState(payload, Date.now() + 3 * 3600_000);
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
  for (const n of [1000, 2000, 3000]) {
    am.accrueCapacity(0, { input: n, output: 0 });
    am.accounts[0].quota.unified5hReset = Date.now() - 1;
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
