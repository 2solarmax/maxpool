// rc-gate integration tests — exercise the gate the way Claude Code does:
// CONNECT tunnel -> TLS with mkcert CA -> HTTP requests through the MITM path.
// The five incidents this suite must keep dead:
//   1. fd leak (09-04): sockets held after close.
//   2. SSE streams killed by agent idle timeout (09-05): a stream that idles >60s must survive.
//   3. ownership replay (09-05): a failed /bridge POST must NOT be sent twice.
//   4. body-stream abort (09-06): a POST with a chunked body must arrive COMPLETE upstream.
//   5. create response mangled: a create response must reach the client byte-intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeChildProcess from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_DIR = join(__dirname, '..', 'tools', 'rc-gate');
const CA = join(process.env.HOME, 'Library', 'Application Support', 'mkcert', 'rootCA.pem');

// CI has neither the locally-minted MITM fixture (gitignored — it is a private
// key) nor the developer's mkcert root. Before this guard those tests ENOENT'd
// and — worse — a spawned-but-unstarted gate leaked its child process, holding
// `node --test`'s event loop open until the 6h runner cap (measured 2026-09-15:
// every CI run since the suite landed hung, cancelled at 6h0m). Skipping is the
// honest state: these pins run wherever the fixtures exist (dev machines); CI
// covers everything else.
const MITM_KEY = join(GATE_DIR, 'anthropic-mitm.key');
const FIXTURES_PRESENT = existsSync(MITM_KEY) && existsSync(CA);
const gateDescribe = FIXTURES_PRESENT ? test : test.skip;

// ── fake upstreams ────────────────────────────────────────────────────────────
function fakeAnthropic() {
  // Records requests; answers with configurable behavior.
  const state = { requests: [], sseStreams: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      state.requests.push({ method: req.method, url: req.url, headers: req.headers, body });

      if (req.url === '/v1/code/sessions' && req.method === 'POST') {
        // The server rejects any create whose body is not complete JSON.
        let ok = false;
        try { JSON.parse(body.toString()); ok = true; } catch {}
        if (!ok) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"truncated body"}'); return; }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'cse_test_123', session: { ok: true } }));
        return;
      }
      if (req.url.endsWith('/bridge') && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true,"path":"bridge"}');
        return;
      }
      if (req.url.endsWith('/worker/heartbeat')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      if (req.url.endsWith('/worker/events/stream')) {
        // SSE: send one event, then IDLE without closing (tests the agent-timeout kill).
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: hello\ndata: {}\n\n');
        state.sseStreams.push(res);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return { server, state };
}

function fakeMaxpool() {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      state.requests.push({ url: req.url, body: Buffer.concat(chunks), headers: req.headers });
      if (req.url.startsWith('/v1/messages')) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"model":"glm-5.3"}}\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  return { server, state };
}


function asTLS(httpServer) {
  return tls.createServer({
    key: readFileSync(join(GATE_DIR, 'anthropic-mitm.key')),
    cert: readFileSync(join(GATE_DIR, 'anthropic-mitm.crt')),
  }, sock => httpServer.emit('connection', sock));
}

// ── gate driver ───────────────────────────────────────────────────────────────
async function startGate(env) {
  const logFile = mkdtempSync(join(tmpdir(), 'rcgate-')) + '/gate.log';
  const gate = spawn('node', ['rc-gate.js'], {
    cwd: GATE_DIR,
    // The fake upstream presents the mkcert-signed api.anthropic.com cert, so the
    // gate must trust the mkcert ROOT to talk to it. Set explicitly: inheriting it
    // from the developer's shell made this suite pass or fail on ambient env
    // ("unable to verify the first certificate" when absent). Production trust is
    // unaffected — there the gate talks to the real api.anthropic.com public cert.
    env: { ...process.env, NODE_EXTRA_CA_CERTS: CA, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  gate.logFile = logFile;
  let log = '';
  gate.port = null;
  gate.stdout.on('data', d => { log += d.toString(); });
  gate.stderr.on('data', d => { log += d.toString(); });
  gate.getLog = () => log;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      // Kill the child on the failure path — otherwise a spawned-but-unstarted
      // gate outlives the test, holds node --test's loop open, and the runner
      // dies at its 6h cap (the 2026-09-15 CI hang).
      gate.kill();
      reject(new Error('gate did not start: ' + log));
    }, 10_000);
    const check = () => {
      const m = /listening on [^:]+:(\d+)/.exec(log);
      if (m) { gate.port = Number(m[1]); clearTimeout(t); resolve(); }
    };
    const iv = setInterval(check, 100);
    gate.on('exit', () => { clearInterval(iv); });
    setTimeout(() => clearInterval(iv), 12_000);
  });
  return gate;
}

