// Dead-link probe (2026-11-18): the Mac pings each linked cloud pool every 5 s on a
// FRESH connection; 3 misses in a row declare the link down (mirrors leave routing),
// 2 answers bring it back. Any HTTP status is an answer — only a timeout / socket
// error is a miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import * as PL from '../src/pool-link.js';
const { PoolLink } = PL;
const probeLink = (...a) => PL.probeLink(...a);
import { AccountManager } from '../src/account-manager.js';

const MISS = { status: null, error: 'timeout' };
const hit = (status = 200) => ({ status, error: null });
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };

function scripted(results) {
  let i = 0;
  const calls = [];
  const fn = async (url) => { calls.push(url); const r = results[Math.min(i, results.length - 1)]; i++; return typeof r === 'function' ? r() : r; };
  return { fn, calls };
}

function linkWith(probeFn) {
  const changes = [];
  const link = new PoolLink({ name: 'team', url: 'http://127.0.0.1:1' }, { probeFn });
  link.startProbe(l => changes.push(l.probeDown), 3_600_000);
  return { link, changes };
}

test('3 consecutive misses declare the link down and call onChange once', async () => {
  const { fn } = scripted([MISS]);
  const { link, changes } = linkWith(fn);
  try {
    await quiet(async () => { await link.probe(); await link.probe(); });
    assert.equal(link.probeDown, false, 'two misses are not an outage');
    assert.equal(link.probeMisses, 2);
    assert.ok(link.probeFirstMissAt != null, 'first miss stamped');
    await quiet(() => link.probe());
    assert.equal(link.probeDown, true, 'third miss declares DOWN');
    assert.ok(link.probeDownAt != null);
    assert.deepEqual(changes, [true], 'onChange exactly once');
    await quiet(() => link.probe());
    assert.deepEqual(changes, [true], 'a 4th miss does not re-announce');
  } finally { link.stop(); }
});

test('2 misses then 1 answer: not down, and the miss streak resets', async () => {
  const { fn } = scripted([MISS, MISS, hit(), MISS, MISS]);
  const { link, changes } = linkWith(fn);
  try {
    await quiet(async () => { for (let i = 0; i < 5; i++) await link.probe(); });
    assert.equal(link.probeDown, false, 'the answer reset the streak, so 2+2 misses never reach 3');
    assert.equal(link.probeMisses, 2);
    assert.deepEqual(changes, []);
  } finally { link.stop(); }
});

test('down, then 2 answers bring it back up with one more onChange', async () => {
  const { fn } = scripted([MISS, MISS, MISS, hit(), hit(), hit()]);
  const { link, changes } = linkWith(fn);
  try {
    await quiet(async () => { for (let i = 0; i < 4; i++) await link.probe(); });
    assert.equal(link.probeDown, true, 'one answer while down is not enough');
    await quiet(() => link.probe());
    assert.equal(link.probeDown, false, 'second answer → UP');
    assert.equal(link.probeDownAt, null);
    assert.deepEqual(changes, [true, false]);
    await quiet(() => link.probe());
    assert.deepEqual(changes, [true, false], 'no repeat announcement');
  } finally { link.stop(); }
});

test('probes never stack: concurrent probe() calls run the probe fn once', async () => {
  let release;
  let runs = 0;
  const fn = () => { runs++; return new Promise(r => { release = () => r(hit()); }); };
  const { link } = linkWith(fn);
  try {
    const a = link.probe(); const b = link.probe(); link.probeNow();
    await new Promise(r => setImmediate(r));
    assert.equal(runs, 1, 'one probe in flight at a time');
    release();
    await Promise.all([a, b]);
  } finally { link.stop(); }
});

