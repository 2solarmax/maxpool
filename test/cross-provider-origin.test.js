// Cross-provider session-origin pinning: a resumed GLM/Kimi ('cc glm') session must
// NEVER route to an Anthropic account (Anthropic 400s on its non-srvtoolu_ tool ids),
// a Claude session prefers Claude with policy-gated provider fallback, and the whole
// thing is controlled by scheduler.crossProviderFallbackPolicy. Also proves the fix
// to the inverted-thinking misroute (GLM thinking blocks were force-pinning to Claude).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';
import { createDefaultConfig } from '../src/config.js';

const { detectTranscriptOrigin, unavailableMessage, describeRequest } = __serverTest;

function withProviders(policy = 'when-exhausted') {
  const am = new AccountManager([
    { name: 'claude1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'claude2', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ], 0.90, { crossProviderFallbackPolicy: policy });
  am.upsertRuntimeAccount({ name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', authHeader: 'authorization', profiles: ['all'], priority: 10, modelMap: { opus: 'glm-5.2', default: 'glm-5.2' } });
  am.upsertRuntimeAccount({ name: 'kimi-fallback', type: 'provider', provider: 'kimi', authToken: 'k', upstream: 'https://k', authHeader: 'authorization', profiles: ['all'], priority: 20, model: 'kimi-k2.7' });
  return am;
}
const oauthOf = am => am.accounts.find(a => a.type === 'oauth');
const glmOf = am => am.accounts.find(a => a.provider === 'zai');
const kimiOf = am => am.accounts.find(a => a.provider === 'kimi');
const disableOauth = am => am.accounts.filter(a => a.type === 'oauth').forEach(a => { a.enabled = false; });

// ── detector unit ───────────────────────────────────────────────────────────

test('detectTranscriptOrigin classifies by tool-use id shape', () => {
  const mk = (id, type = 'tool_use') => ({ messages: [{ role: 'assistant', content: [{ type, id, name: 'x', input: {} }] }] });
  assert.deepEqual(detectTranscriptOrigin(mk('call_00e9')), { class: 'foreign', provider: 'zai' });
  assert.deepEqual(detectTranscriptOrigin(mk('tool_j5x')), { class: 'foreign', provider: 'kimi' });
  assert.deepEqual(detectTranscriptOrigin(mk('toolu_01A')), { class: 'anthropic', provider: null });
  assert.deepEqual(detectTranscriptOrigin(mk('srvtoolu_9', 'server_tool_use')), { class: 'anthropic', provider: null });
  assert.deepEqual(detectTranscriptOrigin(mk('weird_9', 'server_tool_use')), { class: 'foreign', provider: null });
  assert.deepEqual(detectTranscriptOrigin({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }), { class: null, provider: null });
  // tool_result carries the paired id — same signal
  assert.deepEqual(detectTranscriptOrigin({ messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_z', content: 'ok' }] }] }), { class: 'foreign', provider: 'zai' });
  // ANY foreign id wins even if Anthropic ids are also present (mixed = poisoned)
  assert.equal(detectTranscriptOrigin({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'a', input: {} }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_2', name: 'b', input: {} }] },
  ] }).class, 'foreign');
  // non-object / empty → null (fail-open at detection; nothing to bar)
  assert.deepEqual(detectTranscriptOrigin(null), { class: null, provider: null });
  assert.deepEqual(detectTranscriptOrigin({}), { class: null, provider: null });
});

// ── the reported bug: a GLM session must NOT route to Anthropic (the 400) ──────

test('a foreign (GLM) request never selects an Anthropic account and picks a provider', () => {
  const am = withProviders();
  const req = { profile: 'all', model: 'claude-opus-4-8', originClass: 'foreign', originProvider: 'zai', sessionKey: 's1' };
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', req), false, 'oauth barred for foreign');
  assert.equal(am._isRequestCompatible(glmOf(am), 'all', req), true, 'glm allowed');
  assert.equal(am._isRequestCompatible(kimiOf(am), 'all', req), true, 'kimi allowed (sibling, when-exhausted)');
  for (let i = 0; i < 20; i++) {
    const l = am.acquireAccount(req);
    assert.ok(l, 'a provider is always available');
    assert.equal(l.account.type, 'provider', 'never routes a foreign session to Anthropic');
    am.releaseAccount(l, { success: true });
  }
});

test('THE MISROUTE FIX: a foreign request WITH thinking blocks still routes to a provider (not force-pinned to Claude)', () => {
  const am = withProviders();
  // GLM transcripts carry (unsigned) thinking → requiresAnthropicThinkingIntegrity=true.
  // Pre-fix this barred providers and forced the GLM request onto Anthropic → 400.
  const req = { profile: 'all', originClass: 'foreign', originProvider: 'zai', requiresAnthropicThinkingIntegrity: true, sessionKey: 's2' };
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', req), false, 'oauth still barred (foreign wins over thinking)');
  assert.equal(am._isRequestCompatible(glmOf(am), 'all', req), true, 'provider allowed despite the thinking flag');
  const l = am.acquireAccount(req);
  assert.equal(l.account.type, 'provider');
});

// ── Claude-origin: prefer Claude, policy-gated fallback ───────────────────────

test('a Claude-origin request prefers oauth and falls to a provider only when Claude is exhausted (when-exhausted)', () => {
  const am = withProviders('when-exhausted');
  const req = { profile: 'all', originClass: 'anthropic', sessionKey: 's3' };
  const l1 = am.acquireAccount(req);
  assert.equal(l1.account.type, 'oauth', 'oauth preferred while available');
  am.releaseAccount(l1, { success: true });
  disableOauth(am);
  const l2 = am.acquireAccount(req);
  assert.equal(l2.account.type, 'provider', 'falls to a provider once all Claude are down');
});

test("policy 'never' bars providers for a Claude session entirely (no cross-provider fallback)", () => {
  const am = withProviders('never');
  const req = { profile: 'all', originClass: 'anthropic', sessionKey: 's4' };
  assert.equal(am._isRequestCompatible(glmOf(am), 'all', req), false);
  disableOauth(am);
  assert.equal(am.getActiveAccount(req), null, 'no route — never crosses to a provider');
});

test("policy 'always' makes providers peer with oauth (priority 0) for a Claude/unknown session", () => {
  const am = withProviders('always');
  assert.equal(am._effectivePriority(glmOf(am), { originClass: 'anthropic' }), 0, 'provider peers under always');
  assert.equal(am._effectivePriority(glmOf(am), { originClass: 'foreign', originProvider: 'zai' }), 10, 'foreign session keeps provider fallback priority');
  const am2 = withProviders('when-exhausted');
  assert.equal(am2._effectivePriority(glmOf(am2), { originClass: 'anthropic' }), 10, 'when-exhausted keeps provider as fallback');
});

test('a signed-thinking Claude session never uses a provider (unchanged existing behavior)', () => {
  const am = withProviders('when-exhausted');
  const req = { profile: 'all', originClass: 'anthropic', requiresAnthropicThinkingIntegrity: true };
  assert.equal(am._isRequestCompatible(glmOf(am), 'all', req), false);
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', req), true);
});

// ── foreign same-provider pin under 'never' ───────────────────────────────────

test("policy 'never' pins a foreign session to its ORIGIN provider (GLM→GLM, not Kimi)", () => {
  const am = withProviders('never');
  const req = { profile: 'all', originClass: 'foreign', originProvider: 'zai', sessionKey: 's5' };
  assert.equal(am._isRequestCompatible(glmOf(am), 'all', req), true, 'same provider allowed');
  assert.equal(am._isRequestCompatible(kimiOf(am), 'all', req), false, 'sibling provider barred under never');
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', req), false, 'oauth always barred for foreign');
});

// ── sticky latch (R2: selector + oracle both read it) ─────────────────────────

test('foreign origin latches per session: a later no-origin follow-up still bars oauth (selector AND oracle agree)', () => {
  const am = withProviders('when-exhausted');
  const first = { profile: 'all', originClass: 'foreign', originProvider: 'zai', sessionKey: 's6' };
  const lease = am.acquireAccount(first); // _noteRequestPolicy latches foreign on s6
  am.releaseAccount(lease, { success: true });

  const followup = { profile: 'all', sessionKey: 's6' }; // no originClass this turn
  assert.equal(am._effectiveOrigin(followup).class, 'foreign', 'sticky foreign wins');
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', followup), false, 'oauth stays barred via sticky mark');

  // Selector and oracle MUST agree: with providers down, selection returns null and
  // the oracle must NOT claim an oauth route is available (the desync/spin class).
  am.accounts.filter(a => a.type === 'provider').forEach(a => { a.enabled = false; });
  assert.equal(am.getActiveAccount(followup), null, 'no oauth leak on a sticky-foreign followup');
  const retry = am.nextRetryForRequest(followup);
  assert.notEqual(retry.cause, 'available', 'oracle does not offer an oauth route to a foreign-pinned session');
});

test('foreign never downgrades: an Anthropic-looking followup on a latched-foreign session stays foreign', () => {
  const am = withProviders();
  am.acquireAccount({ profile: 'all', originClass: 'foreign', originProvider: 'zai', sessionKey: 's7' });
  assert.equal(am._effectiveOrigin({ profile: 'all', originClass: 'anthropic', sessionKey: 's7' }).class, 'foreign');
});

// ── policy setter + reader validation ─────────────────────────────────────────

test('setCrossProviderFallbackPolicy validates the enum; unknown values read as when-exhausted', () => {
  const am = withProviders('when-exhausted');
  assert.equal(am.setCrossProviderFallbackPolicy('bogus'), false);
  assert.equal(am._crossProviderFallbackPolicy(), 'when-exhausted');
  assert.equal(am.setCrossProviderFallbackPolicy('never'), true);
  assert.equal(am._crossProviderFallbackPolicy(), 'never');
  assert.equal(am.setCrossProviderFallbackPolicy('always'), true);
  assert.equal(am._crossProviderFallbackPolicy(), 'always');
  am.scheduler.crossProviderFallbackPolicy = 'garbage-on-disk';
  assert.equal(am._crossProviderFallbackPolicy(), 'when-exhausted', 'invalid persisted value falls back to default');
});

test('getStatus exposes the policy + foreign-pinned session count', () => {
  const am = withProviders('never');
  am.acquireAccount({ profile: 'all', originClass: 'foreign', originProvider: 'zai', sessionKey: 's8' });
  const st = am.getStatus();
  assert.equal(st.routing.crossProviderFallbackPolicy, 'never');
  assert.equal(st.sessions.foreignPinned, 1);
});

// ── unknown origin (fresh session) fails OPEN — never stranded ─────────────────

test('unknown-origin request (no tool blocks yet) routes normally (fail-open, oauth preferred)', () => {
  const am = withProviders('when-exhausted');
  const req = { profile: 'all', originClass: undefined, sessionKey: 's-fresh' };
  const l = am.acquireAccount(req);
  assert.equal(l.account.type, 'oauth', 'no positive foreign signal ⇒ normal Claude routing');
});

// ── honest error (R3) + config default ────────────────────────────────────────

test('unavailableMessage is honest for a foreign-pinned session (not the misleading Claude message)', () => {
  const am = withProviders('when-exhausted');
  am.acquireAccount({ profile: 'all', originClass: 'foreign', originProvider: 'zai', sessionKey: 's-msg' });
  const msg = unavailableMessage(am, { profile: 'all', sessionKey: 's-msg' }, 30, true);
  assert.match(msg, /GLM/, 'names the real (provider) blocker');
  assert.doesNotMatch(msg, /5h or weekly|all \d+ (are|accounts)/i, 'does not blame Claude quota');
  assert.doesNotMatch(msg, /signed thinking/i, 'does not blame signed thinking');
});

test('createDefaultConfig ships the cross-provider policy default', () => {
  assert.equal(createDefaultConfig().scheduler.crossProviderFallbackPolicy, 'when-exhausted');
});

// ── the SEAM: describeRequest → requestInfo.originClass (what the gate actually reads) ──

test('describeRequest wires transcript origin onto requestInfo (the seam routing reads)', () => {
  const req = { method: 'POST', url: '/v1/messages' };
  const body = obj => Buffer.from(JSON.stringify(obj));
  const glm = describeRequest(req, body({ model: 'claude-opus-4-8', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call_abc', name: 'x', input: {} }] }] }));
  assert.equal(glm.originClass, 'foreign', 'a GLM (call_) transcript resolves to foreign on requestInfo');
  assert.equal(glm.originProvider, 'zai');
  const ant = describeRequest(req, body({ model: 'claude-opus-4-8', messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'x', input: {} }] }] }));
  assert.equal(ant.originClass, 'anthropic');
  const fresh = describeRequest(req, body({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(fresh.originClass, undefined, 'no tool blocks ⇒ originClass unset (routing fails open)');
});
