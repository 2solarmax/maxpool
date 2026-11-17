// GLM-family routing (owner 2026-11-17, audit of 2026-11-16 Mac pool logs):
//  1. z.ai's prompt cache is shared across z.ai accounts (GLM->GLM hops re-wrote ~150-2.6k
//     tokens vs ~190k for a GLM->Claude hop), so a conversation warm on one GLM row is warm
//     on EVERY GLM row. When its GLM row refuses busy it should go to another GLM row before
//     a cold Claude row. 244 GLM->Claude hops carried 46M of 60M Claude cache writes.
//  2. The Claude "home" memory is written when a turn is SERVED, not on every attempt
//     (a refused attempt must not re-arm or disarm return-home).
//  3. A long conversation that already paid one cold Claude re-write and is back on GLM
//     waits (capped, coldClaudeRepeatHoldMs, default 2 min) for a GLM row instead of
//     paying a second cold re-write. Owner: "yes, red team and go".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const claude = (n) => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, upstream: 'http://127.0.0.1:1' });
const glm = (n) => ({ name: n, type: 'provider', provider: 'zai', apiKey: `k-${n}` });
const kimi = (n) => ({ name: n, type: 'provider', provider: 'kimi', apiKey: `k-${n}` });
const mgr = (accts, opts = {}) => new AccountManager(accts, 0.9, { routingMode: 'balance', ...opts });
const BIG = 600_000;
const ri = (over = {}) => ({ affinityKey: 'cv:A', model: 'claude-opus-5-5', weight: 10, bodyBytes: BIG, stream: true, profile: 'all', ...over });
const byName = (m, n) => m.accounts.find(a => a.name === n);
// A turn SERVED by `account` (what releaseAccount / the server do on the first real byte).
const served = (m, account, over = {}) => { const r = ri(over); m._noteConversationAccount(r, account); m.noteConversationServed(r, account); };

// ── 1. family affinity ────────────────────────────────────────────────────────
test('a GLM-warm conversation whose GLM row is excluded goes to a GLM sibling, not a cold Claude row', () => {
  const m = mgr([glm('g1'), glm('g2'), claude('c1')]);
  served(m, byName(m, 'g1'));
  // The sibling carries some load; Claude is idle — without family affinity Claude wins.
  byName(m, 'g2').activeWeight = 20; byName(m, 'g2').inFlight = 2;
  const lease = m.acquireAccount(ri(), new Set([byName(m, 'g1').index]));
  assert.equal(lease?.account.name, 'g2', 'z.ai cache is shared: the GLM sibling is warm');
});

test('family affinity does not cross providers: a Kimi row is not warm for a GLM conversation', () => {
  const m = mgr([glm('g1'), kimi('k1'), claude('c1')]);
  served(m, byName(m, 'g1'));
  const k = byName(m, 'k1');
  assert.equal(m._cacheAffinity(k, ri()), 0, 'kimi gets no bonus from a z.ai holder');
  assert.ok(m._cacheAffinity(byName(m, 'g1'), ri()) > 0, 'the holder keeps its bonus');
});

test('a Claude-warm conversation gets no bonus on GLM rows (family affinity is GLM->GLM only)', () => {
  const m = mgr([glm('g1'), claude('c1'), claude('c2')]);
  served(m, byName(m, 'c1'));
  assert.equal(m._cacheAffinity(byName(m, 'g1'), ri()), 0);
  assert.equal(m._cacheAffinity(byName(m, 'c2'), ri()), 0, 'Claude cache stays per account');
});

// ── 2. home memory at serve ───────────────────────────────────────────────────
test('a refused Claude attempt does not disarm return-home; only a served Claude turn does', () => {
  const m = mgr([glm('g1'), claude('c1'), claude('c2')]);
  served(m, byName(m, 'c1'));
  served(m, byName(m, 'g1'));            // detour served on GLM
  assert.equal(m._returnHome(ri())?.name, 'c1', 'detoured -> home armed');
  // An attempt on c2 that is refused before any byte (acquire, then a busy bounce).
  const r = ri();
  const lease = m.acquireAccount(r, new Set([byName(m, 'g1').index, byName(m, 'c1').index]));
  assert.equal(lease?.account.name, 'c2');
  m.releaseAccount(lease, { bounced: true, status: 503, error: 'remote_pinned_busy', refusal: 'busy' });
  assert.equal(m._returnHome(ri())?.name, 'c1', 'the refused attempt left home and the detour flag alone');
});

