// rc-gate: Remote Control heartbeats must survive a stalled upstream socket (2026-11-21).
// The CLI gives POST /worker/heartbeat 13s; 3 failures => close 4093, the 4th in an hour
// switches Remote Control off for that session for good. Measured mass give-ups came from
// (M1) heartbeat attempts hanging on dead sockets (classed long-poll => no stall timer, and
// stall-destroys were never retried) and (M2) a CPU-starved gate. Runs the REAL rc-gate.js
// as a child process: CONNECT -> TLS (mkcert) -> HTTP, like the CLI.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_DIR = join(__dirname, '..', 'tools', 'rc-gate');

// SELF-MINTED PKI. CI (ubuntu, no mkcert, no gitignored anthropic-mitm.key) used to SKIP the
// whole rc-gate suite. This file instead mints a throwaway CA + an api.anthropic.com leaf with
// openssl, points the gate at the leaf (RC_GATE_MITM_CERT/KEY), and has every client trust only
// that CA. The real anthropic-mitm.key is never read. Skipped only when openssl is missing.
const HAVE_OPENSSL = spawnSync('openssl', ['version'], { stdio: 'ignore' }).status === 0;
if (!HAVE_OPENSSL) console.log('rc-gate-heartbeat-stall: SKIPPED - `openssl` not found on PATH, cannot mint the throwaway test CA');
const gateTest = HAVE_OPENSSL ? test : test.skip;
const pki = { dir: '', ca: '', cert: '', key: '' };

function mintPki() {
  const dir = mkdtempSync(join(tmpdir(), 'rcgate-pki-'));
  const f = n => join(dir, n);
  const sh = (...args) => execFileSync('openssl', args, { stdio: 'pipe' });
  writeFileSync(f('ca.cnf'), [
    '[req]', 'distinguished_name=dn', 'prompt=no', 'x509_extensions=v3_ca',
    '[dn]', 'CN=rc-gate-test-ca',
    '[v3_ca]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign', 'subjectKeyIdentifier=hash', '',
  ].join('\n'));
  writeFileSync(f('leaf.ext'), [
    'subjectAltName=DNS:api.anthropic.com,DNS:localhost,IP:127.0.0.1',
    'basicConstraints=CA:FALSE', 'keyUsage=digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth', '',
  ].join('\n'));
  sh('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-config', f('ca.cnf'), '-keyout', f('ca.key'), '-out', f('ca.crt'));
  sh('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=api.anthropic.com', '-keyout', f('leaf.key'), '-out', f('leaf.csr'));
  sh('x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial',
    '-days', '2', '-extfile', f('leaf.ext'), '-out', f('leaf.crt'));
  Object.assign(pki, { dir, ca: f('ca.crt'), cert: f('leaf.crt'), key: f('leaf.key') });
}
if (HAVE_OPENSSL) before(() => mintPki());

const sleep = ms => new Promise(r => setTimeout(r, ms));

function asTLS(httpServer) {
  return tls.createServer({
    key: readFileSync(pki.key),
    cert: readFileSync(pki.cert),
  }, sock => httpServer.emit('connection', sock));
}

async function startGate(env) {
  const gate = spawn('node', ['rc-gate.js'], {
    cwd: GATE_DIR,
    env: {
      ...process.env, NODE_EXTRA_CA_CERTS: pki.ca, RC_GATE_MITM_CERT: pki.cert, RC_GATE_MITM_KEY: pki.key,
      RC_GATE_TITLE_SYNC: '0', ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  gate.port = null;
  gate.stdout.on('data', d => { log += d.toString(); });
  gate.stderr.on('data', d => { log += d.toString(); });
  gate.getLog = () => log;
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => { clearInterval(iv); gate.kill(); reject(new Error('gate did not start: ' + log)); }, 10_000);
    const iv = setInterval(() => {
      const m = /listening on [^:]+:(\d+)/.exec(log);
      if (m) { gate.port = Number(m[1]); clearTimeout(t); clearInterval(iv); resolve(); }
    }, 50);
  });
  return gate;
}

