import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';

const { isCapacitySignalStatus, isStrippableThinkingBlock, stripForeignThinkingBlocks } = __serverTest;

// REAL signature shapes measured against the live APIs on 2026-07-25. They are NOT
// separable by shape — which is exactly why the repair strips every thinking block
// rather than guessing.
const ANTHROPIC_SIG = 'Eo8DCpQBCBAYAipAqutr+oABLfouNt1pOLV7Bp+M' + 'x'.repeat(180); // ~220 chars base64
const GLM_SIG = '8f8840affff743118e1f569d';                                          // 24 chars, hex
const KIMI_SIG = 'BfcsDPIyLJp20J1ot9Wy+/ouQyqN+iOQxa7oRWrOGB+VqgSit4' + 'z'.repeat(12896); // 12,946 chars

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

test('every thinking block is strippable regardless of provider; redacted_thinking never is', () => {
  // The GLM-tuned shape heuristic this replaced (missing/<60/hex) silently MISSED Kimi's
  // 12,946-char signature, so Kimi-contaminated sessions were never repaired.
  for (const sig of [ANTHROPIC_SIG, GLM_SIG, KIMI_SIG, '', undefined]) {
    assert.equal(isStrippableThinkingBlock({ type: 'thinking', signature: sig }), true);
  }
  assert.equal(isStrippableThinkingBlock({ type: 'redacted_thinking', data: 'abc' }), false,
    'redacted_thinking legitimately has no signature — never touch it');
  assert.equal(isStrippableThinkingBlock({ type: 'text', text: 'hi' }), false);
  assert.equal(isStrippableThinkingBlock({ type: 'tool_use', id: 'toolu_1' }), false);
});

test('a KIMI-contaminated transcript is repaired too (the gap the shape heuristic left)', () => {
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'kimi reasoning', signature: KIMI_SIG },
        { type: 'text', text: 'answer' },
      ] },
    ],
  }));
  const { body: out, removed } = stripForeignThinkingBlocks(body);
  assert.equal(removed, 1, 'Kimi block removed');
  assert.ok(!out.toString().includes(KIMI_SIG.slice(0, 40)), 'the Kimi signature is gone');
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

test('a transcript with NO thinking blocks is left completely untouched', () => {
  // The safety property that matters: strip only ever runs in response to Anthropic's own
  // signature-rejection 400, and it rewrites nothing when there is nothing to remove.
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ],
  }));
  assert.deepEqual(stripForeignThinkingBlocks(body), { body: null, removed: 0, converted: 0 });
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
  assert.deepEqual(stripForeignThinkingBlocks(body), { body: null, removed: 0, converted: 0 },
    'redacted_thinking is left alone → no rewrite at all');
});

test('removed is counted per-message and reports the truth across mixed turns', () => {
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'x', signature: GLM_SIG }, { type: 'text', text: 't' }] },
      { role: 'user', content: 'b' },
      { role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'zzz' }, { type: 'text', text: 'u' }] },  // preserved
    ],
  }));
  const { body: out, removed } = stripForeignThinkingBlocks(body);
  assert.equal(removed, 1, 'only the thinking block counts — redacted_thinking is not removed');
  const json = JSON.parse(out.toString());
  assert.deepEqual(json.messages[1].content.map(b => b.type), ['text']);
  assert.deepEqual(json.messages[3].content.map(b => b.type), ['redacted_thinking', 'text']);
});

test('strip tolerates a non-JSON body without throwing', () => {
  assert.deepEqual(stripForeignThinkingBlocks(Buffer.from('not json')), { body: null, removed: 0, converted: 0 });
});

// ── provider web search: the case that looked permanently unrepairable ─────────

test('a foreign web search is CONVERTED TO TEXT, not left to brick the session', () => {
  // Verified against the live API 2026-07-26: renaming the id does NOT work (a second
  // gate rejects the result's encrypted_content, which only Anthropic can mint), but
  // converting the pair to text returns 200 OK and keeps what the search found.
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'search the weather' },
      { role: 'assistant', content: [
        { type: 'server_tool_use', id: 'call_x1', name: 'web_search', input: { query: 'weather berlin' } },
        { type: 'web_search_tool_result', tool_use_id: 'call_x1',
          content: [{ type: 'web_search_result', title: 'Berlin Weather', url: 'https://w.com', encrypted_content: 'FAKE' }] },
        { type: 'text', text: 'Sunny.' },
      ] },
    ],
  }));
  const { body: out, converted } = stripForeignThinkingBlocks(body);
  assert.equal(converted, 2, 'both the call and its result are converted');
  const s = out.toString();
  assert.ok(!s.includes('server_tool_use'), 'no foreign tool call survives');
  assert.ok(!s.includes('encrypted_content'), 'no unforgeable payload survives');
  assert.match(s, /weather berlin/, 'the query is preserved as text');
  assert.match(s, /Berlin Weather/, 'what the search FOUND is preserved');
  const json = JSON.parse(s);
  assert.ok(json.messages[1].content.every(b => b.type === 'text'), 'all text now');
});

test("Anthropic's OWN server tools (srvtoolu_) are left completely alone", () => {
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [
        { type: 'server_tool_use', id: 'srvtoolu_ok1', name: 'web_search', input: { query: 'x' } },
        { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_ok1', content: [] },
      ] },
    ],
  }));
  assert.deepEqual(stripForeignThinkingBlocks(body), { body: null, removed: 0, converted: 0 });
});

