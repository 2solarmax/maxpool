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

test('a refreshDead (reauth) account suppresses the redundant stale·probe echo', () => {
  const am = oauthAM();
  am.quotaProbeIntervalMs = 60_000;
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.11, severity: 'normal', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  // The death: the expired-token probe recorded a 401, the probe is now stale, and
  // the account is refreshDead → the prober skips it, so that 401 never clears.
  am.accounts[0].quota.lastProbeErrorStatus = 401;
  am.accounts[0].quota.lastProbeOkAt = Date.now() - 5 * 60_000;
  am.accounts[0].refreshDead = true;
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.doesNotMatch(line, /stale/, 'the "reauth" status already tells the story — no stale·probe echo');
});

test('a LIVE account still surfaces a real failing-probe signal (not over-suppressed)', () => {
  const am = oauthAM();
  am.quotaProbeIntervalMs = 60_000;
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.11, severity: 'normal', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  am.accounts[0].quota.lastProbeErrorStatus = 429;
  am.accounts[0].quota.lastProbeOkAt = Date.now() - 5 * 60_000;
  // NOT refreshDead, NOT disabled, no live response-header traffic → a self-throttling
  // probe is a real signal (this is the idle / no-recent-header case).
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.match(line, /stale·rate-limited/, 'a live account keeps its actionable probe signal');
});

test('a busy OAuth account (bars fresh from response headers) is NOT flagged stale when only its background probe is 429-throttled', () => {
  const am = oauthAM();
  am.quotaProbeIntervalMs = 60_000;
  am.accounts[0].quota.unified5h = 0.44;
  am.accounts[0].quota.unified7d = 0.10;
  am.accounts[0].quota.lastProbeOkAt = Date.now() - 5 * 60_000;  // background probe stale
  am.accounts[0].quota.lastProbeErrorStatus = 429;
  am.accounts[0].quota.lastHeaderQuotaAt = Date.now();           // live traffic just refreshed the bars
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.doesNotMatch(line, /stale/, 'header-fresh bars + no probe-only scoped cap → no misleading stale marker');
});

test('a probe-only scoped cap still reads stale on a stale probe even when the unified bars are header-fresh', () => {
  const am = oauthAM();
  am.quotaProbeIntervalMs = 60_000;
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.90, severity: 'critical', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  am.accounts[0].quota.lastProbeOkAt = Date.now() - 5 * 60_000;  // the shown Fable 90% is now unconfirmed
  am.accounts[0].quota.lastProbeErrorStatus = 429;
  am.accounts[0].quota.lastHeaderQuotaAt = Date.now();           // unified bars fresh, but Fable% is probe-ONLY
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.match(line, /stale·rate-limited/, 'a displayed scoped cap is probe-only → still warn');
});

test('automatic mode marks accounts SERVING right now (inFlight>0) with ►, not the last-routed idle one', () => {
  const am = oauthAM();
  am.routingMode = 'automatic';
  am.accounts[0].inFlight = 2;   // actively serving
  am.accounts[1].inFlight = 0;   // idle
  am.currentIndex = 1;           // "most recently routed to" is the IDLE account (the old misleading marker)
  const tui = new TUI({ accountManager: am });
  assert.match(strip(tui._renderAcct(0, 11, true)), /►/, 'a serving account (inFlight 2) is marked active');
  assert.doesNotMatch(strip(tui._renderAcct(1, 11, true)), /►/, 'an idle account is NOT marked, even though it is currentIndex');
});

test('preferred (manual) mode still marks exactly the pinned account, regardless of inFlight', () => {
  const am = oauthAM();
  am.routingMode = 'preferred';
  am.preferredAccountName = 'a1';
  am.accounts[0].inFlight = 0;   // pinned but idle
  am.accounts[1].inFlight = 5;   // busy but not pinned
  const tui = new TUI({ accountManager: am });
  assert.match(strip(tui._renderAcct(0, 11, true)), /►/, 'the pinned account is marked even while idle');
  assert.doesNotMatch(strip(tui._renderAcct(1, 11, true)), /►/, 'a busy non-pinned account is NOT marked in manual mode');
});

