import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { routingSources } from '../src/routing-report.js';
import { TUI, __tuiTest } from '../src/tui.js';

const account = { name: 'dev-local', type: 'oauth', provider: 'codex', accountUuid: 'private-owner', accessToken: 'fixture' };
const makeManager = () => new AccountManager([{ ...account }], 0.9);
const screen = (tui, w = 80, h = 24) => tui._renderAnalyticsPage(w, h)
  .map(line => __tuiTest.strip(__tuiTest.fitLine(line, w)).trimEnd()).join('\n');

test('holder records idle natural weeks from fresh paired vendor readings and reopens after restart', () => {
  const am = makeManager();
  const now = Date.now();
  am.applyUsageData(0, { sevenDay: { utilization: 0, resetAt: now + 500 } });
  const saved = am.routingCapacity.serialize();
  const resumed = makeManager();
  resumed.routingCapacity.restore(saved);
  resumed.closeExpiredCapacityCycles(now + 1000);
  resumed.closeExpiredCapacityCycles(now + 2000);
  const report = resumed.routingReport(now + 2000);
  assert.equal(report.quotas[0].cycles.length, 1);
  assert.equal(report.quotas[0].cycles[0].unusedFraction, 1);
  assert.equal(report.quotas[0].cycles[0].attribution, 'unattributed');
  assert.equal(report.quotas[0].cycles[0].reason, 'natural-reset');
  assert.doesNotMatch(JSON.stringify(report), /private-owner|accessToken|fixture/);
});

test('fresh utilization cannot borrow a reset stamp from an older Anthropic header', () => {
  const am = makeManager();
  const stamp = Math.ceil(Date.now() / 1000) + 2;
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-reset': String(stamp) });
  am.updateQuota(0, { 'anthropic-ratelimit-unified-7d-utilization': '0.23' });
  am.closeExpiredCapacityCycles((stamp + 1) * 1000);
  assert.deepEqual(am.routingReport().quotas[0].cycles, []);
});

test('routing analytics is reachable via keys, distinguishes zero demand, and selects each reporting worker once', () => {
  const am = makeManager();
  const peer = makeManager();
  const trace = peer.routingService.begin({ session: 'sensitive-session-id' });
  trace.route('Cloud account');
  trace.finish('completed');
  const peerStatus = peer.getStatus();
  const link = { name: 'Cloud', lastOkAt: Date.now(), status: peerStatus };
  am.poolLinks = [link, { ...link, name: 'Cloud alias' }, { name: 'Older', status: {} }];
  assert.equal(routingSources(am, Date.now()).length, 3);
  const tui = new TUI({ accountManager: am, config: {} });
  tui._key('v');
  tui._key('r');
  assert.match(screen(tui), /Timely completions +— +0 \/ 0/);
  tui._key('w');
  assert.match(screen(tui), /Routing analytics · Cloud · 24h/);
  assert.match(screen(tui), /100.0% +1 \/ 1/);
  assert.match(screen(tui), /Awaiting a measured reset/);
  tui._key('t');
  assert.match(screen(tui, 40, 8), /Cloud · 7d/);
  for (let i = 0; i < 25; i++) tui._key('down');
  assert.match(screen(tui, 40, 8), /reset|yield|weeks/i);
  tui._key('w');
  assert.match(screen(tui), /unavailable/);
  tui._key('esc');
  assert.match(screen(tui), /Activity analytics/);
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
  assert.doesNotMatch(JSON.stringify(am.routingReport()), /Cloud account|sensitive-session/);
});

test('a releasing worker hands off late outcomes and quota readings once through the normal state drain', async t => {
  const { writeCapacityDrain, readCapacityDrains, acknowledgeCapacityDrains } = await import('../src/config.js');
  const { RoutingCapacityAnalytics } = await import('../src/routing-capacity-analytics.js');
  const { RoutingServiceAnalytics } = await import('../src/routing-service-analytics.js');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-routing-drain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const old = makeManager(), active = makeManager(), at = Date.now();
  const start = old.routingService.begin({ session: 'one' });
  start.route('dev-local');
  const owner = old._localCacheKeys(old.accounts[0])[0];
  const observe = (am, utilization, observedAt) => am.routingCapacity.observe({ owner,
    window: 'wk', resetAt: at + 60_000, utilization, observedAt });
  observe(old, 0.3, at - 180_000);
  const serviceBaseline = old.routingService.exportState();
  const capacityBaseline = old.routingCapacity.serialize();
  active.routingService.restoreState(serviceBaseline);
  active.routingCapacity.restore(capacityBaseline);
  start.finish('completed');
  observe(old, 0.45, at);
  await writeCapacityDrain({ accounts: {}, owners: {},
    routingService: RoutingServiceAnalytics.drainDelta(serviceBaseline, old.routingService.exportState()),
    routingCapacity: RoutingCapacityAnalytics.drainDelta(capacityBaseline, old.routingCapacity.serialize()),
  }, path);
  const ids = await readCapacityDrains(active.capacity, path, active);
  assert.equal(ids.length, 1);
  await readCapacityDrains(active.capacity, path, active);
  assert.equal(active.routingService.snapshot().timelyCompleted, 1);
  active.routingCapacity.advance(at + 65_000);
  assert.equal(active.routingCapacity.snapshot(owner, at + 65_000).cycles[0].unusedFraction, 0.55);
  await acknowledgeCapacityDrains(active.capacity, ids, path);
  assert.deepEqual(await readCapacityDrains(active.capacity, path, active), []);
});
