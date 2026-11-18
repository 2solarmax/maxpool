// Dead link, end to end (2026-11-18). A request waiting on a cloud row whose tunnel
// died must leave as soon as the probe declares the link down — not after the 120 s
// no-headers wait — and land on a local route. A reply the cloud already started is
// never cut. A request-level link fault cools EVERY mirror on that link (provider rows
// included: a dead tunnel kills z.ai egress too) and fires an immediate probe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';
import { listen, close, captureLog, attempts } from './link-fixture.js';

const STATUS = { accounts: [
  { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  { name: 'glm', type: 'provider', provider: 'zai', keyFingerprint: 'fp1', enabled: true, status: 'active', quota: {} },
] };
const LOCAL_SSE = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_local"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const MISS = async () => ({ status: null, error: 'timeout' });

async function rig(onMsg, { probeFn = MISS } = {}) {
  const hits = [];
  const held = [];
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(STATUS)); return; }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    req.resume();
    hits.push(req.headers['x-maxpool-pin-account']);
    held.push(res);
    onMsg(req, res, hits.length);
  });
  const remotePort = await listen(remote);
  let localHits = 0;
  const keyUp = http.createServer((req, res) => {
    localHits++;
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(LOCAL_SSE); });
  });
  const keyPort = await listen(keyUp);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'key', type: 'apikey', apiKey: 'sk-ant-x', upstream: `http://127.0.0.1:${keyPort}` }], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' }, { probeFn });
  await link.poll();
  am.setPoolLinks([link]);
  am.accounts.find(a => a.name === 'key').activeWeight = 500;   // a cloud row is the natural pick
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  return {
    am, link, hits, port, localHits: () => localHits,
    cleanup: async () => { am.setPoolLinks([]); for (const r of held) r.destroy?.(); await close(proxy); await close(remote); await close(keyUp); await close(upstream); },
  };
}

// A distinct conversation per call: no affinity carried from one test into the next.
let convo = 0;
const post = (port, signal) => { const id = `probe-e2e-${process.pid}-${++convo}`; return fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': id },
  body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, max_tokens: 10, messages: [{ role: 'user', content: `hi ${id}` }] }), signal,
}); };
const until = async (cond, ms = 5_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting'); await new Promise(r => setTimeout(r, 20)); } };
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };

test('probe declares the link DOWN while a request waits on a silent cloud → served locally, well under 120 s', async () => {
  const r = await rig(() => { /* accepts, never answers */ });
  try {
    const t0 = Date.now();
    let out;
    const lines = await captureLog(async () => {
      const p = post(r.port);
      await until(() => r.hits.length === 1);
      for (let i = 0; i < 3; i++) await r.link.probe();
      const res = await p;
      out = { status: res.status, text: await res.text() };
    });
    const ms = Date.now() - t0;
    assert.equal(out.status, 200, out.text.slice(0, 200));
    assert.match(out.text, /msg_local/, 'the local account served it');
    assert.ok(ms < 10_000, `left the dead link fast (${ms} ms)`);
    assert.equal(r.hits.length, 1, 'never retried onto a sibling mirror on the dead tunnel');
    assert.equal(r.localHits(), 1);
    const a = attempts(lines);
    assert.ok(a.some(l => /\(link_down\)/.test(l) && /link declared down by probe/.test(l) && /moved$/.test(l)), a.join('\n'));
    assert.ok(lines.some(l => /link "team" DOWN — no answer to 3 probes \(first miss .+, declared .+\)/.test(l)), 'transition logged');
    assert.ok(r.am.accounts.filter(x => x.remote).every(x => x.enabled === false), 'mirrors out of routing');
    assert.equal(r.link._inflight?.size ?? 0, 0, 'in-flight registry emptied in finally');
  } finally { await r.cleanup(); }
});

test('a cloud reply that already streamed real bytes is NOT cut by the probe', async () => {
  const r = await rig((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_cloud"}}\n\n');
    const t = setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 1_000);
    res.on('close', () => clearTimeout(t));
  });
  try {
    let out;
    await quiet(async () => {
      const res = await post(r.port);
      const reader = res.body.getReader();
      const first = await reader.read();
      assert.match(Buffer.from(first.value).toString(), /msg_cloud/, 'real bytes reached the client');
      // Age the hop's byte stamp so the F3 live-bytes veto does not apply: this test is
      // about the CUT skipping a hop that already sent real bytes once DOWN is declared.
      for (const e of r.link._inflight || []) e.lastByteAt = 0;
      for (let i = 0; i < 3; i++) await r.link.probe();
      assert.equal(r.link.probeDown, true);
      let rest = '';
      for (;;) { const c = await reader.read(); if (c.done) break; rest += Buffer.from(c.value).toString(); }
      out = { status: res.status, rest };
    });
    assert.equal(out.status, 200);
    assert.match(out.rest, /message_stop/, 'the cloud finished its reply');
    assert.equal(r.localHits(), 0, 'never re-sent to a local route');
    assert.equal(r.hits.length, 1);
  } finally { await r.cleanup(); }
});

