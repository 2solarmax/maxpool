import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, __tuiTest } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

const { strip } = __tuiTest;
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function mgr(names = ['personal', 'work']) {
  return new AccountManager(
    names.map((n, i) => ({ name: n, type: 'oauth', accessToken: `t${i}`, refreshToken: `r${i}`, expiresAt: Date.now() + 3600_000 })),
    0.90,
  );
}
function tuiFor(am) {
  return new TUI({ accountManager: am, config: { proxy: { port: 3456 } }, saveConfig: async () => {} });
}

// Capture the full-screen paint _render() writes to stdout, stripped of ANSI.
function captureRender(tui) {
  const orig = process.stdout.write;
  let buf = '';
  process.stdout.write = s => { buf += s; return true; };
  try { tui._render(); } finally { process.stdout.write = orig; }
  return { raw: buf, text: strip(buf) };
}

// ── A1: disabled status is prominent (red ✕) and the row reads "off" (dim name) ──

test('A1 a disabled account shows a red "✕ disabled" status and a dimmed name', () => {
  const am = mgr();
  am.accounts[1].enabled = false;
  const tui = tuiFor(am);
  const disabled = tui._renderAcct(1, 11, true);
  assert.ok(strip(disabled).includes('✕ disabled'), 'disabled status is the prominent ✕ marker, not faint gray');
  assert.ok(disabled.includes(DIM), 'the disabled row name is dimmed (reads as off)');
});

test('A1 a disabled name is a single DIM span, never dim(bold(...)) (no nested-RESET cancel)', () => {
  const am = mgr();
  am.accounts[0].enabled = false;
  const tui = tuiFor(am);
  tui.mode = 'select';
  tui.selIdx = 0;                                   // selected AND disabled
  const row = tui._renderAcct(0, 11, true);
  // The name must be dim only — never wrapped in BOLD (whose trailing RESET would
  // cancel the dim mid-string). A disabled row is not bold-selected.
  const nameRegion = row.slice(0, row.indexOf('oauth') > -1 ? row.indexOf('oauth') : 40);
  assert.ok(!nameRegion.includes(BOLD), 'a disabled selected row must not bold the name');
});

test('A1 an ENABLED account is NOT dimmed', () => {
  const am = mgr();
  const tui = tuiFor(am);
  const enabled = tui._renderAcct(0, 11, true);
  assert.ok(!strip(enabled).includes('✕ disabled'));
});

// ── A3: the routing footer shows the CURRENT cross-provider policy inline ─────────

test('A3 the routing footer shows the live cross-provider policy (updates at the keypress)', () => {
  const am = mgr();
  am.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' });
  const tui = tuiFor(am);
  tui.mode = 'routing';
  am.setCrossProviderFallbackPolicy('always');
  assert.ok(strip(tui._renderFooter()).includes('Cross-provider: always'), 'footer reflects the active policy');
  am.setCrossProviderFallbackPolicy('never');
  assert.ok(strip(tui._renderFooter()).includes('Cross-provider: never'), 'footer updates when the policy cycles');
});

// ── A7: the wider Account column fits a full email ───────────────────────────────

test('A7 a 16-char account name renders in full (Account column widened to 16)', () => {
  const am = mgr(['sixteencharname!']);            // exactly 16 chars
  const tui = tuiFor(am);
  assert.ok(strip(tui._renderAcct(0, 11, true)).includes('sixteencharname!'), 'a 16-char name is not truncated');
});

test('A7 the header columns sit at the widened offsets', () => {
  const hdr = strip(__tuiTest.acctHeader(100));
  assert.equal(hdr.indexOf('Account'), 4);
  assert.equal(hdr.indexOf('Provider'), 21);
  assert.equal(hdr.indexOf('Status'), 31);
});

// ── U1: the update banner appears only when a newer version is published ──────────

test('U1 the update banner shows an actionable reminder when hasUpdate', () => {
  const am = mgr();
  am.versionInfo = { current: '1.5.38', latest: '1.5.39', hasUpdate: true, checkedAt: Date.now() };
  const tui = tuiFor(am);
  const { text } = captureRender(tui);
  assert.ok(text.includes('Update available: v1.5.38 → v1.5.39'), 'shows current → latest');
  assert.ok(text.includes('npm i -g maxpool'), 'tells the user how to update');
});

test('U1 no banner (and no blank line) when on the latest version', () => {
  const am = mgr();
  am.versionInfo = { current: '1.5.39', latest: '1.5.39', hasUpdate: false, checkedAt: Date.now() };
  const tui = tuiFor(am);
  const { text } = captureRender(tui);
  assert.ok(!text.includes('Update available'), 'no reminder when up to date');
});

test('U1 the running version is shown in the header', () => {
  const am = mgr();
  am.versionInfo = { current: '1.5.39', latest: '1.5.39', hasUpdate: false, checkedAt: Date.now() };
  const tui = tuiFor(am);
  const { text } = captureRender(tui);
  assert.ok(text.includes('Maxpool v1.5.39'), 'header shows the running version');
});

// ── Restart feedback: R→Yes must not look frozen while requests drain ─────────────

test('restart feedback: a paused-for-restart admission shows a live draining banner', () => {
  const am = mgr();
  const tui = tuiFor(am);
  am.admissionPaused = true;                       // what requestRestart() sets
  tui.active.set('r1', { sessionKey: 's', account: 'personal', started: Date.now(), t: '00:00:00', method: 'POST', path: '/v1/messages' });
  const { text } = captureRender(tui);
  assert.ok(text.includes('Restarting'), 'the screen is no longer a frozen dashboard — it says Restarting');
  assert.match(text, /draining 1 active request\b/, 'shows the live drain count so the user knows it is working');
});

test('restart feedback: with nothing in flight the banner shows "finishing up"', () => {
  const am = mgr();
  const tui = tuiFor(am);
  am.admissionPaused = true;
  const { text } = captureRender(tui);
  assert.ok(text.includes('Restarting'), 'still shows a restarting indicator with 0 in-flight');
  assert.ok(text.includes('finishing up'), 'no misleading "draining 0" — reads "finishing up"');
});

// ── W-D: enable/disable GLM/Kimi providers in the TUI (was Claude-only) ───────────

test('W-D a runtime GLM/Kimi provider is selectable for enable/disable and toggles in-session', async () => {
  const am = mgr(['claude1']);                                             // 1 oauth (in config)
  am.addAccount({ name: 'glm-fallback', type: 'provider', provider: 'zai', apiKey: 'zk' }); // runtime provider, idx 1
  const config = { proxy: { port: 3456 }, accounts: [{ name: 'claude1', type: 'oauth', accessToken: 't0' }] };
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => {} });

  // Previously runtime providers were excluded from the toggle picker (Claude-only).
  assert.ok(tui._selectableIndexes('toggle').includes(1), 'the GLM provider is selectable for enable/disable');

  await tui._doToggle(1, false);
  assert.equal(am.accounts[1].enabled, false, 'the provider is disabled in the running manager (session-only)');
  await tui._doToggle(1, true);
  assert.equal(am.accounts[1].enabled, true, 're-enable works too');
});

test('restart feedback: NO restarting banner during normal operation', () => {
  const am = mgr();
  const tui = tuiFor(am);
  const { text } = captureRender(tui);
  assert.ok(!text.includes('Restarting'), 'no restart banner when admission is not paused');
});
