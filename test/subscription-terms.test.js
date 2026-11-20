import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { subscriptionTermsFor, rememberZaiTerms } from '../src/subscription-terms.js';
import { listSubscriptions, monthlyPriceUSD } from '../src/zai-subs.js';
import { sanitizePlan } from '../src/account-manager.js';

const account = { name: 'example', provider: 'zai', credential: 'fixture' };

function snapshot(t, rows, permissions = 0o600) {
  const dir = mkdtempSync(join(tmpdir(), 'maxpool-terms-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'registry.json');
  writeFileSync(file, JSON.stringify(rows), { mode: permissions });
  chmodSync(file, permissions);
  return file;
}

function source(file, pool) {
  return { ui: { subscriptionRegistries: [{ file, pool }] } };
}

const tracker = [{
  vendor: 'z.ai', maxpool_account: 'example', secret: 'private-source-identifier',
  subscriptions: [
    { status: 'VALID', auto_renew: true, cycle: 'quarterly', price: '20', renew_price: '18', next_renew: '2027-03-01T10:00:00Z' },
    { status: 'VALID', auto_renew: false, cycle: 'annually', price: 80, renew_price: 100, next_renew: '2027-10-01' },
    { status: 'EXPIRED', cycle: 'monthly', price: 100 },
  ],
}];

test('owner snapshot reads active per-charge terms and hides unrelated tracker fields', t => {
  const config = source(snapshot(t, tracker));
  assert.deepEqual(subscriptionTermsFor(config, account), [
    { price: 18, currency: null, cadence: 'quarterly', nextRenewal: '2027-03-01' },
    { price: 80, currency: null, cadence: 'annual', nextRenewal: null },
  ]);
  const mirror = { ...account, remote: { linkName: 'team', remoteName: account.name } };
  assert.deepEqual(subscriptionTermsFor(config, mirror), []);
  const linked = source(config.ui.subscriptionRegistries[0].file, 'team');
  assert.equal(subscriptionTermsFor(linked, mirror).length, 2);
  assert.deepEqual(subscriptionTermsFor(linked, account), []);
  assert.deepEqual(subscriptionTermsFor(linked, { ...mirror, remote: { ...mirror.remote, linkName: 'other' } }), []);
  assert.deepEqual(subscriptionTermsFor(linked, { ...mirror, provider: 'codex' }), []);
});

test('Codex and Claude manual terms support other currencies, zero, partial information and missing dates', t => {
  const config = source(snapshot(t, [
    { vendor: 'codex', account: 'example', subscriptions: [{ price: 0, currency: 'eur', cycle: 'monthly', next_renew: '2027-02-31' }] },
    { vendor: 'claude', account: 'example', subscriptions: [{ price: null, next_renew: '2027-04-01' }] },
    { vendor: 'kimi', account: 'example', subscriptions: [{ price: '17' }] },
  ]));
  assert.deepEqual(subscriptionTermsFor(config, { ...account, provider: 'codex' }),
    [{ price: 0, currency: 'EUR', cadence: 'monthly', nextRenewal: null }]);
  assert.deepEqual(subscriptionTermsFor(config, { ...account, provider: 'anthropic' }),
    [{ price: null, currency: null, cadence: null, nextRenewal: '2027-04-01' }]);
  assert.deepEqual(subscriptionTermsFor(config, { ...account, provider: 'kimi' }),
    [{ price: 17, currency: null, cadence: null, nextRenewal: null }]);
});

test('unavailable/private-ineligible sources and remote-reported terms stay hidden', t => {
  const unprotected = snapshot(t, tracker, 0o644);
  const protectedPath = snapshot(t, tracker);
  symlinkSync(protectedPath, protectedPath + '.link');
  for (const path of [unprotected, protectedPath + '.link', protectedPath + '.missing', './registry.json']) {
    assert.deepEqual(subscriptionTermsFor(source(path), account), []);
  }
  const mirror = { name: 'example', provider: 'zai', remote: { linkName: 'example', remoteName: 'example' },
    remotePlan: { priceUsd: 99, cadence: 'monthly' }, remoteMonthlyPriceUSD: 99 };
  assert.deepEqual(subscriptionTermsFor({}, mirror), []);
  assert.deepEqual(subscriptionTermsFor({}, { type: 'oauth', name: 'example' }), []);
});

test('existing z.ai probe supplies private terms without changing legacy price or serializing into the account', async () => {
  const result = await listSubscriptions('test-only', { fetchImpl: async () => ({
    ok: true, json: async () => ({ data: [{ id: 1, status: 'VALID', autoRenew: 1,
      billingCycle: 'quarterly', currency: 'USD', actualPrice: 55, renewPrice: 60, nextRenewTime: '2027-05-12 00:00:00' }] }),
  }) });
  assert.equal(monthlyPriceUSD(result.subscriptions), 20);
  const local = { ...account };
  const saved = JSON.stringify(local);
  rememberZaiTerms(local, result.subscriptions);
  assert.deepEqual(subscriptionTermsFor({}, local), [{ price: 60, currency: 'USD', cadence: 'quarterly', nextRenewal: '2027-05-12' }]);
  assert.equal(JSON.stringify(local), saved);
  local.credential = 'replacement-fixture';
  assert.deepEqual(subscriptionTermsFor({}, local), []);
  rememberZaiTerms(local, []);
  assert.deepEqual(subscriptionTermsFor({}, local), []);
});

test('explicit local plan keeps zero distinct from unknown and has no inferred renewal date', () => {
  for (const priceUsd of [null, '', '  ', false, true]) {
    const plan = sanitizePlan({ tier: 'Example', cadence: 'monthly', priceUsd });
    const [row] = subscriptionTermsFor({}, { ...account, plan });
    assert.deepEqual(row, { price: null, currency: 'USD', cadence: 'monthly', nextRenewal: null });
  }
  const plan = sanitizePlan({ tier: 'Example', cadence: 'monthly', priceUsd: 0 });
  assert.equal(subscriptionTermsFor({}, { ...account, plan })[0].price, 0);
});
