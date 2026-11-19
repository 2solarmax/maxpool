// Red-team findings on the "add a GLM/Kimi key" flow (2026-11-19). Each test was RED on
// v1.24.108 before its fix:
//  1. adding one provider dropped every other config provider (and their learned state)
//  2. the [T/l] question ran while the screen's key handler was still live
//  3. a second key under an existing NAME was discarded but shown as success
//  4. adding by GCP secret name saved the name but not the key the laptop resolved
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PoolLink } from '../src/pool-link.js';

async function withCloud(fn, { providers = [], seed = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mp-addglm-rt-'));
  const cfgPath = join(dir, 'config.json');
  await writeFile(cfgPath, JSON.stringify({ proxy: { apiKey: 'mp-rt' }, accounts: [], providers }));
  const prevCfg = process.env.MAXPOOL_CONFIG, prevHome = process.env.HOME;
  process.env.MAXPOOL_CONFIG = cfgPath; process.env.HOME = dir;
  const { AccountManager } = await import('../src/account-manager.js');
  const { createProxyServer } = await import('../src/server.js');
  const am = new AccountManager([], 0.9);
  if (seed.length) am.loadConfigProviders(seed);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'mp-rt' }, upstream: 'http://127.0.0.1:9', queue: { enabled: false } });
  const port = await new Promise(r => proxy.listen(0, '127.0.0.1', () => r(proxy.address().port)));
  const post = account => fetch(`http://127.0.0.1:${port}/maxpool/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'mp-rt' }, body: JSON.stringify({ account }) });
  try {
    await fn({ am, post, cfgPath, dir, port });
  } finally {
    await chmod(dir, 0o700).catch(() => {});
    await new Promise(r => proxy.close(r));
    if (prevCfg == null) delete process.env.MAXPOOL_CONFIG; else process.env.MAXPOOL_CONFIG = prevCfg;
    if (prevHome == null) delete process.env.HOME; else process.env.HOME = prevHome;
  }
}

const SEED = [
  { name: 'glm a', provider: 'zai', token: 'key-a.111' },
  { name: 'kimi b', provider: 'kimi', token: 'key-b.222' },
];
const DISK = [
  { name: 'glm a', provider: 'zai', apiKey: 'key-a.111' },
  { name: 'kimi b', provider: 'kimi', apiKey: 'key-b.222' },
];

function markState(am) {
  const until = Date.now() + 600_000;
  for (const a of am.accounts) { a.cooldownUntil = until; a.lastErrorAt = 12345; }
  return until;
}

test('F1 cloud: adding one provider keeps every other provider and its learned state', async () => {
  await withCloud(async ({ am, post }) => {
    const until = markState(am);
    const before = am.accounts.map(a => a);
    const r = await post({ name: 'glm c', type: 'provider', provider: 'zai', apiKey: 'key-c.333' });
    assert.equal(r.status, 200);
    assert.deepEqual(am.accounts.map(a => a.name).sort(), ['glm a', 'glm c', 'kimi b']);
    for (const old of before) {
      const now = am.accounts.find(a => a.name === old.name);
      assert.equal(now, old, `${old.name} is the same live row`);
      assert.equal(now.cooldownUntil, until, `${old.name} kept its cooldown`);
    }
  }, { providers: DISK, seed: SEED });
});

test('F1 cloud: a failed disk write (507) rolls the new row back and keeps the others', async () => {
  await withCloud(async ({ am, post, dir }) => {
    const until = markState(am);
    await chmod(dir, 0o500);   // atomic write cannot create its temp file
    const r = await post({ name: 'glm c', type: 'provider', provider: 'zai', apiKey: 'key-c.333' });
    assert.equal(r.status, 507);
    assert.ok(!am.accounts.some(a => a.name === 'glm c'), 'the unsaved row is gone');
    assert.deepEqual(am.accounts.map(a => a.name).sort(), ['glm a', 'kimi b']);
    assert.ok(am.accounts.every(a => a.cooldownUntil === until), 'others kept their state');
    await chmod(dir, 0o700);
    const retry = await post({ name: 'glm c', type: 'provider', provider: 'zai', apiKey: 'key-c.333' });
    assert.equal((await retry.json()).result, 'added', 'a retry really adds, never a false exists');
  }, { providers: DISK, seed: SEED });
});

test('F1 cloud: a 507 whose rollback meets an in-flight request disables the row, and the retry replaces it', async () => {
  await withCloud(async ({ am, post, dir }) => {
    await chmod(dir, 0o500);
    const realRemove = am.removeAccount.bind(am);
    am.removeAccount = () => false;   // the new row is serving a request right now
    const r = await post({ name: 'glm c', type: 'provider', provider: 'zai', apiKey: 'key-c.333' });
    assert.equal(r.status, 507);
    const left = am.accounts.find(a => a.name === 'glm c');
    assert.ok(left && left.enabled === false && left.notPersisted === true, 'the unsaved row is out of routing and marked');
    const busy = await post({ name: 'glm c', type: 'provider', provider: 'zai', apiKey: 'key-c.333' });
    assert.equal(busy.status, 503, 'still busy: a retry is asked for, never a false exists');
    am.removeAccount = realRemove;
    await chmod(dir, 0o700);
    const retry = await post({ name: 'glm c', type: 'provider', provider: 'zai', apiKey: 'key-c.333' });
    assert.equal((await retry.json()).result, 'added', 'the retry replaces the unsaved row');
    const row = am.accounts.find(a => a.name === 'glm c');
    assert.ok(row && !row.notPersisted && row.enabled !== false, 'the replacement is a live row');
  }, { providers: DISK, seed: SEED });
});

test('F1 cloud: the same key retried under a DIFFERENT name after a busy 507 is added, never a false exists', async () => {
  await withCloud(async ({ am, post, dir }) => {
    await chmod(dir, 0o500);
    const realRemove = am.removeAccount.bind(am);
    am.removeAccount = () => false;   // the new row is serving a request right now
    assert.equal((await post({ name: 'glm c', type: 'provider', provider: 'zai', apiKey: 'key-c.333' })).status, 507);
    assert.ok(am.accounts.find(a => a.name === 'glm c')?.notPersisted, 'fixture: unsaved row left behind');
    am.removeAccount = realRemove;
    await chmod(dir, 0o700);
    const r = await post({ name: 'glm other', type: 'provider', provider: 'zai', apiKey: 'key-c.333' });
    const body = await r.json();
    assert.equal(body.result, 'added', `same key, new name: really added, not "exists" on the unsaved row: ${JSON.stringify(body)}`);
    assert.ok(!am.accounts.some(a => a.notPersisted), 'the unsaved row is gone');
    assert.ok(am.accounts.some(a => a.name === 'glm other' && a.enabled !== false), 'the new row is live');
  }, { providers: DISK, seed: SEED });
});

test('F1 laptop: adding one provider keeps every other provider and its learned state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mp-addglm-rt2-'));
  await mkdir(join(home, '.config'), { recursive: true });
  const cfgPath = join(home, '.config', 'teamclaude.json');
  await writeFile(cfgPath, JSON.stringify({ accounts: [], providers: DISK }));
  const prevHome = process.env.HOME, prevCfg = process.env.MAXPOOL_CONFIG;
  process.env.HOME = home; process.env.MAXPOOL_CONFIG = cfgPath;
  try {
    const { AccountManager } = await import('../src/account-manager.js');
    const { TUI } = await import('../src/tui.js');
    const am = new AccountManager([], 0.9);
    am.loadConfigProviders(SEED);
    const until = markState(am);
    const tui = new TUI({ accountManager: am, config: {} });
    tui._addLog = () => {}; tui.forceRender = () => {};
    await tui._doAddProvider({ name: 'glm c', provider: 'zai', apiKey: 'key-c.333' });
    assert.deepEqual(am.accounts.map(a => a.name).sort(), ['glm a', 'glm c', 'kimi b']);
    assert.ok(am.accounts.filter(a => a.name !== 'glm c').every(a => a.cooldownUntil === until), 'others kept state');
  } finally {
    if (prevHome == null) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevCfg == null) delete process.env.MAXPOOL_CONFIG; else process.env.MAXPOOL_CONFIG = prevCfg;
  }
});

test('F2: the screen is handed off before the [T/l] question, and its key handler never sees the answer', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { TUI } = await import('../src/tui.js');
  const am = new AccountManager([], 0.9);
  am.setPoolLinks([new PoolLink({ name: 'team', url: 'http://127.0.0.1:9', key: 'k' })]);
  const tui = new TUI({ accountManager: am, config: {} });
  tui._addLog = () => {}; tui.forceRender = () => {};
  const events = [];
  const keys = [];
  tui.running = true;
  tui._dataHandler = d => keys.push(String(d));
  process.stdin.on('data', tui._dataHandler);
  // Real halting (removes the key handler); only the terminal writes are stubbed.
  tui.handOff = async () => { events.push('handOff'); tui._haltRendering(); };
  tui.start = () => { events.push('start'); tui.running = true; };
  tui._ask = async () => { events.push('ask'); process.stdin.emit('data', 'l'); return 'l'; };
  const prevHome = process.env.HOME, prevCfg = process.env.MAXPOOL_CONFIG;
  const home = await mkdtemp(join(tmpdir(), 'mp-addglm-rt3-'));
  await mkdir(join(home, '.config'), { recursive: true });
  const cfgPath = join(home, '.config', 'teamclaude.json');
  await writeFile(cfgPath, JSON.stringify({ accounts: [], providers: [] }));
  process.env.HOME = home; process.env.MAXPOOL_CONFIG = cfgPath;
  try {
    await tui._doAddProvider({ name: 'glm c', provider: 'zai', apiKey: 'key-c.333' });
  } finally {
    process.stdin.removeListener('data', tui._dataHandler);
    process.stdin.pause();   // the listener resumed stdin; let the test process exit
    if (prevHome == null) delete process.env.HOME; else process.env.HOME = prevHome;
    if (prevCfg == null) delete process.env.MAXPOOL_CONFIG; else process.env.MAXPOOL_CONFIG = prevCfg;
  }
  assert.deepEqual(events.slice(0, 2), ['handOff', 'ask'], 'hand off first, then ask');
  assert.ok(events.includes('start'), 'the screen comes back afterwards');
  assert.ok(events.indexOf('start') > events.indexOf('ask'));
  assert.deepEqual(keys, [], 'the screen never saw the "l" keystroke');
});

test('F3 cloud: same name with a DIFFERENT key is refused with 409 and a free-name suggestion', async () => {
  await withCloud(async ({ am, post, cfgPath }) => {
    const r = await post({ name: 'glm a', type: 'provider', provider: 'zai', apiKey: 'key-new.999' });
    assert.equal(r.status, 409);
    const j = await r.json();
    assert.equal(j.ok, false);
    assert.equal(j.error, 'name_taken');
    assert.equal(j.suggestedName, 'glm a 2');
    assert.ok(!JSON.stringify(j).includes('key-new.999'), 'the key is never echoed');
    assert.equal(am.accounts.length, 2);
    const same = await post({ name: 'glm a', type: 'provider', provider: 'zai', apiKey: 'key-a.111' });
    assert.equal((await same.json()).result, 'exists', 'the SAME name and key is a true exists');
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.equal(cfg.providers.length, 2, 'disk untouched');
  }, { providers: DISK, seed: SEED });
});

test('F3 screen: a 409 shows the real reason and the suggested name, never the key', async () => {
  const { createServer } = await import('node:http');
  const srv = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(409, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'name_taken', message: 'A provider named "glm primary" already uses a different key', suggestedName: 'glm primary 2' }));
    });
  });
  const port = await new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    const { AccountManager } = await import('../src/account-manager.js');
    const { TUI } = await import('../src/tui.js');
    const am = new AccountManager([], 0.9);
    am.setPoolLinks([new PoolLink({ name: 'team', url: `http://127.0.0.1:${port}`, key: 'k' })]);
    const tui = new TUI({ accountManager: am, config: {} });
    const logs = [];
    tui._addLog = m => logs.push(m); tui.forceRender = () => {};
    await tui._doAddProvider({ name: 'glm primary', provider: 'zai', apiKey: 'zai-secret.zzz' }, { toTeam: true });
    const all = logs.join(' | ');
    assert.ok(!/✓/.test(all), `no success tick: ${all}`);
    assert.ok(/different key/.test(all), all);
    assert.ok(/glm primary 2/.test(all), `suggests a free name: ${all}`);
    assert.ok(!all.includes('zai-secret.zzz'), 'the key is never logged');
  } finally { srv.close(); }
});