function gateFds(gate) {
  return new Promise(resolve => {
    const { execFile } = nodeChildProcess;
    execFile('lsof', ['-p', String(gate.pid)], (err, stdout) => {
      if (err || !stdout) return resolve(-1);
      resolve(stdout.split('\n').filter(l => l.includes('IPv4')).length);
    });
  });
}

// Open a CONNECT tunnel + TLS through the gate, like Claude Code does.
function mitmConnect(gatePort, host = 'api.anthropic.com') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(gatePort, '127.0.0.1', () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    sock.once('data', d => {
      if (!d.toString().includes('200')) return reject(new Error('CONNECT failed: ' + d.toString().slice(0, 80)));
      const t = tls.connect({
        socket: sock, servername: host,
        ca: readFileSync(CA), rejectUnauthorized: true,
      }, () => resolve({ tls: t, sock }));
      t.on('error', reject);
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('mitm connect timeout')), 8000);
  });
}

function httpOverTLS(t, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = [`${method} ${path} HTTP/1.1`, `Host: api.anthropic.com`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    if (body != null) req.push(`content-length: ${Buffer.byteLength(body)}`);
    req.push('connection: close', '', '');
    const raw = req.join('\r\n') + (body != null ? body : '');
    const chunks = [];
    t.on('data', c => chunks.push(c));
    t.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    t.on('error', reject);
    t.write(raw);
    setTimeout(() => reject(new Error('response timeout')), 8000);
  });
}

// ── the suite ─────────────────────────────────────────────────────────────────
gateDescribe('rc-gate: create POST arrives upstream COMPLETE (stream-abort regression)', async () => {
  const up = fakeAnthropic();
  const ups = asTLS(up.server);
  await new Promise(r => ups.listen(0, r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: '1',                       // unused here
    RC_GATE_DIRECT_HOST: '127.0.0.1',
    RC_GATE_DIRECT_PORT: String(ups.address().port),
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    // A realistic create body, sent in MULTIPLE writes (chunked arrival) to stress buffering.
    const body = JSON.stringify({ title: 'harness-session', bridge: {}, tags: ['remote-control-auto'], config: { cwd: '/tmp', model: 'claude-opus-5' } });
    const res = await httpOverTLS(t, 'POST', '/v1/code/sessions', { 'content-type': 'application/json', 'accept-encoding': 'identity' }, body);
    assert.match(res, /HTTP\/1\.1 200/);
    assert.match(res, /cse_test_123/);
    const create = up.state.requests.find(r => r.url === '/v1/code/sessions');
    assert.ok(create, 'create reached the upstream');
    assert.deepEqual(JSON.parse(create.body.toString()), JSON.parse(body), 'body arrived byte-complete upstream');
  } finally {
    gate.kill(); await new Promise(r => ups.close(r));
  }
});

gateDescribe('rc-gate: /v1/sessions/<id> routes DIRECT (identity), not through the pool', async () => {
  // CLI 2.1.269 emits ~21 v1-compat session call sites; routing them through the pool
  // rotated identity-bound CRUD across accounts and 404'd on every non-owner
  // (measured 2026-09-12). Pin the classification both ways.
  const directPath = { requests: [] };
  const up = asTLS(http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      directPath.requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  }));
  await new Promise(r => up.listen(0, r));
  const mp = fakeMaxpool();
  await new Promise(r => mp.server.listen(0, r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: String(mp.server.address().port),
    RC_GATE_DIRECT_HOST: '127.0.0.1',
    RC_GATE_DIRECT_PORT: String(up.address().port),
    RC_GATE_PROFILE: 'all',
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    const res = await httpOverTLS(t, 'GET', '/v1/sessions/session_01ABC', { accept: 'application/json' }, '');
    assert.match(res, /HTTP\/1\.1 200/);
    assert.ok(directPath.requests.some(r2 => r2.url === '/v1/sessions/session_01ABC'),
      'v1-compat session call reached the DIRECT upstream');
    assert.ok(!mp.state.requests.some(r2 => (r2.url || '').startsWith('/v1/sessions')),
      'v1-compat session call must NOT reach the pool');
  } finally {
    gate.kill();
    await new Promise(r => up.close(r));
    await new Promise(r => mp.server.close(r));
  }
});

