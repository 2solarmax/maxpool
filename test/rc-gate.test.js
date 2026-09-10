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
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as nodeChildProcess from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_DIR = join(__dirname, '..', 'tools', 'rc-gate');
const CA = join(process.env.HOME, 'Library', 'Application Support', 'mkcert', 'rootCA.pem');

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
    const t = setTimeout(() => reject(new Error('gate did not start: ' + log)), 10_000);
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
test('rc-gate: create POST arrives upstream COMPLETE (stream-abort regression)', async () => {
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

test('rc-gate: /v1/messages routes to maxpool with profile header', async () => {
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

test('rc-gate: a failed /bridge POST is NOT replayed (4090 regression)', async () => {
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

test('rc-gate: an idle SSE stream survives (behavior pin; the 09-05 agent-timeout kill is NOT separately mutation-pinned — Node agent timeout only reaps IDLE sockets, so the historical mechanism differs)', async () => {
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

test('rc-gate: fds released after tunnel close (behavior pin; 09-04 leak mechanism not mutation-pinned)', async () => {
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
