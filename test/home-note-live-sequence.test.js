// "Return home" must survive the live sequence the cloud pool sees: a conversation is
// served on Claude "personal", detours to GLM, then comes back. Every test drives the
// REAL acquireAccount and asserts on the logged `conversation moved:` line and/or the
// lease's returnedHome flag.
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
const HOME = /glm → personal .*home=personal:/;
// Fill the Claude memory past the real 5000 cap with OTHER conversations while the
// target conversation keeps sending the occasional GLM turn.
const evictionPressure = (m) => {
  const other = m.accounts.find(a => a.name === 'other');
  capture(() => {
    for (let i = 0; i < 5200; i++) {
      m._noteConversationAccount(RI({ affinityKey: `o${i}:h`, sessionKey: `o${i}` }), other);
      if (i % 500 === 0) step(m, RI({ pinAccount: 'glm' }));
    }
  });
};

// Leg 1 pins personal; leg 2 makes personal not-eligible (Anthropic-incompatible
// transcript) so GLM serves; leg 3 makes GLM not-eligible (large context), personal back.
test('live sequence: Claude -> GLM -> Claude prints home= note', () => {
  const m = mk();
  const s1 = step(m, RI(), new Set([1, 2]));
  assert.equal(s1.lease.account.name, 'personal');
  m.markSessionIncompatible('s', 'zai');
  const s2 = step(m, RI());
  assert.equal(s2.lease.account.name, 'glm', s2.logs.join('\n'));
  assert.match(s2.line, /personal → glm .*why=released:not-eligible/, s2.line);
  m.clearSessionIncompatible('s');
  m.markSessionLargeContext('s');
  const s3 = step(m, RI(), new Set([1]));
  assert.equal(s3.lease.account.name, 'personal', s3.logs.join('\n'));
  assert.match(s3.line, HOME, `no home note: ${s3.line}`);
});

// Cloud-pool shape: every request arrives pinned to one account.
test('pinned requests: personal -> glm -> personal prints home= note', () => {
  const m = mk();
  assert.equal(step(m, RI({ pinAccount: 'personal' })).lease.account.name, 'personal');
  assert.equal(step(m, RI({ pinAccount: 'glm' })).lease.account.name, 'glm');
  const s3 = step(m, RI({ pinAccount: 'personal' }));
  assert.match(s3.line, HOME, `no home note: ${s3.line}`);
});

test('home survives >5000 other Claude conversations during a long GLM detour', () => {
  const m = mk();
  step(m, RI({ pinAccount: 'personal' }));
  evictionPressure(m);
  const s3 = step(m, RI({ pinAccount: 'personal' }));
  assert.match(s3.line, HOME, `no home note: ${s3.line}`);
});

test('GLM turns do not refresh the home age: a 2h-old home is reported stale', () => {
  const m = mk();
  step(m, RI({ pinAccount: 'personal', now: Date.now() - 2 * 3600_000 }));
  step(m, RI({ pinAccount: 'glm' }));
  // Another Claude account serves the return, so the note reports why home was skipped.
  const s3 = step(m, RI({ pinAccount: 'other' }));
  assert.match(s3.line, /glm → other .*home=personal:skipped\(stale-1[12]\dm\)/, s3.line);
});

test('identity health flips healthy -> degraded mid-detour: home still found', () => {
  const m = mk();
  step(m, RI({ pinAccount: 'personal' }));
  step(m, RI({ pinAccount: 'glm' }));
  m.identityHealth.degraded = true;
  step(m, RI({ pinAccount: 'glm' }));   // a GLM turn under the new (bare terminal) key
  const s3 = step(m, RI({ pinAccount: 'personal' }));
  assert.equal(s3.lease.returnedHome, true);
  assert.match(s3.line, HOME, `no home note: ${s3.line}`);
});

test('identity health recovers degraded -> healthy mid-detour: home still found', () => {
  const m = mk();
  m.identityHealth.degraded = true;
  step(m, RI({ pinAccount: 'personal' }));
  step(m, RI({ pinAccount: 'glm' }));
  m.identityHealth.degraded = false;
  step(m, RI({ pinAccount: 'glm' }));   // a GLM turn under the conversation key again
  const s3 = step(m, RI({ pinAccount: 'personal' }));
  assert.equal(s3.lease.returnedHome, true);
  assert.match(s3.line, HOME, `no home note: ${s3.line}`);
});

test('home survives eviction pressure when health flips before the return', () => {
  const m = mk();
  step(m, RI({ pinAccount: 'personal' }));
  evictionPressure(m);
  m.identityHealth.degraded = true;
  step(m, RI({ pinAccount: 'glm' }));
  const s3 = step(m, RI({ pinAccount: 'personal' }));
  assert.match(s3.line, HOME, `no home note: ${s3.line}`);
});

// Two conversations share one terminal. B is on personal; A lives on other and never
// detoured. When health degrades both collapse to the terminal key — A must not be
// handed B's home.
test('sibling conversation that never detoured is not pulled home when health degrades', () => {
  const m = mk();
  const A = (x = {}) => RI({ affinityKey: 's:A', ...x });
  const B = (x = {}) => RI({ affinityKey: 's:B', ...x });
  step(m, A({ pinAccount: 'other' }));
  step(m, B({ pinAccount: 'personal' }));
  m.identityHealth.degraded = true;
  step(m, B({ pinAccount: 'glm' }));               // B detours; a terminal-keyed home would now be marked
  const sA = step(m, A(), new Set([2]));           // A unpinned, GLM excluded
  assert.match(sA.line, /glm → /, `moved line present: ${sA.line}`);
  assert.doesNotMatch(sA.line, /home=/, sA.line);
  assert.ok(!sA.lease.returnedHome, 'A was not sent home');
});

test('a conversation that never left Claude gets no home note', () => {
  const m = mk();
  step(m, RI({ pinAccount: 'personal' }));
  const s2 = step(m, RI({ pinAccount: 'other' }));
  assert.match(s2.line, /personal → other/, s2.line);
  assert.doesNotMatch(s2.line, /home=/, s2.line);
});

// A Claude turn after the detour clears it: a later Claude -> Claude move has no home.
test('after returning home the detour is over: a later Claude move gets no home note', () => {
  const m = mk();
  step(m, RI({ pinAccount: 'personal' }));
  step(m, RI({ pinAccount: 'glm' }));
  step(m, RI({ pinAccount: 'personal' }));          // home reached, detour over
  const s4 = step(m, RI({ pinAccount: 'other' }));
  assert.match(s4.line, /personal → other/, s4.line);
  assert.doesNotMatch(s4.line, /home=/, s4.line);
});

// Healthy mode, same terminal: B detours to GLM; A never left Claude and must not see
// B's home (the home is per conversation, not per terminal).
test('sibling in the same terminal does not inherit another conversation\'s detour', () => {
  const m = mk();
  const A = (x = {}) => RI({ affinityKey: 's:A', ...x });
  const B = (x = {}) => RI({ affinityKey: 's:B', ...x });
  step(m, A({ pinAccount: 'other' }));
  step(m, B({ pinAccount: 'personal' }));
  step(m, B({ pinAccount: 'glm' }));
  const sA = step(m, A({ pinAccount: 'personal' }));   // A moves other -> personal
  assert.match(sA.line, /other → personal/, sA.line);
  assert.doesNotMatch(sA.line, /home=/, sA.line);
});
