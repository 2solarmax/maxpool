import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';

const { isContextLengthError, unavailableMessage } = __serverTest;

function fleet() {
  // 'all' profile + explicit 'when-exhausted' so providers are eligible for a Claude
  // session (the DEFAULT is now 'never'). The large-context heal must bench providers
  // even when they'd otherwise be eligible, so the fallback must be ON for the test to
  // prove anything.
  return new AccountManager([
    { name: 'oauth1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://api.z.ai/api/anthropic' },
    { name: 'kimi', type: 'provider', provider: 'kimi', authToken: 'k', upstream: 'https://api.kimi.com/coding' },
  ], 0.90, { crossProviderFallbackPolicy: 'when-exhausted' });
}

// ── isContextLengthError: the provider "request too big for me" signature ──────

test('isContextLengthError matches Kimi coding-endpoint overflow ("exceeded model token limit: 262144")', () => {
  assert.equal(isContextLengthError('{"error":{"message":"exceeded model token limit: 262144 (requested: 643557)"}}'), true);
});

test('isContextLengthError matches common context-overflow phrasings', () => {
  for (const b of [
    'maximum context length is 200000 tokens',
    'context length exceeded',
    'This prompt is too long for the model',
    'input is too long',
    'please reduce the length of the messages',
    'too many input tokens',
    'request too large',
  ]) assert.equal(isContextLengthError(b), true, `should match: ${b}`);
});

test('isContextLengthError does NOT fire on a rate-limit / generic 400 (avoids mis-pinning to Claude)', () => {
  assert.equal(isContextLengthError('rate limit exceeded: 40000 tokens per minute'), false);
  assert.equal(isContextLengthError('{"error":{"type":"invalid_request_error","message":"messages: field required"}}'), false);
  assert.equal(isContextLengthError(''), false);
  assert.equal(isContextLengthError(null), false);
});

// ── the routing invariant: a large-context session NEVER matches a provider ───

test('a large-context session is incompatible with BOTH providers but eligible on Claude', () => {
  const m = fleet();
  const [oauth, glm, kimi] = m.accounts;
  const bigReq = { profile: 'all', largeContext: true };

  assert.equal(m._isRequestCompatible(kimi, 'all', bigReq), false, 'Kimi (256K coding leg) excluded — 262144 cap');
  assert.equal(m._isRequestCompatible(glm, 'all', bigReq), false, 'GLM excluded too — only a 1M Claude holds it');
  assert.equal(m._isRequestCompatible(oauth, 'all', bigReq), true, 'Claude (1M) stays eligible');
  // The chokepoint every selection funnels through must agree.
  assert.equal(m._matchesRequest(kimi, 'all', bigReq), false);
  assert.equal(m._matchesRequest(oauth, 'all', bigReq), true);
});

test('a NORMAL-size session is still eligible on the providers (fix is scoped to oversized)', () => {
  const m = fleet();
  const [, glm, kimi] = m.accounts;
  assert.equal(m._isRequestCompatible(kimi, 'all', { profile: 'all' }), true);
  assert.equal(m._isRequestCompatible(glm, 'all', { profile: 'all' }), true);
});

// ── markSessionLargeContext: sticky, so every follow-up turn skips the providers ─

test('markSessionLargeContext latches the session — later turns skip providers with no largeContext flag', () => {
  const m = fleet();
  const [, , kimi] = m.accounts;
  const sessionKey = 'sess-abc';
  // First turn carries the flag (set by the react-and-heal after the provider 400).
  assert.equal(m._isSessionLargeContext({ sessionKey, largeContext: true }), true);
  m.markSessionLargeContext(sessionKey);
  // A later turn — NO largeContext flag on the request — still resolves large via the sticky policy.
  assert.equal(m._isSessionLargeContext({ sessionKey }), true, 'sticky across turns');
  assert.equal(m._isRequestCompatible(kimi, 'all', { profile: 'all', sessionKey }), false, 'provider stays benched for the session');
  // A DIFFERENT session is unaffected.
  assert.equal(m._isSessionLargeContext({ sessionKey: 'other' }), false);
  assert.equal(m._isRequestCompatible(kimi, 'all', { profile: 'all', sessionKey: 'other' }), true);
});

// ── unavailableMessage: an oversized session gets the truthful "needs Claude" line ─

test('unavailableMessage for a large-context session names the real cause + the ways out', () => {
  const m = fleet();
  m.markSessionLargeContext('big-sess');
  const msg = unavailableMessage(m, { sessionKey: 'big-sess' }, 120, false);
  assert.match(msg, /too large for the GLM\/Kimi fallbacks/);
  assert.match(msg, /1M-context Claude/);
  assert.match(msg, /\/compact/, 'offers the compact way out');
  // Must NOT frame it as the providers being merely "at their limit" (they're barred).
  assert.doesNotMatch(msg, /providers are at their limit/);
});

test('a NORMAL session still gets the generic all-at-limit message (large-context branch not taken)', () => {
  const m = fleet();
  const msg = unavailableMessage(m, { sessionKey: 'normal-sess' }, 60, false);
  assert.doesNotMatch(msg, /too large for the GLM\/Kimi fallbacks/);
  assert.match(msg, /at their limit/);
});

test('markSessionLargeContext coexists with other session policies (does not clobber them)', () => {
  const m = fleet();
  const sessionKey = 'sess-mixed';
  m.markSessionThinkingProtected(sessionKey, 'claude-opus-4-8');
  m.markSessionLargeContext(sessionKey);
  const pol = m.sessionPolicies.get(sessionKey);
  assert.equal(pol.largeContext, true);
  assert.equal(pol.requiresAnthropicThinkingIntegrity, true, 'existing policy preserved');
});
