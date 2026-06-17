import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

test('server exits cleanly when configured port is already in use', async () => {
  const occupied = http.createServer((_req, res) => res.end('ok'));
  const port = await listen(occupied);
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.90,
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-test' }],
  }));

  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, TEAMCLAUDE_CONFIG: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('server did not exit after listen error'));
      }, 5000);
      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', code => {
        clearTimeout(timer);
        resolve({ code });
      });
    });
    assert.equal(result.code, 1);
    assert.match(stderr, new RegExp(`127\\.0\\.0\\.1:${port} is already in use`));
    assert.doesNotMatch(stderr, /Unhandled 'error' event/);
  } finally {
    await close(occupied);
  }
});

test('env command avoids Claude Code auth conflict by default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port: 3456, apiKey: 'tc-test' },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.90,
    accounts: [],
  }));

  const baseEnv = { ...process.env, TEAMCLAUDE_CONFIG: configPath };
  const normal = spawnSync(process.execPath, [cliPath, 'env'], {
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.equal(normal.status, 0);
  assert.match(normal.stdout, /ANTHROPIC_BASE_URL=http:\/\/127\.0\.0\.1:3456/);
  assert.doesNotMatch(normal.stdout, /ANTHROPIC_API_KEY/);

  const withKey = spawnSync(process.execPath, [cliPath, 'env', '--with-key'], {
    env: baseEnv,
    encoding: 'utf8',
  });
  assert.equal(withKey.status, 0);
  assert.match(withKey.stdout, /ANTHROPIC_API_KEY=tc-test/);
});
