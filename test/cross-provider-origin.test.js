// Cross-provider compatibility (v2 — narrowed): Claude/GLM/Kimi INTEROPERATE for
// ordinary sessions (regular tool_use ids pass Anthropic's loose validation). The
// ONLY hard, predicted-ahead incompatibility is a foreign `server_tool_use` id
// (Anthropic 400s on ^srvtoolu_ — the reported bug); everything uncertain self-heals
// via react-and-heal (a pre-stream 400 → latch incompatible → retry provider-only).
// A Kimi session (or GLM without server-tools) CAN run on Claude, and a Claude
// session (incl. signed thinking) can fall to GLM/Kimi when Claude is unavailable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';
import { createDefaultConfig } from '../src/config.js';

const { detectTranscriptOrigin, unavailableMessage, describeRequest, isAnthropicIncompatBody } = __serverTest;

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
const asst = block => ({ messages: [{ role: 'assistant', content: [block] }] });

// ── detector: ONLY foreign server_tool_use is incompatible ────────────────────

test('detectTranscriptOrigin flags ONLY a foreign server_tool_use id as anthropicIncompatible', () => {
  // The hard 400: a server_tool_use id not matching ^srvtoolu_.
  assert.deepEqual(detectTranscriptOrigin(asst({ type: 'server_tool_use', id: 'call_x', name: 'web', input: {} })), { anthropicIncompatible: true, homeProvider: 'zai' });
  assert.deepEqual(detectTranscriptOrigin(asst({ type: 'server_tool_use', id: 'srvtoolu_ok', name: 'web', input: {} })), { anthropicIncompatible: false, homeProvider: null });
  // Regular tool_use ids are NOT incompatible (Anthropic accepts call_/tool_ loosely)
  // — only a homeProvider hint is recorded.
  assert.deepEqual(detectTranscriptOrigin(asst({ type: 'tool_use', id: 'call_g', name: 'x', input: {} })), { anthropicIncompatible: false, homeProvider: 'zai' });
  assert.deepEqual(detectTranscriptOrigin(asst({ type: 'tool_use', id: 'tool_k', name: 'x', input: {} })), { anthropicIncompatible: false, homeProvider: 'kimi' });
  assert.deepEqual(detectTranscriptOrigin(asst({ type: 'tool_use', id: 'toolu_1', name: 'x', input: {} })), { anthropicIncompatible: false, homeProvider: null });
  // No tool blocks → compatible.
  assert.deepEqual(detectTranscriptOrigin({ messages: [{ role: 'user', content: 'hi' }] }), { anthropicIncompatible: false, homeProvider: null });
  assert.deepEqual(detectTranscriptOrigin(null), { anthropicIncompatible: false, homeProvider: null });
});

// ── THE USER'S CORRECTION: Kimi / GLM-without-server-tools can run on Claude ───

test('a Kimi session (tool_ ids, no server_tool_use) is Claude-compatible and PREFERS Claude', () => {
  const am = withProviders('when-exhausted');
  // homeProvider=kimi hint, but NOT incompatible → all account types eligible, Claude preferred (priority 0).
  const req = { profile: 'all', model: 'claude-opus-4-8', homeProvider: 'kimi', sessionKey: 'k1' };
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', req), true, 'Claude eligible for a Kimi session');
  const l = am.acquireAccount(req);
  assert.equal(l.account.type, 'oauth', 'a Kimi session runs on Claude (preferred) — not force-pinned to a provider');
});

test('a GLM session WITHOUT server-tools reaches Claude; a GLM session WITH a foreign server_tool_use does NOT', () => {
  const am = withProviders();
  const plain = { profile: 'all', homeProvider: 'zai', sessionKey: 'g-plain' };
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', plain), true, 'plain GLM session can use Claude');
  const incompat = { profile: 'all', homeProvider: 'zai', anthropicIncompatible: true, sessionKey: 'g-srv' };
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', incompat), false, 'GLM-with-server_tool_use barred from Claude (the 400)');
  const l = am.acquireAccount(incompat);
  assert.equal(l.account.type, 'provider', 'server_tool_use session pinned to a provider');
});

// ── the reported bug still fixed ──────────────────────────────────────────────

test('an anthropicIncompatible session never selects Claude across ALL policies', () => {
  for (const policy of ['never', 'when-exhausted', 'always']) {
    const am = withProviders(policy);
    const req = { profile: 'all', anthropicIncompatible: true, homeProvider: 'zai', sessionKey: `s-${policy}` };
    for (let i = 0; i < 12; i++) {
      const l = am.acquireAccount(req);
      assert.equal(l.account.type, 'provider', `policy ${policy}: never routes an incompatible session to Claude`);
      am.releaseAccount(l, { success: true });
    }
  }
});

