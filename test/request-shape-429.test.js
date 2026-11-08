// Request-shape 429s and z.ai reset parsing (2026-11-08).
//
// On a subscription login Anthropic serves Opus/Sonnet only to Claude-Code-shaped
// requests: a non-CC request gets a bare 429 ("Error", NO quota headers) while Haiku
// on the same account is served (bisected live — the identity system line alone flips
// 429 → 200). The account is healthy, so the pool must answer that request and leave
// the account untouched — not bench it (blocking real sessions) and not fail over
// (collecting the same refusal from every account).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, __serverTest } from '../src/server.js';

const { isRequestShapeRefusal, looksLikeClaudeCode, parseProviderRetryAfter, secondsUntilParsedTime } = __serverTest;
const CC_ID = "You are Claude Code, Anthropic's official CLI for Claude.";
const BARE_429 = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' }, request_id: 'req_x' });
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));

/** Upstream that behaves like Anthropic did on 2026-11-08: Haiku always served;
 *  Opus served only with the CC identity line, else a bare headerless 429.
 *  `mode.capWithoutHeaders` simulates a REAL cap whose headers were stripped. */
function anthropicStub(seen, mode = {}) {
  return http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      const body = JSON.parse(b); seen.push(body);
      const sys = Array.isArray(body.system) ? body.system.map(x => x.text) : [body.system || ''];
      const cc = sys.some(t => String(t).startsWith('You are Claude Code'));
      if (mode.capWithoutHeaders || (!/haiku/.test(body.model) && !cc)) {
        res.writeHead(429, { 'content-type': 'application/json' }); res.end(BARE_429); return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'anthropic-ratelimit-unified-status': 'allowed',
        'anthropic-ratelimit-unified-7d-utilization': '0.10', 'anthropic-ratelimit-unified-5h-utilization': '0.05' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
}

async function rig(mode) {
  const seen = [];
  const up = anthropicStub(seen, mode);
  const upPort = await listen(up);
  const mk = n => ({ name: n, type: 'apikey', apiKey: 'sk-ant-x', accountUuid: `U-${n}`, upstream: `http://127.0.0.1:${upPort}` });
  const am = new AccountManager([mk('a1'), mk('a2')], 0.9, { routingMode: 'balance' });
  const proxy = createProxyServer(am, { proxy: { apiKey: 't' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  const post = (model, system) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 't' },
    body: JSON.stringify({ model, max_tokens: 8, ...(system ? { system } : {}), messages: [{ role: 'user', content: 'hi' }] }),
  });
  return { seen, am, post, close: () => { proxy.close(); up.close(); } };
}

test('non-Claude-Code Opus request: answered with the refusal, ONE upstream call, accounts untouched', async () => {
  const r = await rig();
  const res = await r.post('claude-opus-5-5', [{ type: 'text', text: 'You are a precise assistant.' }]);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('x-maxpool-request-shape-refused'), '1');
  assert.match((await res.json()).error.message, /only to Claude Code requests/);
  assert.equal(r.seen.length, 1, 'no failover: every account would refuse the same shape');
  for (const a of r.am.accounts) {
    assert.notEqual(a.status, 'throttled', `${a.name} must not be benched`);
    assert.ok(!a.rateLimitedUntil, `${a.name} carries no rate-limit window`);
  }
  // The very next real Claude Code request is served — nothing was benched.
  const ok = await r.post('claude-opus-5-5', [{ type: 'text', text: CC_ID }]);
  assert.equal(ok.status, 200);
  r.close();
});

test('a headerless bare 429 on a REAL Claude Code request keeps account-wide handling', async () => {
  const r = await rig({ capWithoutHeaders: true });
  const res = await r.post('claude-opus-5-5', [{ type: 'text', text: CC_ID }]);
  assert.notEqual(res.headers.get('x-maxpool-request-shape-refused'), '1');
  assert.ok(r.seen.length >= 2, 'failover still runs for a genuine cap');
  // Matching ambiguous 429s on every account promote to the shared upstream throttle
  // (existing design, red-teamed 2026-10-21) — the account handling stays intact.
  assert.ok(r.am.accounts.some(a => a.status === 'throttled') || r.am.upstreamThrottle?.until, 'a genuine cap still engages a limit state');
  r.close();
});

test('refusal predicate needs all three: no quota headers, bare body, non-CC request', () => {
  const nonCC = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', system: 'You are a precise assistant.', messages: [] }));
  const cc = Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', system: [{ type: 'text', text: 'x-anthropic-billing-header: v' }, { type: 'text', text: CC_ID }], messages: [] }));
  assert.equal(isRequestShapeRefusal({}, BARE_429, nonCC), true);
  assert.equal(isRequestShapeRefusal({ 'anthropic-ratelimit-unified-status': 'rejected' }, BARE_429, nonCC), false, 'quota headers = a real limit');
  assert.equal(isRequestShapeRefusal({}, JSON.stringify({ error: { type: 'rate_limit_error', message: 'Weekly limit reached' } }), nonCC), false);
  assert.equal(isRequestShapeRefusal({}, BARE_429, cc), false, 'identity line in an early block counts');
  assert.equal(looksLikeClaudeCode(Buffer.from('not json')), true, 'unparseable → never a refusal');
  assert.equal(looksLikeClaudeCode(Buffer.from(JSON.stringify({ system: "You are a Claude agent, built on Anthropic's Claude Agent SDK." }))), true);
});

test('z.ai reset time: bracketed request id no longer breaks the parse; time is UTC+8', () => {
  const realNow = Date.now;
  try {
    // 2026-11-08T05:00:00Z. z.ai says "reset at 2026-11-08 16:00:00" (China time) = 08:00Z → 3h.
    Date.now = () => Date.parse('2026-11-08T05:00:00Z');
    const body = JSON.stringify({ error: { type: 'rate_limit_error', code: '1308',
      message: '[1308][Usage limit reached. Your limit will reset at 2026-11-08 16:00:00][20261108131520f2f1c241834a4b9f]' } });
    assert.equal(parseProviderRetryAfter(body, 'zai'), 3 * 3600);
    // Old unbracketed format still parses.
    const old = JSON.stringify({ error: { code: '1308', message: 'Usage limit reached. Your limit will reset at 2026-11-08 16:00:00' } });
    assert.equal(parseProviderRetryAfter(old, 'zai'), 3 * 3600);
    // A zone-bearing time is not shifted.
    assert.equal(secondsUntilParsedTime('2026-11-08T06:00:00Z', { tzOffsetMs: 8 * 3600_000 }), 3600);
  } finally { Date.now = realNow; }
});

test('z.ai "no coding plan" is a named state, not an endless probe', async () => {
  const am = new AccountManager([{ name: 'glm p', type: 'provider', provider: 'zai', authToken: 'k', upstream: 'http://glm' }], 0.9, {});
  am.applyProviderUsage(0, { noPlan: true, source: 'zai' });
  assert.equal(am.accounts[0].quota.noPlan, true);
  assert.ok(am.accounts[0].quota.lastProbeOkAt);
  // A real reading later (plan re-bought) clears it.
  am.applyProviderUsage(0, { ses: { utilization: 0.2, resetAt: Date.now() + 3600_000 }, source: 'zai' });
  assert.equal(am.accounts[0].quota.noPlan, false);
});