test('a refused GLM attempt does not mark a detour', () => {
  const m = mgr([glm('g1'), claude('c1')]);
  served(m, byName(m, 'c1'));
  const lease = m.acquireAccount(ri(), new Set([byName(m, 'c1').index]));
  assert.equal(lease?.account.name, 'g1');
  m.releaseAccount(lease, { bounced: true, status: 503, error: 'remote_pinned_busy', refusal: 'busy' });
  assert.equal(m._returnHome(ri()), null, 'no GLM turn was served, so there is no detour to return from');
});

// ── 3. repeat cold-hop hold ───────────────────────────────────────────────────
function repeatOffender(opts = {}) {
  const m = mgr([glm('g1'), glm('g2'), claude('c1')], opts);
  const t0 = Date.now() - 3_600_000;
  // GLM-warm conversation hops cold to Claude once (no Claude copy yet) ...
  served(m, byName(m, 'g1'), { now: t0 });
  served(m, byName(m, 'c1'), { now: t0 + 1000 });
  // ... then went back to GLM long ago enough that the Claude copy is dead.
  served(m, byName(m, 'g2'), { now: t0 + 2000 });
  m.conversationLastClaudeAccount.get('cv:A').at = Date.now() - 20 * 60_000;
  return m;
}

test('a repeat offender waits for GLM: Claude is not a route while a GLM row can serve soon', () => {
  const m = repeatOffender();
  const allGlm = new Set([byName(m, 'g1').index, byName(m, 'g2').index]);
  const r = ri();
  assert.equal(m.hasAvailableRoute(r, allGlm), false, 'busy GLM rows excluded -> no route -> the request queues');
  assert.equal(m.acquireAccount(r, allGlm), null, 'and acquire does not place it on cold Claude');
  // A GLM row frees: it serves.
  const lease = m.acquireAccount(ri());
  assert.match(lease?.account.name, /^g/);
});

test('the hold is capped: after coldClaudeRepeatHoldMs the request may go to Claude', () => {
  const m = repeatOffender({ coldClaudeRepeatHoldMs: 120_000 });
  const allGlm = new Set([byName(m, 'g1').index, byName(m, 'g2').index]);
  const r = ri();
  assert.equal(m.hasAvailableRoute(r, allGlm), false);
  r._coldHoldStartedAt = Date.now() - 121_000;   // the hold began over 2 minutes ago
  assert.equal(m.hasAvailableRoute(r, allGlm), true, 'cap reached -> Claude is a route again');
  assert.equal(m.acquireAccount(r, allGlm)?.account.name, 'c1');
});

test('no hold for a first-time hop (never paid a cold Claude write)', () => {
  const m = mgr([glm('g1'), claude('c1')]);
  served(m, byName(m, 'g1'));
  assert.equal(m.hasAvailableRoute(ri(), new Set([byName(m, 'g1').index])), true);
});

test('no hold while the Claude copy is still warm (returned to GLM minutes ago)', () => {
  const m = repeatOffender();
  m.conversationLastClaudeAccount.get('cv:A').at = Date.now() - 60_000;
  assert.equal(m.hasAvailableRoute(ri(), new Set([byName(m, 'g1').index, byName(m, 'g2').index])), true);
});

test('no hold for small prompts, count_tokens, non-streaming, or with the knob at 0', () => {
  const ex = (m) => new Set([byName(m, 'g1').index, byName(m, 'g2').index]);
  let m = repeatOffender();
  assert.equal(m.hasAvailableRoute(ri({ bodyBytes: 40_000 }), ex(m)), true, 'small prompt');
  assert.equal(m.hasAvailableRoute(ri({ isCountTokens: true }), ex(m)), true, 'count_tokens');
  assert.equal(m.hasAvailableRoute(ri({ stream: false }), ex(m)), true, 'non-streaming');
  m = repeatOffender({ coldClaudeRepeatHoldMs: 0 });
  assert.equal(m.hasAvailableRoute(ri(), ex(m)), true, 'knob 0 = off');
});

