import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';

const { isCapacitySignalStatus, isForeignThinkingSignature, stripForeignThinkingBlocks } = __serverTest;

// REAL signatures captured from the live APIs on 2026-07-25.
const ANTHROPIC_SIG = 'Eo8DCpQBCBAYAipAqutr+oABLfouNt1pOLV7Bp+M' + 'x'.repeat(180); // long base64 blob
const GLM_SIG = '8f8840affff743118e1f569d';                                          // 24-char hex digest

// ── the deadlock breaker: which statuses may keep the SHARED breaker armed ─────

test('only genuine capacity signals keep the shared upstream throttle armed', () => {
  // Capacity signals — the breaker legitimately stays armed.
  for (const s of [429, 403, 408, 500, 502, 503, 529]) {
    assert.equal(isCapacitySignalStatus(s), true, `${s} is a capacity signal`);
  }
  // Per-request verdicts — Anthropic ANSWERED, so the upstream is provably alive.
  // 400 is the one that deadlocked the fleet on 2026-07-25.
  for (const s of [200, 400, 401, 404, 413, 422] ) {
    assert.equal(isCapacitySignalStatus(s), false, `${s} must NOT keep the breaker armed`);
  }
});

test('a failed probe escalates backoff and force-clears once the budget is spent (no infinite wedge)', () => {
  const am = new AccountManager(
    [{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.90,
  );
  am.markUpstreamThrottled(60, 'real 429s');
  assert.ok(am.upstreamThrottle.until, 'breaker armed');

  const waits = [];
  for (let i = 0; i < 8; i++) {
    if (!am.upstreamThrottle.until) break;                 // force-cleared
    am.upstreamThrottle.probeInFlight = true;
    const before = Date.now();
    am.deferUpstreamThrottleProbe(5, 'invalid_thinking_signature');
    if (am.upstreamThrottle.until) waits.push(Math.round((am.upstreamThrottle.until - before) / 1000));
  }
  // Backoff escalates rather than pinning a flat 5s forever...
  assert.ok(waits.length >= 2 && waits[1] > waits[0], `backoff escalates (${waits.join(',')})`);
  // ...and the breaker is eventually released instead of wedging the whole fleet.
  assert.equal(am.upstreamThrottle.until, null, 'probe budget exhausted → breaker force-cleared');
});

test('relinquishing an unused probe does NOT re-arm the breaker (client-gone / token-refresh)', () => {
  const am = new AccountManager(
    [{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.90,
  );
  am.markUpstreamThrottled(60, 'real 429s');
  const until = am.upstreamThrottle.until;
  const lease = { upstreamThrottleProbe: true };
  am.relinquishUpstreamProbe(lease);
  assert.equal(lease.upstreamThrottleProbe, false, 'probe handed back');
  assert.equal(am.upstreamThrottle.probeInFlight, false, 'next request may claim it immediately');
  assert.equal(am.upstreamThrottle.until, until, 'window unchanged — no failure scored');
});

// ── the recovery: strip provider-authored thinking so the session runs on Claude ─

test('isForeignThinkingSignature separates a real Anthropic blob from GLM\'s hex digest', () => {
  assert.equal(isForeignThinkingSignature(ANTHROPIC_SIG), false, 'genuine Anthropic signature is kept');
  assert.equal(isForeignThinkingSignature(GLM_SIG), true, "GLM's short hex digest is foreign");
  assert.equal(isForeignThinkingSignature(''), true);
  assert.equal(isForeignThinkingSignature(undefined), true);
});

test('strip removes ONLY the provider-authored thinking, preserving text + tool_use', () => {
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'glm reasoning', signature: GLM_SIG },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'toolu_1', name: 'get', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] },
    ],
  }));
  const { body: out, removed } = stripForeignThinkingBlocks(body);
  assert.equal(removed, 1, 'the GLM thinking block is removed');
  const json = JSON.parse(out.toString());
  const types = json.messages[1].content.map(b => b.type);
  assert.deepEqual(types, ['text', 'tool_use'], 'text + tool_use survive (tool wiring intact)');
  assert.equal(json.messages[2].content[0].tool_use_id, 'toolu_1', 'tool_result still pairs');
});

test('strip is a NO-OP for a clean Anthropic transcript (never rewrites a healthy session)', () => {
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'claude reasoning', signature: ANTHROPIC_SIG },
        { type: 'text', text: 'answer' },
      ] },
    ],
  }));
  const { body: out, removed } = stripForeignThinkingBlocks(body);
  assert.equal(removed, 0);
  assert.equal(out, null, 'no rewrite → the original body is forwarded untouched');
});

test('a thinking-ONLY turn is DROPPED, never left carrying the poisoned block', () => {
  // The defect this locks: previously the turn was left untouched (because emptying it
  // was believed illegal), so the retry resent the exact body that just 400'd — while
  // logging a successful strip and burning the one recovery attempt.
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: GLM_SIG }] },
      { role: 'user', content: 'next' },
    ],
  }));
  const { body: out, removed } = stripForeignThinkingBlocks(body);
  assert.equal(removed, 1);
  const out8 = out.toString();
  assert.ok(!out8.includes(GLM_SIG), 'the poisoned signature is GONE from the retried body');
  const json = JSON.parse(out8);
  assert.equal(json.messages.length, 2, 'the emptied assistant turn is dropped');
  assert.deepEqual(json.messages.map(m => m.role), ['user', 'user']);
});

test('a genuine redacted_thinking block (data, NO signature) is never stripped', () => {
  // Real redacted_thinking carries `data` and legitimately has no `signature`, so
  // signature-based judging would false-positive on 100% of them.
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'EroBCkYIBBgCKkD...' },
        { type: 'text', text: 'answer' },
      ] },
    ],
  }));
  assert.deepEqual(stripForeignThinkingBlocks(body), { body: null, removed: 0 },
    'redacted_thinking is left alone → no rewrite at all');
});

test('removed is counted per-message and reports the truth across mixed turns', () => {
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [                                   // 1 stripped, survives
        { type: 'thinking', thinking: 'x', signature: GLM_SIG }, { type: 'text', text: 't' }] },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: [                                   // clean → untouched
        { type: 'thinking', thinking: 'y', signature: ANTHROPIC_SIG }, { type: 'text', text: 'u' }] },
    ],
  }));
  const { body: out, removed } = stripForeignThinkingBlocks(body);
  assert.equal(removed, 1, 'exactly one block was actually removed');
  const json = JSON.parse(out.toString());
  assert.deepEqual(json.messages[1].content.map(b => b.type), ['text']);
  assert.deepEqual(json.messages[3].content.map(b => b.type), ['thinking', 'text'], 'clean turn untouched');
});

test('strip tolerates a non-JSON body without throwing', () => {
  assert.deepEqual(stripForeignThinkingBlocks(Buffer.from('not json')), { body: null, removed: 0 });
});
