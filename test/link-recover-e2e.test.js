// Dead link that COMES BACK (first live outage after v1.24.105, 2026-11-18 17:43Z). The
// probe declared the link DOWN at 17:43:13, cut 9 in-flight cloud hops (link_down) and
// queued them — the laptop had no room of its own. The link was back UP at 17:43:31, but
// the link_down cut had also benched every mirror for a flat 30 s, so the held requests
// could not be released onto the revived mirrors and NEW requests got
// "No route — 429 (cause: cooldown)" until ~17:43:44.
//   1. a link_down cut applies no timed bench (the probe already holds the mirrors out
//      and revives them on UP);
//   2. the probe's UP lifts any LINK-FAULT bench still on that link's mirrors (never a
//      throttle/unavailable cooldown);
//   3. a request held by the cut is released onto a revived mirror once the link is UP.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';
import { listen, close, captureLog, attempts } from './link-fixture.js';

const STATUS = { accounts: [
  { name: 'continuity@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  { name: 'mk@gomokka', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  { name: 'glm6', type: 'provider', provider: 'zai', keyFingerprint: 'fp1', enabled: true, status: 'active', quota: {} },
] };
const CLOUD_SSE = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_cloud"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
const MISS = { status: null, error: 'timeout' };
const ANSWER = { status: 200, error: null };

/** A fake cloud whose tunnel can die and come back: while `dead`, it answers neither the
 *  probe nor requests (requests are accepted and never answered — a blackholed tunnel). */
async function rig({ queue = { enabled: true, pollMs: 50, heartbeatMs: 1_000 } } = {}) {
  const state = { dead: false };
  const hits = [];
  const held = [];
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(STATUS)); return; }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    req.resume();
    hits.push({ pin: req.headers['x-maxpool-pin-account'], dead: state.dead });
    if (state.dead) { held.push(res); return; }
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(CLOUD_SSE); });
  });
  const remotePort = await listen(remote);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  // NO local capacity: the laptop's own accounts had no room during the outage.
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' }, {
    probeFn: async () => (state.dead ? MISS : ANSWER),
  });
  await link.poll();
  am.setPoolLinks([link]);
  link.stop();   // the test drives probe() by hand; no timers
  const ends = [];
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue }, {
    onRequestEnd: (id, info) => ends.push(info),
  });
  const port = await listen(proxy);
  return {
    am, link, state, hits, port, ends,
    mirrors: () => am.accounts.filter(a => a.remote),
    cleanup: async () => { am.setPoolLinks([]); for (const r of held) r.destroy?.(); await close(proxy); await close(remote); await close(upstream); },
  };
}

let convo = 0;
const post = (port) => { const id = `recover-e2e-${process.pid}-${++convo}`; return fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': id },
  body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, max_tokens: 10, messages: [{ role: 'user', content: `hi ${id}` }] }),
}); };
const until = async (cond, ms = 5_000, what = 'condition') => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 20)); } };
// A held stream commits its headers (200) at once, so bound the WHOLE body read, not the fetch.
const read = async (p) => { const res = await p; return { status: res.status, text: await res.text() }; };
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: not answered within ${ms} ms`)), ms).unref())]);
const down = async (link) => { for (let i = 0; i < 3; i++) await link.probe(); assert.equal(link.probeDown, true, 'probe declared DOWN'); };
const up = async (link) => { for (let i = 0; i < 2; i++) await link.probe(); assert.equal(link.probeDown, false, 'probe declared UP'); };

test('live sequence: cut by DOWN, no local room, link back UP → the held request is served by a cloud mirror (200), and a NEW request is served at once', { timeout: 30_000 }, async () => {
  const r = await rig();
  try {
    let held;
    const lines = await captureLog(async () => {
      r.state.dead = true;
      const p = post(r.port);
      await until(() => r.hits.length === 1, 5_000, 'the hop to reach the cloud');
      await down(r.link);
      await until(() => r.am.queueState.waiting.length === 1, 5_000, 'the cut request to be held');
      // (1) The probe holds the mirrors out of routing; the cut adds NO timed bench.
      const now = Date.now();
      for (const m of r.mirrors()) {
        assert.equal(m.enabled, false, `${m.name}: out of routing while DOWN`);
        assert.ok(!((m.cooldownUntil || 0) > now), `${m.name}: a link_down cut must not bench the mirror for a fixed time (cooldownUntil=${m.cooldownUntil})`);
      }
      // The tunnel returns: the probe gets 2 answers → UP.
      r.state.dead = false;
      const upAt = Date.now();
      await up(r.link);
      held = await within(read(p), 5_000, 'the held request after UP');
      held.ms = Date.now() - upAt;
    });
    assert.equal(held.status, 200);
    assert.match(held.text, /msg_cloud/, `served by the cloud once the link was back: ${held.text.slice(0, 300)}`);
    assert.doesNotMatch(held.text, /event: error/, 'no error frame on the held stream');
    assert.equal(r.ends[0]?.status, 200, `request log status (live run logged 502): ${JSON.stringify(r.ends[0])}`);
    assert.match(String(r.ends[0]?.account), /☁$/, 'the request log names the cloud mirror that served it');
    assert.equal(r.hits.length, 2, 'one hop on the dead tunnel, one on the revived one');
    const a = attempts(lines);
    assert.ok(a.some(l => /\(link_down\)/.test(l) && /→ queued$/.test(l)), a.join('\n'));
    assert.ok(!lines.some(l => /hold gave up/.test(l)), 'the hold did not give up');

    // (2) A NEW request right after UP is served by a mirror — not a 429 "cooldown".
    const t0 = Date.now();
    const res2 = await within(read(post(r.port)), 3_000, 'a new request right after UP');
    assert.equal(res2.status, 200, res2.text.slice(0, 200));
    assert.match(res2.text, /msg_cloud/);
    assert.ok(Date.now() - t0 < 3_000);
  } finally { await r.cleanup(); }
});

test('UP lifts a LINK-FAULT bench on that link\'s mirrors (providers too) — never a throttle cooldown — and a new request is served, not 429', { timeout: 30_000 }, async () => {
  // Queue OFF: a stuck bench would answer the new request with an immediate 429.
  const r = await rig({ queue: { enabled: false } });
  try {
    await captureLog(async () => {
      const ms = r.mirrors();
      assert.equal(ms.length, 3);
      // A request-level link fault whose immediate probe got no answer benches every
      // mirror on the link for 30 s (the existing path; still correct while it is down).
      const cooled = r.am.markLinkMirrorsCooldown(ms[0], 30_000, { includeProviders: true });
      assert.equal(cooled.length, 3);
      // One row ALSO holds a later, unrelated cooldown (throttle / unavailable): UP must keep it.
      const throttled = ms[1];
      throttled.cooldownUntil = Date.now() + 90_000;
      r.state.dead = true;
      await down(r.link);
      r.state.dead = false;
      await up(r.link);
      const now = Date.now();
      assert.ok(!((ms[0].cooldownUntil || 0) > now), `${ms[0].name}: link-fault bench lifted on UP`);
      assert.ok(!((ms[2].cooldownUntil || 0) > now), `${ms[2].name}: provider mirror's link-fault bench lifted too`);
      assert.ok(throttled.cooldownUntil > now + 60_000, `${throttled.name}: a non-link cooldown survives UP`);
    });
    const res = await within(read(post(r.port)), 3_000, 'a new request right after UP');
    assert.equal(res.status, 200, `no "cooldown" 429 after UP: ${res.text.slice(0, 200)}`);
    assert.match(res.text, /msg_cloud/);
  } finally { await r.cleanup(); }
});