test('a provider-routed request is tagged with its session id in the event-log line', () => {
  const am = oauthAM();
  am.accounts.push({ name: 'glm-fallback', type: 'provider', quota: {}, inFlight: 0 });
  const tui = new TUI({ accountManager: am });
  const logged = [];
  tui._addLog = (m) => logged.push(m);   // capture; avoids the on-disk appendEventLog
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionKey: '2e30989e-aaaa-bbbb-cccc-ddddeeeeffff' });
  tui.onRequestEnd(1, { account: 'glm-fallback', status: 200 });
  assert.match(logged[0], /→ glm-fallback \(200, .+s\) {2}\[sess 2e30989e\]/, 'provider request tagged with the 8-char session id');
});

test('a header-less provider request does NOT emit an empty [sess ] tag (truthiness guard)', () => {
  const am = oauthAM();
  am.accounts.push({ name: 'glm-fallback', type: 'provider', quota: {}, inFlight: 0 });
  const tui = new TUI({ accountManager: am });
  const logged = [];
  tui._addLog = (m) => logged.push(m);
  tui.onRequestStart(2, { method: 'POST', path: '/v1/messages', sessionKey: '' }); // server.js headerValue → '' for a missing header (the real production value)
  tui.onRequestEnd(2, { account: 'glm-fallback', status: 200 });
  assert.doesNotMatch(logged[0], /\[sess/, 'no empty session tag when the header is absent (empty-string sessionKey)');
});

test('an OAuth-routed request is NOT tagged (only provider requests carry the session id)', () => {
  const am = oauthAM();
  const tui = new TUI({ accountManager: am });
  const logged = [];
  tui._addLog = (m) => logged.push(m);
  tui.onRequestStart(3, { method: 'POST', path: '/v1/messages', sessionKey: 'abcd1234-aaaa-bbbb-cccc-ddddeeeeffff' });
  tui.onRequestEnd(3, { account: 'a1', status: 200 });
  assert.doesNotMatch(logged[0], /\[sess/, 'OAuth line unchanged — no session tag');
});

test('routing header surfaces provider overflow volume when GLM/Kimi took traffic in the last 15m', () => {
  const am = oauthAM();
  const now = Date.now();
  am.accounts.push({ name: 'glm-fallback', type: 'provider', quota: {}, inFlight: 0, loadEvents: [
    { at: now - 60_000, durationMs: 5000, weight: 1, success: true, status: 200 },
    { at: now - 120_000, durationMs: 8000, weight: 1, success: true, status: 200 },
  ] });
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });
  let out = ''; const ow = process.stdout.write; const oc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  try { Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true }); process.stdout.write = s => { out += s; return true; }; tui._render(); }
  finally { process.stdout.write = ow; if (oc) Object.defineProperty(process.stdout, 'columns', oc); }
  assert.match(strip(out), /providers: 2 req\/15m/, 'the routing header shows the 15m provider request volume');
});