test('F4 cloud: adding by GCP secret name saves the resolved key too, and the cloud serves it without the secret', async () => {
  await withCloud(async ({ am, post, cfgPath }) => {
    const r = await post({ name: 'glm sec', type: 'provider', provider: 'zai', apiKey: 'key-resolved.444', secretName: 'RESTRICTED_X_ZAI' });
    assert.equal(r.status, 200);
    const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
    assert.deepEqual(cfg.providers, [{ name: 'glm sec', provider: 'zai', apiKey: 'key-resolved.444', secretName: 'RESTRICTED_X_ZAI' }]);
    const row = am.accounts.find(a => a.name === 'glm sec');
    assert.equal(row.credential, 'key-resolved.444');
    assert.equal(row.secretName, 'RESTRICTED_X_ZAI');
  });
});

test('F4 disk sync: an entry with secretName + apiKey falls back to the saved key when the secret is unreadable', async () => {
  const { providerTokenFromEntry } = await import('../src/secret-resolver.js');
  assert.equal(typeof providerTokenFromEntry, 'function', 'secret-resolver.js exports providerTokenFromEntry');
  assert.equal(providerTokenFromEntry({ secretName: 'S', apiKey: 'saved' }, {}), 'saved');
  assert.equal(providerTokenFromEntry({ secretName: 'S', apiKey: 'saved' }, { S: 'fresh' }), 'fresh');
  assert.equal(providerTokenFromEntry({ secretName: 'S' }, {}), null);
  assert.equal(providerTokenFromEntry({ apiKey: 'k' }, {}), 'k');
});

test('provider endpoint rejects a missing or non-string name with 400', async () => {
  await withCloud(async ({ am, post, cfgPath }) => {
    for (const name of [undefined, 42, '', '   ']) {
      const r = await post({ name, type: 'provider', provider: 'zai', apiKey: 'key-n.555' });
      assert.equal(r.status, 400, `name=${JSON.stringify(name)}`);
    }
    assert.equal(am.accounts.length, 0);
    assert.deepEqual(JSON.parse(await readFile(cfgPath, 'utf8')).providers, []);
  });
});
