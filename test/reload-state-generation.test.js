// State-generation-across-reload (M4): isolated in its OWN file because it does
// TWO sequential reloads and is sensitive to OS resource pressure (ephemeral
// ports in TIME_WAIT) accumulated by sibling subprocess tests. run-tests.sh runs
// each reload file in a fresh node process, so this gets clean resources.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate, timeoutMs = 20000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error('waitFor predicate never became true');
}

function proxyGet(port, apiKey, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'x', messages: [] }));
  });
}

function startJsonUpstream() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

function awaitChildExit(child) {
  return new Promise(r => {
    if (child.exitCode != null || child.signalCode != null) { r(); return; }
    child.once('exit', r);
    const t = setTimeout(r, 3000);
    t.unref && t.unref();
  });
}

test('M4: quota persistence keeps working after a reload (state generation advances post-swap)', async () => {
  const upstream = await startJsonUpstream();
  const port = await getFreePort();
  const apiKey = 'mp-test-key';
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-gen-'));
  const configPath = join(dir, 'config.json');
  const statePath = configPath.replace(/\.json$/, '.state.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey },
    upstream: `http://127.0.0.1:${upstream.port}`,
    updateCheck: false, switchThreshold: 0.90, shutdown: { drainTimeoutMs: 4000 },
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-stub' }],
  }) + '\n');

  const readStateGen = async () => {
    try { return Number(JSON.parse(await readFile(statePath, 'utf-8'))._generation) || 0; } catch { return 0; }
  };

  let out = '';
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, MAXPOOL_CONFIG: configPath, MAXPOOL_FORCE_SUPERVISOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);

  try {
    await waitFor(async () => { try { return (await proxyGet(port, apiKey)).status === 200; } catch { return false; } }, 20000);
    // NOTE: do NOT send SIGUSR2 here — maxpool doesn't handle it, and Node's default
    // action for an unhandled SIGUSR2 is to TERMINATE the process (it would kill the
    // supervisor and the reload below would never cut over). The primary persists on
    // its own quota-save interval, so the baseline generation exists anyway.

    // Reload — the old worker flushes state (bumping the on-disk generation), the
    // new primary must re-sync it so ITS writes aren't refused.
    child.kill('SIGHUP');
    await waitFor(() => /cutover complete/.test(out), 20000);
    await waitFor(async () => { try { return (await proxyGet(port, apiKey)).status === 200; } catch { return false; } }, 20000);

    const genAfterReload = await readStateGen();

    // The NEW primary must ADVANCE the state generation. Reload again and confirm
    // the generation grows beyond what the post-reload primary first saw.
    child.kill('SIGHUP');
    await waitFor(() => (out.match(/cutover complete/g) || []).length >= 2, 20000);
    await waitFor(async () => { try { return (await proxyGet(port, apiKey)).status === 200; } catch { return false; } }, 20000);
    await waitFor(async () => (await readStateGen()) > genAfterReload, 20000);

    const finalGen = await readStateGen();
    assert.ok(finalGen > genAfterReload, `state generation advanced after reload (${genAfterReload} -> ${finalGen}); persistence not wedged`);
  } finally {
    killGroup(child);
    await awaitChildExit(child);
    await new Promise(r => upstream.server.close(r));
  }
});
