// False-outage defect (owner, live v1.24.107, 2026-11-18): the 30 s status poll pulls
// ~1 MB from the cloud and, under load, crossed its 10 s timeout twice in a row. That
// set link.lastError, syncRemoteMirrors dropped every mirror, and the TUI said "Cloud
// team unreachable ... Cloud accounts paused" while the 5 s liveness probe (the real
// liveness signal) kept answering. Fix: a slow/failed poll never marks the link down
// while the probe says it is alive; the status body is compact JSON; the poll timeout
// is 20 s.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as PL from '../src/pool-link.js';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { listen, close } from './link-fixture.js';

const { PoolLink } = PL;
const quiet = async (fn) => { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } };

const STATUS = { accounts: [
  { name: 'glm a', type: 'provider', provider: 'zai', keyFingerprint: 'fp1', enabled: true, status: 'active', quota: {} },
  { name: 'glm b', type: 'provider', provider: 'zai', keyFingerprint: 'fp2', enabled: true, status: 'active', quota: {} },
] };
const OK = () => ({ ok: true, status: 200, json: structuredClone(STATUS), error: null, at: Date.now() });
const FAIL = (error, status = null) => () => ({ ok: false, status, json: null, error, at: Date.now() });

function makeLink(polls, probeAnswers) {
  let p = 0; let q = 0;
  const fetchRemoteStatus = async () => polls[Math.min(p++, polls.length - 1)]();
  const probeFn = async () => probeAnswers[Math.min(q++, probeAnswers.length - 1)];
  return new PoolLink({ name: 'team', url: 'http://x', key: 'k' }, { fetchRemoteStatus, probeFn });
}
const liveMirrors = (am) => am.accounts.filter(a => a.remote && a.enabled !== false).length;
const HIT = { status: 200, error: null };
const MISS = { status: null, error: 'timeout' };

test('(a) two poll timeouts while the probe answers: link stays up, mirrors stay routable', async () => {
  const link = makeLink([OK, FAIL('timeout'), FAIL('timeout')], [HIT]);
  const am = new AccountManager([], 0.9);
  try {
    await quiet(async () => {
      await link.poll();
      await link.probe();
      am.syncRemoteMirrors(link);
      assert.equal(liveMirrors(am), 2, 'baseline: both cloud rows mirrored');
      await link.poll();
      await link.poll();
    });
    assert.equal(link.failStreak, 2, 'the streak is still counted');
    assert.equal(link.lastError, null, 'a slow poll is not an outage while the probe answers');
    assert.equal(link.downSince, null);
    assert.ok(link.summary, 'last good summary kept');
    assert.ok(link.status?.accounts?.length === 2, 'last good status kept (stale-but-usable)');
    am.syncRemoteMirrors(link);
    assert.equal(liveMirrors(am), 2, 'mirrors stay in routing');
  } finally { link.stop(); }
});

test('(a2) a network error (not just timeout) is also soft while the probe answers', async () => {
  const link = makeLink([OK, FAIL('fetch failed'), FAIL('fetch failed')], [HIT]);
  await quiet(async () => { await link.poll(); await link.probe(); await link.poll(); await link.poll(); });
  assert.equal(link.lastError, null);
});

test('(a3) the soft-fail log line is printed once per streak start', async () => {
  const link = makeLink([OK, FAIL('timeout'), FAIL('timeout'), FAIL('timeout')], [HIT]);
  const lines = [];
  const o = console.log; console.log = (m) => lines.push(String(m));
  try { await link.poll(); await link.probe(); await link.poll(); await link.poll(); await link.poll(); } finally { console.log = o; }
  const hits = lines.filter(l => l.includes('status poll slow/failed'));
  assert.equal(hits.length, 1, `one line per streak: ${JSON.stringify(lines)}`);
  assert.match(hits[0], /\[Maxpool\] link "team" status poll slow\/failed \(timeout\) — link alive per probe; keeping last status/);
});

test('(b) two poll timeouts while the probe MISSES: link marked down as today', async () => {
  const link = makeLink([OK, FAIL('timeout'), FAIL('timeout')], [MISS]);
  const am = new AccountManager([], 0.9);
  await quiet(async () => {
    await link.poll();
    await link.probe();   // the probe ran but got no answer
    await link.probe();
    await link.poll();
    await link.poll();
  });
  assert.equal(link.lastError, 'timeout', 'probe missed → today\'s behaviour (down)');
  assert.ok(link.downSince != null);
  assert.equal(link.summary, null);
  am.syncRemoteMirrors(link);
  assert.equal(liveMirrors(am), 0);
});

