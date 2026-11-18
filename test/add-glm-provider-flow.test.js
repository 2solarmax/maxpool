// Bug 2026-11-18 (Max): adding a z.ai GLM key through the pool screen failed with no
// clear error. Root cause: _doAddProvider's dynamic imports pointed one directory UP
// ('../config.js', '../secret-resolver.js' from src/tui.js → the package root, where
// neither file exists) — broken since the 2026-08-10 screen merge. This drives the REAL
// _doAddProvider end to end with a pasted key and a temp config home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('adding a GLM key through the screen succeeds and persists (the add flow imports resolve)', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mp-addglm-'));
  const prevHome = process.env.HOME;
  const prevCfg = process.env.MAXPOOL_CONFIG;
  process.env.HOME = home;
  const cfgPath = join(home, '.config', 'teamclaude.json');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(home, '.config'), { recursive: true });
  await writeFile(cfgPath, JSON.stringify({ accounts: [], providers: [] }));
  process.env.MAXPOOL_CONFIG = cfgPath;
  try {
    const { AccountManager } = await import('../src/account-manager.js');
    const { TUI } = await import('../src/tui.js');
    const am = new AccountManager([], 0.9);
    const tui = new TUI({ accountManager: am, config: {} });
    const logs = [];
    tui._addLog = (m) => logs.push(m);
    tui.forceRender = () => {};
    await tui._doAddProvider({ name: 'glm test', provider: 'zai', apiKey: 'zai-test-key.abcdef' });
    assert.ok(!logs.some(l => /Failed to add provider/.test(l)), `no failure: ${logs.join(' | ')}`);
    assert.ok(logs.some(l => /✓ Added "glm test"/.test(l)), `success line: ${logs.join(' | ')}`);
    assert.ok(am.accounts.some(a => a.name === 'glm test' && a.type === 'provider'), 'the provider is live in the running process');
  } finally {
    if (prevHome == null) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevCfg == null) delete process.env.MAXPOOL_CONFIG; else process.env.MAXPOOL_CONFIG = prevCfg;
  }
});

// The cloud-vs-laptop choice (2026-11-18): the add flow asks when a team pool is linked,
// sends the key there on 'T', and saves NOTHING locally; on 'l' it saves locally as before.
import { PoolLink } from '../src/pool-link.js';

function fakeTeamPool() {
  const received = [];
  const server = http.createServer((req, res) => {
    if (req.url !== '/maxpool/accounts') { res.writeHead(404); res.end('{}'); return; }
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      received.push(JSON.parse(raw).account);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: 'added', name: JSON.parse(raw).account.name }));
    });
  });
  return { received, server };
}

test('choosing the TEAM pool sends the key there and saves nothing locally', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mp-addglm2-'));
  const cfgPath = join(home, '.config', 'teamclaude.json');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(home, '.config'), { recursive: true });
  await writeFile(cfgPath, JSON.stringify({ accounts: [], providers: [] }));
  const prevHome = process.env.HOME, prevCfg = process.env.MAXPOOL_CONFIG;
  process.env.HOME = home; process.env.MAXPOOL_CONFIG = cfgPath;
  const fake = fakeTeamPool();
  const port = await new Promise(r => fake.server.listen(0, '127.0.0.1', () => r(fake.server.address().port)));
  try {
    const { AccountManager } = await import('../src/account-manager.js');
    const { TUI } = await import('../src/tui.js');
    const am = new AccountManager([], 0.9);
    am.setPoolLinks([new PoolLink({ name: 'team', url: `http://127.0.0.1:${port}`, key: 'k1' })]);
    const tui = new TUI({ accountManager: am, config: {} });
    const logs = [];
    tui._addLog = m => logs.push(m);
    tui.forceRender = () => {};
    tui._ask = async () => '';   // Enter = the recommended team pool
    await tui._doAddProvider({ name: 'glm teamtest', provider: 'zai', apiKey: 'zai-key.teamtest' });
    assert.equal(fake.received.length, 1, 'the key was sent to the team pool');
    assert.equal(fake.received[0].provider, 'zai');
    assert.equal(fake.received[0].apiKey, 'zai-key.teamtest');
    assert.ok(logs.some(l => /Added "glm teamtest" to the team pool/.test(l)), logs.join(' | '));
    assert.ok(!am.accounts.some(a => a.name === 'glm teamtest'), 'nothing saved locally');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(cfg.providers, [], 'the config was not touched');
  } finally {
    fake.server.close();
    if (prevHome == null) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevCfg == null) delete process.env.MAXPOOL_CONFIG; else process.env.MAXPOOL_CONFIG = prevCfg;
  }
});

