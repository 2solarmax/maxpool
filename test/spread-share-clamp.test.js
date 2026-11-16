// The spread term's share is clamped to 1 (2026-11-15). A GLM/Kimi row is outside the
// Claude-fleet denominator, so its raw share could reach many times 1 and swamp every
// other term in its score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

test('a provider\'s spread share never exceeds 1', () => {
  const am = new AccountManager([
    { name: 'c1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'g1', type: 'provider', provider: 'zai', authToken: 'k' },
  ], 0.9, { routingMode: 'balance' });
  const [c, g] = am.accounts;
  const lease = (a, w) => { a.inFlight++; return { account: a, weight: w, startedAt: Date.now() - 10 }; };
  am.releaseAccount(lease(c, 1), { success: true, status: 200 });
  am.releaseAccount(lease(g, 20), { success: true, status: 200 });   // raw share 20
  const ctx = am._scoringContext();
  assert.equal(ctx.fleetRecentWeight, 1, 'the denominator is the Claude fleet');
  const t = am._scoreTerms(g, { model: 'claude-opus-5-5' }, ctx);
  assert.ok(t.spread > 0, 'still carries a spread cost');
  assert.ok(t.spread <= am.scheduler.spreadShareWeight + 1e-9, `share clamped: spread=${t.spread}`);
});
