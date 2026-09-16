// WEEKLY-AWARE ROUTING (task-2026-09-16-maxpool-quota-utilization-policy)
//
// Two features, one goal: stop weekly-burning accounts from winning the lease all day.
//  1. _rawUtilization folds WEEKLY utilization in (unified7d / providerWk) behind
//     scheduler.weeklyAwareScoring (default ON; the pre-flag behavior was the bug).
//  2. Config: peakDepreference off, peakCap stays (owner decision 2026-09-16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { readFileSync, existsSync } from 'node:fs';

const oauth = (name, quota) => ({
  name, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 36e5, quota,
});
const glm = (name, quota) => ({
  name, type: 'provider', provider: 'zai', profiles: ['all'],
  accessToken: 'k', model: 'glm-5.3', quota,
});

// The constructor REPLACES the quota object with an empty scaffold — set quota AFTER
// construction, the way the live prober does.
const am = (accounts, opts = {}) => {
  const m = new AccountManager(accounts, 0.9, { routingMode: 'balance', ...opts });
  for (let i = 0; i < accounts.length; i++) {
    if (accounts[i].quota) m.accounts[i].quota = accounts[i].quota;
  }
  return m;
};

// --- feature 1: weekly-aware _rawUtilization ---------------------------------

test('weekly-aware: a claude at 89% weekly / 0% session scores as EXPENSIVE (>= 0.89 util)', () => {
  const a = am([oauth('c1', { unified5h: 0, unified7d: 0.89 })]);
  assert.ok(a._rawUtilization(a.accounts[0]) >= 0.89,
    'weekly must flow into the routing score when the flag is on');
});

test('weekly-aware: providerWk is honored for provider accounts', () => {
  const a = am([glm('g1', { providerSes: 0.05, providerWk: 0.7 })]);
  assert.ok(Math.abs(a._rawUtilization(a.accounts[0]) - 0.7) < 1e-9,
    'provider weekly should dominate a low session number');
});

test('weekly-aware OFF restores the session-only behavior exactly', () => {
  const a = am([oauth('c1', { unified5h: 0.2, unified7d: 0.95 })],
    { weeklyAwareScoring: false });
  assert.equal(a._rawUtilization(a.accounts[0]), 0.2,
    'flag off must hide the weekly number from the score');
});

test('weekly-aware: session still dominates when it is higher (5h pressure wins)', () => {
  const a = am([oauth('c1', { unified5h: 0.8, unified7d: 0.4 })]);
  assert.equal(a._rawUtilization(a.accounts[0]), 0.8);
});

test('weekly-aware: full-score ordering — high-weekly claude LOSES to low-weekly glm', () => {
  const a = am([
    oauth('burning', { unified5h: 0.1, unified7d: 0.88 }),
    glm('fresh', { providerSes: 0.1, providerWk: 0.1 }),
  ]);
  const ctx = { now: Date.now(), fleetRecentWeight: 0 };
  const sBurning = a._scoreAccount(a.accounts[0], {}, ctx);
  const sFresh = a._scoreAccount(a.accounts[1], {}, ctx);
  assert.ok(sFresh < sBurning,
    `fresh glm (${sFresh.toFixed(2)}) must score cheaper than weekly-burning claude (${sBurning.toFixed(2)})`);
});

test('weekly-aware OFF: the MARGINAL band (60% weekly, below the 85% reserve ladder) is a near-coin-flip — the old blind spot', () => {
  // The pre-flag system was not fully weekly-blind: above 85% the reserve ladder
  // catches the account regardless. The genuinely-missed band is 50-85% weekly with
  // a fresh session — where the pace cost is discounted and the ladder does not fire.
  // Measured: flag ON gap 2.25 vs flag OFF 0.75 for this pair.
  const ctx = { now: Date.now(), fleetRecentWeight: 0 };
  const gap = (flag) => {
    const a = am([
      oauth('burning', { unified5h: 0.1, unified7d: 0.6 }),
      glm('fresh', { providerSes: 0.1, providerWk: 0.1 }),
    ], flag ? {} : { weeklyAwareScoring: false });
    return a._scoreAccount(a.accounts[0], {}, ctx) - a._scoreAccount(a.accounts[1], {}, ctx);
  };
  const on = gap(true), off = gap(false);
  assert.ok(on > off + 0.5,
    `flag ON must widen the gap in the marginal band (on=${on.toFixed(2)} > off=${off.toFixed(2)})`);
  assert.ok(off < 1.0,
    `flag OFF leaves the pair nearly tied — the blind spot being fixed (off=${off.toFixed(2)})`);
});