test('choosing LAPTOP saves locally and never contacts the team pool', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mp-addglm3-'));
  const cfgPath = join(home, '.config', 'teamclaude.json');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(home, '.config'), { recursive: true });
  await writeFile(cfgPath, JSON.stringify({ accounts: [], providers: [] }));
  const prevHome = process.env.HOME, prevCfg = process.env.MAXPOOL_CONFIG;
  process.env.HOME = home; process.env.MAXPOOL_CONFIG = cfgPath;
  const fake = fakeTeamPool();
  const port = await new Promise(r => fake.server.listen(0, '127.0.0.1', () => r(fake.server.address().port)));
  try {
    const { AccountManager } = await import('../src/account-manager.js');
    const { TUI } = await import('../src/tui.js');
    const am = new AccountManager([], 0.9);
    am.setPoolLinks([new PoolLink({ name: 'team', url: `http://127.0.0.1:${port}`, key: 'k1' })]);
    const tui = new TUI({ accountManager: am, config: {} });
    const logs = [];
    tui._addLog = m => logs.push(m);
    tui.forceRender = () => {};
    tui._ask = async () => 'l';
    await tui._doAddProvider({ name: 'glm localtest', provider: 'zai', apiKey: 'zai-key.localtest' });
    assert.equal(fake.received.length, 0, 'the team pool was never contacted');
    assert.ok(am.accounts.some(a => a.name === 'glm localtest'), 'saved locally');
    assert.ok(logs.some(l => /✓ Added "glm localtest"/.test(l)), logs.join(' | '));
  } finally {
    fake.server.close();
    if (prevHome == null) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevCfg == null) delete process.env.MAXPOOL_CONFIG; else process.env.MAXPOOL_CONFIG = prevCfg;
  }
});

// The CLOUD side: /maxpool/accounts accepts a provider payload, activates it live
// (no restart) and persists it; a duplicate key answers 'exists'.
test('the team-pool door accepts a provider key, activates it live, persists it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mp-addglm4-'));
  const cfgPath = join(dir, 'config.json');
  await writeFile(cfgPath, JSON.stringify({ proxy: { apiKey: 'mp-glm-test' }, accounts: [], providers: [] }));
  const prevCfg = process.env.MAXPOOL_CONFIG;
  const prevHome = process.env.HOME;
  process.env.MAXPOOL_CONFIG = cfgPath;
  process.env.HOME = dir;   // atomicConfigUpdate may fall back to ~/.config; pin it too
  const { AccountManager } = await import('../src/account-manager.js');
  const { createProxyServer } = await import('../src/server.js');
  const am = new AccountManager([], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'mp-glm-test' }, upstream: 'http://127.0.0.1:9', queue: { enabled: false } });
  const port = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  try {
    const post = body => fetch(`http://127.0.0.1:${port}/maxpool/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'mp-glm-test' }, body });
    const r1 = await post(JSON.stringify({ account: { name: 'glm remote', type: 'provider', provider: 'zai', apiKey: 'zai-key.remote' } }));
    const j1 = await r1.json();
    assert.equal(r1.status, 200); assert.equal(j1.ok, true); assert.equal(j1.result, 'added');
    assert.ok(am.accounts.some(a => a.name === 'glm remote' && a.type === 'provider' && a.credential === 'zai-key.remote'), 'live in the running pool at once');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(cfg.providers, [{ name: 'glm remote', provider: 'zai', apiKey: 'zai-key.remote' }], 'persisted to disk');
    const r2 = await post(JSON.stringify({ account: { name: 'glm remote2', type: 'provider', provider: 'zai', apiKey: 'zai-key.remote' } }));
    const j2 = await r2.json();
    assert.equal(j2.result, 'exists', 'the same key is not added twice');
    assert.equal(j2.name, 'glm remote', 'the duplicate names the row that already holds it');
    const r3 = await post(JSON.stringify({ account: { name: 'glm remote', type: 'provider', provider: 'zai', apiKey: 'zai-key.other' } }));
    const j3 = await r3.json();
    assert.equal(j3.result, 'exists', 'the same NAME is not added twice either');
    const bad = await post(JSON.stringify({ account: { name: 'x', type: 'provider', provider: 'anthropic', apiKey: 'k' } }));
    assert.equal(bad.status, 400, 'only zai/kimi provider types are accepted');
  } finally {
    await new Promise(r => proxy.close(r));
    if (prevCfg == null) delete process.env.MAXPOOL_CONFIG; else process.env.MAXPOOL_CONFIG = prevCfg;
    if (prevHome == null) delete process.env.HOME; else process.env.HOME = prevHome;
  }
});
