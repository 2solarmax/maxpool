// SAFEGUARD-REFUSAL REROUTE — INTEGRATION (task-2026-09-14-maxpool-reroute-anthropic-refusals-to-provider)
//
// Pins the SEAMS the unit suite cannot see: a real request through the real proxy,
// where an Anthropic-style upstream refuses and a PROVIDER upstream serves the
// retried turn. Verifies: (1) the client receives the provider's answer, not the
// refusal; (2) the eligibility WIRING (armed on oauth, not on provider) — the M5
// mutant the unit tests cannot catch; (3) the one-hop latch; (4) the log line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => s.close(r));

const oauthAcc = (name = 'anth1') => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, modelMap: null });
// profiles:['all'] is what REAL runtime provider accounts carry (src/server.js:2885-2910) — without it the account never matches a 'claude'-profile request and the fixture tests nothing.
const providerAcc = (name = 'glm1') => ({ name, type: 'provider', provider: 'zai', profiles: ['all'], accessToken: 'k', refreshToken: null, expiresAt: null, model: 'glm-5.3', modelMap: null });

const REFUSAL_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_r","model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0}}}',
  '',
  'event: ping',
  'data: {"type":"ping"}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"reasoning_extraction"}},"usage":{"output_tokens":0}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

const PROVIDER_SSE = [
  'event: message_start',
  'data: {"type":"message_start","message":{"id":"msg_p","model":"glm-5.3","usage":{"input_tokens":10,"output_tokens":0}}}',
  '',
  'event: content_block_start',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
  '',
  'event: content_block_delta',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"provider answered"}}',
  '',
  'event: message_delta',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

function makeUpstream(handler) {
  return new Promise(async (resolve) => {
    const s = http.createServer(handler);
    const port = await listen(s);
    resolve({ s, port, close: () => close(s) });
  });
}

test('refused turn is transparently rerouted to a provider; the client sees the provider answer', async () => {
  const logs = [];
  const realLog = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };

  // Upstream serves BOTH roles by port convention: we build two upstreams.
  const anthropic = await makeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(REFUSAL_SSE);
  });
  const provider = await makeUpstream((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(PROVIDER_SSE);
  });

  // Two AccountManagers? No — one manager, but per-account upstream is not the model
  // here: the proxy has ONE upstream config. Instead: refuse on the FIRST request to
  // the single upstream, serve the provider SSE on the SECOND (the rerouted retry).
  let call = 0;
  const dual = await makeUpstream((req, res) => {
    call += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(call === 1 ? REFUSAL_SSE : PROVIDER_SSE);
  });

  // Owner's live config: routingMode 'balance' (providers peer with Claude). The
  // library default (sticky + claudeFallback 'never') bars providers entirely, so a
  // default-config fixture would test the policy gate, not the reroute.
  const am = new AccountManager([oauthAcc('anth1'), providerAcc('glm1')], 0.90, { routingMode: 'balance' });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${dual.port}`,
    queue: { enabled: false },
  });
  const port = await listen(proxy);

  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      // The real cc wrapper sends profile 'all' (see _cc_run_all); provider accounts
      // carry profiles:['all'], so ONLY that profile can route to them. A 'claude'-profile
      // session cannot be rerouted at all — asserted by the sibling test below.
      headers: { 'content-type': 'application/json', 'x-maxpool-api-key': 'tc-test', 'x-maxpool-profile': 'all' },
      body: JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await r.text();
    assert.ok(text.includes('provider answered'), 'client must receive the PROVIDER answer, not the refusal');
    assert.ok(!text.includes('refusal'), 'the refusal must never reach the client');
    assert.equal(call, 2, 'exactly one reroute hop');
    assert.ok(logs.some(l => l.includes('safeguard refusal') && l.includes('reasoning_extraction')),
      'the reroute must be logged with its category');
  } finally {
    console.log = realLog;
    await close(proxy); await dual.close(); await anthropic.close(); await provider.close();
  }
});

test('a claude-PROFILE session cannot reroute (no provider matches it) and surfaces the refusal', async () => {
  // Provider accounts carry profiles:['all']; a session on profile 'claude' structurally
  // has no provider route, so the refusal must surface exactly as before this feature —
  // never a silent hang, never a 429 pretending the fleet is saturated.
  let call = 0;
  const up = await makeUpstream((req, res) => {
    call += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(REFUSAL_SSE);
  });
  const am = new AccountManager([oauthAcc('anth1'), providerAcc('glm1')], 0.90, { routingMode: 'balance' });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${up.port}`, queue: { enabled: false },
  });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-maxpool-profile': 'claude' },
      body: JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    assert.equal(call, 1, 'no reroute attempt is made when no provider can serve the profile');
  } finally {
    await close(proxy); await up.close();
  }
});

test('ONE hop only: a provider that also refuses does not loop', async () => {
  // The latch (requestInfo.refusalRerouted) is what bounds this. Without it, a refusal
  // from every route would re-dispatch until the attempt budget ran out — burning the
  // whole fleet on one poisoned turn. Here EVERY upstream refuses: exactly one reroute
  // may be attempted, then the error surfaces.
  let call = 0;
  const up = await makeUpstream((req, res) => {
    call += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(REFUSAL_SSE);
  });
  const am = new AccountManager(
    [oauthAcc('anth1'), providerAcc('glm1'), providerAcc('glm2')],
    0.90, { routingMode: 'balance' },
  );
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${up.port}`, queue: { enabled: false },
  });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-maxpool-profile': 'all' },
      body: JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    assert.ok(call <= 2, `at most one reroute hop; upstream was called ${call} times`);
  } finally {
    await close(proxy); await up.close();
  }
});

