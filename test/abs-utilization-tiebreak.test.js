// Absolute weekly headroom as a TIE-BREAK for new conversations (2026-11-15): at equal
// load and equal pace-adjusted weekly, the account with more weekly left wins. A held
// conversation is unaffected (its steering terms are zeroed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const DAY = 24 * 3600_000;
function pool() {
  const am = new AccountManager(['heavy', 'fresh'].map(n => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, accountUuid: `U-${n}` })), 0.95, { routingMode: 'balance' });
  const [heavy, fresh] = am.accounts;
  // Both reset in a day, so the pace-adjusted weekly is 0 for both: only the absolute
  // used fraction tells them apart.
  for (const [a, wk] of [[heavy, 0.60], [fresh, 0.05]]) {
    Object.assign(a.quota, { unified5h: 0.10, unified5hReset: Date.now() + 3600_000, unified7d: wk, unified7dReset: Date.now() + DAY });
  }
  return { am, heavy, fresh };
}

test('equal load: a 5%-weekly account beats a 60%-weekly one for a new conversation', () => {
  const { am, fresh } = pool();
  const l = am.acquireAccount({ profile: 'claude', affinityKey: 'new', model: 'claude-opus-5-5', weight: 1 });
  assert.equal(l.account.name, fresh.name);
  am.releaseAccount(l);
});

test('a conversation held by the 60% account stays there', () => {
  const { am, heavy } = pool();
  am.noteConversationServed({ affinityKey: 'held' }, heavy);
  const l = am.acquireAccount({ profile: 'claude', affinityKey: 'held', model: 'claude-opus-5-5', weight: 1 });
  assert.equal(l.account.name, heavy.name);
  am.releaseAccount(l);
});
