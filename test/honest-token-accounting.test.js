// Honest token accounting (2026-11-17, audit finding 3): "Usage by person" and the CLI
// per-account "Total" used to book only message_start input_tokens + output — a
// 908k-token cache-write MISS booked 2 tokens, and GLM input (counters ride
// message_delta) never landed. These figures book FULL prompt tokens
// (input + cache_read + cache_creation, running max across message_start/message_delta
// — the same semantics noteCapacityUsage uses), including GLM, plus a separate "paid"
// figure (cache write + uncached input) so the interesting part is visible on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const acct = (n, type = 'oauth', extra = {}) => ({ name: n, type, accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, ...extra });
const caller = 'max';

test('a caller turn books input + cache_read + cache_creation as prompt tokens, and paid = write + uncached', () => {
  const m = new AccountManager([acct('c1')], 0.9);
  m.noteCallerPrompt(caller, { input: 2, cacheRead: 900_000, cacheCreation: 8_000, output: 500 });
  const cw = m.callerWindowStats().get(caller);
  assert.equal(cw.d7.tok, 908_502, 'the ~7d tok figure counts full prompt + output');
  assert.equal(cw.d7.paid, 8_002, 'paid rides the daily buckets');
  assert.equal(cw.total.tok, 908_502);
  assert.equal(cw.total.paid, 8_002);
});

test('GLM input (counters arrive on message_delta) reaches the caller figure', () => {
  const m = new AccountManager([{ ...acct('z1', 'provider'), provider: 'zai' }], 0.9);
  m.noteCallerPrompt(caller, { input: 40, cacheRead: 96_000, cacheCreation: 0, output: 700 });
  const cw = m.callerWindowStats().get(caller);
  assert.equal(cw.d7.tok, 96_740, 'provider-native tokens, no message_start-only hole');
});

test('a rerouted request accrues its caller tokens ONCE (per-request max, not per hop)', () => {
  const m = new AccountManager([acct('c1')], 0.9);
  const acc = () => {
    const a = m.accounts[0];
    a.inFlight++;
    return { account: a, weight: 1, startedAt: Date.now() - 50, requestInfo: {} };
  };
  // The live shape: capacity figures were running-maxed onto the request across
  // message_start/message_delta and across hops; the terminal release books ONCE.
  const ri = { caller, _capacityInput: 2, _capacityCacheRead: 900_000, _capacityCacheCreation: 8_000, _capacityOutput: 500 };
  const l1 = acc(); l1.requestInfo = ri;
  m.releaseAccount(l1, { success: true, status: 200 });
  const l2 = acc(); l2.requestInfo = ri;   // same request released again (retry path)
  m.releaseAccount(l2, { success: true, status: 200 });
  const cw = m.callerWindowStats().get(caller);
  assert.equal(cw.total.tok, 908_502, 'the serve path accrues the same full-prompt figure');
  assert.equal(cw.total.paid, 8_002);
});

test('the per-account usage counters book full prompt tokens (CLI Total)', () => {
  const m = new AccountManager([acct('c1'), { ...acct('z1', 'provider'), provider: 'zai' }], 0.9);
  const a = m.accounts[0];
  m.updateUsage(a.index, { input: 2, cacheRead: 900_000, cacheCreation: 8_000 }, 500);
  const g = m.accounts[1];
  m.updateUsage(g.index, { input: 40, cacheRead: 96_000, cacheCreation: 0 }, 700);
  assert.equal(a.usage.totalInputTokens, 908_002, 'input = full prompt');
  assert.equal(a.usage.totalOutputTokens, 500);
  assert.equal(a.usage.totalPaidTokens, 8_002, 'paid (write + uncached) tracked beside it');
  assert.equal(g.usage.totalInputTokens, 96_040, 'GLM included');
  // Back-compat: the old (input, output) two-arg shape still works.
  m.updateUsage(a.index, 7, 3);
  assert.equal(a.usage.totalInputTokens, 908_009);
  assert.equal(a.usage.totalOutputTokens, 503);
  assert.equal(a.usage.totalPaidTokens, 8_009, 'plain input counts as uncached, i.e. paid');
});

// ── through the real proxy: the SSE seam → request book → terminal release ──────────
import http from 'node:http';
import { createProxyServer } from '../src/server.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => s.close(r));
const sse = (...events) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

async function streamOnce(accounts, body, { model: modelUsed = 'claude-opus-4-8', profile } = {}) {
  const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(body); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts, 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upstreamPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(profile ? { 'x-maxpool-profile': profile } : {}) },
      body: JSON.stringify({ model: modelUsed, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    await new Promise(r2 => setTimeout(r2, 50));
    return am;
  } finally { await close(proxy); await close(upstream); }
}

test('stream: a Claude cache-write MISS books the full prompt, not 2 tokens', async () => {
  const am = await streamOnce([acct('a1')], sse(
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'x', content: [], usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 908_000, output_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 40 } },
    { type: 'message_stop' }));
  const u = am.accounts[0].usage;
  assert.equal(u.totalInputTokens, 908_002, 'input + cache read + cache write');
  assert.equal(u.totalOutputTokens, 40, 'output max, not summed per delta');
  assert.equal(u.totalPaidTokens, 908_002, 'a cold write is all paid');
});

test('stream: zai-shaped counters that arrive only on message_delta land (they used to book never)', async () => {
  // Routed through an oauth row on purpose: the seam defect (input booked from
  // message_start only, so zai's message_delta counters never landed) is
  // provider-agnostic — the fixture pins the WIRE SHAPE, not the routing.
  const am = await streamOnce([acct('a1')], sse(
    { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'glm', content: [], usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 40, cache_read_input_tokens: 96_000, output_tokens: 700 } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 40, cache_read_input_tokens: 96_000, output_tokens: 700 } },
    { type: 'message_stop' }));
  const u = am.accounts[0].usage;
  assert.equal(u.totalInputTokens, 96_040);
  assert.equal(u.totalOutputTokens, 700, 'cumulative deltas are not re-added');
  assert.equal(u.totalPaidTokens, 40);
});