test('stop() clears the probe timer as well as the poll timer', () => {
  const link = new PoolLink({ name: 'team', url: 'http://127.0.0.1:1' }, {
    probeFn: async () => hit(), fetchRemoteStatus: async () => ({ ok: false, error: 'x', at: Date.now() }),
  });
  link.start(() => {});
  link.startProbe(() => {}, 3_600_000);
  assert.ok(link._probeTimer, 'probe timer armed');
  link.stop();
  assert.equal(link._probeTimer, null, 'probe timer cleared');
  assert.equal(link._timer, null, 'poll timer cleared');
});

test('any HTTP status (200 / 401 / 404) counts as an answer', async () => {
  for (const status of [200, 401, 404, 500]) {
    const { fn } = scripted([MISS, MISS, hit(status)]);
    const { link } = linkWith(fn);
    try {
      await quiet(async () => { for (let i = 0; i < 3; i++) await link.probe(); });
      assert.equal(link.probeMisses, 0, `HTTP ${status} resets the miss streak`);
      assert.equal(link.probeDown, false);
    } finally { link.stop(); }
  }
});

test('a probe fn that throws is a miss, never a crash', async () => {
  const { link } = linkWith(async () => { throw new Error('boom'); });
  try {
    await quiet(async () => { for (let i = 0; i < 3; i++) await link.probe(); });
    assert.equal(link.probeDown, true);
  } finally { link.stop(); }
});

// ── real sockets ─────────────────────────────────────────────────────────────
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };

test('real socket: an old cloud answering 404 is alive, and each probe opens a fresh connection', async () => {
  const sockets = new Set();
  const paths = [];
  const srv = http.createServer({ keepAlive: true }, (req, res) => { paths.push(req.url); res.writeHead(404, { connection: 'keep-alive' }); res.end('{}'); });
  srv.on('connection', s => sockets.add(s));
  const port = await listen(srv);
  try {
    const r1 = await probeLink(`http://127.0.0.1:${port}/`);
    const r2 = await probeLink(`http://127.0.0.1:${port}`);
    assert.equal(r1.status, 404);
    assert.equal(r2.status, 404);
    assert.deepEqual(paths, ['/maxpool/ping', '/maxpool/ping']);
    assert.equal(sockets.size, 2, 'two probes → two distinct sockets (never a pooled one)');
  } finally { await close(srv); }
});

test('real socket: the probe never borrows an idle pooled keep-alive socket (agent:false)', async () => {
  const sockets = new Set();
  const srv = http.createServer({ keepAlive: true }, (req, res) => { res.writeHead(404, { connection: 'keep-alive' }); res.end('{}'); });
  srv.on('connection', s => sockets.add(s));
  const port = await listen(srv);
  try {
    // Park a keep-alive socket in the global agent's free pool — the kind a silently
    // dropped tunnel leaves half-dead. A pooled probe would reuse it.
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/warm`, res => { res.resume(); res.on('end', resolve); });
      req.on('error', reject);
    });
    await new Promise(r => setImmediate(r));
    assert.equal(sockets.size, 1);
    const r = await probeLink(`http://127.0.0.1:${port}`);
    assert.equal(r.status, 404);
    assert.equal(sockets.size, 2, 'the probe opened its own connection');
  } finally { http.globalAgent.destroy(); await close(srv); }
});

test('real socket: a server that accepts and never answers is a miss within ~3.5 s', async () => {
  const held = [];
  const srv = net.createServer(s => { held.push(s); s.on('error', () => {}); });
  const port = await listen(srv);
  try {
    const t0 = Date.now();
    const r = await probeLink(`http://127.0.0.1:${port}`);
    const ms = Date.now() - t0;
    assert.equal(r.status, null, 'no status = miss');
    assert.ok(r.error, 'names the miss');
    assert.ok(ms >= 2_500 && ms < 3_500, `timed out at the 3 s bound (took ${ms} ms)`);
  } finally { for (const s of held) s.destroy(); await new Promise(r => srv.close(r)); }
});

test('real socket: a refused port is a miss', async () => {
  const srv = net.createServer();
  const port = await listen(srv);
  await new Promise(r => srv.close(r));
  const r = await probeLink(`http://127.0.0.1:${port}`);
  assert.equal(r.status, null);
});

