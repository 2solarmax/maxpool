// Cache-affinity routing (owner 2026-11-08): in balance mode a conversation stays
// on the account it used last unless real pressure (load gap, quota wall,
// exclusion, failure) says move — because the prompt cache is per account and a
// hop re-writes the whole prefix (72% of all Anthropic cache writes over 24h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';

const acct = (n) => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, upstream: 'http://127.0.0.1:1' });
const am = (n = 3, opts = {}) => new AccountManager(
  Array.from({ length: n }, (_, i) => acct(`a${i + 1}`)), 0.9,
  { routingMode: 'balance', ...opts });
const release = (l) => am_ref.releaseAccount(l, { status: 200, success: true });
let am_ref;
const acquire = (mgr, sessionKey = 'sess-x', excluded) => mgr.acquireAccount({ sessionKey, model: 'claude-opus-5-5', weight: 10 }, excluded);

test('balance: consecutive turns stay on the same account at comparable load', () => {
  const m = am(); am_ref = m;
  const first = acquire(m); assert.ok(first, 'first acquire');
  const name1 = first.account.name; release(first);
  const second = acquire(m);
  assert.equal(second.account.name, name1, 'second turn stays on the first account');
  release(second);
});

test('balance: a major load gap moves the session (two large turns of extra depth)', () => {
  const m = am(); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  const sibling = m.accounts.find(a => a.name !== name1);
  sibling.activeWeight = 0; sibling.inFlight = 0;
  // ~100 weight units of extra depth on the bound account (≈1200 points) — far past the bonus:
  first.account.activeWeight = 1200;
  const moved = acquire(m, 'sess-x');
  assert.notEqual(moved.account.name, name1, 'session moved off the heavily loaded account');
  release(moved);
});

test('balance: exclusion of the last-used account fails over immediately', () => {
  const m = am(); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  const second = acquire(m, 'sess-x', new Set([first.account.index]));
  assert.ok(second && second.account.name !== name1, 'served by another account');
  release(second);
});

test('bonus is configurable: 0 restores pure balancing (turn can hop)', () => {
  const m = am(2, { cacheAffinityBonus: 0 }); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  m.accounts.forEach(a => { a.activeWeight = 0; });
  // Without the bonus the sibling is now strictly lighter → pure balancing hops.
  const sibling = m.accounts.find(a => a.name !== name1); sibling.activeWeight = 0;
  first.account.activeWeight = 20;
  const second = acquire(m);
  assert.notEqual(second.account.name, name1, 'no bonus → hops to the lighter account');
  release(second);
});

test('sticky mode: binding path unchanged (returns the bound account regardless of siblings)', () => {
  const m = am(2, { routingMode: 'sticky' }); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.activeWeight = 500; // heavy home still returned in sticky mode
  const second = acquire(m);
  assert.equal(second.account.name, name1);
  release(second);
});

test('affinity releases when the last-used account nears its 5-hour limit', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.quota.unified5h = 0.87; first.account.quota.unified5hReset = Date.now() + 3600_000;
  first.account.activeWeight = 20; // modest extra load: affinity alone would have held it
  const next = acquire(m);
  assert.notEqual(next.account.name, name1, 'near the 5h wall → conversation moves');
  release(next);
});

test('affinity releases when the last-used account is in its weekly reserve tier', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.quota.unified7d = 0.9; first.account.quota.unified7dReset = Date.now() + 3 * 86400_000;
  m.accounts.find(a => a !== first.account).quota.unified7d = 0.1;
  first.account.activeWeight = 20;
  const next = acquire(m);
  assert.notEqual(next.account.name, name1, 'weekly reserve → conversation moves');
  release(next);
});

test('GLM rows get the same affinity, released by GLM\'s own 5-hour reading', () => {
  const m = am(1); am_ref = m;
  m.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' });
  const glm = m.accounts.find(a => a.type === 'provider');
  m._noteConversationAccount({ sessionKey: 'sess-g' }, glm);
  assert.equal(m._cacheAffinity(glm, { sessionKey: 'sess-g' }), 400, 'same rule as Anthropic');
  // The distinctive case: a GLM plan WITH a low weekly reading (used=weekly → 'normal')
  // whose 5-HOUR window is near the wall — only the explicit providerSes gate releases.
  glm.quota.providerWk = 0.2; glm.quota.providerSes = 0.87;
  assert.equal(m._cacheAffinity(glm, { sessionKey: 'sess-g' }), 0, 'GLM near its 5h wall → released');
  glm.quota.providerSes = 0.3;
  assert.equal(m._cacheAffinity(glm, { sessionKey: 'sess-g' }), 400, 'healthy again → holds');
});

test('affinity releases after a failure on the last-used account', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.consecutiveFailures = 1; // failed recently, not cooling down
  first.account.activeWeight = 20;
  const next = acquire(m);
  assert.notEqual(next.account.name, name1, 'a failing account loses its hold on the conversation');
  release(next);
});

test('sticky mode: no affinity discount (its rebalance must be able to leave a hot account)', () => {
  const m = am(2, { routingMode: 'sticky' }); am_ref = m;
  const first = acquire(m); release(first);
  assert.equal(m._cacheAffinity(first.account, { sessionKey: 'sess-x' }), 0);
});

test('prefer-claude mode: affinity applies too (scored mode)', () => {
  const m = am(2, { routingMode: 'prefer-claude' }); am_ref = m;
  const first = acquire(m); release(first);
  assert.equal(m._cacheAffinity(first.account, { sessionKey: 'sess-x' }), 400);
});