test('a provider account stays probe-only — a stale probe still reads stale, header-freshness never applies', () => {
  const am = providerAM();
  am.quotaProbeIntervalMs = 60_000;
  am.applyProviderUsage(1, { source: 'zai', ses: { utilization: 0.42, resetAt: Date.now() + 3600_000 }, wk: { utilization: 0.61, resetAt: Date.now() + 3 * DAY } });
  am.accounts[1].quota.lastProbeOkAt = Date.now() - 5 * 60_000;  // provider probe stale
  am.accounts[1].quota.lastProbeErrorStatus = 429;
  am.accounts[1].quota.lastHeaderQuotaAt = Date.now();           // must be IGNORED for a provider (bars are probe-only)
  const line = strip(new TUI({ accountManager: am })._renderAcct(1, 11, true));
  assert.match(line, /stale·rate-limited/, 'provider bars are probe-only → header stamp must not suppress');
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

test('a dead-refresh account renders "reauth" (not a generic error), status stays error', () => {
  const am = oauthAM(1);
  am.accounts[0].status = 'error';   // routing/eligibility must still exclude it
  am.accounts[0].refreshDead = true;
  const tui = new TUI({ accountManager: am });
  const line = strip(tui._renderAcct(0, 11, true));
  assert.match(line, /reauth/, 'tells the user to re-login');
  assert.equal(am.accounts[0].status, 'error', 'display-only — the model status is untouched');
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

// ── the reported UX bug: the top header must ALIGN to the columns it names ─────

test('the column header sits exactly over the Account/Type/Status/Quota columns', () => {
  const am = oauthAM();
  am.applyUsageData(0, {
    fiveHour: { utilization: 0.3, resetAt: Date.now() + 3600_000 },
    sevenDay: { utilization: 0.4, resetAt: Date.now() + 3 * DAY },
  });
  const tui = new TUI({ accountManager: am });
  const hdr = strip(__tuiTest.acctHeader(100));
  const row = strip(tui._renderAcct(0, 11, true));
  assert.equal(hdr.indexOf('Account'), 4, 'Account over the name column');
  assert.equal(hdr.indexOf('Type'), 17, 'Type over the type column');
  assert.equal(hdr.indexOf('Status'), 26, 'Status over the status column');
  // the Quota group label lands exactly on the inline Ses/Tok quota label
  assert.equal(hdr.indexOf('Quota'), row.indexOf('Ses '), 'Quota over the quota bars');
});

test('the header aligns for an API-key row too (Quota group label over Tok, not mislabeled)', () => {
  const am = oauthAM(1);
  // API-key-style quota (Tok/Req bars instead of Ses/Wk).
  am.accounts[0].quota.tokensLimit = 1000;
  am.accounts[0].quota.tokensRemaining = 700;
  am.accounts[0].quota.requestsLimit = 100;
  am.accounts[0].quota.requestsRemaining = 90;
  const tui = new TUI({ accountManager: am });
  const hdr = strip(__tuiTest.acctHeader(100));
  const row = strip(tui._renderAcct(0, 11, true));
  assert.equal(hdr.indexOf('Quota'), row.indexOf('Tok '), 'group label sits over Tok — a single "Quota" is honest for both row types');
});

test('narrow mode: the header still aligns and shrinks Quota to avoid overflow', () => {
  const wide = strip(__tuiTest.acctHeader(100));
  const narrow = strip(__tuiTest.acctHeader(72));
  assert.equal(narrow.indexOf('Account'), 4);
  assert.equal(narrow.indexOf('Status'), 26);
  assert.match(wide, /Quota \(used% · resets-in\)/, 'wide shows the full quota key');
  assert.equal(narrow.indexOf('Quota'), 40);
  assert.doesNotMatch(narrow, /resets-in/, 'narrow drops the parenthetical so it does not clip');
});

test('the Activity header shows in-flight REQUESTS + distinct SESSION count (not "N active")', () => {
  const am = oauthAM(2);
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });
  // 4 in-flight requests spanning 2 distinct sessions (sessA fans out ×2 — the subagent
  // case) + 1 with no session header (must not inflate the session count).
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionKey: 'sessA' });
  tui.onRequestStart(2, { method: 'POST', path: '/v1/messages', sessionKey: 'sessA' });
  tui.onRequestStart(3, { method: 'POST', path: '/v1/messages', sessionKey: 'sessB' });
  tui.onRequestStart(4, { method: 'POST', path: '/v1/messages' }); // header-less → not a session

  const origCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const origWrite = process.stdout.write;
  let out = '';
  try {
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    process.stdout.write = (s) => { out += s; return true; };
    tui._render();
  } finally {
    process.stdout.write = origWrite;
    if (origCols) Object.defineProperty(process.stdout, 'columns', origCols);
  }
  const activity = strip(out).split('\n').find(l => /Activity/.test(l)) || '';
  assert.match(activity, /4 in-flight/, 'counts in-flight REQUESTS');
  assert.match(activity, /2 sessions/, 'distinct sessions among them (sessA×2 + sessB; the keyless one excluded)');
  assert.doesNotMatch(activity, /\d+ active/, 'header no longer labels the count "active" (which read as sessions)');
});

