// Generation-guard tests (defense-in-depth single-writer enforcement) for the
// near-zero-downtime reload. The baton sequencing already guarantees a single
// writer; these prove the on-disk generation counter ALSO refuses a stale write,
// so a sequencing bug can't revert a fresher token or fresher quota.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withConfigEnv(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-gen-'));
  const configPath = join(dir, 'config.json');
  const prev = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = configPath;
  // Import AFTER setting env so getConfigPath() resolves to our temp path. The
  // module reads the env at call time, so a single import is fine.
  const mod = await import('../src/config.js');
  try {
    return await fn({ configPath, statePath: configPath.replace(/\.json$/, '.state.json'), mod });
  } finally {
    if (prev === undefined) delete process.env.MAXPOOL_CONFIG;
    else process.env.MAXPOOL_CONFIG = prev;
  }
}

test('atomicConfigUpdate bumps a monotonic generation on every write', async () => {
  await withConfigEnv(async ({ configPath, mod }) => {
    await writeFile(configPath, JSON.stringify({ accounts: [] }) + '\n');
    await mod.atomicConfigUpdate(c => { c.marker = 'a'; });
    let disk = JSON.parse(await readFile(configPath, 'utf-8'));
    assert.equal(disk._generation, 1, 'first write → gen 1');
    assert.equal(disk.marker, 'a');

    await mod.atomicConfigUpdate(c => { c.marker = 'b'; });
    disk = JSON.parse(await readFile(configPath, 'utf-8'));
    assert.equal(disk._generation, 2, 'second write → gen 2');
    assert.equal(disk.marker, 'b');
  });
});

test('a stale writer at gen N is REFUSED; on-disk ends at N+1 with the live token', async () => {
  await withConfigEnv(async ({ configPath, mod }) => {
    // Lease holder writes the rotated (fresh) token at gen 1.
    await writeFile(configPath, JSON.stringify({
      accounts: [{ name: 'a1', type: 'oauth', refreshToken: 'r-fresh', accessToken: 'at-fresh' }],
    }) + '\n');
    await mod.atomicConfigUpdate(c => { c.accounts[0].refreshToken = 'r-fresh'; });
    const afterFresh = JSON.parse(await readFile(configPath, 'utf-8'));
    assert.equal(afterFresh._generation, 1);

    // A stale ex-lease worker that read gen 0 tries to write the OLD token.
    await assert.rejects(
      () => mod.atomicConfigUpdate(
        c => { c.accounts[0].refreshToken = 'r-stale'; },
        { guardGeneration: 0 },
      ),
      err => err.code === 'STALE_GENERATION',
      'stale write must be refused with STALE_GENERATION',
    );

    // On-disk is unchanged: still gen 1, still the fresh token.
    const final = JSON.parse(await readFile(configPath, 'utf-8'));
    assert.equal(final._generation, 1, 'generation not advanced by refused write');
    assert.equal(final.accounts[0].refreshToken, 'r-fresh', 'live token preserved');
  });
});

test('saveState refuses a stale flush so fresher quota is not reverted', async () => {
  await withConfigEnv(async ({ statePath, mod }) => {
    // Gen 1: fresher quota written by the lease holder.
    const g1 = await mod.saveState({ quota: [{ name: 'a1', quota: { unified7d: 0.9 } }] });
    assert.equal(g1, 1);

    // A stale writer that read gen 0 tries to flush OLDER quota → refused.
    const refused = await mod.saveState(
      { quota: [{ name: 'a1', quota: { unified7d: 0.1 } }] },
      { expectedGeneration: 0 },
    );
    assert.equal(refused, null, 'stale state flush refused');

    // On-disk still carries the fresher quota at gen 1.
    const disk = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(disk._generation, 1);
    assert.equal(disk.quota[0].quota.unified7d, 0.9, 'fresher quota preserved');

    // The lease holder (expecting gen 1) advances to gen 2 with new quota.
    const g2 = await mod.saveState(
      { quota: [{ name: 'a1', quota: { unified7d: 0.95 } }] },
      { expectedGeneration: 1 },
    );
    assert.equal(g2, 2);
    const disk2 = JSON.parse(await readFile(statePath, 'utf-8'));
    assert.equal(disk2.quota[0].quota.unified7d, 0.95);
  });
});
