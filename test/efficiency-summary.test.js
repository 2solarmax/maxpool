// The efficiency summary (2026-11-15): cache share per provider (Claude and GLM never
// blended), GLM's no-cache-write math, bounces out of every scoring denominator, and no
// double count between this pool and a linked pool's export.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const acct = (n, type = 'oauth') => ({ name: n, type, accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}` });
const am = () => new AccountManager([acct('c1'), acct('c2'), { ...acct('g1', 'provider'), provider: 'zai' }], 0.9);
const lease = (a, w = 1) => { a.inFlight++; return { account: a, weight: w, startedAt: Date.now() - 100, requestInfo: {} }; };
const served = (m, a, u = {}, extra = {}) => { m.releaseAccount(lease(a), { success: true, status: 200, usage: u, ...extra }); };
const bounce = (m, a, extra = {}) => { m.releaseAccount(lease(a), { bounced: true, status: 503, ...extra }); };

test('cache hit share is per provider; GLM (no cache writes) degenerates to r/(r+in)', () => {
  const m = am();
  served(m, m.accounts[0], { in: 100, cr: 900, cc: 0, out: 10 });     // 90% on Claude
  served(m, m.accounts[0], { in: 500, cr: 0, cc: 500, out: 10 });     // 0% (a miss)
  served(m, m.accounts[2], { in: 40, cr: 960, cc: 0, out: 10 });      // z.ai: r/(r+in)
  const c = m._efficiencySummary(m.accounts[0], 60 * 60_000);
  assert.equal(c.provider, 'claude');
  assert.equal(c.hit, 900 / 2000, 'cr/(cr+cc+in) over both turns');
  assert.equal(c.missTokens, 1100, 'in + cc');
  const g = m._efficiencySummary(m.accounts[2], 60 * 60_000);
  assert.equal(g.provider, 'glm');
  assert.equal(g.hit, 960 / 1000);
});

test('bounces are kept out of failed, requests, weight and avgMs', () => {
  const m = am();
  served(m, m.accounts[0], { in: 10, cr: 90, cc: 0, out: 1 });
  bounce(m, m.accounts[0], { refusal: 'busy' });
  bounce(m, m.accounts[0], { refusal: 'unavailable' });
  const w = m._loadSummary(m.accounts[0], 15 * 60_000);
  assert.equal(w.requests, 1);
  assert.equal(w.failed, 0);
  assert.equal(w.bounced, 2);
  assert.equal(w.weight, 1);
  assert.ok(w.avgMs > 0);
  const e = m._efficiencySummary(m.accounts[0], 15 * 60_000);
  assert.equal(e.bounced, 2);
  assert.equal(e.refused, 1, 'only the non-busy bounce is refused');
});

test('moves are counted at serve time, by cause, and waitThenMoved is the waste detector', () => {
  const m = am();
  served(m, m.accounts[0], { in: 1, cr: 1, cc: 0 }, { moved: true, moveCause: 'busy', busyWaitMs: 4_000 });   // wasted wait
  served(m, m.accounts[1], { in: 1, cr: 1, cc: 0 }, { moved: true, moveCause: 'busy' });
  served(m, m.accounts[1], { in: 1, cr: 1, cc: 0 }, { newConversation: true });
  const e = m._efficiencySummary(m.accounts[0], 60 * 60_000);
  assert.equal(e.movedByCause.busy, 1);
  assert.equal(e.waitThenMoved, 1);
  assert.equal(e.waited, 1);
  assert.equal(m._efficiencySummary(m.accounts[1], 60 * 60_000).newConversation, 1);
});

test('overall = local rows + cloud export, with the Mac\'s own mirror events counted once', () => {
  const m = am();
  served(m, m.accounts[0], { in: 100, cr: 900, cc: 0, out: 1 });       // local Claude
  const mirror = { name: 'cloud', type: 'oauth', remote: { linkName: 'team' }, enabled: true, quota: {}, status: 'active' };
  m.addAccount({ name: 'cloud ☁', type: 'oauth', configSourced: true, runtime: false });
  const row = m.accounts.find(a => a.name === 'cloud ☁');
  Object.assign(row, { remote: mirror.remote, enabled: true });
  served(m, row, { in: 100, cr: 0, cc: 0, out: 1 });                    // the Mac relayed it…
  row._remoteLoad = { last15m: { efficiency: { provider: 'claude', served: 5, cr: 4000, in: 1000, cc: 0, movedByCause: {} } } };
  const onlyLocal = m.efficiencyOverall('last15m', Date.now(), { mirrors: false });
  assert.equal(onlyLocal.claude.served, 1, 'the export alone: mirror-row OWN events excluded');
  assert.equal(onlyLocal.claude.cr, 900);
  const overall = m.efficiencyOverall('last15m', Date.now());
  assert.equal(overall.claude.served, 6, 'local + cloud export, each request once');
  assert.equal(overall.claude.cr, 4900);
  assert.equal(overall.claude.in + overall.claude.cc, 1100);
  assert.ok(Math.abs(overall.claude.hit - 4900 / 6000) < 1e-9, `combined share: ${overall.claude.hit}`);
});

test('client outcomes are edge-only and split pool- vs request-caused', () => {
  const m = am();
  const edge = { method: 'POST', path: '/v1/messages' };
  const pinned = { method: 'POST', path: '/v1/messages', pinAccount: 'x' };
  m.noteClientOutcome(edge, 200);
  m.noteClientOutcome(edge, 500);
  m.noteClientOutcome(edge, 429);
  m.noteClientOutcome(edge, 400);
  m.noteClientOutcome(pinned, 503);
  m.noteClientOutcome({ method: 'POST', path: '/v1/messages/count_tokens' }, 500);
  const w = m.clientOutcomeSummary(15 * 60_000);
  assert.equal(w.total, 4);
  assert.equal(w.poolErrors, 2);
  assert.equal(w.requestErrors, 1);
});
