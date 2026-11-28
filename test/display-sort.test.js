// Requested 2026-11-28: every account list sorts by the provider it SHOWS, then by
// the account name it SHOWS, alphabetical and case-insensitive. Local rows stay
// before cloud rows (owner 2026-10-29) and the sort applies inside each group.
// Display-only: the canonical am.accounts array is never reordered, so routing and
// every index-keyed action keep addressing the original row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { TUI, __tuiTest } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';
import { PoolLink, remoteIdentities } from '../src/pool-link.js';

const { strip, providerLabel } = __tuiTest;

// Synthetic names only. Deliberately unsorted, mixed case, and with the provider
// families in reverse-alphabetical array order (Moonshot rows before Anthropic).
const LOCAL = [
  { name: 'zeta api', type: 'apikey', apiKey: 'k-z', accountUuid: 'UZ' },
  { name: 'Kimi team', type: 'provider', provider: 'kimi', authToken: 'key-1', upstream: 'http://x', profiles: ['all'] },
  { name: 'alpha claude', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 36e5, accountUuid: 'UA' },
  { name: 'glm beta', type: 'provider', provider: 'zai', authToken: 'key-2', upstream: 'http://x', profiles: ['all'] },
  { name: 'Z.ai alpha', type: 'provider', provider: 'zai', authToken: 'key-3', upstream: 'http://x', profiles: ['all'] },
  { name: 'mid claude', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 36e5, accountUuid: 'UM' },
  { name: 'codex one', type: 'provider', provider: 'codex', authToken: 'key-4', upstream: 'http://x', profiles: ['all'] },
];

function build() {
  const am = new AccountManager(structuredClone(LOCAL), 0.9);
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  const ra = (name, type, provider, extra = {}) => ({ name, type, provider, enabled: true, status: 'active', inFlight: 0, quota: {}, ...extra });
  link.status = { accounts: [
    ra('cloud kimi', 'provider', 'kimi'),
    ra('cloud Anthropic', 'oauth', 'anthropic', { accountUuid: 'UC1' }),
    ra('cloud glm', 'provider', 'zai'),
    ra('Cloud claude', 'oauth', 'anthropic', { accountUuid: 'UC2' }),
  ] };
  link.identities = remoteIdentities(link.status);
  am.setPoolLinks([link]);
  const tui = new TUI({ accountManager: am, config: {} });
  return { am, tui };
}

const shownName = (am, i) => { const a = am.accounts[i]; return a.remote ? a.remote.remoteName : a.name; };
const shownRows = (am, tui) => tui._displayOrder().map(i => `${providerLabel(am.accounts[i])}|${shownName(am, i)}`);

// Alphabetical by the DISPLAYED provider label, then by the displayed name, case-insensitive.
// Terminal labels: Anthropic, Codex, Moonshot (Kimi), z.ai.
const EXPECTED = [
  'Anthropic|alpha claude', 'Anthropic|mid claude', 'Anthropic|zeta api',
  'Codex|codex one',
  'Moonshot|Kimi team',
  'z.ai|glm beta', 'z.ai|Z.ai alpha',
  'Anthropic|cloud Anthropic', 'Anthropic|Cloud claude',
  'Moonshot|cloud kimi',
  'z.ai|cloud glm',
];

test('display order: provider as shown, then name as shown, case-insensitive, local before cloud', () => {
  const { am, tui } = build();
  assert.deepEqual(shownRows(am, tui), EXPECTED);
});

test('display order is a view: the canonical account array and its indices are untouched', () => {
  const { am, tui } = build();
  const before = am.accounts.map(a => a.name);
  tui._displayOrder();
  assert.deepEqual(am.accounts.map(a => a.name), before);
  assert.deepEqual(am.accounts.map(a => a.index), before.map((_, i) => i), 'account.index still equals the array position');
  // The order is NOT the array order, i.e. the test above is not passing vacuously.
  assert.notDeepEqual(tui._displayOrder(), am.accounts.map((_, i) => i));
});

test('stable on re-login: a fresh account array rebuilt in a different add order shows the same rows', () => {
  const a = build();
  const b_am = new AccountManager(structuredClone(LOCAL).reverse(), 0.9);
  const link = a.am.poolLinks[0];
  b_am.setPoolLinks([link]);
  const b = new TUI({ accountManager: b_am, config: {} });
  const localOnly = rows => rows.filter(r => !r.includes('☁'));
  assert.notDeepEqual(b_am.accounts.map(x => x.name), a.am.accounts.map(x => x.name), 'sanity: the arrays really differ');
  assert.deepEqual(localOnly(shownRows(b_am, b)), localOnly(shownRows(a.am, a.tui)));
});