// ── routing exclusion ────────────────────────────────────────────────────────
test('syncRemoteMirrors: probeDown disables every mirror IN PLACE; recovery revives them; indexes never move', () => {
  const am = new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'sk-ant-x' }], 0.9);
  const link = {
    name: 'team', url: 'http://127.0.0.1:1', key: 'k', lastOkAt: Date.now(), lastError: null, probeDown: false,
    status: { accounts: [
      { name: 'a', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active' },
      { name: 'g', type: 'provider', provider: 'zai', keyFingerprint: 'fp', enabled: true, status: 'active' },
    ] },
  };
  am.syncRemoteMirrors(link);
  const snapshot = () => am.accounts.map(a => `${a.index}:${a.name}`);
  const before = snapshot();
  const mirrors = am.accounts.filter(a => a.remote);
  assert.equal(mirrors.length, 2);
  assert.ok(mirrors.every(a => a.enabled === true));
  link.probeDown = true;
  am.syncRemoteMirrors(link);
  assert.ok(mirrors.every(a => a.enabled === false), 'probe-down link: mirrors out of routing');
  assert.deepEqual(snapshot(), before, 'no row removed or reindexed');
  link.probeDown = false;
  am.syncRemoteMirrors(link);
  assert.ok(mirrors.every(a => a.enabled === true), 'link back up + healthy status: revived');
  assert.deepEqual(snapshot(), before);
});

test('setPoolLinks arms the probe, and replacing the links stops it', () => {
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: 'http://127.0.0.1:1' }, {
    probeFn: async () => hit(), fetchRemoteStatus: async () => ({ ok: false, error: 'x', at: Date.now() }),
  });
  am.setPoolLinks([link]);
  try {
    assert.ok(link._probeTimer, 'probe started alongside the status poll');
  } finally { am.setPoolLinks([]); }
  assert.equal(link._probeTimer, null, 'stop() on replace clears the probe');
});

test('TUI: a probe-down link reads "offline" on its cloud rows, never "disabled"', async () => {
  const am = new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'k1' }], 0.9);
  const link = {
    name: 'team', url: 'http://127.0.0.1:1', key: 'k', lastOkAt: Date.now(), lastError: null, probeDown: false,
    status: { accounts: [{ name: 'glm a', type: 'provider', provider: 'zai', keyFingerprint: 'fp', enabled: true, status: 'active', quota: {} }] },
  };
  am.syncRemoteMirrors(link);
  const m = am.accounts.find(x => x.remote);
  link.probeDown = true;
  am.syncRemoteMirrors(link);
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const line = strip(new TUI({ accountManager: am })._renderAcct(m.index, 11, true));
  assert.match(line, /⟐ offline/);
  assert.doesNotMatch(line, /disabled/);
});

// Red team F3 (2026-11-18): a ping that misses while live replies keep flowing on the same
// link must NOT declare the tunnel dead (an event-loop stall or a new-connection limit can
// starve the ping while existing streams are healthy).
test('F3: 3 missed probes do NOT declare DOWN while an in-flight hop on the link received bytes recently', async () => {
  const { PoolLink } = await import('../src/pool-link.js');
  let changes = 0;
  const link = new PoolLink({ name: 'team', url: 'http://127.0.0.1:9' }, { probeFn: async () => ({ status: null, error: 'timeout' }) });
  link._probeOnChange = () => { changes++; };
  link._inflight = new Set([{ lastByteAt: Date.now() }]);
  for (let i = 0; i < 3; i++) await link.probe();
  assert.equal(link.probeDown, false, 'live bytes veto the down verdict');
  assert.equal(changes, 0);
  link._inflight = new Set([{ lastByteAt: Date.now() - 60_000 }]);   // stale bytes do not veto
  await link.probe();
  assert.equal(link.probeDown, true, 'once bytes stop, the next miss declares down');
});
