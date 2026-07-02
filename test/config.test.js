import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, readdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDefaultConfig, saveConfig, loadConfig, atomicConfigUpdate,
} from '../src/config.js';

test('default config uses automatic routing', () => {
  const config = createDefaultConfig();

  assert.deepEqual(config.routing, {
    mode: 'automatic',
    preferredAccount: null,
  });
});

test('quota prober is enabled by default', () => {
  // Off-by-default left maxpool blind to idle / out-of-band-used accounts, which
  // the scorer then preferred and drove to exhaustion. Probing must be on.
  assert.equal(createDefaultConfig().quotaProbeSeconds, 60);
});

test('loadConfig backfills absent keys from current defaults (existing installs get new defaults)', async () => {
  await withTempConfig(async (dir, path) => {
    // A pre-existing config WITHOUT quotaProbeSeconds — exactly like the real
    // on-disk file. Flipping the default alone must actually reach it.
    await writeFile(path, JSON.stringify({
      proxy: { port: 3456, host: '127.0.0.1', apiKey: 'mp-x' },
      accounts: [{ name: 'one', type: 'apikey', apiKey: 'sk-1' }],
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.quotaProbeSeconds, 60, 'absent quotaProbeSeconds must inherit the default');
    // Present keys are preserved untouched — an explicit user value always wins.
    assert.equal(cfg.proxy.port, 3456);
    assert.deepEqual(cfg.accounts.map(a => a.name), ['one']);
  });
});

test('loadConfig never overrides an explicitly-set key with a default', async () => {
  await withTempConfig(async (dir, path) => {
    await writeFile(path, JSON.stringify({
      proxy: { port: 3456, host: '127.0.0.1', apiKey: 'mp-x' },
      accounts: [], quotaProbeSeconds: 0, // user deliberately disabled probing
    }));
    const cfg = await loadConfig();
    assert.equal(cfg.quotaProbeSeconds, 0, 'an explicit 0 must be respected, not clobbered by the default');
  });
});

async function withTempConfig(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-cfg-'));
  const path = join(dir, 'maxpool.json');
  const prev = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = path;
  try {
    return await fn(dir, path);
  } finally {
    if (prev === undefined) delete process.env.MAXPOOL_CONFIG;
    else process.env.MAXPOOL_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test('saveConfig writes valid JSON at 0600 and leaves no temp file', async () => {
  await withTempConfig(async (dir, path) => {
    const cfg = createDefaultConfig();
    cfg.accounts.push({ name: 'a1', type: 'apikey', apiKey: 'sk-secret' });
    await saveConfig(cfg);

    const parsed = JSON.parse(await readFile(path, 'utf-8')); // complete + valid
    assert.equal(parsed.accounts.length, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual((await readdir(dir)).filter(f => f.includes('.tmp')), []);
  });
});

test('saveConfig forces 0600 even when the file already exists world-readable', async () => {
  await withTempConfig(async (dir, path) => {
    // Pre-create a world-readable config (e.g. from an older version / bad umask).
    await writeFile(path, JSON.stringify(createDefaultConfig()));
    await chmod(path, 0o644);
    assert.equal((await stat(path)).mode & 0o777, 0o644);

    await saveConfig(createDefaultConfig());
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });
});

test('overlapping atomicConfigUpdate calls do not lose a write', async () => {
  await withTempConfig(async () => {
    await saveConfig({ ...createDefaultConfig(), accounts: [] });
    // Fire two updates concurrently; serialization must land both, not last-wins.
    await Promise.all([
      atomicConfigUpdate(c => { c.accounts.push({ name: 'one', type: 'apikey', apiKey: 'k1' }); }),
      atomicConfigUpdate(c => { c.accounts.push({ name: 'two', type: 'apikey', apiKey: 'k2' }); }),
    ]);
    const cfg = await loadConfig();
    assert.deepEqual(cfg.accounts.map(a => a.name).sort(), ['one', 'two']);
  });
});