// --- feature 2: config — depreference off, cap intact -------------------------

test('config: live teamclaude.json has zai peakDepreference off and peakCap 0.5', { skip: !existsSync(
  process.env.HOME + '/.config/teamclaude.json') }, () => {
  const cfg = JSON.parse(readFileSync(
    process.env.HOME + '/.config/teamclaude.json', 'utf8'));
  const zai = cfg.scheduler?.providers?.zai || {};
  assert.equal(zai.peakDepreference, false, 'depreference must be off (owner decision 2026-09-16)');
  assert.equal(zai.peakCap, 0.5, 'the weekly cap stays as the backstop');
});

// --- the peak tier under the new config ----------------------------------------

test('peak: with depreference off, an under-cap provider is tier 0 IN the window', () => {
  const a = am([glm('g1', { providerSes: 0.05, providerWk: 0.2 })], {
    providers: { zai: {
      peakTimezone: 'Asia/Singapore',
      peakWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }],
      peakCap: 0.5, peakDepreference: false,
    } },
  });
  // window covers all day → inPeak is true right now
  assert.equal(a._peakTier(a.accounts[0]), 0,
    'under the cap with depreference off, the provider must be rankable');
});

test('peak: over the cap it is still tier 2 (benched from selection during peak)', () => {
  const a = am([glm('g1', { providerSes: 0.05, providerWk: 0.7 })], {
    providers: { zai: {
      peakTimezone: 'Asia/Singapore',
      peakWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }],
      peakCap: 0.5, peakDepreference: false,
    } },
  });
  assert.equal(a._peakTier(a.accounts[0]), 2,
    'the cap must still bite above 50% weekly');
});

// --- TUI: the 'w' key is wired (footer + toggle + persistence) ----------------

test('tui: routing footer shows score:weekly, and the w key flips + persists it', async () => {
  const { TUI } = await import('../src/tui.js');
  const { strip } = (await import('../src/tui.js')).__tuiTest;
  const saved = [];
  const am2 = new AccountManager(
    [{ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk', profiles: ['all'] }],
    0.90,
  );
  // Give the provider a peak window so the peak controls line renders at all.
  am2.scheduler.providers = { zai: {
    peakTimezone: 'Asia/Singapore',
    peakWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }],
    peakCap: 0.5, peakDepreference: false,
  } };
  const tui = new TUI({
    accountManager: am2,
    config: { proxy: { port: 3456 }, scheduler: am2.scheduler },
    saveConfig: async c => { saved.push(JSON.parse(JSON.stringify(c.scheduler))); },
  });
  tui.mode = 'routing';
  let f = strip(tui._renderFooter());
  assert.match(f, /score:weekly/, 'default ON renders as weekly');

  tui._keyRouting('w');   // the REAL key path — a test that only calls the method
  await new Promise(r => setTimeout(r, 0));   // _keyRouting doesn't await the async toggle
  assert.equal(am2.scheduler.weeklyAwareScoring, false, 'live flag flipped');
  assert.equal(saved.at(-1).weeklyAwareScoring, false, 'persisted to config');
  f = strip(tui._renderFooter());
  assert.match(f, /score:5h-only/, 'footer reflects the flip');

  await tui._toggleWeeklyAware();
  assert.equal(am2.scheduler.weeklyAwareScoring, true);
  f = strip(tui._renderFooter());
  assert.match(f, /score:weekly/, 'round-trips back to weekly');
});


// --- persistence: the production saveConfig MERGE carries the key ----------------
// The TUI test above stubs saveConfig — exactly what masked the v1.20.0 bug: production
// saveConfig (index.js) merges a WHITELIST of scheduler keys onto disk, and
// weeklyAwareScoring was not on it, so OFF was memory-only and silently reverted to ON
// on restart. The merge is an inline closure in index.js (importing it would boot the
// server), so the pin is a source scan of the merge block: a mutant deleting the line
// kills this test.
test('persistence: index.js saveConfig merge carries weeklyAwareScoring', () => {
  const idx = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const m = idx.match(/diskConfig\.scheduler = \{[\s\S]*?\n( {10})\};/);
  assert.ok(m, 'merge block found in index.js');
  assert.ok(m[0].includes('weeklyAwareScoring: config.scheduler.weeklyAwareScoring'),
    'the merge whitelist must persist weeklyAwareScoring (v1.20.0 red-team finding)');
});