test('(b2) probe never ran: two poll timeouts mark down as today', async () => {
  const link = makeLink([OK, FAIL('timeout'), FAIL('timeout')], [HIT]);
  await quiet(async () => { await link.poll(); await link.poll(); await link.poll(); });
  assert.equal(link.lastError, 'timeout');
});

test('(b3) a stale probe answer (> 2 probe intervals old) does not vouch for the link', async () => {
  let t = 1_000_000;
  let p = 0;
  const polls = [OK, FAIL('timeout'), FAIL('timeout')];
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' }, {
    fetchRemoteStatus: async () => polls[Math.min(p++, polls.length - 1)](),
    probeFn: async () => HIT,
    now: () => t,
  });
  await quiet(async () => {
    await link.poll(); await link.probe();
    t += 3 * PL.PROBE_INTERVAL_MS;
    await link.poll(); await link.poll();
  });
  assert.equal(link.lastError, 'timeout');
});

test('(c) a rejected key marks down at once even with a healthy probe', async () => {
  const link = makeLink([OK, FAIL('key rejected', 401)], [HIT]);
  await quiet(async () => { await link.poll(); await link.probe(); await link.poll(); });
  assert.equal(link.lastError, 'key rejected');
  assert.equal(link.summary, null);
});

test('(c2) an HTTP 5xx from the cloud still marks down after the streak, probe or not', async () => {
  const link = makeLink([OK, FAIL('HTTP 503', 503), FAIL('HTTP 503', 503)], [HIT]);
  await quiet(async () => { await link.poll(); await link.probe(); await link.poll(); await link.poll(); });
  assert.equal(link.lastError, 'HTTP 503');
});

test('(d) /maxpool/status body is compact JSON (no indentation)', async () => {
  const am = new AccountManager([
    { name: 'k1', type: 'apikey', apiKey: 'key-1' },
    { name: 'k2', type: 'apikey', apiKey: 'key-2' },
  ], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1', queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/maxpool/status`, { headers: { 'x-api-key': 'tc-test' } });
    assert.equal(r.status, 200);
    const body = await r.text();
    assert.ok(body.length > 50, 'non-trivial body');
    assert.ok(!body.includes('\n  '), 'no pretty-print indentation');
    assert.ok(!body.includes('\n'), 'single line');
    const json = JSON.parse(body);
    assert.ok(Array.isArray(json.accounts) && json.accounts.length === 2, 'same field set parses');
  } finally { await close(proxy); }
});

test('(e) status poll timeout defaults to 20 s', async () => {
  assert.equal(PL.STATUS_TIMEOUT_MS, 20_000);
  // Behavioural: a fetch that never resolves is aborted at the default timeout.
  let abortedAfter = null;
  const realSetTimeout = globalThis.setTimeout;
  const scheduled = [];
  // fetchRemoteStatus arms its abort timer synchronously, before its first await, so
  // the patch is restored before anything else can schedule a timer.
  globalThis.setTimeout = (fn, ms) => { scheduled.push(ms); return realSetTimeout(fn, 0); };
  const t0 = Date.now();
  let pending;
  try {
    pending = PL.fetchRemoteStatus('http://x', 'k', {
      fetchFn: (_u, { signal }) => new Promise((_res, rej) => {
        signal.addEventListener('abort', () => { abortedAfter = Date.now() - t0; const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
      }),
    });
  } finally { globalThis.setTimeout = realSetTimeout; }
  const r = await pending;
  assert.equal(r.error, 'timeout');
  assert.deepEqual(scheduled, [20_000], 'default abort timer is 20 s');
  assert.ok(abortedAfter != null);
});

test('(d2) gzip only when asked: raw client gets compact plain JSON; gzip client gets the same JSON gzipped', async () => {
  const { default: http } = await import('node:http');
  const { gunzipSync } = await import('node:zlib');
  const am = new AccountManager([{ name: 'k1', type: 'apikey', apiKey: 'key-1' }], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1', queue: { enabled: false } });
  const port = await listen(proxy);
  const get = (headers) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/maxpool/status', headers: { 'x-api-key': 'tc-test', ...headers } }, (res) => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ res, buf: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  try {
    const plain = await get({});
    assert.equal(plain.res.headers['content-encoding'], undefined, 'no encoding unless asked');
    const text = plain.buf.toString('utf8');
    assert.ok(!text.includes('\n'), 'plain body is compact');
    const gz = await get({ 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(gz.res.headers['content-encoding'], 'gzip');
    const decoded = JSON.parse(gunzipSync(gz.buf).toString('utf8'));
    assert.deepEqual(Object.keys(decoded).sort(), Object.keys(JSON.parse(text)).sort(), 'same field set');
  } finally { await close(proxy); }
});