gateDescribe('rc-gate: /v1/messages routes to maxpool with profile header', async () => {
  const mp = fakeMaxpool();
  await new Promise(r => mp.server.listen(0, r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: String(mp.server.address().port),
    RC_GATE_PROFILE: 'all',
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    const res = await httpOverTLS(t, 'POST', '/v1/messages?beta=true', { 'content-type': 'application/json' }, JSON.stringify({ model: 'claude-opus-5', messages: [] }));
    assert.match(res, /HTTP\/1\.1 200/);
    const msg = mp.state.requests.find(r => r.url.startsWith('/v1/messages'));
    assert.ok(msg, 'inference reached maxpool');
    assert.equal(msg.headers['x-maxpool-profile'], 'all', 'profile header applied');
    assert.ok(!('authorization' in msg.headers), 'client authorization stripped for pool auth');
  } finally {
    gate.kill(); await new Promise(r => mp.server.close(r));
  }
});

gateDescribe('rc-gate: a failed /bridge POST is NOT replayed (4090 regression)', async () => {
  let bridgeCalls = 0;
  const up = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url.endsWith('/bridge')) {
        bridgeCalls++;
        // Simulate the socket race: destroy mid-response the FIRST time.
        if (bridgeCalls === 1) { res.socket.destroy(); return; }
        res.writeHead(200); res.end('{"ok":true}');
        return;
      }
      res.writeHead(200); res.end('{"ok":true}');
    });
  });
  const ups3 = asTLS(up);
  await new Promise(r => ups3.listen(0, r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: '1',
    RC_GATE_DIRECT_HOST: '127.0.0.1',
    RC_GATE_DIRECT_PORT: String(ups3.address().port),
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    await httpOverTLS(t, 'POST', '/v1/code/sessions/cse_x/bridge', { 'content-type': 'application/json' }, '{"claim":1}')
      .catch(() => 'connection reset (expected)');
    await new Promise(r => setTimeout(r, 1500));   // any (forbidden) replay would land here
    assert.equal(bridgeCalls, 1, 'ownership POST must never be replayed by the gate');
  } finally {
    gate.kill(); await new Promise(r => ups3.close(r));
  }
});

gateDescribe('rc-gate: an idle SSE stream survives (behavior pin; the 09-05 agent-timeout kill is NOT separately mutation-pinned — Node agent timeout only reaps IDLE sockets, so the historical mechanism differs)', async () => {
  const up = fakeAnthropic();
  const ups4 = asTLS(up.server);
  await new Promise(r => ups4.listen(0, r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: '1',
    RC_GATE_DIRECT_HOST: '127.0.0.1',
    RC_GATE_DIRECT_PORT: String(ups4.address().port),
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    const got = await new Promise((resolve, reject) => {
      let buf = '';
      t.on('data', c => { buf += c.toString(); if (buf.includes('hello')) resolve(true); });
      t.on('error', reject);
      t.write('GET /v1/code/sessions/cse_x/worker/events/stream HTTP/1.1\r\nHost: api.anthropic.com\r\naccept: text/event-stream\r\n\r\n');
      setTimeout(() => resolve(false), 3000);
    });
    assert.ok(got, 'first SSE event forwarded');
    // Now the stream IDLES for 3s (proxy for >60s at test scale) and must not be killed.
    await new Promise(r => setTimeout(r, 3000));
    assert.ok(!t.destroyed, 'idle stream not destroyed');
  } finally {
    gate.kill(); await new Promise(r => ups4.close(r));
  }
});

gateDescribe('rc-gate: fds released after tunnel close (behavior pin; 09-04 leak mechanism not mutation-pinned)', async () => {
  const up = fakeAnthropic();
  const ups5 = asTLS(up.server);
  await new Promise(r => ups5.listen(0, r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: '1',
    RC_GATE_DIRECT_HOST: '127.0.0.1',
    RC_GATE_DIRECT_PORT: String(ups5.address().port),
  });
  try {
    const before = await gateFds(gate);
    for (let i = 0; i < 25; i++) {
      const { tls: t, sock } = await mitmConnect(gate.port);
      await httpOverTLS(t, 'POST', '/api/event_logging/v2/batch', { 'content-type': 'application/json' }, '{"e":1}').catch(() => {});
      t.destroy(); sock.destroy();
    }
    await new Promise(r => setTimeout(r, 2000));
    const after = await gateFds(gate);
    assert.ok(after - before <= 6, `fds leaked: before=${before} after=${after}`);
  } finally {
    gate.kill(); await new Promise(r => ups5.close(r));
  }
});


// ── stalled-upstream timeout (2026-09-17) ─────────────────────────────────────
// v1 of this fix (adfbd7b) destroyed 134 long-poll streams in 2 live minutes.
// These pin the v2 semantics: short-RPC create gets a 502 after the stall window;
// long-poll paths NEVER get a headers timeout.
gateDescribe('rc-gate: a stalled upstream on session CREATE errors out (stall timeout)', { timeout: 20_000 }, async () => {
  // Upstream that accepts TLS and never responds.
  const stall = tls.createServer({ key: readFileSync(join(GATE_DIR, 'anthropic-mitm.key')), cert: readFileSync(join(GATE_DIR, 'anthropic-mitm.crt')) }, () => {});
  await new Promise(r => stall.listen(0, '127.0.0.1', r));
  const { port: upPort } = stall.address();
  try {
    const gate = await startGate({ RC_GATE_PORT: '0', RC_GATE_DIRECT_HOST: '127.0.0.1', RC_GATE_DIRECT_PORT: String(upPort), RC_GATE_DIRECT_STALL_MS: '1500' });
    const { tls: t, sock } = await mitmConnect(gate.port);
    const status = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('no response — stall timeout failed to fire')), 12_000);
      const settle = v => { clearTimeout(to); resolve(v); };
      t.on('error', () => settle('tls-error'));
      t.on('data', d => settle('data:' + d.toString().split('\r\n')[0]));
      t.on('close', () => settle('closed'));
      sock.on('close', () => settle('closed'));
      t.write('POST /v1/code/sessions HTTP/1.1\r\nhost: api.anthropic.com\r\ncontent-length: 2\r\n\r\n{}');
    });
    // The gate must DESTROY the stalled request (client sees the tunnel close or a
    // 502), never hang. The pinned property is "settles at all" — the bug was
    // silence forever.
    assert.ok(typeof status === 'string' && status.length > 0, 'request settled: ' + status);
    gate.kill();
  } finally {
    stall.close();
  }
});

