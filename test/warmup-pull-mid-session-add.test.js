import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 60 * 60 * 1000;

function manager(count) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`, type: 'oauth',
      accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

// Make a BOOT account healthy + a genuine recent carrier (weight > 0) so the
// warmup-pull is willing to relieve it. Boot accounts have no addedAt → never warming.
function makeCarrier(am, idx, util = 0.30) {
  am.applyUsageData(idx, {
    fiveHour: { utilization: 0.10, resetAt: Date.now() + HOUR },
    sevenDay: { utilization: util, resetAt: Date.now() + 152 * HOUR },
  });
  am.accounts[idx].loadEvents = [{ at: Date.now(), durationMs: 100, weight: 5, success: true }];
}

// The real mid-session-add path: addAccount stamps addedAt + resets completedRequests.
function addFresh(am, name = 'fresh') {
  return am.addAccount({ name, type: 'oauth', accessToken: `tok-${name}`, refreshToken: `r-${name}`, expiresAt: Date.now() + 3600_000 });
}

// Migration-safe request (fully thinking-scanned, no signed thinking).
function req(extra = {}) {
  return { profile: 'claude', model: 'claude-sonnet-5', weight: 1, bodyThinkingScanned: true, ...extra };
}

// ── Invariant 1: onboarding FIRES (the reported symptom, in the steady-state case) ─

test('W4.1 a freshly-added account draws a migration-safe bound session WITHOUT a reload', () => {
  const am = manager(2);
  makeCarrier(am, 0);
  makeCarrier(am, 1);
  addFresh(am, 'fresh');                       // warming: addedAt now, completedRequests 0
  am._bindSession('sess1', am.accounts[0], 'claude-sonnet-5');
  const lease = am.acquireAccount(req({ sessionKey: 'sess1' }));
  assert.equal(lease.account.name, 'fresh', 'the just-added account must be used without a reload');
});

// ── Invariant 2: fail-closed on an unscanned body (never migrate signed thinking blindly)

test('W4.2 a request whose body was NOT fully thinking-scanned never warmup-migrates (fail-closed)', () => {
  const am = manager(2);
  makeCarrier(am, 0);
  makeCarrier(am, 1);
  addFresh(am, 'fresh');
  am._bindSession('sess1', am.accounts[0], 'claude-sonnet-5');
  const lease = am.acquireAccount(req({ sessionKey: 'sess1', bodyThinkingScanned: false }));
  assert.equal(lease.account.name, 'a1', 'an unscanned body stays on its bound account');
});

// ── Invariant 3: NEVER lands on a provider — even under 'always', even for signed thinking

test('W4.3 warmup-pull never lands a session on a provider, even under always policy + signed thinking', () => {
  const am = manager(2);
  makeCarrier(am, 0);
  makeCarrier(am, 1);
  am.setCrossProviderFallbackPolicy('always');       // providers peer at priority 0
  am.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' }); // also freshly added, but a provider
  addFresh(am, 'fresh');
  am._bindSession('sess1', am.accounts[0], 'claude-sonnet-5');
  // A signed-thinking request is migration-safe by default (crossAccountThinkingMigration),
  // and _isRequestCompatible does NOT bar providers in the compatible case — so only the
  // DIRECTED non-provider warmup-pull keeps this off glm.
  const lease = am.acquireAccount(req({ sessionKey: 'sess1', requiresAnthropicThinkingIntegrity: true }));
  assert.notEqual(lease.account.type, 'provider', 'a signed-thinking session must never be shuttled onto a provider');
  assert.equal(lease.account.name, 'fresh', 'it onboards the fresh NON-provider account');
});

// ── Invariant 4 + 6: bounded / one-and-done — terminates, no flap ─────────────────

test('W4.4 warmup-pull TERMINATES: the fresh account stops drawing once it is onboarded', () => {
  const am = manager(2);
  makeCarrier(am, 0);
  makeCarrier(am, 1);
  addFresh(am, 'fresh');
  let pulls = 0;
  // 12 distinct sequential sessions, each bound to the carrier a1, each fires one request.
  for (let s = 0; s < 12; s++) {
    const key = `sess${s}`;
    am._bindSession(key, am.accounts[0], 'claude-sonnet-5');
    am.accounts[0].loadEvents.push({ at: Date.now(), durationMs: 100, weight: 5, success: true }); // keep a1 a carrier
    const lease = am.acquireAccount(req({ sessionKey: key }));
    if (lease.account.name === 'fresh') pulls++;
    am.releaseAccount(lease, { success: true, status: 200 });  // completedRequests++ on the served account
  }
  // Keyed on the fresh account's OWN onboarding count → it stops warming after
  // WARMUP_REQUESTS(5), so the total pulls are bounded regardless of how many
  // sessions/requests arrive (no share-based oscillation).
  assert.ok(pulls <= 5, `warmup-pull must terminate — bounded pulls (got ${pulls})`);
  assert.ok(pulls >= 1, 'at least one session must have been onboarded onto the fresh account');
  assert.ok(am.accounts[2].completedRequests >= 5, 'the fresh account got onboarded (served its warmup quota)');
});

test('W4.6 one-and-done: a re-homed session stays on the fresh account (no re-migration next request)', () => {
  const am = manager(2);
  makeCarrier(am, 0);
  makeCarrier(am, 1);
  addFresh(am, 'fresh');
  am._bindSession('sessX', am.accounts[0], 'claude-sonnet-5');
  const first = am.acquireAccount(req({ sessionKey: 'sessX' }));
  assert.equal(first.account.name, 'fresh', 'migrates onto the fresh account once');
  am.releaseAccount(first, { success: true, status: 200 });
  const second = am.acquireAccount(req({ sessionKey: 'sessX' }));
  assert.equal(second.account.name, 'fresh', 'stays bound to it — no ping-pong back');
});

// ── Invariant: a boot account is never "warming"; an idle carrier is not pulled ───

test('W4 a boot/config account is never treated as warming (only mid-session adds are)', () => {
  const am = manager(2);
  assert.equal(am._isWarming(am.accounts[0], Date.now()), false, 'boot account (no addedAt) is never warming');
  const idx = addFresh(am, 'fresh');
  assert.equal(am._isWarming(am.accounts[idx], Date.now()), true, 'a mid-session-added account is warming');
});

test('W4 _isWarming respects BOTH bounds (WARMUP_REQUESTS and WARMUP_MS)', () => {
  const am = manager(1);
  const idx = addFresh(am, 'fresh');
  const a = am.accounts[idx];
  const now = a.addedAt;
  assert.equal(am._isWarming(a, now), true);
  a.completedRequests = 5;
  assert.equal(am._isWarming(a, now), false, 'served its warmup quota → onboarded → not warming');
  a.completedRequests = 0;
  assert.equal(am._isWarming(a, now + 6 * 60 * 1000), false, 'past WARMUP_MS → not warming (time bound)');
});

test('W4 an IDLE bound account (no recent load) is not warmup-pulled (no needless churn)', () => {
  const am = manager(2);
  makeCarrier(am, 1);
  // a1 is healthy but has NO recent loadEvents → not carrying load.
  am.applyUsageData(0, { fiveHour: { utilization: 0.1, resetAt: Date.now() + HOUR }, sevenDay: { utilization: 0.3, resetAt: Date.now() + 152 * HOUR } });
  addFresh(am, 'fresh');
  am._bindSession('sessI', am.accounts[0], 'claude-sonnet-5');
  const lease = am.acquireAccount(req({ sessionKey: 'sessI' }));
  assert.equal(lease.account.name, 'a1', 'an idle bound session is left alone (nothing to relieve)');
});

// ── Invariant 5: existing hot-rebalance is unchanged when no warming account exists ─

test('W4.5 with NO warming account, an idle near-cap bound session still hot-rebalances (unchanged)', () => {
  const am = manager(2);
  am.applyUsageData(0, { fiveHour: { utilization: 0.1, resetAt: Date.now() + HOUR }, sevenDay: { utilization: 0.90, resetAt: Date.now() + 39 * HOUR } }); // reserve
  am.applyUsageData(1, { fiveHour: { utilization: 0.1, resetAt: Date.now() + HOUR }, sevenDay: { utilization: 0.17, resetAt: Date.now() + 152 * HOUR } }); // healthy
  am._bindSession('sessR', am.accounts[0], 'claude-sonnet-5');
  const lease = am.acquireAccount(req({ sessionKey: 'sessR' }));
  assert.equal(lease.account.name, 'a2', 'no warming account → the pre-existing hot-rebalance path is unaffected');
});
