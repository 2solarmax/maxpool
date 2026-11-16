// count_tokens calls (Claude Code measures prompt size constantly) are not conversation
// turns: they carry no prompt cache, so they must neither count as served turns in the
// efficiency figures nor re-point the conversation -> account memory that the busy wait
// (holdsWarmConversation) and move telemetry read. Review 2026-11-16, cluster 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function build() {
  return new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'b', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 36e5 },
  ], 0.9);
}
const lease = (a, requestInfo) => { a.inFlight++; return { account: a, weight: 1, startedAt: Date.now() - 50, requestInfo }; };

test('a successful count_tokens call is not counted as a served turn', () => {
  const am = build();
  const a = am.accounts[0];
  const real = { affinityKey: 'k1', startedAt: Date.now() - 2000 };
  am.noteConversationServed(real, a);
  am.releaseAccount(lease(a, real), { success: true, status: 200 });
  const ct = { affinityKey: 'k1', isCountTokens: true, startedAt: Date.now() - 300 };
  am.noteConversationServed(ct, a);
  am.releaseAccount(lease(a, ct), { success: true, status: 200 });
  const eff = am._efficiencySummary(a, 15 * 60e3);
  assert.equal(eff.served, 1, `only the real turn is served; got ${eff.served}`);
});

test('count_tokens served elsewhere does not re-point the conversation memory', () => {
  const am = build();
  const [a, b] = am.accounts;
  am.noteConversationServed({ affinityKey: 'k1' }, a);
  am.noteConversationServed({ affinityKey: 'k1', isCountTokens: true }, b);
  assert.equal(am.conversationLastAccount.get('k1'), 'a',
    'the conversation still lives on the account holding its cache');
  assert.equal(am.holdsWarmConversation(a, { affinityKey: 'k1' }), true,
    'the next real turn still waits for its warm account');
});
