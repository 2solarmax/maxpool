// A BENCHED account is a local duplicate of an account the cloud team pool owns
// (`poolBenchedBy`). It is never token-refreshed (account-manager ensureTokenFresh
// returns early so the cloud keeps the single-use refresh token), so its local
// access token goes dead. Probing it just fails every sweep — and each 429 widens
// the shared inter-probe gap ×1.5 (cap 120s), slowing probes of the HEALTHY rows.
// Every sibling prober path already skips benched rows; the OAuth sweep did not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

const BASE_GAP = 10;

function harness() {
  const am = new AccountManager([
    { name: 'healthy', type: 'oauth', accessToken: 'healthy-token', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'benched', type: 'oauth', accessToken: 'benched-token', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.setWriterLease(true);
  am.accounts[1].poolBenchedBy = 'cloud-team-row';
  const probed = [];
  const probeFn = async (credential) => {
    probed.push(credential);
    // The benched copy's token is dead; the shared endpoint answers it with an error.
    if (credential === 'benched-token') return { error: 'HTTP 429', status: 429 };
    return { fiveHour: { utilization: 0.1 } };
  };
  const prober = new Prober(am, {
    grantsFn: async () => null, intervalMs: 0, probeFn,
    providerProbeFn: async () => null, log: () => {}, usageGapMs: BASE_GAP,
  });
  return { am, prober, probed };
}

test('a sweep never probes a benched duplicate', async () => {
  const { prober, probed } = harness();
  await prober.probeAll();
  assert.deepEqual(probed, ['healthy-token'], 'only the healthy row is probed');
});

test('a benched duplicate costs the sweep no pacing slot', async () => {
  // Each swept row waits one inter-probe gap first; a benched row must not take a slot
  // (and must not stamp the shared last-probe time) even if probeOne itself bails.
  const { prober } = harness();
  let paced = 0;
  const orig = prober._paceUsage.bind(prober);
  prober._paceUsage = async () => { paced++; return orig(); };
  await prober.probeAll();
  assert.equal(paced, 1, 'one pacing wait for the one healthy row');
});

test('a benched duplicate cannot widen the shared inter-probe gap', async () => {
  const { prober } = harness();
  await prober.probeAll();
  const gap = prober._usageGapMs ?? BASE_GAP;
  assert.equal(gap, BASE_GAP, 'the gap stays at its base — no 429 from a row we should not probe');
});

test('probeOne on a benched row is a no-op (no upstream call)', async () => {
  const { am, prober, probed } = harness();
  const r = await prober.probeOne(am.accounts[1]);
  assert.deepEqual(probed, [], 'no upstream call');
  assert.equal(r?.ok ?? false, false, 'nothing was read');
});
