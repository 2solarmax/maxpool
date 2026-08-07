import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';

const { unavailableMessage } = __serverTest;

// The reported defect: "429 No account can take this request right now — all 9 Claude
// accounts ... at their limit" while the accounts were in 5-SECOND network cooldowns.
// The user reads a quota wall (add accounts? wait hours?) for a blip that clears itself.

const fleet = n => Array.from({ length: n }, (_, i) => ({
  name: `a${i}`, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000,
}));

const netCooled = (am) => {
  for (const a of am.accounts) a.cooldownUntil = Date.now() + am.scheduler.networkCooldownMs;
};

test('a fleet in NETWORK cooldown is not described as out of quota', () => {
  const am = new AccountManager(fleet(9), 0.90);
  netCooled(am);
  const c = am.unavailabilityCensus();
  assert.equal(c.total, 9);
  assert.equal(c.network, 9, 'every account is in a network-length cooldown');
  assert.equal(c.quota, 0, 'none is actually out of quota');
  assert.equal(c.dominant, 'transient');

  const msg = unavailableMessage(am, {}, 5, true);
  assert.match(msg, /reconnect cooldown/, 'names the REAL cause');
  assert.match(msg, /not out of quota/, 'explicitly corrects the quota reading');
  assert.doesNotMatch(msg, /at their limit/, 'must not claim a quota wall');
  assert.match(msg, /9 Claude accounts/, 'still says how many');
});

test('a genuinely quota-exhausted fleet KEEPS the limit message', () => {
  // The guard against over-correcting: a real quota wall must still read as one.
  const am = new AccountManager(fleet(3), 0.90);
  for (const a of am.accounts) {
    a.quota.unified7d = 1.0;
    a.quota.unifiedStatus = 'rejected';
  }
  const c = am.unavailabilityCensus();
  assert.equal(c.quota, 3);
  assert.equal(c.dominant, 'quota');
  const msg = unavailableMessage(am, {}, 3600, true);
  assert.match(msg, /at their limit/, 'a real quota wall still says so');
  assert.doesNotMatch(msg, /reconnect cooldown/);
});

test('a MIXED fleet reports quota only when quota actually dominates', () => {
  const am = new AccountManager(fleet(4), 0.90);
  // 1 exhausted, 3 in network cooldown → transient dominates.
  am.accounts[0].quota.unified7d = 1.0;
  am.accounts[0].quota.unifiedStatus = 'rejected';
  for (const a of am.accounts.slice(1)) a.cooldownUntil = Date.now() + am.scheduler.networkCooldownMs;
  const c = am.unavailabilityCensus();
  assert.equal(c.quota, 1);
  assert.equal(c.network, 3);
  assert.equal(c.dominant, 'transient', '1 of 4 exhausted is not a quota wall');
  assert.match(unavailableMessage(am, {}, 5, true), /not out of quota/);
});

test('a LONG cooldown is not mislabelled as a network blip', () => {
  // A 30-minute rate-limit cooldown is transient but NOT a reconnect blip; saying
  // "brief reconnect cooldown" there would be a new lie in the other direction.
  const am = new AccountManager(fleet(3), 0.90);
  for (const a of am.accounts) a.cooldownUntil = Date.now() + 30 * 60_000;
  const c = am.unavailabilityCensus();
  assert.equal(c.transient, 3);
  assert.equal(c.network, 0, 'a 30-min cooldown is not the 5s network cooldown');
  const msg = unavailableMessage(am, {}, 1800, true);
  assert.doesNotMatch(msg, /reconnect cooldown/, 'must not claim a reconnect blip');
  assert.match(msg, /momentarily busy|at their limit/);
});

test('disabled/error accounts do not count toward the quota verdict', () => {
  const am = new AccountManager(fleet(3), 0.90);
  am.accounts[0].enabled = false;
  am.accounts[1].status = 'error';
  am.accounts[2].cooldownUntil = Date.now() + am.scheduler.networkCooldownMs;
  const c = am.unavailabilityCensus();
  assert.equal(c.disabled, 1);
  assert.equal(c.error, 1);
  assert.equal(c.dominant, 'transient', 'the one ELIGIBLE account is transiently blocked');
});

test('census counts only Claude accounts, never providers', () => {
  const am = new AccountManager([
    ...fleet(2),
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.90);
  assert.equal(am.unavailabilityCensus().total, 2, 'providers are a separate story');
});