test('no hold when no GLM row can serve soon (all weekly-capped or rate-limited past the cap)', () => {
  const m = repeatOffender();
  for (const n of ['g1', 'g2']) {
    const a = byName(m, n);
    a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 3_600_000;
  }
  assert.equal(m.hasAvailableRoute(ri(), new Set()), true, 'waiting would buy nothing -> Claude now');
});

test('a served GLM->Claude hop with a cold Claude copy is remembered as a cold hop; a warm return is not', () => {
  const m = mgr([glm('g1'), claude('c1')]);
  served(m, byName(m, 'c1'));
  served(m, byName(m, 'g1'));
  served(m, byName(m, 'c1'));          // back within seconds: copy warm
  assert.equal(m.conversationColdClaudeHops.has('cv:A'), false, 'warm return is not a cold hop');
  served(m, byName(m, 'g1'));
  m.conversationLastClaudeAccount.get('cv:A').at = Date.now() - 20 * 60_000;
  served(m, byName(m, 'c1'));
  assert.equal(m.conversationColdClaudeHops.has('cv:A'), true, 'cold return remembered');
});

// ── guards pinned by mutation (each of these survived a mutant before) ─────────
test('Kimi caches stay per account: a Kimi sibling of a Kimi holder gets no bonus', () => {
  const m = mgr([kimi('k1'), kimi('k2'), claude('c1')]);
  served(m, byName(m, 'k1'));
  assert.ok(m._cacheAffinity(byName(m, 'k1'), ri()) > 0, 'holder keeps its bonus');
  assert.equal(m._cacheAffinity(byName(m, 'k2'), ri()), 0, 'unmeasured provider: no family bonus');
});

test('no hold once the conversation is back on Claude (Claude is its holder, even if idle a while)', () => {
  const m = repeatOffender();
  served(m, byName(m, 'c1'));
  m.conversationLastClaudeAccount.get('cv:A').at = Date.now() - 20 * 60_000;
  assert.equal(m.hasAvailableRoute(ri(), new Set([byName(m, 'g1').index, byName(m, 'g2').index])), true);
});

test('an invalid hold setting never holds (not an endless wait)', () => {
  const m = repeatOffender({ coldClaudeRepeatHoldMs: 'soon' });
  assert.equal(m.hasAvailableRoute(ri(), new Set([byName(m, 'g1').index, byName(m, 'g2').index])), true);
});

// ── red-team 2026-11-17 f1: a held request must not stall unrelated traffic ─────
test('a held request waiting for GLM does not block another request from an idle Claude row', () => {
  const m = repeatOffender();
  const allGlm = new Set([byName(m, 'g1').index, byName(m, 'g2').index]);
  const held = ri();
  assert.equal(m.hasAvailableRoute(held, allGlm), false, 'the repeat offender holds');
  held._coldHoldStartedAt = Date.now();               // it is now parked, polling
  m.registerQueuedRequest({ ...held, sessionKey: 'sess-held' }, {});
  m.queueState.waiting[0].requestInfo = held;          // in the line, as queueAndRetry leaves it
  // An unrelated small claude-profile request from another terminal, c1 idle:
  const other = { sessionKey: 'sess-other', profile: 'claude', model: 'claude-opus-5-5', weight: 1, bodyBytes: 30_000, stream: true };
  assert.equal(m.hasAvailableRoute(other, new Set()), true, 'Claude is a route for it');
  const lease = m.acquireAccount(other, new Set());
  assert.equal(lease?.account.name, 'c1', 'served at once on the idle Claude row');
});

// ── red-team 2026-11-17 f2: dead GLM rows must not keep the hold alive ─────────
for (const [what, mark] of [
  ['auth error', (a) => { a.status = 'error'; }],
  ['exhausted', (a) => { a.status = 'exhausted'; }],
  ['subscription gone', (a) => { a.subscriptionGone = true; }],
  ['provisional upstream block past the cap', (a) => { a.provisionalUpstreamUntil = Date.now() + 3_600_000; }],
]) {
  test(`no hold when every GLM row is ${what}`, () => {
    const m = repeatOffender();
    for (const n of ['g1', 'g2']) mark(byName(m, n));
    assert.equal(m.hasAvailableRoute(ri(), new Set()), true, 'waiting would buy nothing -> Claude now');
  });
}