test('selection walks the visible order and acts on the ORIGINAL index', () => {
  const { am, tui } = build();
  const order = tui._displayOrder();
  const toggle = tui._selectableIndexes('toggle');
  assert.deepEqual(toggle, order, 'nav order is the display order');
  // Step down twice from the top: the third visible row must be the account shown third.
  tui.mode = 'select'; tui.selAction = 'toggle'; tui.selIdx = toggle[0];
  tui._keySelect('down'); tui._keySelect('down');
  assert.equal(shownName(am, tui.selIdx), 'zeta api', 'the highlight is on the third visible row');
  assert.equal(am.accounts[tui.selIdx].name, 'zeta api', 'and it resolves to that row\'s real account object');
  // An index-keyed action targets the same row it addressed before the sort.
  const target = am.accounts.findIndex(a => a.name === 'Kimi team');
  assert.equal(providerLabel(am.accounts[target]), 'Moonshot');
  assert.ok(order.includes(target), 'the Kimi row is still addressed by its canonical index');
  // "prefer" never offers a provider and stays in display order.
  assert.deepEqual(tui._selectableIndexes('prefer').map(i => shownName(am, i)),
    ['alpha claude', 'mid claude', 'zeta api', 'cloud Anthropic', 'Cloud claude']);
  assert.ok(tui._selectableIndexes('prefer').every(i => am.accounts[i].type !== 'provider' && am.accounts[i].enabled));
});

test('the rendered terminal table lists rows in that order', () => {
  const { tui } = build();
  const ow = process.stdout.write;
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  let buf = '';
  try {
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    Object.defineProperty(process.stdout, 'rows', { value: 60, configurable: true });
    process.stdout.write = s => { buf += s; return true; };
    tui._render();
  } finally {
    process.stdout.write = ow;
    cols ? Object.defineProperty(process.stdout, 'columns', cols) : delete process.stdout.columns;
    rows ? Object.defineProperty(process.stdout, 'rows', rows) : delete process.stdout.rows;
  }
  const text = strip(buf);
  const at = name => text.indexOf(name);
  const seq = ['alpha claude', 'mid claude', 'zeta api', 'codex one', 'Kimi team', 'glm beta', 'Z.ai alpha',
    'cloud Anthropic', 'Cloud claude', 'cloud kimi', 'cloud glm'];
  for (const n of seq) assert.ok(at(n) >= 0, `"${n}" renders`);
  for (let k = 1; k < seq.length; k++) {
    assert.ok(at(seq[k - 1]) < at(seq[k]), `"${seq[k - 1]}" renders above "${seq[k]}"`);
  }
});

