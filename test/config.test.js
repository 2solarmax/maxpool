import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, lstat, readFile, readdir, writeFile, chmod, symlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
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

const nativeGrant = {
  name: 'Codex', type: 'oauth', provider: 'codex', codexAuth: 'native',
  accountUuid: 'user', organizationUuid: 'workspace', codexAccountId: 'workspace',
  accessToken: 'existing-access', refreshToken: 'existing-refresh',
};

// Use the same public config transaction in both separate processes as the real
// local enrollment and refresh persistence paths. Pause the worker after its
// on-disk grant check, immediately before it stages the rotated credentials.
const writerSource = `
  import { once } from 'node:events';
  import { atomicConfigUpdate } from '${new URL('../src/config.js', import.meta.url).href}';
  import { canPersistOAuthRefresh } from '${new URL('../src/account-config.js', import.meta.url).href}';
  const operation = process.argv[1];
  const original = ${JSON.stringify(nativeGrant)};
  process.send('attempted');
  try {
    await atomicConfigUpdate(async config => {
      const row = config.accounts.find(account => account.name === original.name);
      if (operation === 'refresh') {
        const tokens = { accessToken: 'rotated-access', refreshToken: 'rotated-refresh' };
        const target = { ...original, credential: original.accessToken };
        if (!canPersistOAuthRefresh(row, tokens, { target, refreshedFrom: original.refreshToken })) throw Error('unexpected refresh predecessor');
        process.send('inside');
        await once(process, 'message');
        Object.assign(row, tokens);
      } else if (operation === 'reauth') {
        process.send('inside');
        Object.assign(row, { accessToken: 'new-login-access', refreshToken: 'new-login-refresh' });
      } else {
        process.send('inside');
        config.accounts.push({ ...original, name: operation, accountUuid: operation });
      }
    });
    process.send('saved');
  } catch (error) {
    process.send(error.code || String(error));
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
`;

function configWriter(t, path, operation) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', writerSource, operation], {
    env: { ...process.env, MAXPOOL_CONFIG: path }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const messages = new Set();
  child.on('message', value => messages.add(value));
  const exit = once(child, 'exit');
  t.after(() => { child.kill(); return exit; });
  const wait = async (message) => {
    const started = Date.now();
    while (!messages.has(message) && child.exitCode == null && child.signalCode == null && Date.now() - started < 2000) {
      await delay(10);
    }
    assert.ok(messages.has(message), `expected ${message} from ${operation}: ${Array.from(messages).join(', ')}`);
  };
  return { child, exit, wait, messages };
}

for (const viaSymlink of [false, true]) {
  test(`local Codex reauthorization and worker refresh serialize on ${viaSymlink ? 'a symlink alias' : 'the same file'}`, async (t) => {
    await withTempConfig(async (dir, path) => {
      await saveConfig({ ...createDefaultConfig(), accounts: [nativeGrant] });
      const loginPath = viaSymlink ? join(dir, 'alias.json') : path;
      if (viaSymlink) await symlink(path, loginPath, 'file');
      const worker = configWriter(t, path, 'refresh');
      await worker.wait('inside');
      const login = configWriter(t, loginPath, 'reauth');
      await login.wait('attempted');
      // The old implementation enters the login callback here, before the
      // worker commits its now-stale snapshot.
      await delay(150);
      const overlapped = login.messages.has('inside');
      worker.child.send('finish');
      assert.deepEqual(await worker.exit, [0, null]);
      assert.deepEqual(await login.exit, [0, null]);
      const updated = await loadConfig();
      assert.equal(updated.accounts[0].refreshToken, 'new-login-refresh');
      assert.equal(overlapped, false);
      if (viaSymlink) assert.equal((await lstat(loginPath)).isSymbolicLink(), true);
      assert.equal(updated._generation, 2);
    });
  });
}

test('a live config writer is never evicted and concurrent writers recover after it dies', { timeout: 15_000 }, async (t) => {
  await withTempConfig(async (dir, path) => {
    await saveConfig({ ...createDefaultConfig(), accounts: [nativeGrant] });
    const holder = configWriter(t, path, 'refresh');
    await holder.wait('inside');
    const waiting = configWriter(t, path, 'must-not-write');
    assert.deepEqual(await waiting.exit, [1, null]);
    assert.ok(waiting.messages.has('CONFIG_BUSY'));
    assert.equal((await loadConfig()).accounts.length, 1);

    holder.child.kill('SIGKILL');
    assert.deepEqual(await holder.exit, [null, 'SIGKILL']);
    const first = configWriter(t, path, 'first-login');
    const second = configWriter(t, path, 'second-login');
    assert.deepEqual(await Promise.all([first.exit, second.exit]), [[0, null], [0, null]]);
    assert.deepEqual((await loadConfig()).accounts.map(a => a.name).sort(), ['Codex', 'first-login', 'second-login']);
    assert.deepEqual((await readdir(dir)).filter(name => name.includes('.write-lock')), []);
  });
});