// ── providerCrossFallback: GLM↔Kimi crossing under the default 'never' policy ──

function providerFleet(schedulerOpts) {
  const am = new AccountManager(
    [{ name: 'claude1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 }],
    0.90, { crossProviderFallbackPolicy: 'never', ...schedulerOpts },
  );
  am.upsertRuntimeAccount({ name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', authHeader: 'authorization', profiles: ['all'], priority: 10, modelMap: { opus: 'glm-5.2', default: 'glm-5.2' } });
  am.upsertRuntimeAccount({ name: 'kimi-fallback', type: 'provider', provider: 'kimi', authToken: 'k', upstream: 'https://k', authHeader: 'authorization', profiles: ['all'], priority: 20, model: 'kimi-k2.7' });
  return am;
}

test("under 'never', a GLM-origin session STILL crosses to Kimi by default (providerCrossFallback on) — the reliable direction", () => {
  const am = providerFleet();                                   // providerCrossFallback defaults true
  const req = { profile: 'all', anthropicIncompatible: true, homeProvider: 'zai', sessionKey: 'glm-x' };
  assert.equal(am._isRequestCompatible(kimiOf(am), 'all', req), true, 'GLM→Kimi allowed under never (default)');
  assert.equal(am._isRequestCompatible(glmOf(am), 'all', req), true, 'its home GLM still eligible too');
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', req), false, 'but NEVER Claude (the 400 direction)');
});

test("under 'never' with providerCrossFallback:false, a GLM-origin session is strictly home-pinned to GLM", () => {
  const am = providerFleet({ providerCrossFallback: false });
  const req = { profile: 'all', anthropicIncompatible: true, homeProvider: 'zai', sessionKey: 'glm-pin' };
  assert.equal(am._isRequestCompatible(glmOf(am), 'all', req), true, 'home GLM eligible');
  assert.equal(am._isRequestCompatible(kimiOf(am), 'all', req), false, 'strict pin: no GLM→Kimi crossing');
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', req), false, 'still never Claude');
});

// ── Claude → provider fallback (the "use Kimi if no Claude" direction) ─────────

test('a Claude session falls to a provider only when Claude is exhausted (when-exhausted default)', () => {
  const am = withProviders('when-exhausted');
  const req = { profile: 'all', sessionKey: 'c1' };
  assert.equal(am.acquireAccount(req).account.type, 'oauth', 'Claude preferred while available');
  disableOauth(am);
  assert.equal(am.acquireAccount(req).account.type, 'provider', 'falls to a provider once Claude is down');
});

test("policy 'never' keeps a Claude session on Claude (no provider fallback)", () => {
  const am = withProviders('never');
  const req = { profile: 'all', sessionKey: 'c2' };
  assert.equal(am._isRequestCompatible(glmOf(am), 'all', req), false);
  disableOauth(am);
  assert.equal(am.getActiveAccount(req), null, 'never crosses to a provider');
});

test("policy 'always' peers providers with Claude for a compatible session", () => {
  const am = withProviders('always');
  assert.equal(am._effectivePriority(glmOf(am), { profile: 'all' }), 0, 'provider peers under always');
  // Under balance mode (migrated from 'always'), the incompatible-session home
  // provider peers at priority 0 — same as any account in balance mode.
  assert.equal(am._effectivePriority(glmOf(am), { anthropicIncompatible: true }), 0, 'balance mode: incompatible home provider peers');
});

// ── signed thinking: fallback allowed, MIGRATION stays Claude-only ────────────

test('a signed-thinking Claude session CAN fall to a provider (when-exhausted), but its live migration stays Claude-only', () => {
  const am = withProviders('when-exhausted');
  const req = { profile: 'all', requiresAnthropicThinkingIntegrity: true, sessionKey: 't1' };
  // Loosened: a provider is eligible for a thinking session (lenient providers accept the signature).
  assert.equal(am._isRequestCompatible(glmOf(am), 'all', req), true);
  // 'never' keeps it Claude-only.
  const strict = withProviders('never');
  assert.equal(strict._isRequestCompatible(glmOf(strict), 'all', req), false);
});

// ── sticky incompatible latch + react-and-heal marker ─────────────────────────

test('incompatible latches per session: a later no-tell follow-up still bars Claude (selector + oracle agree)', () => {
  const am = withProviders('when-exhausted');
  am.acquireAccount({ profile: 'all', anthropicIncompatible: true, homeProvider: 'zai', sessionKey: 's6' }); // _noteRequestPolicy latches
  const followup = { profile: 'all', sessionKey: 's6' };
  assert.equal(am._effectiveIncompatible(followup).incompatible, true, 'sticky incompatible wins');
  assert.equal(am._isRequestCompatible(oauthOf(am), 'all', followup), false);
  am.accounts.filter(a => a.type === 'provider').forEach(a => { a.enabled = false; });
  assert.equal(am.getActiveAccount(followup), null, 'no Claude leak on a sticky-incompatible followup');
  assert.notEqual(am.nextRetryForRequest(followup).cause, 'available', 'oracle agrees with selector');
});

test('markSessionIncompatible (react-and-heal) latches + is exposed in getStatus', () => {
  const am = withProviders('when-exhausted');
  am.markSessionIncompatible('healed', 'kimi');
  assert.equal(am._effectiveIncompatible({ sessionKey: 'healed' }).incompatible, true);
  assert.equal(am.getStatus().sessions.providerPinned, 1);
});

// ── policy setter + honest error + config + describeRequest seam ───────────────

test('setCrossProviderFallbackPolicy validates the enum; invalid persisted value reads as when-exhausted', () => {
  const am = withProviders('when-exhausted');
  assert.equal(am.setCrossProviderFallbackPolicy('bogus'), false);
  assert.equal(am.setCrossProviderFallbackPolicy('never'), true);
  assert.equal(am._crossProviderFallbackPolicy(), 'never');
  am.scheduler.crossProviderFallbackPolicy = 'garbage';
  assert.equal(am._crossProviderFallbackPolicy(), 'when-exhausted');
});

test('unavailableMessage is honest for an incompatible-pinned session (not the misleading Claude message)', () => {
  const am = withProviders('when-exhausted');
  am.markSessionIncompatible('s-msg', 'zai');
  const msg = unavailableMessage(am, { profile: 'all', sessionKey: 's-msg' }, 30, true);
  assert.match(msg, /GLM/);
  assert.doesNotMatch(msg, /5h or weekly|all \d+ (are|accounts)/i);
});

test('createDefaultConfig ships the cross-provider policy default (never — Claude stays on Anthropic)', () => {
  assert.equal(createDefaultConfig().scheduler.crossProviderFallbackPolicy, 'never');
  // The other direction (GLM↔Kimi) ships ON.
  assert.equal(createDefaultConfig().scheduler.providerCrossFallback, true);
});

test('isAnthropicIncompatBody matches the 3 real shapes but NOT a generic 400 echoing the words', () => {
  assert.equal(isAnthropicIncompatBody("server_tool_use.id: String should match pattern '^srvtoolu_'"), true);
  assert.equal(isAnthropicIncompatBody('Invalid `signature` in `thinking` block'), true);
  assert.equal(isAnthropicIncompatBody('messages.4.content.0.thinking.signature: Field required'), true);
  // A user prompt that merely mentions the words must NOT latch the session provider-pinned.
  assert.equal(isAnthropicIncompatBody('Please explain your thinking and the signature style of Bach.'), false);
  assert.equal(isAnthropicIncompatBody('max_tokens: must be greater than 0'), false);
  assert.equal(isAnthropicIncompatBody(''), false);
});

test('react-and-heal does NOT trigger when no provider exists (profile=claude) — the 400 surfaces, session not stranded', () => {
  // With no provider account, an incompatible request has no compatible route: it must
  // yield a route-less verdict rather than a phantom retry. (The HTTP surface-the-400
  // path is covered in server.test.js; here we assert the routing verdict.)
  const am = new AccountManager([
    { name: 'claude1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90, { crossProviderFallbackPolicy: 'when-exhausted' });
  const req = { profile: 'all', anthropicIncompatible: true, homeProvider: 'zai', sessionKey: 'no-prov' };
  assert.equal(am.getActiveAccount(req), null, 'no provider ⇒ no route (honest), never a Claude account');
});

test('describeRequest wires anthropicIncompatible/homeProvider onto requestInfo (the seam routing reads)', () => {
  const req = { method: 'POST', url: '/v1/messages' };
  const body = obj => Buffer.from(JSON.stringify(obj));
  const srv = describeRequest(req, body(asst({ type: 'server_tool_use', id: 'call_x', name: 'web', input: {} })));
  assert.equal(srv.anthropicIncompatible, true);
  assert.equal(srv.homeProvider, 'zai');
  const kimi = describeRequest(req, body(asst({ type: 'tool_use', id: 'tool_k', name: 'x', input: {} })));
  assert.equal(kimi.anthropicIncompatible, undefined, 'a Kimi client tool_use is NOT incompatible');
  assert.equal(kimi.homeProvider, 'kimi', 'but the home-provider hint is recorded');
  const fresh = describeRequest(req, body({ model: 'claude-opus-4-8', messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(fresh.anthropicIncompatible, undefined);
});
