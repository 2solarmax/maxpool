import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function runCli(configPath, ...cliArgs) {
  return execFileSync(process.execPath, [cliPath, ...cliArgs], {
    env: { ...process.env, MAXPOOL_CONFIG: configPath },
    encoding: 'utf8',
  });
}

test('pool switch: shared writes client block; env/run follow it; local restores', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-pool-'));
  const configPath = join(dir, 'config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      proxy: { host: '127.0.0.1', port: 3456, apiKey: 'tc-test' },
      upstream: 'https://api.anthropic.com',
      accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
    }));

    // LOCAL (default): env prints the local pool address with port.
    let out = runCli(configPath, 'env');
    assert.match(out, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:3456/);

    // SWITCH to shared.
    out = runCli(configPath, 'pool', 'shared', 'maxpool.example.ts.net:3456', 'mp-max-key');
    assert.match(out, /SHARED pool: http:\/\/maxpool\.example\.ts\.net:3456/);
    const cfg = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(cfg.client.mode, 'shared');
    assert.equal(cfg.client.sharedHost, 'maxpool.example.ts.net:3456');
    assert.equal(cfg.client.sharedKey, 'mp-max-key');

    // env follows the switch (host:port as given, shared key with --with-key).
    out = runCli(configPath, 'env', '--with-key');
    assert.match(out, /ANTHROPIC_BASE_URL=http:\/\/maxpool\.example\.ts\.net:3456/);
    assert.match(out, /ANTHROPIC_API_KEY=mp-max-key/);

    // status reports shared.
    out = runCli(configPath, 'pool', 'status');
    assert.match(out, /shared → http:\/\/maxpool\.example\.ts\.net:3456/);

    // SWITCH BACK to local: block cleared, env prints local address + legacy key.
    out = runCli(configPath, 'pool', 'local');
    assert.match(out, /OWN local pool/);
    out = runCli(configPath, 'env', '--with-key');
    assert.match(out, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:3456/);
    assert.match(out, /ANTHROPIC_API_KEY=tc-test/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