test('a ticketed request is not kept behind a cold-held ticket at the head of the line', () => {
  const m = repeatOffender();
  const held = ri();
  m.hasAvailableRoute(held, new Set([byName(m, 'g1').index, byName(m, 'g2').index]));
  assert.ok(held._coldHoldStartedAt != null);
  assert.ok(m.registerQueuedRequest({ ...held, sessionKey: 'sess-held' }, {}) || true);
  m.queueState.waiting[0].requestInfo = held;
  const other = { sessionKey: 'sess-other', profile: 'claude', model: 'claude-opus-5-5', weight: 1, bodyBytes: 30_000, stream: true };
  m.registerQueuedRequest(other, {});
  assert.equal(m.queueState.waiting.length, 2, 'both in line, the held one first');
  assert.equal(m.canAdmitQueuedRequest(other), true, 'admitted at once, not after the 60 s head-skip');
});

test('once the hold cap has passed, the ticket is an ordinary fair waiter again', () => {
  const m = repeatOffender({ coldClaudeRepeatHoldMs: 120_000 });
  // same request shape the live hold stamped (big, streaming, GLM-warm, cold-hop remembered)
  const req = ri();
  assert.equal(m._coldClaudeHold(req), true, 'the hold is live for this request');
  const t = { id: 1, queuedAt: Date.now(), requestInfo: { ...req, _coldHoldStartedAt: Date.now() - 121_000 } };
  assert.equal(m._coldHeldTicket(t), false, 'cap passed -> ordinary waiter');
  assert.equal(m._coldHeldTicket({ id: 2, queuedAt: Date.now(), requestInfo: { ...req, _coldHoldStartedAt: Date.now() } }), true);
});

test('a cold-held ticket at the FRONT of the line keeps its turn for GLM rows', () => {
  const m = repeatOffender();
  const held = ri();
  m.hasAvailableRoute(held, new Set([byName(m, 'g1').index, byName(m, 'g2').index]));
  m.registerQueuedRequest(held, {});
  const other = { sessionKey: 'sess-other', profile: 'claude', model: 'claude-opus-5-5', weight: 1, bodyBytes: 30_000, stream: true };
  m.registerQueuedRequest(other, {});
  assert.equal(m.canAdmitQueuedRequest(held), true, 'front of the line, admitted for a GLM row');
});

// ── red-team r2 ───────────────────────────────────────────────────────────────
test('a hold that releases early (GLM rows die mid-wait) turns its ticket back into a normal waiter', () => {
  const m = repeatOffender();
  const held = ri();
  m.hasAvailableRoute(held, new Set([byName(m, 'g1').index, byName(m, 'g2').index]));
  m.registerQueuedRequest(held, {});
  assert.equal(m._coldHeldTicket(m.queueState.waiting[0]), true);
  for (const n of ['g1', 'g2']) { byName(m, n).status = 'error'; }
  assert.equal(m._coldHeldTicket(m.queueState.waiting[0]), false, 'hold is off -> ordinary waiter');
  const other = { sessionKey: 'sess-other', profile: 'claude', model: 'claude-opus-5-5', weight: 1, bodyBytes: 30_000, stream: true };
  m.registerQueuedRequest(other, {});
  assert.equal(m.canAdmitQueuedRequest(other), false, 'queued behind a normal head again (fairness restored)');
});

test('no hold when GLM is hard-barred by the peak-hour setting for the whole cap', () => {
  const m = repeatOffender();
  // peak window covering now through the end of the cap, cap 0 = never serve.
  m.scheduler.providers = { zai: { peakCap: 0, peakTimezone: 'UTC', peakWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }] } };
  m._peakCache = null;
  assert.equal(m.hasAvailableRoute(ri(), new Set([byName(m, 'g1').index, byName(m, 'g2').index])), true, 'GLM can never serve -> Claude now');
});