function mitmConnect(gatePort, host = 'api.anthropic.com') {
  return new Promise((resolve, reject) => {
    const sock = net.connect(gatePort, '127.0.0.1', () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    sock.once('data', d => {
      if (!d.toString().includes('200')) return reject(new Error('CONNECT failed: ' + d.toString().slice(0, 80)));
      const t = tls.connect({ socket: sock, servername: host, ca: readFileSync(pki.ca), rejectUnauthorized: true }, () => resolve({ tls: t, sock }));
      t.on('error', reject);
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('mitm connect timeout')), 8000);
  });
}

// Send one request over the tunnel (NO `connection: close`: that header is forwarded
// upstream and would defeat the keep-alive agent). Resolves with what arrived once the
// response head is complete and, for the JSON fakes below, the body marker has landed —
// or on a 4xx/5xx head — or with { how: 'timeout' | 'closed' } so a failing run reports instead of hanging.
function request(t, method, path, budgetMs, body = '{}') {
  return new Promise(resolve => {
    let raw = '';
    const t0 = Date.now();
    const done = how => { clearTimeout(timer); resolve({ how, ms: Date.now() - t0, raw }); };
    t.on('data', c => { raw += c.toString('latin1'); if (raw.includes('\r\n\r\n') && (/"(ok|via)"/.test(raw) || /^HTTP\/1\.1 [45]/.test(raw))) done('response'); });
    t.on('close', () => done('closed'));
    t.on('error', () => done('closed'));
    const timer = setTimeout(() => done('timeout'), budgetMs);
    t.write(`${method} ${path} HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\n\r\n${body}`);
  });
}

const status = raw => (/^HTTP\/1\.1 (\d{3})/.exec(raw) || [])[1];

// ── (a) heartbeat whose first attempt black-holes is retried on a fresh connection ──
// Bites: M1. Revert the `isHeartbeat` carve-out of `isLongPoll` (no stall timer: the first
// attempt hangs forever -> no response in 13s) OR the `hbStallRetry` term in `replaySafe`
// (the stall-destroy is not retried -> 502, never 2xx).
gateTest('rc-gate: a heartbeat whose first upstream attempt hangs is retried on a fresh connection and answered 2xx inside the CLI 13s budget', { timeout: 30_000 }, async () => {
  const hbSockets = [];
  const up = http.createServer((req, res) => {
    req.resume();
    if (!req.url.endsWith('/worker/heartbeat')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    hbSockets.push(req.socket);
    if (hbSockets.length === 1) return;                 // black hole: accept, never answer
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const ups = asTLS(up);
  await new Promise(r => ups.listen(0, '127.0.0.1', r));
  // DEFAULT stall budget on purpose: the 6s default x 2 attempts must fit in 13s.
  const gate = await startGate({
    RC_GATE_PORT: '0', RC_GATE_MAXPOOL_PORT: '1',
    RC_GATE_DIRECT_HOST: '127.0.0.1', RC_GATE_DIRECT_PORT: String(ups.address().port),
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', '/v1/code/sessions/cse_hb/worker/heartbeat', 13_000);
    assert.equal(r.how, 'response', `heartbeat must be answered inside 13s, got ${r.how} after ${r.ms}ms. Gate log:\n${gate.getLog().slice(-500)}`);
    assert.match(status(r.raw), /^2/, `2xx expected, got: ${r.raw.slice(0, 90)}`);
    assert.ok(r.ms < 13_000, `answered in ${r.ms}ms`);
    assert.equal(hbSockets.length, 2, 'upstream saw exactly one retry');
    assert.notEqual(hbSockets[0], hbSockets[1], 'the retry used a fresh upstream connection');
    assert.match(gate.getLog(), /\[direct-stall\].*worker\/heartbeat/, 'the stall timer fired on the heartbeat');
  } finally { gate.kill(); await new Promise(r => ups.close(r)); }
});

// ── (b) a stall-destroyed session CREATE is still never retried ─────────────────
// Guard (passes before AND after the fix). Bites if someone widens `hbStallRetry` to all
// idempotent/own-stall paths: remove the `isHeartbeat &&` term (or the `!ownStall` guard)
// and the create is replayed -> upstream sees 2 POSTs.
gateTest('rc-gate: a stall-destroyed session create is NOT retried (a replayed create can double-create)', { timeout: 20_000 }, async () => {
  let creates = 0;
  const up = http.createServer(req => {
    req.resume();
    if (req.method === 'POST' && req.url === '/v1/code/sessions') creates++;   // never answers
  });
  const ups = asTLS(up);
  await new Promise(r => ups.listen(0, '127.0.0.1', r));
  const gate = await startGate({
    RC_GATE_PORT: '0', RC_GATE_MAXPOOL_PORT: '1',
    RC_GATE_DIRECT_HOST: '127.0.0.1', RC_GATE_DIRECT_PORT: String(ups.address().port),
    RC_GATE_DIRECT_STALL_MS: '1000',
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', '/v1/code/sessions', 8_000);
    assert.notEqual(r.how, 'timeout', 'the stalled create must settle (502 / tunnel closed), not hang');
    await sleep(2_500);                                  // well past any 500ms-backoff retry
    assert.equal(creates, 1, `create must reach upstream exactly once, saw ${creates}`);
    assert.match(gate.getLog(), /\[direct-stall\] \/v1\/code\/sessions/);
  } finally { gate.kill(); await new Promise(r => ups.close(r)); }
});

// ── (c) a forced net-evac must not reset an in-flight request to a LOOPBACK maxpool ──
// Bites: R3. Revert the `if (!LOOPBACK_HOSTS.has(MAXPOOL_HOST))` guard around
// poolAgent.destroy() and Agent.destroy() kills the in-use socket: the gate logs
// `[resp-break] UPSTREAM ...` and the client body is truncated.
// Uses the gate's own FORCE_EVAC seam (flag file, path made configurable for tests).
gateTest('rc-gate: an in-flight /v1/messages to a loopback maxpool survives a net-evac', { timeout: 40_000 }, async () => {
  const HEAD = 'event: message_start\ndata: {}\n\n';
  const TAIL = 'event: message_stop\ndata: {}\n\n';
  const mp = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(HEAD);
      setTimeout(() => res.end(TAIL), 9_000);           // outlives the <=5s seam poll
    });
  });
  await new Promise(r => mp.listen(0, '127.0.0.1', r));
  const flag = join(mkdtempSync(join(tmpdir(), 'rcgate-evac-')), 'force-evac');
  const gate = await startGate({
    RC_GATE_PORT: '0', RC_GATE_MAXPOOL_PORT: String(mp.address().port),
    RC_GATE_PROFILE: 'claude', RC_GATE_FORCE_EVAC_FLAG: flag,
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    let raw = '';
    let closed = false;
    t.on('data', c => { raw += c.toString('latin1'); });
    t.on('close', () => { closed = true; });
    t.on('error', () => { closed = true; });
    t.write('POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}');
    const until = Date.now() + 5_000;
    while (!raw.includes('message_start') && Date.now() < until) await sleep(50);
    assert.ok(raw.includes('message_start'), 'stream is in flight before the evac');
    writeFileSync(flag, '');
    const evacBy = Date.now() + 8_000;
    while (!/\[net-evac\]/.test(gate.getLog()) && Date.now() < evacBy) await sleep(100);
    assert.match(gate.getLog(), /\[net-evac\]/, 'the seam really fired the evacuation (else this test proves nothing)');
    const endBy = Date.now() + 14_000;
    while (!raw.includes('message_stop') && !closed && Date.now() < endBy) await sleep(100);
    assert.ok(raw.includes('message_stop'), `in-flight response must complete after the evac; closed=${closed}. Gate log:\n${gate.getLog().slice(-500)}`);
    assert.doesNotMatch(gate.getLog(), /\[resp-break\] UPSTREAM/, 'the pool leg was not reset');
  } finally { gate.kill(); await new Promise(r => mp.close(r)); }
});

// ── (d) a telemetry retry must not destroy the DIRECT agent's idle sockets ──────
// Bites: R2. Revert sweepIdleSockets' agent scoping / the `if (connectPhase)` condition
// (old code: `for (const sock of Object.values(directAgent.freeSockets).flat()) sock.destroy()`
// on every retry) and the idle direct keep-alive socket is destroyed -> server sees 'close'.
gateTest('rc-gate: a telemetry retry leaves the direct agent\'s idle keep-alive sockets alone', { timeout: 20_000 }, async () => {
  let directSock = null;
  let directClosed = false;
  let telemetryAttempts = 0;
  const up = http.createServer((req, res) => {
    req.resume();
    if (req.url.startsWith('/api/event_logging')) {
      telemetryAttempts++;
      if (telemetryAttempts === 1) { req.socket.destroy(); return; }   // reset: retried (idempotent), not a connect error
    } else {
      directSock = req.socket;
      req.socket.once('close', () => { directClosed = true; });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const ups = asTLS(up);
  await new Promise(r => ups.listen(0, '127.0.0.1', r));
  const gate = await startGate({
    RC_GATE_PORT: '0', RC_GATE_MAXPOOL_PORT: '1',
    RC_GATE_DIRECT_HOST: '127.0.0.1', RC_GATE_DIRECT_PORT: String(ups.address().port),
  });
  try {
    // 1. park an idle keep-alive socket in directAgent
    const { tls: t1 } = await mitmConnect(gate.port);
    const r1 = await request(t1, 'POST', '/v1/code/sessions/cse_k/bridge', 5_000);
    assert.equal(status(r1.raw), '200');
    assert.ok(directSock && !directClosed, 'direct socket parked idle upstream');
    // 2. telemetry: first attempt reset, retried after its backoff
    const { tls: t2 } = await mitmConnect(gate.port);
    const r2 = await request(t2, 'POST', '/api/event_logging/v2/batch', 8_000);
    assert.equal(status(r2.raw), '200', `telemetry retried to success, got: ${r2.raw.slice(0, 90)}`);
    assert.equal(telemetryAttempts, 2);
    assert.match(gate.getLog(), /\[direct-retry\] \/api\/event_logging/, 'the retry path ran');
    await sleep(300);
    assert.equal(directClosed, false, 'the telemetry retry must not destroy the direct agent\'s idle socket');
  } finally { gate.kill(); await new Promise(r => ups.close(r)); }
});