test('affinity HOLDS in the soft weekly tier (65-85% — normal mid-week)', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); release(first);
  first.account.quota.unified7d = 0.72; first.account.quota.unified7dReset = Date.now() + 3 * 86400_000;
  assert.equal(m._weeklyRawState(first.account), 'soft', 'fixture is in the soft tier');
  assert.equal(m._cacheAffinity(first.account, { sessionKey: 'sess-x' }), 400);
});

test('fan-out: subagents on other accounts do not drag the MAIN conversation off its account', () => {
  const m = am(3); am_ref = m;
  const main = { sessionKey: 'term-1', affinityKey: 'term-1:MAIN', model: 'claude-opus-5-5', weight: 10 };
  const first = m.acquireAccount(main); const home = first.account.name;
  m.releaseAccount(first, { status: 200, success: true });
  // Same terminal, different conversations (subagents) forced onto the OTHER accounts.
  for (const a of m.accounts.filter(x => x.name !== home)) {
    const l = m.acquireAccount({ sessionKey: 'term-1', affinityKey: `term-1:SUB-${a.name}`, model: 'claude-opus-5-5', weight: 10 },
      new Set(m.accounts.filter(x => x !== a).map(x => x.index)));
    assert.equal(l.account.name, a.name); m.releaseAccount(l, { status: 200, success: true });
  }
  const again = m.acquireAccount(main);
  assert.equal(again.account.name, home, 'main conversation returns to ITS account, not the last subagent\'s');
  m.releaseAccount(again, { status: 200, success: true });
});

test('no readable quota (Kimi console-only) → no affinity', () => {
  const m = am(1); am_ref = m;
  m.addAccount({ name: 'kimi', type: 'provider', provider: 'kimi', apiKey: 'kk' });
  const kimi = m.accounts.find(a => a.provider === 'kimi');
  kimi.quota.providerQuotaSource = 'console-only';
  m._noteConversationAccount({ sessionKey: 'k' }, kimi);
  assert.equal(m._cacheAffinity(kimi, { sessionKey: 'k' }), 0);
});

test('bonus is scaled to the row\'s per-unit price (discounted rows tolerate the same depth)', () => {
  const m = am(1); am_ref = m;
  const a = m.accounts[0];
  m._noteConversationAccount({ sessionKey: 's' }, a);
  assert.equal(m._cacheAffinity(a, { sessionKey: 's' }), 400, 'undiscounted row: full bonus');
  const orig = m._fastRefillMultiplier.bind(m);
  m._fastRefillMultiplier = () => 0.4;
  assert.ok(Math.abs(m._cacheAffinity(a, { sessionKey: 's' }) - 160) < 1e-9, 'unit at 0.4x → bonus at 0.4x');
  m._fastRefillMultiplier = orig;
});

test('conversation map is bounded (LRU)', () => {
  const m = am(1); am_ref = m;
  for (let i = 0; i < 5005; i++) m._noteConversationAccount({ affinityKey: `k${i}` }, m.accounts[0]);
  assert.equal(m.conversationLastAccount.size, 5000);
  assert.equal(m.conversationLastAccount.has('k0'), false, 'oldest dropped');
  assert.equal(m.conversationLastAccount.has('k5004'), true);
});

test('conversation hash: stable across turns, distinct per conversation (main vs subagent)', () => {
  const req = { method: 'POST', url: '/v1/messages' };
  const body = (sys, msgs) => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', system: sys, messages: msgs }));
  const sys = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
  const t1 = __serverTest.describeRequest(req, body(sys, [{ role: 'user', content: 'build X' }]));
  const t2 = __serverTest.describeRequest(req, body(sys, [{ role: 'user', content: 'build X' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }]));
  const sub = __serverTest.describeRequest(req, body([{ type: 'text', text: 'You are a search agent.' }], [{ role: 'user', content: 'find Y' }]));
  assert.ok(t1.conversationHash && t1.conversationHash === t2.conversationHash, 'same conversation, later turn → same key');
  assert.notEqual(t1.conversationHash, sub.conversationHash, 'a subagent is its own conversation');
});

test('bonus scales with conversation size: a 500K-token conversation holds harder than a small one', () => {
  const m = am(2); am_ref = m;
  const first = m.acquireAccount({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 20_000 });
  const home = first.account.name; m.releaseAccount(first, { status: 200, success: true });
  const small = m._cacheAffinity(m.accounts.find(a => a.name === home), { sessionKey: 's', affinityKey: 's:h', bodyBytes: 20_000 });
  const big = m._cacheAffinity(m.accounts.find(a => a.name === home), { sessionKey: 's', affinityKey: 's:h', bodyBytes: 500_000 });
  assert.equal(small, 400, 'small conversation: base bonus');
  assert.equal(big, 1200, '500K conversation: 3x cap');
});

test('conversation-move evidence log: fires once when a known conversation changes account', async () => {
  const logs = [];
  const origLog = console.log; console.log = l => { if (typeof l === 'string' && l.startsWith('[Maxpool]')) logs.push(l); };
  try {
    const m = am(2); am_ref = m;
    const first = m.acquireAccount({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000 });
    m.releaseAccount(first, { status: 200, success: true });
    m._noteConversationAccount({ affinityKey: 's:h' }, m.accounts.find(a => a.name !== first.account.name)); // pretend it ran elsewhere
    // Force a move back: exclude everyone except the first account.
    const excl = new Set(m.accounts.filter(a => a.name !== first.account.name).map(a => a.index));
    const next = m.acquireAccount({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000 }, excl);
    m.releaseAccount(next, { status: 200, success: true });
    assert.ok(logs.some(l => l.includes('conversation moved:') && l.includes('→')), `log line present: ${logs.filter(Boolean).join(' | ')}`);
  } finally { console.log = origLog; }
});
