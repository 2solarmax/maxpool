// A cloud row's depth, as the Mac sees it (2026-11-15): teammates' load enters scoring in
// WEIGHT units (the cloud's activeWeight minus ours — like units, no conversion), and a row
// one short of the cloud's pin limit is skipped by NEW placements. Its holder still reaches
// it, and a lone candidate still serves (never benched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function linked(rows) {
  const am = new AccountManager([], 0.9, { routingMode: 'balance' });
  const link = { name: 'team', url: 'http://x', key: 'k', lastOkAt: Date.now(), lastError: null, status: { accounts: rows } };
  am.syncRemoteMirrors(link);
  return am;
}
const ROW = (name, extra = {}) => ({ name, type: 'oauth', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 }, ...extra });
const ri = (key) => ({ profile: 'claude', affinityKey: key, model: 'claude-opus-5-5', weight: 1, path: '/v1/messages' });

test('teammates\' load on a cloud row is scored in weight units from the poll', () => {
  const am = linked([ROW('a', { inFlight: 2, activeWeight: 40 }), ROW('b', { inFlight: 2, activeWeight: 2 })]);
  const a = am.accounts.find(x => x.name === 'a ☁');
  assert.equal(a._remoteOtherWeight, 40, 'activeWeight diff, in units');
  const conc = am._scoreTerms(a, ri('k1')).concurrency;
  assert.equal(conc, (0 + 1 + 40) * am.scheduler.concurrencyWeight, 'scoring sees 40 units, not 2 requests');
  // An older cloud with no activeWeight falls back to the in-flight count.
  const old = linked([ROW('a', { inFlight: 3 })]).accounts[0];
  assert.ok(Number.isNaN(old._remoteOtherWeight));
  assert.equal(linked([ROW('a', { inFlight: 3 })])._scoreTerms(old, ri('k')).concurrency, (0 + 1 + 3) * am.scheduler.concurrencyWeight);
});

test('a refusal\'s depth headers (5 of 6) make new placements skip the row; its holder and a lone pick still get it', () => {
  const am = linked([ROW('a'), ROW('b')]);
  const [a, b] = ['a ☁', 'b ☁'].map(n => am.accounts.find(x => x.name === n));
  b.activeWeight = 3;                       // a is the natural pick
  am.noteRemoteDepth(a.name, 5, 6);
  assert.equal(am._pinBusyForNew(a), true, 'one short of the pin limit');
  let l = am.acquireAccount(ri('new'));
  assert.equal(l.account.name, b.name, 'a new conversation goes elsewhere'); am.releaseAccount(l);
  am.noteConversationServed(ri('held'), a);
  l = am.acquireAccount(ri('held'));
  assert.equal(l.account.name, a.name, 'the holder still reaches its row'); am.releaseAccount(l);
  l = am.acquireAccount(ri('lone'), new Set([b.index]));
  assert.equal(l?.account.name, a.name, 'the only candidate still serves'); am.releaseAccount(l);
  // Review 2026-11-16 (3/3 verifiers): route EXISTENCE must agree with placement. The
  // cloud still accepts at 5 of 6, and acquire just placed 'lone' there, so the queue
  // counts it as a route too — else a failover queues (or 429s) while a slot is free.
  assert.equal(am.hasAvailableRoute(ri('lone2'), new Set([b.index])), true, 'depth one short of the limit is still a route');
  // Only a fresh busy REFUSAL (time-capped pinBusyUntil) closes it for a non-holder.
  am.markPinBusy(a.index, 2000);
  assert.equal(am.hasAvailableRoute(ri('lone3'), new Set([b.index])), false, 'a just-refused row is no route for a new placement');
});