// The probe itself answers here (the tunnel is fine as far as the 5 s ping knows) so
// the REQUEST-level fault path is what moves the request, not a probe cut.
const ALIVE = async () => ({ status: 200, error: null });
const DEAD = async () => ({ status: null, error: 'timeout' });
async function faultCase(onMsg, { probeFn = DEAD, expectLifted = false } = {}) {
  const r = await rig(onMsg, { probeFn });
  let probes = 0;
  const orig = r.link.probeNow.bind(r.link);
  r.link.probeNow = () => { probes++; return orig(); };
  try {
    let out;
    const lines = await captureLog(async () => { const res = await post(r.port); out = { status: res.status, text: await res.text() }; });
    assert.equal(out.status, 200, out.text.slice(0, 200));
    assert.match(out.text, /msg_local/);
    if (!expectLifted) assert.equal(r.hits.length, 1, `one link hop, then off the link: ${r.hits.join(', ')}`);
    assert.ok(probes >= 1, 'an immediate probe was fired');
    const now = Date.now();
    if (expectLifted) {
      // Probe FIRST (2026-11-18): the tunnel answered → nothing is benched link-wide.
      for (const m of r.am.accounts.filter(a => a.remote)) {
        assert.ok(!(m.cooldownUntil > now + 20_000), `${m.name}: an answering probe means no link-wide bench`);
      }
    } else {
      for (const m of r.am.accounts.filter(a => a.remote)) {
        assert.ok(m.cooldownUntil > now + 20_000, `${m.name} stays cooled while the probe gets no answer`);
      }
      assert.ok(r.am.accounts.some(a => a.remote && a.type === 'provider' && a.cooldownUntil > now + 20_000), 'provider mirror cooled too');
    }
    return lines;
  } finally { await r.cleanup(); }
}

test('request-level link fault (connection reset): every mirror on the link cooled + excluded, retry lands local, probeNow fired', async () => {
  await faultCase((req) => { req.socket.destroy(); });
});

test('a one-request blip on a LIVE tunnel: the immediate probe answers, so nothing is benched link-wide', async () => {
  await faultCase((req) => { req.socket.destroy(); }, { probeFn: ALIVE, expectLifted: true });
});
test('request-level link fault (no-headers timeout): same — and the throttle cooldown default still spares providers', { timeout: 60_000 }, async () => {
  const saved = process.env.MAXPOOL_LINK_TTFB_MS;
  process.env.MAXPOOL_LINK_TTFB_MS = '15000';   // the floor; the 120 s default stays untouched
  try {
    // The ping answers (tunnel alive, only the request hung): the request-level path
    // moves it as link_ttfb and, being probe-gated, lifts the link-wide bench. (With a
    // DEAD ping the 5 s probe declares the link down first — that is the link_down path,
    // covered by the probe-cut test above.)
    const lines = await faultCase(() => { /* never answers */ }, { probeFn: ALIVE, expectLifted: true });
    assert.ok(attempts(lines).some(l => /\(link_ttfb\)/.test(l)), attempts(lines).join('\n'));
  } finally { if (saved == null) delete process.env.MAXPOOL_LINK_TTFB_MS; else process.env.MAXPOOL_LINK_TTFB_MS = saved; }
  const am = new AccountManager([
    { name: 'c ☁', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'g ☁', type: 'provider', provider: 'zai', authToken: 'k' },
  ], 0.9);
  for (const a of am.accounts) a.remote = { linkName: 'team' };
  assert.deepEqual(am.markLinkMirrorsCooldown(am.accounts[0], 30_000).map(a => a.name), ['c ☁']);
  assert.deepEqual(am.markLinkMirrorsCooldown(am.accounts[0], 30_000, { includeProviders: true }).map(a => a.name), ['c ☁', 'g ☁']);
});

test('a pool answers /maxpool/ping keyless (before auth, never proxied) and the real probe sees 200', async () => {
  let upstreamHits = 0;
  const upstream = http.createServer((req, res) => { upstreamHits++; res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'key', type: 'apikey', apiKey: 'sk-ant-x' }], 0.9);
  const proxy = createProxyServer(am, { proxy: { clients: [{ name: 'max', key: 'mp-max' }] }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const { probeLink } = await import('../src/pool-link.js');
    const r = await probeLink(`http://127.0.0.1:${port}`);
    assert.equal(r.status, 200, 'strict-auth pool still answers the ping');
    assert.equal(upstreamHits, 0, 'never forwarded upstream');
  } finally { await close(proxy); await close(upstream); }
});
