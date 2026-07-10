import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const DAY = 24 * 60 * 60 * 1000;
const strip = __tuiTest.strip;

function oauthAM(count = 2) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`, type: 'oauth',
      accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

function providerAM() {
  return new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zt', upstream: 'https://api.z.ai/api/anthropic' },
    { name: 'kimi-fallback', type: 'provider', provider: 'kimi', authToken: 'kt', upstream: 'https://api.moonshot.ai/anthropic' },
  ], 0.90);
}

// ── the user's exact symptom: 90% must read "Fable 90%", never "maxed" ────────

test('scoped tag renders the real % at 90% (not "maxed")', () => {
  const am = oauthAM();
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.90, severity: 'critical', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(0, 11, true));
  assert.match(line, /Fable 90%/, 'shows the actual utilization');
  assert.doesNotMatch(line, /maxed/, '90% is not maxed');
});

test('scoped tag renders "maxed" only at genuine exhaustion (>= 0.985)', () => {
  const am = oauthAM();
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.99, severity: 'critical', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(0, 11, true));
  assert.match(line, /Fable maxed/);
});

test('a below-reserve scoped cap shows no tag at all', () => {
  const am = oauthAM();
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.40, severity: 'normal', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(0, 11, true));
  assert.doesNotMatch(line, /Fable/, 'plenty of headroom → nothing to surface');
});

test('an inactive scoped cap shows no tag (matches the routing gate)', () => {
  const am = oauthAM();
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.99, severity: 'critical', isActive: false, resetAt: Date.now() + 3 * DAY } } });
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(0, 11, true));
  assert.doesNotMatch(line, /Fable/);
});

// ── staleness marker answers "how do you know it's refreshed?" ────────────────

test('a stale probe marks the scoped tag "stale"; a fresh one does not', () => {
  const am = oauthAM();
  am.quotaProbeIntervalMs = 60_000;
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.90, severity: 'critical', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  const tui = new TUI({ accountManager: am });

  // Fresh (just applied) → no stale marker.
  assert.doesNotMatch(strip(tui._renderAcct(0, 11, true)), /stale/);

  // Age the last successful probe past 2x the interval.
  am.accounts[0].quota.lastProbeOkAt = Date.now() - 5 * 60_000;
  assert.match(strip(tui._renderAcct(0, 11, true)), /stale/, 'aged probe → explicit stale marker');
});

// ── Ask A: providers show Ses/Wk like the rest ────────────────────────────────

test('a z.ai provider account renders real Ses/Wk bars from provider fields', () => {
  const am = providerAM();
  am.applyProviderUsage(1, {
    source: 'zai',
    ses: { utilization: 0.42, resetAt: Date.now() + 3600_000 },
    wk: { utilization: 0.61, resetAt: Date.now() + 3 * DAY },
  });
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(1, 11, true));
  assert.match(line, /Ses/);
  assert.match(line, /42%/);
  assert.match(line, /Wk/);
  assert.match(line, /61%/);
});

test('a z.ai account with no weekly (z.ai omits it) shows real Ses + an honest "—" Wk placeholder', () => {
  const am = providerAM();
  am.applyProviderUsage(1, { source: 'zai', ses: { utilization: 0.07, resetAt: Date.now() + 3600_000 } });
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(1, 11, true));
  assert.match(line, /Ses/);
  assert.match(line, /7%/);
  assert.match(line, /Wk\s+—/, 'weekly shows an aligned "—" placeholder, not a fabricated data bar');
  assert.doesNotMatch(line, /Wk\s+\d+%/, 'never a fake Wk percentage');
});

// ── the reported visual bug: provider Ses/Wk bars must align with OAuth rows ───

test('provider Ses/Wk bars sit in the SAME column as OAuth rows (alignment)', () => {
  const am = providerAM();
  // OAuth account with unified quota + z.ai provider with a real Ses bar.
  am.applyUsageData(0, { fiveHour: { utilization: 0.3, resetAt: Date.now() + 3600_000 }, sevenDay: { utilization: 0.4, resetAt: Date.now() + 3 * DAY } });
  am.applyProviderUsage(1, { source: 'zai', ses: { utilization: 0.42, resetAt: Date.now() + 3600_000 } });
  const tui = new TUI({ accountManager: am });
  const oauthLine = strip(tui._renderAcct(0, 11, true));
  const providerLine = strip(tui._renderAcct(1, 11, true));
  // The "Ses " column must start at the same character offset on both rows.
  assert.equal(providerLine.indexOf('Ses '), oauthLine.indexOf('Ses '),
    'Ses column misaligned between provider and OAuth rows');
  // And the "Wk" column too.
  assert.equal(providerLine.indexOf(' Wk '), oauthLine.indexOf(' Wk '),
    'Wk column misaligned between provider and OAuth rows');
});

test('narrow terminal (showBoth=false) drops the provider Wk column — no overflow', () => {
  const am = providerAM();
  am.applyProviderUsage(1, { source: 'zai', ses: { utilization: 0.42, resetAt: Date.now() + 3600_000 } });
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(1, 11, false));
  assert.match(line, /Ses/);
  assert.doesNotMatch(line, /\bWk\b/, 'Wk column hidden on a narrow terminal, like OAuth rows');
});

test('a Kimi account shows an honest console-only label, never a fake bar', () => {
  const am = providerAM();
  am.applyProviderUsage(2, { error: 'unsupported', source: 'console-only' });
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(2, 11, true));
  assert.match(line, /console-only/);
  assert.doesNotMatch(line, /Ses .*%/, 'no fabricated Ses bar for Kimi');
});

test('a z.ai account whose probe has not landed yet shows "probing", not a fake bar', () => {
  const am = providerAM();
  am.accounts[1].quota.providerQuotaSource = 'zai'; // known source, no reading yet
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(1, 11, true));
  assert.match(line, /probing/);
});
