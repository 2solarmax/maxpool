// rc-gate: an upstream leg that dies AFTER the response status was sent must END the
// client leg too (2026-11-14). Before the fix, `ures.pipe(cres)` neither ended nor
// destroyed cres when ures errored/aborted, so Claude Code sat forever on an open 200
// stream (no bytes, no end, no error) and its own timeout/retry never ran. Runs the REAL
// rc-gate.js as a child process: CONNECT -> TLS (mkcert) -> HTTP, like the CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_DIR = join(__dirname, '..', 'tools', 'rc-gate');
const CA = join(process.env.HOME || '', 'Library', 'Application Support', 'mkcert', 'rootCA.pem');
// Same fixture gate as rc-gate.test.js: CI has neither the gitignored MITM key nor the mkcert root.
const MITM_KEY = join(GATE_DIR, 'anthropic-mitm.key');
const FIXTURES_PRESENT = existsSync(MITM_KEY) && existsSync(CA);
const gateTest = FIXTURES_PRESENT ? test : test.skip;

const DECLARED = 1000;      // content-length the fake upstream promises
const SENT = 120;           // bytes it actually delivers before dying
const BREAK_BUDGET_MS = 5000;

function asTLS(httpServer) {
  return tls.createServer({
    key: readFileSync(MITM_KEY),
    cert: readFileSync(join(GATE_DIR, 'anthropic-mitm.crt')),
  }, sock => httpServer.emit('connection', sock));
}

// Upstream: 200 + a partial body, then the socket dies (the network-change shape).
function dyingUpstream() {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-length': String(DECLARED) });
      res.write('x'.repeat(SENT));
      setTimeout(() => req.socket.destroy(), 150);
    });
  });
}

async function startGate(env) {
  const gate = spawn('node', ['rc-gate.js'], {
    cwd: GATE_DIR,
    env: { ...process.env, NODE_EXTRA_CA_CERTS: CA, RC_GATE_TITLE_SYNC: '0', ...env },
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
      const t = tls.connect({ socket: sock, servername: host, ca: readFileSync(CA), rejectUnauthorized: true }, () => resolve({ tls: t, sock }));
      t.on('error', reject);
    });
    sock.on('error', reject);
    setTimeout(() => reject(new Error('mitm connect timeout')), 8000);
  });
}

// Send one request and report how the response stream TERMINATED, within `budgetMs`.
// 'hung' = no end/close/error inside the budget (the bug). A clean finish would carry
// the full DECLARED body, which this fake upstream never delivers.
function observeResponse(t, method, path, budgetMs) {
  return new Promise(resolve => {
    const t0 = Date.now();
    let raw = '';
    let done = false;
    const finish = how => {
      if (done) return;
      done = true; clearTimeout(timer);
      resolve({ how, ms: Date.now() - t0, raw });
    };
    t.on('data', c => { raw += c.toString('latin1'); });
    t.on('end', () => finish('end'));
    t.on('close', () => finish('close'));
    t.on('error', () => finish('error'));
    const timer = setTimeout(() => finish('hung'), budgetMs);
    t.write(`${method} ${path} HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}`);
  });
}

function bodyBytes(raw) {
  const i = raw.indexOf('\r\n\r\n');
  return i < 0 ? 0 : raw.length - (i + 4);
}

gateTest('rc-gate: POOL leg dies after the 200 was sent -> client stream is torn down, not left hanging', async () => {
  const mp = dyingUpstream();
  await new Promise(r => mp.listen(0, '127.0.0.1', r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: String(mp.address().port),
    RC_GATE_PROFILE: 'claude',
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await observeResponse(t, 'POST', '/v1/messages', BREAK_BUDGET_MS);
    assert.match(r.raw, /^HTTP\/1\.1 200/, 'client got the 200 head before the break');
    assert.ok(bodyBytes(r.raw) > 0 && bodyBytes(r.raw) < DECLARED, `partial body then break (got ${bodyBytes(r.raw)}B of ${DECLARED})`);
    assert.notEqual(r.how, 'hung', `client must observe the break within ${BREAK_BUDGET_MS}ms, not hang on an open 200 stream`);
    assert.match(gate.getLog(), /UPSTREAM (aborted|errored) mid-response/, 'gate saw the upstream break');
  } finally {
    gate.kill(); mp.close();
  }
});

gateTest('rc-gate: DIRECT leg dies after the 200 was sent -> client stream is torn down, not left hanging', async () => {
  const up = asTLS(dyingUpstream());
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const gate = await startGate({
    RC_GATE_PORT: '0',
    RC_GATE_MAXPOOL_PORT: '1',                        // unused: identity paths go direct
    RC_GATE_DIRECT_HOST: '127.0.0.1',
    RC_GATE_DIRECT_PORT: String(up.address().port),
  });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await observeResponse(t, 'POST', '/v1/environments/env_01TEST/work/poll', BREAK_BUDGET_MS);
    assert.match(r.raw, /^HTTP\/1\.1 200/, 'client got the 200 head before the break');
    assert.ok(bodyBytes(r.raw) > 0 && bodyBytes(r.raw) < DECLARED, `partial body then break (got ${bodyBytes(r.raw)}B of ${DECLARED})`);
    assert.notEqual(r.how, 'hung', `client must observe the break within ${BREAK_BUDGET_MS}ms, not hang on an open 200 stream`);
    assert.match(gate.getLog(), /\[direct-break\] upstream (aborted|errored) mid-response/, 'gate saw the upstream break');
  } finally {
    gate.kill(); up.close();
  }
});