test('a foreign tool RESULT carried on the following user turn is converted too', () => {
  const body = Buffer.from(JSON.stringify({
    messages: [
      { role: 'assistant', content: [{ type: 'server_tool_use', id: 'call_z', name: 'web_search', input: { query: 'q' } }] },
      { role: 'user', content: [{ type: 'web_search_tool_result', tool_use_id: 'call_z', content: [] }] },
    ],
  }));
  const { body: out, converted } = stripForeignThinkingBlocks(body);
  assert.equal(converted, 2, 'the result is converted even on a non-assistant turn');
  assert.ok(!out.toString().includes('web_search_tool_result'));
});

// ── rejected effort level: a hard failure that killed every web search ─────────

const { classifyEffortRejection, repairEffort } = __serverTest;

test('effort rejections are classified by the THREE real shapes seen live', () => {
  // Measured against the live API 2026-07-26 on three models.
  assert.equal(classifyEffortRejection("This model does not support effort level 'xhigh'. Supported levels: high, low, medium."), 'downgrade');
  assert.equal(classifyEffortRejection("output_config.effort 'xhigh' is not supported when thinking is disabled on this model. Use effort 'high' or below, or enable thinking."), 'downgrade');
  assert.equal(classifyEffortRejection('This model does not support the effort parameter.'), 'drop');
  assert.equal(classifyEffortRejection('messages: field required'), null, 'unrelated 400s are untouched');
  assert.equal(classifyEffortRejection('Invalid `signature` in `thinking` block'), null);
});

test('downgrade picks the best level the error itself advertises', () => {
  const body = Buffer.from(JSON.stringify({ model: 'm', output_config: { effort: 'xhigh' }, messages: [] }));
  const r = repairEffort(body, 'downgrade', "does not support effort level 'xhigh'. Supported levels: high, low, medium.");
  assert.equal(r.effort, 'high', 'highest advertised level wins');
  assert.equal(JSON.parse(r.body.toString()).output_config.effort, 'high');
});

test('downgrade falls back to high when the error lists nothing', () => {
  const body = Buffer.from(JSON.stringify({ model: 'm', output_config: { effort: 'xhigh' }, messages: [] }));
  const r = repairEffort(body, 'downgrade', "'xhigh' is not supported when thinking is disabled on this model.");
  assert.equal(r.effort, 'high');
});

test('drop removes effort — and the empty output_config with it', () => {
  const body = Buffer.from(JSON.stringify({ model: 'm', output_config: { effort: 'xhigh' }, messages: [] }));
  const r = repairEffort(body, 'drop', 'This model does not support the effort parameter.');
  const json = JSON.parse(r.body.toString());
  assert.equal(r.effort, null);
  assert.ok(!('output_config' in json), 'no empty object left behind');
});

test('drop keeps other output_config keys intact', () => {
  const body = Buffer.from(JSON.stringify({ model: 'm', output_config: { effort: 'xhigh', other: 1 }, messages: [] }));
  const json = JSON.parse(repairEffort(body, 'drop', 'x').body.toString());
  assert.deepEqual(json.output_config, { other: 1 });
});

test('effort repair is a no-op when there is no effort field at all', () => {
  const body = Buffer.from(JSON.stringify({ model: 'm', messages: [] }));
  assert.deepEqual(repairEffort(body, 'downgrade', 'x'), { body: null, effort: null });
});

test('a downgrade never retries the SAME level — it steps strictly below', () => {
  // Retrying the value the model just rejected burns a full transcript upload for nothing.
  const high = Buffer.from(JSON.stringify({ model: 'm', output_config: { effort: 'high' }, messages: [] }));
  assert.equal(repairEffort(high, 'downgrade', 'unhelpful message').effort, 'medium');
  // A ceiling named in the message is honoured ("Use effort 'medium' or below").
  const xh = Buffer.from(JSON.stringify({ model: 'm', output_config: { effort: 'xhigh' }, messages: [] }));
  assert.equal(repairEffort(xh, 'downgrade', "Use effort 'medium' or below, or enable thinking.").effort, 'medium');
  // Nothing below the floor -> genuinely no repair, falls through to the real error.
  const low = Buffer.from(JSON.stringify({ model: 'm', output_config: { effort: 'low' }, messages: [] }));
  assert.deepEqual(repairEffort(low, 'downgrade', 'x'), { body: null, effort: null });
});

test('an invalid effort VALUE from the client is repaired, not surfaced', () => {
  assert.equal(classifyEffortRejection("output_config.effort: Input should be 'low', 'medium', 'high', 'xhigh' or 'max'"), 'downgrade');
});

test('the working effort level is LATCHED per session+model (later turns skip the 400)', async () => {
  const { AccountManager: AM } = await import('../src/account-manager.js');
  const am = new AM([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 }], 0.9);
  am.markSessionEffort('s1', 'claude-opus-4-5', 'high');
  assert.deepEqual(am.getSessionEffort('s1', 'claude-opus-4-5'), { model: 'claude-opus-4-5', effort: 'high' });
  // Model-scoped: opus-4-5 accepts 'high' while opus-4-1 accepts no effort at all, so a
  // latch from one model must never be applied to another.
  assert.equal(am.getSessionEffort('s1', 'claude-opus-4-1'), undefined);
  assert.equal(am.getSessionEffort('other-session', 'claude-opus-4-5'), undefined);
});
