// Red-team round 2 on the link work (v1.24.108):
//   1. A short blip never reaches 3 probe misses, so no DOWN->UP ever lifts the 30 s link-fault
//      bench a request fault set; two probe ANSWERS in a row must lift it (stamp-equality guard
//      intact), and a lossy link (miss, answer, miss, answer) must never lift it.
//   2. A tunnel that answers the tiny ping but blackholes large bodies must not keep the link
//      "up" forever: consecutive soft status-poll failures (or a stale last-good status) mark it
//      down — while one slow poll still must not (status-poll-false-down.test.js).
//   3. After an outage long enough for the poll to set lastError, probe UP triggers an immediate
//      poll so the mirrors revive without waiting for the next 30 s tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as PL from '../src/pool-link.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { listen, close, captureLog } from './link-fixture.js';

const { PoolLink } = PL;
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };
const until = async (cond, ms = 5_000, what = 'condition') => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 20)); } };

const STATUS = { accounts: [
  { name: 'mk@gomokka', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  { name: 'glm6', type: 'provider', provider: 'zai', keyFingerprint: 'fp1', enabled: true, status: 'active', quota: {} },
] };
const HIT = { status: 200, error: null };
const MISS = { status: null, error: 'timeout' };
const CLOUD_SSE = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_cloud"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

// ── 1. blip: fault -> ONE probe miss -> answer (never DOWN) ──────────────────────────────────
test('a blip that never reaches DOWN: the next probe ANSWER lifts the link-fault bench, a new request is served (not 429)', { timeout: 30_000 }, async () => {
  let resetNext = true;
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(STATUS)); return; }
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404); res.end('{}'); return; }
    req.resume();
    if (resetNext) { resetNext = false; req.socket.destroy(); return; }   // the blip: one dropped hop
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(CLOUD_SSE); });
  });
  const remotePort = await listen(remote);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);   // the laptop has NO room of its own
  // The fault's immediate probe misses once; every later probe answers.
  let probes = 0;
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' }, { probeFn: async () => (probes++ === 0 ? MISS : HIT) });
  await link.poll();
  am.setPoolLinks([link]);
  link.stop();   // the test drives probes by hand
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  let convo = 0;
  const post = async () => { const id = `blip-${process.pid}-${++convo}`; const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': id },
    body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, max_tokens: 10, messages: [{ role: 'user', content: `hi ${id}` }] }),
  }); return { status: r.status, text: await r.text() }; };
  try {
    await captureLog(async () => {
      const first = await post();   // real fault path: reset -> probeNow (miss) -> bench every mirror 30 s
      assert.notEqual(first.status, 200, 'the blip request itself could not be served');
      assert.equal(link.probeMisses, 1, 'exactly one probe miss — never DOWN');
      assert.equal(link.probeDown, false);
      const mirrors = am.accounts.filter(a => a.remote);
      assert.ok(mirrors.length === 2 && mirrors.every(m => m.cooldownUntil > Date.now() + 20_000), 'the fault set the 30 s link-fault bench');
      // Throttle cooldown set later on one row must survive the lift.
      const throttled = mirrors[0]; throttled.cooldownUntil = Date.now() + 90_000;
      await link.probe();   // the tunnel answers once — one lucky ping is not recovery
      assert.ok(mirrors[1].cooldownUntil > Date.now() + 15_000, 'ONE answer does not lift the bench (hysteresis)');
      await link.probe();   // a second answer in a row (never went DOWN, so no UP event)
      const now = Date.now();
      assert.ok(!(mirrors[1].cooldownUntil > now), 'link-fault bench lifted after two answers in a row');
      assert.ok(throttled.cooldownUntil > now + 60_000, 'a non-link cooldown survives');
      throttled.cooldownUntil = null;
      const second = await post();
      assert.equal(second.status, 200, `new request served, not "cooldown" 429: ${second.text.slice(0, 200)}`);
      assert.match(second.text, /msg_cloud/);
    });
  } finally { am.setPoolLinks([]); await close(proxy); await close(remote); await close(upstream); }
});

// ── 1b. lossy link (miss, answer, miss, answer): the bench never lifts on a single ping ──────
test('a lossy link alternating miss/answer never lifts the link-fault bench (red team r3)', async () => {
  const seq = [MISS, HIT, MISS, HIT, MISS, HIT, MISS];
  let i = 0;
  const link = new PoolLink({ name: 'team', url: 'http://127.0.0.1:1', key: 'mp-max' }, { probeFn: async () => seq[i++] });
  let lifts = 0;
  link.onAlive(() => { lifts++; });
  await quiet(async () => { for (let k = 0; k < seq.length; k++) await link.probe(); });
  assert.equal(link.probeDown, false, 'fixture: never 3 misses in a row, so never DOWN');
  assert.equal(lifts, 0, 'no alive announcement while the link keeps dropping');
  await quiet(async () => { i = 0; seq.length = 0; seq.push(HIT, HIT); await link.probe(); await link.probe(); });
  assert.equal(lifts, 1, 'two answers in a row announce alive once');
});