test('the Activity header uses the singular "1 session" for a single session', () => {
  const tui = new TUI({ accountManager: oauthAM(1), config: { proxy: { port: 3456 } } });
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages', sessionKey: 'only' });
  tui.onRequestStart(2, { method: 'POST', path: '/v1/messages', sessionKey: 'only' });
  const ow = process.stdout.write; const oc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  let out = '';
  try { Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true }); process.stdout.write = s => { out += s; return true; }; tui._render(); }
  finally { process.stdout.write = ow; if (oc) Object.defineProperty(process.stdout, 'columns', oc); }
  const activity = strip(out).split('\n').find(l => /Activity/.test(l)) || '';
  assert.match(activity, /2 in-flight · 1 session\b/, 'singular "session" for one session, no trailing s');
});

test('the abbreviation glossary is a FOOTER below the rows, never between the header and the data', () => {
  // Regression guard for the reported "header not aligned" — a left-aligned glossary
  // sentence sandwiched between the aligned header and the aligned rows reads as a
  // broken second header. It must sit AFTER the rows.
  const am = oauthAM(2);
  am.applyUsageData(0, { fiveHour: { utilization: 0.3, resetAt: Date.now() + 3600_000 }, sevenDay: { utilization: 0.4, resetAt: Date.now() + 3 * DAY } });
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });

  const origCols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const origWrite = process.stdout.write;
  let out = '';
  try {
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    process.stdout.write = (s) => { out += s; return true; };
    tui._render(); // render() no-ops unless running; _render does the actual frame build
  } finally {
    process.stdout.write = origWrite;
    if (origCols) Object.defineProperty(process.stdout, 'columns', origCols);
  }
  const flat = strip(out);
  const iHeader = flat.indexOf('Account');
  const iRow = flat.indexOf('a1');          // first account row
  const iGlossary = flat.indexOf('Legend'); // the DISTINCTIVE legend label (not a bare row bar label)
  assert.ok(iHeader >= 0 && iRow >= 0 && iGlossary >= 0, 'header, a row, and the legend all render');
  assert.ok(iHeader < iRow, 'header sits above the rows');
  assert.ok(iRow < iGlossary, 'the legend is a FOOTER below the rows — never between header and data');
  // Explicitly labeled + spells out each abbreviation, so it doesn't read as an orphan sentence.
  const legend = flat.slice(iGlossary);
  assert.match(legend, /Ses = 5h/);
  assert.match(legend, /Wk = 7d/);
  assert.match(legend, /Now = in-flight \(weight\)/);
  assert.match(legend, /15m\/1h = served \(avg · f = fails\)/);
});

test('an extreme-narrow header clips WITHOUT bleeding the underline into later lines', () => {
  // The header renders whenever W>=40; the 45-char short header exceeds W in the
  // 40<=W<45 window. It must go through fitLine like the real _render pipeline and
  // still terminate its underline (\x1b[0m) so it can't bleed onto the rows below.
  const RESET = '\x1b[0m';
  const headerLine = '\x1b[2;4m' + __tuiTest.acctHeader(42) + RESET; // dim+underline, as _render builds it
  const fitted = __tuiTest.fitLine(headerLine, 42);
  assert.ok(__tuiTest.strip(fitted).length <= 42, 'truncated to the terminal width');
  assert.ok(fitted.endsWith(RESET), 'RESET still terminates the underline after truncation');
});