gateDescribe('rc-gate: a long-poll path with slow headers is NEVER stall-destroyed', { timeout: 20_000 }, async () => {
  // Upstream that answers /worker/heartbeat only after 4s — longer than the 1.5s
  // stall window. v1 would have destroyed it; v2 must not.
  const up = tls.createServer({
    key: readFileSync(join(GATE_DIR, 'anthropic-mitm.key')),
    cert: readFileSync(join(GATE_DIR, 'anthropic-mitm.crt')),
  }, sock => {
    sock.on('data', () => {
      setTimeout(() => {
        sock.write('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\n{}');
      }, 4000);
    });
  });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const { port: upPort } = up.address();
  try {
    const gate = await startGate({ RC_GATE_PORT: '0', RC_GATE_DIRECT_HOST: '127.0.0.1', RC_GATE_DIRECT_PORT: String(upPort), RC_GATE_DIRECT_STALL_MS: '1500' });
    const { tls: t } = await mitmConnect(gate.port);
    const got = await new Promise((resolve, reject) => {
      let buf = '';
      const to = setTimeout(() => reject(new Error('no response within 10s — long-poll was stall-destroyed or upstream broken')), 10_000);
      t.on('data', d => { buf += d.toString(); if (buf.includes('200 OK')) { clearTimeout(to); resolve('200'); } });
      t.on('close', () => { clearTimeout(to); reject(new Error('tunnel closed before headers — stall timeout destroyed a long-poll')); });
      t.write('POST /v1/code/sessions/cse_x/worker/heartbeat HTTP/1.1\r\nhost: api.anthropic.com\r\ncontent-length: 2\r\n\r\n{}');
    });
    assert.equal(got, '200', 'slow-headers heartbeat survives the stall window');
    gate.kill();
  } finally {
    up.close();
  }
});

// ── incident 6 (2026-09-26): pool saturation read as "server unreachable" ────
// 43 live RC sessions against a 64-socket direct pool: 64 ESTABLISHED (pinned at the
// cap) + 9 SYN_SENT queued. A queued short RPC blew the 30s headers timer, was
// destroyed, and reconnected into the same saturated pool — stalls climbed 823/hr to
// 4,100/hr and the CLI reported "could not reach the Remote Control server for about
// 30 minutes" while the network was perfectly fine.
//
// Both tests need a SLOW upstream: with the instant-answering fakeAnthropic, a queue
// wait is milliseconds and the stall timer never fires, so the test passes against
// broken code (measured — the first version of these two tests survived both mutants).

