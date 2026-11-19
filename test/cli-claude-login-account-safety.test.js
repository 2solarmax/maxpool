import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/index.js', import.meta.url));
const configModule = new URL('../src/config.js', import.meta.url).href;
const accountName = 'shared@example.test';

async function login(t, env, preload, beforeCallback) {
  const child = spawn(process.execPath, ['--import', preload, cli, 'login', '--oauth', '--local', '--name', accountName], {
    env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode == null) child.kill(); });
  const exited = once(child, 'exit');
  let output = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  let resolveAuthorize;
  const authorization = new Promise(resolve => { resolveAuthorize = resolve; });
  child.stdout.on('data', chunk => {
    output += chunk;
    const match = /https:\/\/claude\.ai\/oauth\/authorize\?[^\s]+\n/.exec(output);
    if (match) resolveAuthorize(new URL(match[0].trim()));
  });
  const auth = await Promise.race([authorization, exited.then(() => {
    throw new Error('CLI exited before opening authorization: ' + errors);
  })]);
  await beforeCallback?.();
  const callback = new URL(auth.searchParams.get('redirect_uri'));
  callback.searchParams.set('state', auth.searchParams.get('state'));
  callback.searchParams.set('code', 'fixture-only-code');
  const response = await fetch(callback, { redirect: 'manual', signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 302);
  assert.deepEqual(await exited, [0, null], output + errors);
  return output;
}

test('CLI Claude login keeps a Codex grant rotated while browser authorization was pending', { timeout: 12_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-claude-login-safety-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'config.json');
  const preload = join(dir, 'login-fixture.mjs');
  const env = { ...process.env, MAXPOOL_CONFIG: path, MAXPOOL_DISABLE_QUOTA_PROBE: '1' };
  const codex = { name: accountName, type: 'oauth', provider: 'codex', codexAuth: 'native',
    accountUuid: 'same-user', organizationUuid: 'same-org', codexAccountId: 'workspace',
    accessToken: 'codex-consumed-access', refreshToken: 'codex-consumed-grant', expiresAt: Date.now() + 60_000 };
  await writeFile(path, JSON.stringify({ _generation: 11, proxy: {}, accounts: [codex] }));
  await writeFile(preload, `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    childProcess.exec = () => undefined;
    syncBuiltinESMExports();
    globalThis.fetch = async (url) => {
      if (String(url) === 'https://platform.claude.com/v1/oauth/token') {
        return Response.json({ access_token: process.env.TEST_CLAUDE_ACCESS, refresh_token: process.env.TEST_CLAUDE_REFRESH, expires_in: 3600 });
      }
      if (String(url) === 'https://api.anthropic.com/api/oauth/profile') {
        return Response.json({ account: { uuid: 'same-user', email: 'shared@example.test' }, organization: { uuid: 'same-org' } });
      }
      throw new Error('Unexpected network call in login fixture');
    };
  `);

  const first = await login(t, { ...env, TEST_CLAUDE_ACCESS: 'claude-first', TEST_CLAUDE_REFRESH: 'claude-first-grant' },
    preload, async () => {
      // A separate process acquires the real config lock while the login waits
      // for its OAuth callback. The login began with the now-consumed grant.
      await exec(process.execPath, ['--input-type=module', '-e', `
        import { atomicConfigUpdate } from ${JSON.stringify(configModule)};
        await atomicConfigUpdate(config => {
          config.accounts[0].accessToken = 'codex-fresh-access';
          config.accounts[0].refreshToken = 'codex-fresh-grant';
          config.accounts[0].expiresAt += 60_000;
          config.concurrentField = 'survives';
        });
      `], { env });
    });
  assert.match(first, /Added account "shared@example\.test 2"/);
  const disk = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(disk._generation, 13);
  assert.equal(disk.concurrentField, 'survives');
  assert.deepEqual(disk.accounts[0], { ...codex, accessToken: 'codex-fresh-access',
    refreshToken: 'codex-fresh-grant', expiresAt: codex.expiresAt + 60_000 });
  assert.equal(disk.accounts[1].provider, undefined);
  assert.equal(disk.accounts[1].refreshToken, 'claude-first-grant');

  const second = await login(t, { ...env, TEST_CLAUDE_ACCESS: 'claude-second', TEST_CLAUDE_REFRESH: 'claude-second-grant' }, preload);
  assert.match(second, /Updated account "shared@example\.test 2"/);
  const after = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(after._generation, 14);
  assert.equal(after.accounts.length, 2);
  assert.deepEqual(after.accounts[0], disk.accounts[0]);
  assert.equal(after.accounts[1].refreshToken, 'claude-second-grant');
});
