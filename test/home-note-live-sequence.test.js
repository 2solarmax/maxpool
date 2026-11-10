// Repro: live cloud pool logs GLM→Claude moves with NO `home=` note.
// Drives the REAL acquire path (acquireAccount) through the live sequence:
//   served on Claude "personal" -> personal not-eligible -> served on GLM
//   -> GLM not-eligible while personal eligible again -> next acquire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const acct = (n) => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, upstream: 'http://127.0.0.1:1' });
const mk = () => {
  const m = new AccountManager([acct('personal'), acct('other')], 0.9,
    { routingMode: 'balance', crossProviderFallbackPolicy: 'always' });
  m.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' });
  return m;
};
const RI = (extra = {}) => ({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5',
  weight: 10, bodyBytes: 10_000, profile: 'all', ...extra });
const capture = (fn) => {
  const logs = []; const orig = console.log;
  console.log = l => { if (typeof l === 'string' && l.startsWith('[Maxpool]')) logs.push(l); };
  try { fn(); } finally { console.log = orig; }
  return logs;
};
const step = (m, ri, excl = new Set()) => {
  let lease; const logs = capture(() => { lease = m.acquireAccount(ri, excl); });
  const line = logs.find(l => l.includes('conversation moved:')) || '';
  if (lease) m.releaseAccount(lease, { status: 200, success: true });
  return { lease, line, logs };
};

// Leg 1 is forced onto personal by pin-free exclusion of siblings; leg 2 is made
// "not-eligible" (live reason) by marking the session Anthropic-incompatible.
test('live sequence via real acquire: Claude -> GLM -> Claude prints home= note', () => {
  const m = mk();
  const by = n => m.accounts.find(a => a.name === n);
  // 1. served on personal
  const s1 = step(m, RI(), new Set([by('other').index, by('glm').index]));
  assert.equal(s1.lease.account.name, 'personal');
  // 2. personal not-eligible (transcript Anthropic-incompatible) -> GLM
  m.markSessionIncompatible('s', 'zai');
  const s2 = step(m, RI());
  assert.equal(s2.lease.account.name, 'glm', s2.logs.join('\n'));
  assert.match(s2.line, /personal → glm .*why=released:not-eligible/, s2.line);
  // 3. GLM not-eligible (context too large for provider), personal eligible again
  m.clearSessionIncompatible('s');
  m.markSessionLargeContext('s');
  const s3 = step(m, RI(), new Set([by('other').index]));
  console.log = console.log;
  process.stderr.write(`LINE3: ${s3.line}\n`);
  assert.equal(s3.lease.account.name, 'personal', s3.logs.join('\n'));
  assert.match(s3.line, /glm → personal .*home=personal:/, `no home note: ${s3.line}`);
});

// Cloud-side shape: every request arrives PINNED (x-maxpool-pin-account) by a linked
// local pool; "not-eligible" in the live log = the previous account is not the pin.
test('pinned requests (cloud pool shape): personal -> glm -> personal prints home= note', () => {
  const m = mk();
  const s1 = step(m, RI({ pinAccount: 'personal' }));
  assert.equal(s1.lease.account.name, 'personal');
  const s2 = step(m, RI({ pinAccount: 'glm' }));
  assert.equal(s2.lease.account.name, 'glm');
  assert.match(s2.line, /personal → glm .*why=released:not-eligible/, s2.line);
  const s3 = step(m, RI({ pinAccount: 'personal' }));
  process.stderr.write(`LINE3-pinned: ${s3.line}\n`);
  assert.equal(s3.lease.account.name, 'personal');
  assert.match(s3.line, /glm → personal .*home=personal:/, `no home note: ${s3.line}`);
});

// Hypothesis (a): identity health flips to degraded between the Claude leg and the
// GLM detour -> _affinityKey switches from "s:h" to "s", the Claude memory lives under
// the OLD key, so the later GLM->Claude move prints with no home note.
test('identity-health flips to degraded mid-detour: home= note survives', () => {
  const m = mk();
  const s1 = step(m, RI({ pinAccount: 'personal' }));
  assert.equal(s1.lease.account.name, 'personal');
  m.identityHealth.degraded = true;               // flip (what _noteIdentityHealth does at >=90% new-id share)
  const s2 = step(m, RI({ pinAccount: 'glm' }));
  assert.equal(s2.lease.account.name, 'glm');
  const s3 = step(m, RI({ pinAccount: 'personal' }));
  process.stderr.write(`LINE3-degraded: ${s3.line}\n`);
  assert.match(s3.line, /glm → personal/, 'moved line printed');
  assert.match(s3.line, /home=personal:/, `no home note: ${s3.line}`);
});

// LRU: other conversations' Claude traffic must not evict the home during a long
// GLM detour (cap CONVERSATION_AFFINITY_MAX = 5000, exercised at the real value).
test('home survives >5000 other Claude conversations while the target keeps sending GLM turns', () => {
  const m = mk();
  const by = n => m.accounts.find(a => a.name === n);
  const s1 = step(m, RI({ pinAccount: 'personal' }));
  assert.equal(s1.lease.account.name, 'personal');
  const logs = capture(() => {
    for (let i = 0; i < 5200; i++) {
      m._noteConversationAccount(RI({ affinityKey: `o${i}:h`, sessionKey: `o${i}` }), by('other'));
      if (i % 500 === 0) { const l = m.acquireAccount(RI({ pinAccount: 'glm' }));
        m.releaseAccount(l, { status: 200, success: true }); }
    }
  });
  void logs;
  const s3 = step(m, RI({ pinAccount: 'personal' }));
  process.stderr.write(`LINE3-evict: ${s3.line}\n`);
  assert.match(s3.line, /glm → personal .*home=personal:/, `no home note: ${s3.line}`);
});

// Refresh must cover EVERY key the Claude memory is written under: evict-pressure while
// healthy, then the identity-health flip makes the reader use the bare session key.
test('home survives eviction pressure on the bare-session key (health flips before return)', () => {
  const m = mk();
  const by = n => m.accounts.find(a => a.name === n);
  step(m, RI({ pinAccount: 'personal' }));
  capture(() => {
    for (let i = 0; i < 5200; i++) {
      m._noteConversationAccount(RI({ affinityKey: `o${i}:h`, sessionKey: `o${i}` }), by('other'));
      if (i % 500 === 0) { const l = m.acquireAccount(RI({ pinAccount: 'glm' }));
        m.releaseAccount(l, { status: 200, success: true }); }
    }
  });
  m.identityHealth.degraded = true;
  step(m, RI({ pinAccount: 'glm' }));   // one more GLM turn, now keyed by the bare session key
  const s3 = step(m, RI({ pinAccount: 'personal' }));
  assert.match(s3.line, /glm → personal .*home=personal:/, `no home note: ${s3.line}`);
});

// The refresh moves LRU position only: `at` must stay the last CLAUDE turn's time, so a
// long detour still reads as stale rather than being made to look fresh by GLM turns.
test('GLM turns do not refresh the home age: a 2h-old home is reported stale', () => {
  const m = mk();
  step(m, RI({ pinAccount: 'personal', now: Date.now() - 2 * 3600_000 }));
  step(m, RI({ pinAccount: 'glm' }));
  const s3 = step(m, RI({ pinAccount: 'other' }));  // another Claude account serves: age decides the note
  assert.match(s3.line, /glm → other .*home=personal:skipped\(stale-1[12]\dm\)/, s3.line);
});