/** An upstream that holds each request open for `holdMs` before answering — the only
 *  way to make one request's occupancy exceed the next one's stall budget. */
function slowAnthropic(holdMs) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.url);
    req.resume();
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    }, holdMs);
  });
  return { server, seen };
}

gateDescribe('rc-gate: a request QUEUED for a socket is not destroyed by the stall timer', async () => {
  // ONE socket to the upstream; each request occupies it for 2s; stall budget 3s.
  // Geometry: hold < budget < 2*hold (2000 < 3000 < 4000), with ~1s of slack for the
  // two TLS handshakes (client->gate MITM and gate->upstream) — a tighter budget made
  // the test measure handshake latency instead of the mechanism.
  //   old code (timer armed at creation): B destroyed at 3s (it finishes at ~4s) -> 502
  //   new code (timer armed on socket):   B's budget starts when it gets the socket -> served
  const up = slowAnthropic(2000);
  const ups = asTLS(up.server);
  await new Promise(r => ups.listen(0, r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: '1',
    RC_GATE_DIRECT_HOST: '127.0.0.1',
    RC_GATE_DIRECT_PORT: String(ups.address().port),
    RC_GATE_DIRECT_MAX_SOCKETS: '1',
    RC_GATE_DIRECT_STALL_MS: '3000',
  });
  try {
    const { tls: a } = await mitmConnect(gate.port);
    const { tls: b } = await mitmConnect(gate.port);
    const pa = httpOverTLS(a, 'GET', '/v1/code/sessions/cse_q1', { accept: 'application/json' });
    await new Promise(r => setTimeout(r, 120));      // let A take the only socket
    const pb = httpOverTLS(b, 'GET', '/v1/code/sessions/cse_q2', { accept: 'application/json' });
    const [ra, rb] = await Promise.all([pa, pb]);
    assert.ok(/^HTTP\/1\.1 200/.test(ra), `A must succeed, got: ${ra.slice(0, 90)}`);
    assert.ok(/^HTTP\/1\.1 200/.test(rb),
      `B waited for a socket and must still be served — not destroyed for queueing. Got: ${rb.slice(0, 90)}`);
    assert.ok(!/no response headers in/.test(gate.getLog()),
      `the stall timer must not fire on a queue wait. Gate log:\n${gate.getLog().slice(-400)}`);
  } finally { gate.kill(); await new Promise(r => ups.close(r)); }
});

gateDescribe('rc-gate: telemetry batches do not consume the Remote Control socket pool', async () => {
  // Telemetry occupies a socket for 1s; stall budget 1.5s. On its OWN agent the RC
  // lifeline takes the free direct socket and completes in ~1s. On a SHARED pool the
  // lifeline queues 1s behind telemetry, then holds 1s = 2s > 1.5s budget → destroyed.
  const up = slowAnthropic(1000);
  const ups = asTLS(up.server);
  await new Promise(r => ups.listen(0, r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: '1',
    RC_GATE_DIRECT_HOST: '127.0.0.1',
    RC_GATE_DIRECT_PORT: String(ups.address().port),
    RC_GATE_DIRECT_MAX_SOCKETS: '1',
    RC_GATE_DIRECT_STALL_MS: '1500',
  });
  try {
    const { tls: t1 } = await mitmConnect(gate.port);
    const { tls: t2 } = await mitmConnect(gate.port);
    const telemetry = httpOverTLS(t1, 'POST', '/api/event_logging/v2/batch',
      { 'content-type': 'application/json' }, JSON.stringify({ events: [{ n: 1 }] }));
    await new Promise(r => setTimeout(r, 120));      // telemetry takes its socket first
    const t0 = Date.now();
    const lifeline = httpOverTLS(t2, 'POST', '/v1/code/sessions/cse_rc1/bridge',
      { 'content-type': 'application/json' }, JSON.stringify({ ping: true }));
    const rl = await lifeline;
    const waited = Date.now() - t0;
    assert.ok(/^HTTP\/1\.1 200/.test(rl),
      `the RC lifeline must be served while telemetry is in flight, got: ${rl.slice(0, 90)}`);
    // On its own agent the lifeline never waits for telemetry's socket: it completes in
    // about one upstream hold (1.5s), not two (3s).
    assert.ok(waited < 2200,
      `the lifeline must not queue behind telemetry (waited ${waited}ms — looks like a shared pool)`);
    await telemetry;
  } finally { gate.kill(); await new Promise(r => ups.close(r)); }
});
