import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, __tuiTest } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

// Reported 2026-08-17: a new GLM account added to the config AFTER the Kimi row
// rendered BELOW Kimi — same-provider accounts split across the table. Providers
// must group by family: all GLM together, then all Kimi (or vice versa — whatever
// first-seen order dictates), never interleaved.

const { strip } = __tuiTest;

const build = () => {
  const accounts = [
    { name: 'claude-1', type: 'oauth', enabled: true, accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, quota: {} },
    { name: 'glm max', type: 'provider', provider: 'zai', enabled: true, apiKey: 'k1', quota: {} },
    { name: 'glm glm1', type: 'provider', provider: 'zai', enabled: true, apiKey: 'k2', quota: {} },
    { name: 'kimi max', type: 'provider', provider: 'kimi', enabled: true, apiKey: 'k3', quota: {} },
    // The reported case: a GLM row added AFTER the Kimi row (config append order).
    { name: 'glm glm2', type: 'provider', provider: 'zai', enabled: true, apiKey: 'k4', quota: {} },
  ];
  const am = new AccountManager(accounts, 0.90);
  const tui = new TUI({ accountManager: am, config: {} });
  return { tui, am };
};

const order = tui => tui._displayOrder().map(i => tui.am.accounts[i].name);

test('providers group by family — a GLM added after Kimi still renders with GLM', () => {
  const { tui } = build();
  const o = order(tui);
  // OAuth first, then all zai together, then kimi — no interleaving.
  assert.deepEqual(o, ['claude-1', 'glm max', 'glm glm1', 'glm glm2', 'kimi max'],
    `display order must group families: got ${JSON.stringify(o)}`);
});

test('grouping is stable across renders and never reorders OAuth', () => {
  const { tui } = build();
  assert.deepEqual(order(tui), order(tui), 'same input → same order');
  assert.equal(order(tui)[0], 'claude-1', 'OAuth rows stay first');
});

test('the render loop emits the grouped order (the visible table)', () => {
  const { tui } = build();
  let out = ''; const ow = process.stdout.write;
  const oc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  try {
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    process.stdout.write = s => { out += s; return true; };
    tui._render();
  } finally {
    process.stdout.write = ow;
    if (oc) Object.defineProperty(process.stdout, 'columns', oc);
  }
  const text = strip(out);
  const glm1At = text.indexOf('glm glm1');
  const glm2At = text.indexOf('glm glm2');
  const kimiAt = text.indexOf('kimi max');
  assert.ok(glm1At >= 0 && glm2At >= 0 && kimiAt >= 0, 'all rows render');
  assert.ok(glm2At < kimiAt, 'glm2 renders BEFORE kimi (grouped with its family)');
  assert.ok(glm1At < kimiAt, 'glm1 before kimi');
});

test('kimi-first config also groups (order determined by first-seen, not hardcoded)', () => {
  const accounts = [
    { name: 'kimi a', type: 'provider', provider: 'kimi', enabled: true, apiKey: 'k1', quota: {} },
    { name: 'glm a', type: 'provider', provider: 'zai', enabled: true, apiKey: 'k2', quota: {} },
    { name: 'kimi b', type: 'provider', provider: 'kimi', enabled: true, apiKey: 'k3', quota: {} },
  ];
  const am = new AccountManager(accounts, 0.90);
  const tui = new TUI({ accountManager: am, config: {} });
  const o = order(tui);
  assert.deepEqual(o, ['kimi a', 'kimi b', 'glm a'],
    `kimi-seen-first keeps kimis together: got ${JSON.stringify(o)}`);
});
