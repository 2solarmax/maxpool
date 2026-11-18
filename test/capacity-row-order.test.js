// D17: the Capacity page's row order must match the main account screen. A dual-copy
// identity (benched local + cloud mirror) used to anchor at the benched LOCAL copy's
// position — a row the main screen hides — so rows landed where Max never saw them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { PoolLink, credentialFp } from '../src/pool-link.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { strip } = __tuiTest;
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, ...extra });
const prov = (name, extra = {}) => ({ name, type: 'provider', provider: 'zai', authToken: 'key-' + name, upstream: 'http://x', profiles: ['all'], ...extra });
const NAMES = ['a-local', 'b-pair', 'c-cloud', 'd-prov', 'e-off'];

function build() {
  // Local rows first; mirrors are appended AFTER them by syncRemoteMirrors, so a dual-copy
  // identity's benched local sits far earlier than its mirror.
  const am = new AccountManager([
    oauth('a-local', { accountUuid: 'UA' }),
    oauth('b-pair', { accountUuid: 'UB' }),
    prov('d-prov'),
    oauth('e-off', { accountUuid: 'UE', enabled: false }),
  ], 0.9);
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  const ra = (name, extra) => ({ name, enabled: true, status: 'active', inFlight: 0, quota: {}, ...extra });
  const fp = credentialFp('key-d-prov');
  link.status = { accounts: [
    ra('c-cloud', { type: 'oauth', provider: 'anthropic', accountUuid: 'UC' }),
    ra('b-pair', { type: 'oauth', provider: 'anthropic', accountUuid: 'UB' }),
    ra('d-prov', { type: 'provider', provider: 'zai', keyFingerprint: fp }),
  ] };
  link.identities = new Map([
    ['uuid:UB', { name: 'b-pair', provider: 'anthropic', type: 'oauth' }],
    [`key:zai:${fp}`, { name: 'd-prov', provider: 'zai', type: 'provider' }],
  ]);
  am.setPoolLinks([link]);
  am.applyPoolLinks();
  return am;
}

const baseOf = n => n.replace(/ ☁$/, '');
function mainScreenOrder(am, hideDisabled) {
  const t = new TUI({ accountManager: am, config: { proxy: { port: 3456 }, ui: { hideDisabled } }, saveConfig: async () => {} });
  const cols = Object.getOwnPropertyDescriptor(process.stdout, 'columns'), rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  Object.defineProperty(process.stdout, 'columns', { value: 220, configurable: true });
  Object.defineProperty(process.stdout, 'rows', { value: 80, configurable: true });
  const orig = process.stdout.write; let buf = '';
  process.stdout.write = s => { buf += s; return true; };
  try { t._render(); } finally {
    process.stdout.write = orig;
    cols ? Object.defineProperty(process.stdout, 'columns', cols) : delete process.stdout.columns;
    rows ? Object.defineProperty(process.stdout, 'rows', rows) : delete process.stdout.rows;
  }
  const out = [];
  for (const l of strip(buf).split('\n')) {
    if (!/\s(Local|Cloud)\s/.test(l)) continue;   // account rows carry a where-column; log lines do not
    const hit = NAMES.find(n => new RegExp(`(^|\\s)${n}( ☁)?(\\s|$)`).test(l));
    if (hit) out.push(hit);
  }
  return out;
}
function capacityOrder(am, hideDisabled) {
  const t = new TUI({ accountManager: am, config: { ui: { hideDisabled } } });
  return am.capacityRows(t._displayOrder(), { hideDisabled }).map(r => baseOf(r.displayName));
}

test('D17: fixture really has benched local + mirror pairs', () => {
  const am = build();
  assert.ok(am.accounts.find(a => a.name === 'b-pair').poolBenchedBy);
  assert.ok(am.accounts.find(a => a.name === 'b-pair ☁').remote);
  assert.ok(am.accounts.find(a => a.name === 'd-prov').poolBenchedBy);
});

test('D17: hideDisabled ON — capacity order == main-screen order, one row per identity', () => {
  const am = build();
  const main = mainScreenOrder(am, true), cap = capacityOrder(am, true);
  assert.equal(main.length, 4, 'main sanity: a-local, c-cloud, b-pair, d-prov visible; e-off + benched locals hidden');
  assert.equal(new Set(main).size, main.length, 'main: one row per identity');
  assert.equal(new Set(cap).size, cap.length, 'capacity: one row per identity');
  assert.deepEqual(cap, main);
  assert.ok(!cap.includes('e-off'));
});

test('D17: hideDisabled OFF — still one row per identity on both surfaces; capacity keeps main order', () => {
  const am = build();
  const cap = capacityOrder(am, false);
  assert.equal(new Set(cap).size, cap.length);
  assert.deepEqual([...cap].sort(), [...NAMES].sort(), 'every identity once');
  // identities appear in the order of their PRIMARY (mirror) row's position on the main screen
  const pos = n => am.accounts.findIndex(a => a.name === n + ' ☁' || (a.name === n && !a.poolBenchedBy));
  const sorted = [...cap].sort((x, y) => pos(x) - pos(y));
  assert.deepEqual(cap, ['a-local', 'e-off', 'b-pair', 'c-cloud', 'd-prov'].sort((x, y) => pos(x) - pos(y)));
  assert.deepEqual(cap, sorted);
});