// ── 2. soft poll failures while the probe answers ────────────────────────────────────────────
const OK = () => ({ ok: true, status: 200, json: structuredClone(STATUS), error: null, at: Date.now() });
const FAIL = (error = 'timeout') => () => ({ ok: false, status: null, json: null, error, at: Date.now() });

// Clock-injected variants: the link reads time from `now`, so the poll result must be stamped with it.
const okAt = (clock) => () => ({ ...OK(), at: clock() });
function softLink(polls, now) {
  let p = 0;
  return new PoolLink({ name: 'team', url: 'http://x', key: 'k' }, {
    fetchRemoteStatus: async () => polls[Math.min(p++, polls.length - 1)](),
    probeFn: async () => HIT,
    ...(now ? { now } : {}),
  });
}

test('soft poll failures past the cap while the probe answers: link marked DOWN (MTU blackhole)', async () => {
  const link = softLink([OK, FAIL()]);
  await quiet(async () => {
    await link.poll();
    for (let i = 0; i < PL.SOFT_FAILS_BEFORE_DOWN; i++) { await link.probe(); await link.poll(); }
  });
  assert.equal(link.lastError, 'timeout', 'persistent soft failures are an outage even though the ping answers');
  assert.ok(link.downSince != null);
  assert.equal(link.summary, null);
});

test('soft poll failures below the cap: stays UP', async () => {
  const link = softLink([OK, FAIL()]);
  await quiet(async () => {
    await link.poll();
    for (let i = 0; i < PL.SOFT_FAILS_BEFORE_DOWN - 1; i++) { await link.probe(); await link.poll(); }
  });
  assert.equal(link.lastError, null);
  assert.ok(link.summary);
});

test('a good poll resets the soft-failure count', async () => {
  const seq = [OK, ...Array(PL.SOFT_FAILS_BEFORE_DOWN - 1).fill(FAIL()), OK, ...Array(PL.SOFT_FAILS_BEFORE_DOWN - 1).fill(FAIL())];
  const link = softLink(seq);
  await quiet(async () => { for (let i = 0; i < seq.length; i++) { await link.probe(); await link.poll(); } });
  assert.equal(link.lastError, null, 'two sub-cap streaks split by a good poll are not one outage');
  assert.equal(link.failStreak, PL.SOFT_FAILS_BEFORE_DOWN - 1);
});

test('last good status older than the age cap while the probe answers: DOWN once the usual 2-failure streak is met (the probe no longer vouches)', async () => {
  let t = 1_000_000;
  const link = softLink([okAt(() => t), FAIL()], () => t);
  await quiet(async () => {
    await link.poll();
    t += PL.STATUS_STALE_DOWN_MS + 1_000;
    await link.probe();
    await link.poll();
    await link.poll();
  });
  assert.equal(link.lastError, 'timeout');
});

test('last good status younger than the age cap: slow polls stay UP', async () => {
  let t = 1_000_000;
  const link = softLink([okAt(() => t), FAIL()], () => t);
  await quiet(async () => {
    await link.poll();
    t += PL.STATUS_STALE_DOWN_MS - 5_000;
    await link.probe();
    await link.poll();
    await link.poll();
  });
  assert.equal(link.lastError, null);
});

// ── 3. probe UP triggers an immediate poll ───────────────────────────────────────────────────
test('probe UP after an outage that set lastError triggers an immediate poll: mirrors revive without the next tick', async () => {
  let fetches = 0;
  let cloudUp = true;
  let probeAnswers = true;
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' }, {
    fetchRemoteStatus: async () => { fetches++; return cloudUp ? OK() : FAIL()(); },
    probeFn: async () => (probeAnswers ? HIT : MISS),
  });
  const am = new AccountManager([], 0.9);
  const live = () => am.accounts.filter(a => a.remote && a.enabled !== false).length;
  await quiet(async () => {
    am.setPoolLinks([link]);
    link.stop();   // no timers; probes/polls are driven by hand
    await until(() => link.lastOkAt != null, 2_000, 'the first poll');
    am.syncRemoteMirrors(link);
    assert.equal(live(), 2, 'baseline');
    cloudUp = false; probeAnswers = false;
    for (let i = 0; i < 3; i++) await link.probe();
    for (let i = 0; i < 3; i++) await link.poll();
    assert.equal(link.probeDown, true);
    assert.ok(link.lastError, 'the outage set lastError');
    am.syncRemoteMirrors(link);
    assert.equal(live(), 0);
    // The tunnel returns: the probe reads UP.
    cloudUp = true; probeAnswers = true;
    const before = fetches;
    await link.probe(); await link.probe();
    assert.equal(link.probeDown, false);
    await until(() => fetches > before, 2_000, 'an immediate poll after UP');
    await until(() => link.lastError == null && live() === 2, 2_000, 'mirrors revived');
  });
  am.setPoolLinks([]);
});
