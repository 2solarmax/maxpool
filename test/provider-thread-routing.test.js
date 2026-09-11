// A request whose conversation lives on Anthropic's servers must never be sent to a
// provider, and an over-large transcript a provider rejects must latch the session.
//
// Driver 2026-09-10/11. Claude Code >= 2.1.265 uses the stateful Threads API: it sends
// the last turn or two plus a `thread`/`previous_message_id` reference and leaves the
// rest on Anthropic. GLM has no such state, so it receives a conversation opening with a
// bare tool_result and answers [1214] "messages parameter is illegal". Measured on
// 09-11: 37 provider rejections, 14 threaded and 23 over 1MB (median 3.6MB, max 4.8MB).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';

const { isProviderParamRejection, PROVIDER_OVERSIZE_BYTES, describeRequest } = __serverTest;

function fleet() {
  return new AccountManager([
    { name: 'oauth1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://api.z.ai/api/anthropic' },
    { name: 'kimi', type: 'provider', provider: 'kimi', authToken: 'k', upstream: 'https://api.kimi.com/coding' },
  ], 0.90, { crossProviderFallbackPolicy: 'when-exhausted' });
}
const at = (m, name) => m.accounts.find(a => a.name === name);

test('a threaded request is ineligible for every provider', () => {
  const m = fleet();
  for (const p of ['glm', 'kimi']) {
    assert.equal(m._isRequestCompatible(at(m, p), 'all', { threaded: true }), false, `${p} must be benched`);
  }
});

test('a threaded request still routes to Claude', () => {
  const m = fleet();
  assert.equal(m._isRequestCompatible(at(m, 'oauth1'), 'claude', { threaded: true }), true);
});

test('the SAME session\'s unthreaded requests still reach providers', () => {
  // Per-request, deliberately not sticky: only the threaded turns are Anthropic-only.
  const m = fleet();
  const info = { sessionKey: 's1', threaded: false };
  assert.equal(m._isRequestCompatible(at(m, 'glm'), 'all', info), true);
});

test('an oversized provider rejection reads as a context verdict', () => {
  // z.ai says "messages parameter is illegal" and names no length, so the plain
  // context-length matcher cannot see it — size is what makes it legible.
  const body = '{"error":{"code":"1214","message":"[1214][The messages parameter is illegal. Please check the documentation.]"}}';
  assert.equal(isProviderParamRejection(body), true);
  assert.ok(PROVIDER_OVERSIZE_BYTES === 1_000_000, 'threshold is an order of magnitude above a normal turn');
});

test('1210 and 1214 are both provider shape rejections; neighbouring codes are not', () => {
  for (const c of ['1210', '1214']) {
    assert.equal(isProviderParamRejection(`[${c}][whatever]`), true, `${c} should match`);
    assert.equal(isProviderParamRejection(`{"code":"${c}"}`), true, `${c} json should match`);
  }
  for (const c of ['1211', '1213', '1215', '1200']) {
    assert.equal(isProviderParamRejection(`[${c}][whatever]`), false, `${c} must NOT match`);
  }
  // An Anthropic 400 that names its own field keeps its own message.
  assert.equal(isProviderParamRejection('{"error":{"message":"messages.4: Field required"}}'), false);
});

test('describeRequest flags a threaded body and leaves a plain one alone', () => {
  const mk = (o) => describeRequest(
    { url: '/v1/messages', method: 'POST', headers: {} },
    Buffer.from(JSON.stringify({ model: 'claude-opus-5', messages: [], ...o })),
  );
  assert.equal(mk({ thread: { id: 't_1' } }).threaded, true);
  assert.equal(mk({ previous_message_id: 'msg_1' }).threaded, true);
  assert.equal(mk({}).threaded, undefined);
});