// ── Web dashboard (src/screen.html): the same sort on both of its lists ─────────
const html = readFileSync(new URL('../src/screen.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));

async function renderScreen(status) {
  const app = { innerHTML: '' };
  const stub = { onclick: null, onkeydown: null, value: '' };
  vm.runInNewContext(script, {
    document: { getElementById: id => (id === 'app' ? app : stub) },
    localStorage: { getItem: () => 'k', setItem() {}, removeItem() {} },
    fetch: async () => ({ status: 200, ok: true, json: async () => status }),
    setTimeout: () => 0, clearTimeout: () => {}, console, Date, Object, String, Math, isFinite,
  });
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  return app.innerHTML;
}

const webStatus = () => ({
  accounts: [
    { name: 'zeta api', type: 'apikey', provider: 'anthropic', quota: {} },
    { name: 'Kimi team', type: 'provider', provider: 'kimi', quota: {} },
    { name: 'alpha claude', type: 'oauth', provider: 'anthropic', quota: {} },
    { name: 'glm beta', type: 'provider', provider: 'zai', quota: {} },
    { name: 'Z.ai alpha', type: 'provider', provider: 'zai', quota: {} },
    { name: 'mid claude', type: 'oauth', provider: 'anthropic', quota: {} },
    { name: 'codex one', type: 'provider', provider: 'codex', quota: {} },
  ],
  pools: [{ name: 'team', ok: true, accounts: [
    { name: 'cloud kimi', type: 'provider', provider: 'kimi', quota: {} },
    { name: 'cloud Anthropic', type: 'oauth', provider: 'anthropic', quota: {} },
    { name: 'cloud glm', type: 'provider', provider: 'zai', quota: {} },
    { name: 'Cloud claude', type: 'oauth', provider: 'anthropic', quota: {} },
  ] }],
});

// Read the names back out of the rendered cards, in page order.
function cardOrder(out) {
  return [...out.matchAll(/<div class="name">([^<]*)<\/div><div class="sub">([^<·]*)/g)]
    .map(m => `${m[2].trim()}|${m[1]}`);
}

test('web dashboard: this-Mac cards sort by shown provider then shown name', async () => {
  const out = await renderScreen(webStatus());
  const mac = cardOrder(out).slice(0, 7);   // the pool's cards follow the this-Mac grid
  // The web page labels a row by its raw provider key (Codex is special-cased); the
  // sort uses whatever label the card shows.
  assert.deepEqual(mac, [
    'anthropic|alpha claude', 'anthropic|mid claude', 'anthropic|zeta api',
    'Codex|codex one', 'kimi|Kimi team', 'zai|glm beta', 'zai|Z.ai alpha',
  ]);
});

test('web dashboard: cloud cards inside a pool sort the same way', async () => {
  const out = await renderScreen(webStatus());
  const cloud = cardOrder(out).filter(r => r.includes('cloud') || r.includes('Cloud'));
  assert.deepEqual(cloud, ['anthropic|cloud Anthropic', 'anthropic|Cloud claude', 'kimi|cloud kimi', 'zai|cloud glm']);
});

// ── Ties and names that only differ by the cloud uniqueness suffix ─────────────

test('names that differ only by case tie, and the tie keeps the canonical array order', () => {
  // `Bob` is added first. Case-folded they are equal, so the array order decides; a
  // case-sensitive compare would put `bob` first (ICU sorts lowercase before uppercase).
  const am = new AccountManager([
    { name: 'Bob', type: 'apikey', apiKey: 'k1' },
    { name: 'bob', type: 'apikey', apiKey: 'k2' },
  ], 0.9);
  const tui = new TUI({ accountManager: am, config: {} });
  assert.deepEqual(tui._displayOrder().map(i => am.accounts[i].name), ['Bob', 'bob']);
  // Same two accounts re-added in the other order: still array order, so never flipped.
  const am2 = new AccountManager([
    { name: 'bob', type: 'apikey', apiKey: 'k2' },
    { name: 'Bob', type: 'apikey', apiKey: 'k1' },
  ], 0.9);
  assert.deepEqual(new TUI({ accountManager: am2, config: {} })._displayOrder().map(i => am2.accounts[i].name), ['bob', 'Bob']);
});

test('a cloud row sorts by the name it shows, not by its internal uniqueness suffix', () => {
  // Two linked pools both expose "bob": the second mirror is stored as "bob (other) ☁"
  // but shown as "bob". By internal name it would sort after "bob (a ☁" (o > a); by
  // shown name both "bob" rows come before "bob (a".
  const am = new AccountManager([{ name: 'local one', type: 'apikey', apiKey: 'k1' }], 0.9);
  const mk = (linkName, names) => {
    const link = new PoolLink({ name: linkName, url: 'http://x', key: 'k' });
    link.lastOkAt = 1; link.lastError = null;
    link.status = { accounts: names.map(([name, uuid]) => ({ name, type: 'oauth', provider: 'anthropic', enabled: true, status: 'active', inFlight: 0, quota: {}, accountUuid: uuid })) };
    link.identities = remoteIdentities(link.status);
    return link;
  };
  am.setPoolLinks([mk('team', [['bob', 'U1'], ['bob (a', 'U2']]), mk('other', [['bob', 'U3']])]);
  const tui = new TUI({ accountManager: am, config: {} });
  assert.ok(am.accounts.some(a => a.name === 'bob (other) ☁'), 'sanity: the uniqueness suffix was applied');
  const cloud = tui._displayOrder().filter(i => am.accounts[i].remote).map(i => shownName(am, i));
  assert.deepEqual(cloud, ['bob', 'bob', 'bob (a']);
});

test('web dashboard: a case-only tie falls through to the next key, and a provider key in capitals folds', async () => {
  const out = await renderScreen({
    accounts: [
      { name: 'bob', type: 'oauth', provider: 'anthropic', enabled: false, quota: {} },
      { name: 'Bob', type: 'oauth', provider: 'anthropic', quota: {} },
      { name: 'late', type: 'provider', provider: 'Zeta', quota: {} },
      { name: 'early', type: 'provider', provider: 'beta', quota: {} },
    ],
    pools: [],
  });
  // Same provider and same name ignoring case: the switched-on card goes first.
  // "Zeta" sorts by its lowercase form, so after "beta" even though "Z" < "b" in ASCII.
  assert.deepEqual(cardOrder(out), ['anthropic|Bob', 'anthropic|bob', 'beta|early', 'Zeta|late']);
});
