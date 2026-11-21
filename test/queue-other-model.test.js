import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

/** A queued request stuck on its own model's weekly sub-limit (Fable at 100% on every
 *  account it can use) must not hold requests for other models. Everything that really
 *  competes keeps strict FIFO. */

function manager(count = 2) {
  const accounts = Array.from({ length: count }, (_, i) => ({
    name: `a${i + 1}`,
    type: 'oauth',
    accessToken: `t${i + 1}`,
    refreshToken: `r${i + 1}`,
    expiresAt: Date.now() + 3600_000,
  }));
  return new AccountManager(accounts, 0.90);
}

/** One OAuth account plus a GLM provider that serves the 'all' profile. */
function managerWithGlm() {
  return new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'], priority: 10 },
  ], 0.90, { routingMode: 'balance' });
}

const DAY = 24 * 60 * 60 * 1000;
const fable = (extra = {}) => ({ model: 'claude-fable-5', profile: 'claude', ...extra });
const opus = (extra = {}) => ({ model: 'claude-opus-4-8', profile: 'claude', ...extra });
/** A signed-thinking request: behind the queue, the retry oracle gives it a short
 *  queued_behind_fairness hold instead of dropping it. */
const thinkingOpus = () => opus({ requiresAnthropicThinkingIntegrity: true });

function benchFable(am, index) {
  am.applyUsageData(index, { scopedWeekly: { fable: { utilization: 1, severity: 'critical', isActive: true, resetAt: Date.now() + 6 * DAY } } });
}

function benchFableEverywhere(am) {
  am.accounts.forEach((_, index) => benchFable(am, index));
}

function enqueue(am, requestInfo) {
  am.registerQueuedRequest(requestInfo, { res: { destroyed: false, writableEnded: false } });
  return requestInfo;
}

test('another model passes a Fable ticket that is benched on every account', () => {
  const am = manager();
  benchFableEverywhere(am);
  enqueue(am, fable());

  const plan = am.nextRetryForRequest(thinkingOpus());
  const lease = am.acquireAccount(thinkingOpus());
  assert.equal(plan.available, true);
  assert.notEqual(plan.cause, 'queued_behind_fairness');
  assert.ok(lease);
});

test('a queued Opus ticket behind a benched Fable ticket is admitted at once', () => {
  const am = manager();
  benchFableEverywhere(am);
  const stuck = enqueue(am, fable());
  const other = enqueue(am, opus());

  const admitted = am.canAdmitQueuedRequest(other);
  assert.equal(admitted, true);
  assert.equal(am.queueState.waiting.length, 1);
  assert.equal(am.queueState.waiting[0].requestInfo, stuck);
});

test('a request for the same model keeps FIFO behind the benched ticket', () => {
  const am = manager();
  benchFableEverywhere(am);
  enqueue(am, fable());
  const second = enqueue(am, fable());

  const admitted = am.canAdmitQueuedRequest(second);
  const newcomerMatches = am._matchesRequest(am.accounts[0], 'claude', fable());
  assert.equal(admitted, false);
  assert.equal(newcomerMatches, false);
});

test('a ticket waiting for something other than its model limit keeps FIFO', () => {
  const am = manager();
  enqueue(am, fable());

  const lease = am.acquireAccount(opus());
  const plan = am.nextRetryForRequest(thinkingOpus());
  const other = enqueue(am, opus());
  const admitted = am.canAdmitQueuedRequest(other);
  assert.equal(lease, null);
  assert.equal(plan.cause, 'queued_behind_fairness');
  assert.equal(admitted, false);
});

test('a Fable ticket another account can still serve stays in the way', () => {
  const am = manager();
  benchFable(am, 0);
  enqueue(am, fable());

  const lease = am.acquireAccount(opus());
  const other = enqueue(am, opus());
  const admitted = am.canAdmitQueuedRequest(other);
  assert.equal(lease, null);
  assert.equal(admitted, false);
});

test('a request without a model keeps FIFO behind the benched ticket', () => {
  const am = manager();
  benchFableEverywhere(am);
  enqueue(am, fable());

  const lease = am.acquireAccount({ profile: 'claude' });
  assert.equal(lease, null);
});

test('a disabled account does not count as one the Fable ticket could use', () => {
  const am = manager();
  benchFable(am, 0);
  am.setAccountEnabled(1, false);
  enqueue(am, fable());

  const lease = am.acquireAccount(opus());
  assert.equal(lease?.account.name, 'a1');
});

/** Accounts that never serve: a duplicate of a team-pool account, dead credentials, a
 *  cancelled subscription. None of them has Fable data, so none may keep the ticket in the way. */
const accountsThatNeverServe = [
  { name: 'a team-pool duplicate', mark: account => { account.poolBenchedBy = 'team pool'; } },
  { name: 'an account with dead credentials', mark: account => { account.refreshDead = true; } },
  { name: 'an account with a cancelled subscription', mark: account => { account.subscriptionGone = true; } },
];

for (const { name, mark } of accountsThatNeverServe) {
  test(`${name} does not count as an account the Fable ticket could use`, () => {
    const am = manager();
    benchFable(am, 0);
    mark(am.accounts[1]);
    enqueue(am, fable());

    const lease = am.acquireAccount(opus());
    assert.ok(lease);
  });
}

test('only accounts the Fable ticket profile reaches count', () => {
  const claudeOnly = managerWithGlm();
  benchFable(claudeOnly, 0);
  enqueue(claudeOnly, fable());
  const claudeOnlyLease = claudeOnly.acquireAccount(opus());
  assert.equal(claudeOnlyLease?.account.name, 'a1');

  const anyProvider = managerWithGlm();
  const anyProviderFable = fable({ profile: 'all' });
  benchFable(anyProvider, 0);
  enqueue(anyProvider, anyProviderFable);
  const anyProviderLease = anyProvider.acquireAccount(opus());
  assert.equal(anyProviderLease, null);
});

test('a mixed queue holds a request only behind the tickets in its way', () => {
  const am = manager();
  benchFableEverywhere(am);
  enqueue(am, fable());
  const first = enqueue(am, opus());
  const second = enqueue(am, opus());

  const secondBeforeFirst = am.canAdmitQueuedRequest(second);
  const firstAdmitted = am.canAdmitQueuedRequest(first);
  const secondAfterFirst = am.canAdmitQueuedRequest(second);
  assert.equal(secondBeforeFirst, false);
  assert.equal(firstAdmitted, true);
  assert.equal(secondAfterFirst, true);
});

test('the hold comes back once the Fable limit lifts', () => {
  const am = manager();
  benchFableEverywhere(am);
  enqueue(am, fable());
  am.accounts.forEach(account => { account.quota.scopedWeekly = {}; });

  const lease = am.acquireAccount(opus());
  assert.equal(lease, null);
});
