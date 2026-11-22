// rc-gate: Remote Control heartbeats must survive a stalled upstream socket (2026-11-21).
// The CLI gives POST /worker/heartbeat 13s; 3 failures => close 4093, the 4th in an hour
// switches Remote Control off for that session for good. Measured mass give-ups came from
// (M1) heartbeat attempts hanging on dead sockets (classed long-poll => no stall timer, so the
// CLI's 13s budget expired silently) and (M2) a CPU-starved gate. Runs the REAL rc-gate.js
// as a child process: CONNECT -> TLS (mkcert) -> HTTP, like the CLI.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { HAVE_OPENSSL, mintPki } from './helpers/rc-gate-pki.js';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_DIR = join(__dirname, '..', 'tools', 'rc-gate');

// SELF-MINTED PKI (test/helpers/rc-gate-pki.js): CI has no mkcert and no gitignored
// anthropic-mitm.key, so this file mints a throwaway CA + api.anthropic.com leaf with openssl,
// points the gate at the leaf (RC_GATE_MITM_CERT/KEY) and trusts only that CA. The real
// anthropic-mitm.key is never read. Skipped only when openssl is missing.
if (!HAVE_OPENSSL) console.log('rc-gate-heartbeat-stall: SKIPPED - `openssl` not found on PATH, cannot mint the throwaway test CA');
const gateTest = HAVE_OPENSSL ? test : test.skip;
const pki = { dir: '', ca: '', cert: '', key: '' };
// Every temp dir this file creates is enumerated here and removed in after().
const tmpDirs = [];
const tmp = prefix => { const d = mkdtempSync(join(tmpdir(), prefix)); tmpDirs.push(d); return d; };

if (HAVE_OPENSSL) before(() => { Object.assign(pki, mintPki(tmp('rcgate-pki-'))); });
after(() => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function asTLS(httpServer) {
  return tls.createServer({
    key: readFileSync(pki.key),
    cert: readFileSync(pki.cert),
  }, sock => httpServer.emit('connection', sock));
}

// A port nothing listens on: the default upstream, so a test that forgets to point the
// gate at its fake can never reach the real api.anthropic.com.
function deadPort() {
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// ISOLATED gate: nothing inherited from the developer's shell or live setup may steer it.
// Strips proxy vars and every RC_GATE_*; routing file absent; upstream = a dead port unless
// the test overrides; its own force-evac flag file (never the live /tmp one).
async function startGate(env = {}) {
  const base = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^RC_GATE_/.test(k) || /^(https?_proxy|no_proxy)$/i.test(k)) continue;
    base[k] = v;
  }
  const evacFlag = join(tmp('rcgate-evac-'), 'force-evac');
  const gate = spawn('node', ['rc-gate.js'], {
    cwd: GATE_DIR,
    env: {
      ...base, NODE_EXTRA_CA_CERTS: pki.ca, RC_GATE_MITM_CERT: pki.cert, RC_GATE_MITM_KEY: pki.key,
      RC_GATE_TITLE_SYNC: '0', RC_GATE_PORT: '0', RC_GATE_MAXPOOL_PORT: '1',
      RC_GATE_ROUTE_FILE: join(tmp('rcgate-route-'), 'no-such-route-file'),
      RC_GATE_DIRECT_HOST: '127.0.0.1', RC_GATE_DIRECT_PORT: String(await deadPort()),
      RC_GATE_FORCE_EVAC_FLAG: evacFlag,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  gate.port = null;
  gate.evacFlag = evacFlag;
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
// response head is complete and, for the JSON fakes below, the body marker has landed,
// or on a 4xx/5xx head, or with { how: 'timeout' | 'closed' } so a failing run reports
// instead of hanging.
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
// The gate prefixes every log line with an ISO timestamp; compare from the tag on.
const hedgeOutcomes = gate => gate.getLog().split('\n').filter(line => line.includes('[hedge-outcome]')).map(line => line.slice(line.indexOf('[hedge-outcome]')));
async function assertHedgeOutcome(gate, code, winner) {
  // Child stdout and the client socket are consumed independently.
  const until = Date.now() + 2_000;
  while (hedgeOutcomes(gate).length === 0 && Date.now() < until) await sleep(20);
  assert.deepEqual(
    hedgeOutcomes(gate).map(line => line.replace(/ after \d+ms$/, ' after <elapsed>')),
    [`[hedge-outcome] status=${code} won=${winner} after <elapsed>`],
  );
}
const HB = '/v1/code/sessions/cse_hb/worker/heartbeat';
const OK = '{"ok":true}';
const json200 = (res, body = OK) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); };
const track = sock => { const rec = { sock, closed: false }; sock.once('close', () => { rec.closed = true; }); return rec; };

async function withUpstream(handler, fn, gateEnv) {
  const up = http.createServer(handler);
  up.keepAliveTimeout = 60_000;     // idle keep-alive sockets must outlive a test, only the gate may close them
  const ups = asTLS(up);
  await new Promise(r => ups.listen(0, '127.0.0.1', r));
  const gate = await startGate({ RC_GATE_DIRECT_PORT: String(ups.address().port), ...gateEnv });
  try { await fn(gate, up); } finally { gate.kill(); await new Promise(r => ups.close(r)); }
}

// ── (a) heartbeat whose first attempt black-holes is HEDGED on a fresh connection ──
// Kills: dropping the `isHeartbeat` carve-out of `isLongPoll` (no stall timer: no hedge, the
// request hangs past the CLI's 13s); `canHedge` never true / `dirSend(true)` removed (no second
// attempt -> no 2xx).
gateTest('rc-gate: a heartbeat whose first upstream attempt hangs is hedged on a fresh connection and answered 2xx inside the CLI 13s budget', { timeout: 30_000 }, async () => {
  const hb = [];
  await withUpstream((req, res) => {
    req.resume();
    if (!req.url.endsWith('/worker/heartbeat')) return json200(res);
    hb.push(track(req.socket));
    if (hb.length === 1) return;                         // black hole: accept, never answer
    json200(res);
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 13_000);       // DEFAULT 6s budget: hedge at 6s, answer ~6s
    assert.equal(r.how, 'response', `heartbeat must be answered inside 13s, got ${r.how} after ${r.ms}ms. Gate log:\n${gate.getLog().slice(-500)}`);
    assert.match(status(r.raw), /^2/, `2xx expected, got: ${r.raw.slice(0, 90)}`);
    assert.ok(r.ms < 13_000, `answered in ${r.ms}ms`);
    assert.equal(hb.length, 2, 'upstream saw exactly one extra attempt');
    assert.notEqual(hb[0].sock, hb[1].sock, 'the hedge used a fresh upstream connection');
    assert.match(gate.getLog(), /\[direct-stall\].*worker\/heartbeat.*hedging/, 'the stall timer fired and hedged');
    await assertHedgeOutcome(gate, 200, 'hedge');
  });
});

// ── (a2) hedge: the FIRST attempt answers late and the hedge never does -> client gets attempt 1 ──
// Kills destroy-and-retry (the stall destroys attempt 1 at 6s; attempt 2 never answers; client
// gets a 502 at ~12s instead of attempt 1's 2xx at 8s), and a winner rule that favours the newest
// attempt. Also pins that the loser's connection is torn down.
gateTest('rc-gate: hedged heartbeat - attempt 1 answering at ~8s (after the 6s hedge) wins; attempt 2 is torn down', { timeout: 30_000 }, async () => {
  const hb = [];
  await withUpstream((req, res) => {
    req.resume();
    hb.push(track(req.socket));
    if (hb.length === 1) setTimeout(() => json200(res, '{"ok":true,"via":"first"}'), 8_000);
    // attempt 2: never answers
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 13_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms. Gate log:\n${gate.getLog().slice(-500)}`);
    assert.match(status(r.raw), /^2/, `attempt 1's 2xx expected, got: ${r.raw.slice(0, 90)}`);
    assert.match(r.raw, /"via":"first"/, 'the body is attempt 1\'s');
    assert.ok(r.ms >= 7_500 && r.ms < 12_000, `answered at attempt 1's time (~8s), got ${r.ms}ms`);
    assert.equal(hb.length, 2, 'the hedge did fire (attempt 2 reached upstream)');
    await sleep(500);
    assert.equal(hb[1].closed, true, 'the losing attempt\'s connection was destroyed');
    await assertHedgeOutcome(gate, 200, 'first');
  });
});

// ── (a3) two stalls: exactly two attempts, 502 before the CLI's 13s ──────────────
// Kills: a third attempt (hedge not capped by `hbHedged`), no overall deadline (client hangs
// past 13s), a deadline that is not 12.5s.
gateTest('rc-gate: a heartbeat that stalls on BOTH attempts makes exactly two upstream attempts and gets a 502 before 13s', { timeout: 30_000 }, async () => {
  let attempts = 0;
  await withUpstream(req => { req.resume(); attempts++; }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 14_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms`);
    assert.equal(status(r.raw), '502');
    assert.match(r.raw, /rc_gate_direct_error/, 'the existing 502 shape');
    assert.ok(r.ms < 13_000, `502 must beat the CLI's 13s budget, took ${r.ms}ms`);
    await sleep(500);
    assert.equal(attempts, 2, `exactly two upstream attempts, saw ${attempts}`);
  });
});

// ── (a4) error retries share the overall deadline ───────────────────────────────
// The upstream resets every heartbeat; retries back off ~3s*n. Kills: no deadline on error
// retries (the client waits through all retries, tens of seconds -> 'timeout'), a retry timer
// that outlives the 502 (attempt count keeps growing afterwards).
gateTest('rc-gate: heartbeat error retries stop at the 12.5s overall deadline with a 502', { timeout: 30_000 }, async () => {
  let attempts = 0;
  await withUpstream(req => { attempts++; req.socket.destroy(); }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 14_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms. Gate log:\n${gate.getLog().slice(-400)}`);
    assert.equal(status(r.raw), '502');
    assert.ok(r.ms >= 11_500 && r.ms < 13_000, `502 at the 12.5s deadline, got ${r.ms}ms`);
    const at502 = attempts;
    assert.ok(at502 >= 2, 'retries really happened before the deadline');
    await sleep(2_000);
    assert.equal(attempts, at502, 'no retry fires after the deadline answered the client');
  }, { RC_GATE_DIRECT_RETRY_MAX: '50', RC_GATE_DIRECT_RETRY_BACKOFF_MS: '3000' });
});

// ── (a5) client gone mid-hedge -> BOTH attempts destroyed ───────────────────────
// Kills: the close handler tearing down only the latest attempt (`curDir`) and not every
// live one (attempt 1 leaks until the process dies).
gateTest('rc-gate: when the client closes mid-hedge, both upstream attempts are destroyed', { timeout: 20_000 }, async () => {
  const hb = [];
  await withUpstream(req => { req.resume(); hb.push(track(req.socket)); }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    t.on('error', () => {});
    t.write(`POST ${HB} HTTP/1.1\r\nHost: api.anthropic.com\r\ncontent-length: 2\r\n\r\n{}`);
    const until = Date.now() + 8_000;
    while (hb.length < 2 && Date.now() < until) await sleep(50);
    assert.equal(hb.length, 2, 'hedge fired (1s budget)');
    t.destroy();
    await sleep(1_000);
    assert.deepEqual(hb.map(h => h.closed), [true, true], 'both attempts torn down');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '1000' });
});

// A TCP front for the fake upstream that lets a test fail chosen CONNECTIONS at connect time
// (reset before any TLS) while the rest pass through to the real fake upstream.
function front(upPort, failConn) {
  let n = 0;
  const srv = net.createServer(c => {
    n++;
    if (failConn.has(n)) { c.destroy(); return; }
    const u = net.connect(upPort, '127.0.0.1');
    c.pipe(u); u.pipe(c);
    const kill = () => { c.destroy(); u.destroy(); };
    c.on('error', kill); u.on('error', kill); c.on('close', kill); u.on('close', kill);
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r(srv)));
}

// ── (a6) hedge fails fast at connect while attempt 1 is hung -> replaced, client still gets 2xx ──
// Kills: the swallowed error (`if (isHeartbeat && liveDirs.size > 0) return` with no replacement):
// the request would wait for the 12.5s 502.
gateTest('rc-gate: a hedge that fails at connect is replaced while attempt 1 stays hung; client gets 2xx < 13s', { timeout: 30_000 }, async () => {
  const hb = [];
  const up = http.createServer((req, res) => {
    req.resume();
    hb.push(track(req.socket));
    if (hb.length === 1) return;                        // attempt 1 black-holes
    json200(res);
  });
  up.keepAliveTimeout = 60_000;
  const ups = asTLS(up);
  await new Promise(r => ups.listen(0, '127.0.0.1', r));
  const fr = await front(ups.address().port, new Set([2]));   // connection #2 (the first hedge) is reset
  const gate = await startGate({ RC_GATE_DIRECT_PORT: String(fr.address().port), RC_GATE_HEARTBEAT_STALL_MS: '2000' });
  try {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 13_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms. Gate log:\n${gate.getLog().slice(-500)}`);
    assert.match(status(r.raw), /^2/, `2xx expected (not the 12.5s 502), got: ${r.raw.slice(0, 90)}`);
    assert.ok(r.ms < 8_000, `answered by the replacement hedge, not the deadline: ${r.ms}ms`);
    assert.equal(hb.length, 2, 'attempt 1 + the replacement reached upstream (the reset hedge never did)');
    assert.match(gate.getLog(), /\[direct-retry\].*worker\/heartbeat/, 'the failed hedge went through the retry ladder');
  } finally { gate.kill(); fr.close(); await new Promise(r => ups.close(r)); }
});

// ── (a7) status-aware winner: a fast non-2xx does not beat a slower 2xx ──────────
// Kills: "first headers win" regardless of status (client would get the hedge's 503).
gateTest('rc-gate: a hedge answering 503 fast does not win; attempt 1\'s 200 at ~8s is delivered', { timeout: 30_000 }, async () => {
  const hb = [];
  await withUpstream((req, res) => {
    req.resume();
    hb.push(track(req.socket));
    if (hb.length === 1) { setTimeout(() => json200(res, '{"ok":true,"via":"first"}'), 8_000); return; }
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"overloaded"}');
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 13_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms. Gate log:\n${gate.getLog().slice(-400)}`);
    assert.equal(status(r.raw), '200', `attempt 1's 200 expected, got: ${r.raw.slice(0, 90)}`);
    assert.match(r.raw, /"via":"first"/);
    assert.ok(r.ms >= 7_500, `waited for attempt 1 (~8s), got ${r.ms}ms`);
  }, { RC_GATE_HEARTBEAT_STALL_MS: '2000' });
});

// ── (a8) ... and when no sibling ever succeeds, the held upstream answer is delivered, not a gate 502 ──
// Kills: dropping `deliverHeld()` at the deadline (client would get rc_gate_direct_error).
gateTest('rc-gate: with attempt 1 hung forever, the hedge\'s held 503 is delivered at the deadline instead of a gate 502', { timeout: 30_000 }, async () => {
  let n = 0;
  await withUpstream((req, res) => {
    req.resume();
    n++;
    if (n === 1) return;                                // attempt 1 hangs forever
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"overloaded"}');
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 14_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms`);
    assert.equal(status(r.raw), '503', `the held upstream 503, got: ${r.raw.slice(0, 90)}`);
    assert.match(r.raw, /overloaded/);
    assert.doesNotMatch(r.raw, /rc_gate_direct_error/, 'not the gate\'s own 502');
    assert.ok(r.ms >= 11_500 && r.ms < 13_000, `delivered at the 12.5s deadline, got ${r.ms}ms`);
    await assertHedgeOutcome(gate, 503, 'hedge');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '1000' });
});

// ── (a11) attempt 1 dies while the hedge is still running -> replaced, client gets 2xx ──
// Attempt 1 is reset at ~3s while the hedge (started at 2s) hangs. Kills: swallowing attempt 1's
// failure when a sibling is live (`sibling && !dir.isHedge` -> return): the hung hedge would leave
// the client waiting for the 12.5s 502.
gateTest('rc-gate: when attempt 1 dies while the hedge is still hung, a replacement is started and the client gets 2xx', { timeout: 30_000 }, async () => {
  let n = 0;
  await withUpstream((req, res) => {
    req.resume();
    n++;
    if (n === 1) { const s1 = req.socket; setTimeout(() => s1.destroy(), 3_000); return; }   // attempt 1: reset at 3s
    if (n === 2) return;                                                                      // the hedge hangs
    json200(res);                                                                             // the replacement answers
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 13_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms. Gate log:\n${gate.getLog().slice(-500)}`);
    assert.match(status(r.raw), /^2/, `2xx expected (not the 12.5s 502), got: ${r.raw.slice(0, 90)}`);
    assert.ok(r.ms < 8_000, `answered by the replacement, not the deadline: ${r.ms}ms`);
    assert.equal(n, 3, 'attempt 1, the hedge and exactly one replacement');
    await assertHedgeOutcome(gate, 200, 'retry');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '2000' });
});

// ── (a12) a held non-2xx whose body never finishes is destroyed, and the client still gets an answer ──
// The hedge sends 503 headers and never ends the body; attempt 1 hangs. At the deadline the gate
// has no complete held answer, so it destroys the held connection and sends its own 502 (chosen over
// waiting past the deadline). Kills: forgetting the held attempt after it leaves liveDirs (its
// upstream connection would stay open forever).
gateTest('rc-gate: a held 503 whose body never ends is destroyed at the deadline and the client gets an answer', { timeout: 30_000 }, async () => {
  const hb = [];
  await withUpstream((req, res) => {
    req.resume();
    hb.push(track(req.socket));
    if (hb.length === 1) return;                                   // attempt 1 hangs
    res.writeHead(503, { 'content-type': 'application/json', 'content-length': '100' });
    res.write('{"error":');                                        // ...and never finishes
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 14_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms`);
    assert.equal(status(r.raw), '502', `the gate's own 502 (held body incomplete), got: ${r.raw.slice(0, 90)}`);
    assert.ok(r.ms >= 11_500 && r.ms < 13_000, `answered at the deadline, got ${r.ms}ms`);
    await assertHedgeOutcome(gate, 502, 'none');
    await sleep(500);
    assert.equal(hb.length, 2);
    assert.equal(hb[1].closed, true, 'the held attempt\'s upstream connection was destroyed');
    assert.equal(hb[0].closed, true, 'attempt 1 too');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '1000' });
});

// ── (a13) a held body that completes late is delivered as soon as it is needed ──
// The hedge's 503 headers arrive at ~1s, its body at ~3.5s; attempt 1 is reset at 3s with retries
// disabled, so the gate needs the held answer while its body is still arriving. It must wait for the
// body and deliver the upstream 503 (~3.5s), not send a 502 at 3s. Kills: `deliverHeld` returning
// false for an incomplete body.
gateTest('rc-gate: a held 503 whose body is still arriving when needed is delivered once complete, not replaced by a 502', { timeout: 30_000 }, async () => {
  let n = 0;
  await withUpstream((req, res) => {
    req.resume();
    n++;
    if (n === 1) { const s1 = req.socket; setTimeout(() => s1.destroy(), 3_000); return; }
    res.writeHead(503, { 'content-type': 'application/json', 'content-length': '22' });
    res.write('{"error":');
    setTimeout(() => res.end('"overloaded"}'), 2_500);
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 13_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms`);
    assert.equal(status(r.raw), '503', `the upstream 503, got: ${r.raw.slice(0, 90)}`);
    assert.doesNotMatch(r.raw, /rc_gate_direct_error/);
    assert.match(r.raw, /overloaded/);
    assert.ok(r.ms >= 3_200 && r.ms < 8_000, `delivered when the body completed (~3.5s), got ${r.ms}ms`);
    await assertHedgeOutcome(gate, 503, 'hedge');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '1000', RC_GATE_DIRECT_RETRY_MAX: '0' });
});

// ── (a14) starved loop: an already-buffered fast answer must not look like a stall ──
// The gate's loop is blocked (test seam, once, right after the heartbeat is flushed) across the 300ms
// stall point while the upstream answers in ~20ms. Without the setImmediate deferral the overdue timer
// fires before the buffered response is read: a needless hedge + a sweep of the healthy idle socket.
// Kills: removing the `setImmediate(... if (hbWinner || cres.headersSent ...) return ...)` deferral.
gateTest('rc-gate: a loop starved across the stall point does not hedge or sweep when the answer was already buffered', { timeout: 30_000 }, async () => {
  const parkedSocks = [];
  let hbN = 0;
  await withUpstream((req, res) => {
    req.resume();
    if (!req.url.endsWith('/worker/heartbeat')) { parkedSocks.push(track(req.socket)); return json200(res); }
    hbN++;
    setTimeout(() => json200(res), 20);                // fast, healthy upstream
  }, async gate => {
    const parked = await parkTwoDirect(gate, parkedSocks);
    assert.equal(parked.length, 2);
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 10_000);
    assert.match(status(r.raw), /^2/, `2xx expected, got ${r.how}: ${r.raw.slice(0, 80)}`);
    await sleep(300);
    assert.match(gate.getLog(), /\[loop-stall\]/, 'premise: the loop really was blocked');
    assert.equal(hbN, 1, `no hedge connect, saw ${hbN} heartbeat attempts`);
    assert.doesNotMatch(gate.getLog(), /hedging/);
    assert.deepEqual(parked.map(p => p.closed), [false, false], 'no healthy idle socket was swept');
    // healthy fast answer, no hedge: nothing is ever logged as an outcome
    await sleep(300);
    assert.equal(hedgeOutcomes(gate).length, 0, 'no [hedge-outcome] without a hedge');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '300', RC_GATE_TEST_BLOCK_LOOP_AFTER_SEND_MS: '900' });
});

// ── (a15) a LATE timer (own loop lag > 1s) may still hedge, but never sweeps ──
// Attempt 1 really hangs; the loop is blocked 1.5s across the 300ms stall point. Kills: dropping the
// `late` guard on sweepIdleSockets (the other idle socket would be destroyed).
gateTest('rc-gate: a stall timer that fired >1s late hedges but does not sweep the pool', { timeout: 30_000 }, async () => {
  const parkedSocks = [];
  const hb = [];
  await withUpstream((req, res) => {
    req.resume();
    if (!req.url.endsWith('/worker/heartbeat')) { parkedSocks.push(track(req.socket)); return json200(res); }
    hb.push(track(req.socket));
    if (hb.length === 1) return;                       // attempt 1 hangs for real
    json200(res);
  }, async gate => {
    const parked = await parkTwoDirect(gate, parkedSocks);
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 10_000);
    assert.match(status(r.raw), /^2/, `hedge answered, got ${r.how}`);
    assert.equal(hb.length, 2, 'the hedge still happened');
    assert.match(gate.getLog(), /\[direct-stall\] late timer \(loop lag ~\d+ms\) — not sweeping/);
    const other = parked.find(p => p.sock !== hb[0].sock);
    assert.equal(other.closed, false, 'the other idle socket was not swept');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '300', RC_GATE_TEST_BLOCK_LOOP_AFTER_SEND_MS: '1500' });
});

// ── (a14b) the stalled attempt already FAILED in the same turn: no extra hedge on top of its retry ──
// Same starved-loop seam as (a14), but the upstream resets the connection straight away, so when the
// loop resumes the overdue stall timer and the connection error arrive together; the error schedules
// a retry. Kills: dropping the `retryTimer !== null || !liveDirs.has(dir)` guard in the stall deferral
// (a needless hedge is logged on top of the retry).
gateTest('rc-gate: when the stalled attempt already failed and a retry is scheduled, the stall does not also hedge', { timeout: 30_000 }, async () => {
  let n = 0;
  await withUpstream((req, res) => {
    req.resume();
    n++;
    if (n === 1) { req.socket.destroy(); return; }     // attempt 1: reset immediately (during the block)
    json200(res);
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 10_000);
    assert.match(status(r.raw), /^2/, `2xx expected, got ${r.how}: ${r.raw.slice(0, 80)}`);
    assert.match(gate.getLog(), /\[loop-stall\]/, 'premise: the loop really was blocked');
    assert.match(gate.getLog(), /\[direct-retry\].*worker\/heartbeat/, 'premise: the failed attempt went through the retry ladder');
    assert.doesNotMatch(gate.getLog(), /hedging a second attempt/, 'no needless hedge beside the scheduled retry');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '300', RC_GATE_TEST_BLOCK_LOOP_AFTER_SEND_MS: '900' });
});

// ── (a16) a final (non-transient) non-2xx wins at once; it is not held for a hung sibling ──
// Attempt 1 answers 401 at ~3s while the hedge (started at 2s) hangs. Kills: holding every non-2xx
// (the 401 would sit until the 12.5s deadline).
gateTest('rc-gate: a 401 is final and delivered immediately, not held while the other attempt hangs', { timeout: 30_000 }, async () => {
  let n = 0;
  await withUpstream((req, res) => {
    req.resume();
    n++;
    if (n === 1) { setTimeout(() => { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); }, 3_000); return; }
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 13_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms`);
    assert.equal(status(r.raw), '401');
    assert.match(r.raw, /unauthorized/);
    assert.ok(r.ms < 4_500, `delivered right after the 401 arrived (~3s), got ${r.ms}ms`);
    await assertHedgeOutcome(gate, 401, 'first');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '2000' });
});

// ── (a17) session-create response parsing must not throw (zlib was `require`d in an ES module) ──
// A gzip create response used to hit `require is not defined`, and the catch then read a try-scoped
// `body`: an uncaught exception on every create. Kills: the missing import / out-of-scope `body`.
gateTest('rc-gate: a gzip session-create response is parsed into [create-status] with no uncaught exception', { timeout: 20_000 }, async () => {
  const { gzipSync } = await import('node:zlib');
  await withUpstream((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.headers['x-case'] === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('not json'); return; }
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from('{"id":"cse_gzip_000001","ok":true}')));
    });
  }, async gate => {
    const send = async hdr => {
      const { tls: t } = await mitmConnect(gate.port);
      t.on('error', () => {});
      t.write(`POST /v1/code/sessions HTTP/1.1\r\nHost: api.anthropic.com\r\n${hdr}content-length: 2\r\n\r\n{}`);
    };
    await send('');
    await send('x-case: garbage\r\n');
    const until = Date.now() + 6_000;
    while (!(/\[create-status\] 200 id: cse_gzip_000/.test(gate.getLog()) && /PARSE-FAIL/.test(gate.getLog())) && Date.now() < until) await sleep(100);
    assert.match(gate.getLog(), /\[create-status\] 200 id: cse_gzip_000/, 'gzip body decoded and parsed');
    assert.match(gate.getLog(), /\[create-status\] 200 PARSE-FAIL: "not json"/, 'garbage body reported, not thrown');
    assert.doesNotMatch(gate.getLog(), /rc-gate uncaught/, 'no uncaught exception');
  });
});

// Park two idle keep-alive sockets in the DIRECT agent (two concurrent bridge calls); returns them.
async function parkTwoDirect(gate, socks) {
  const [a, b] = await Promise.all([mitmConnect(gate.port), mitmConnect(gate.port)]);
  const [ra, rb] = await Promise.all([
    request(a.tls, 'POST', '/v1/code/sessions/cse_k/bridge', 5_000),
    request(b.tls, 'POST', '/v1/code/sessions/cse_k/bridge', 5_000)]);
  assert.equal(status(ra.raw) + status(rb.raw), '200200');
  return socks.filter(r => !r.closed);
}

// ── (a9) a heartbeat stall sweeps the agent's OTHER idle sockets ────────────────
// Kills: removing `sweepIdleSockets(reqAgent)` from the stall handler (the parked idle socket
// survives).
gateTest('rc-gate: a heartbeat stall sweeps the direct agent\'s other idle sockets', { timeout: 30_000 }, async () => {
  const parkedSocks = [];
  let hbN = 0;
  await withUpstream((req, res) => {
    req.resume();
    if (!req.url.endsWith('/worker/heartbeat')) { parkedSocks.push(track(req.socket)); return json200(res); }
    hbN++;
    if (hbN === 1) return;                              // attempt 1 black-holes
    json200(res);
  }, async gate => {
    const parked = await parkTwoDirect(gate, parkedSocks);
    assert.equal(parked.length, 2, 'two idle sockets parked');
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', HB, 13_000);
    assert.match(status(r.raw), /^2/, `hedge answered, got ${r.how}`);
    await sleep(300);
    // attempt 1 reused one parked socket (now closed with the dropped attempt); the other was idle
    assert.equal(parked.filter(p => p.closed).length, 2, 'both parked sockets are gone: one with attempt 1, the other swept at the stall');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '1500' });
});

// ── (a10) the hedge never lands on a POOLED idle socket ─────────────────────────
// A heartbeat H0 stalls first (stamping the per-agent sweep debounce), so H1's stall sweep is
// debounced and a parked idle socket is still free when H1 hedges. Kills:
// `attemptAgent = hedge ? ... : reqAgent` -> `reqAgent` (the hedge would take the free pooled socket).
gateTest('rc-gate: the hedge uses a fresh connection even when a pooled idle socket is free', { timeout: 30_000 }, async () => {
  const parkedSocks = [];
  const hb = [];
  await withUpstream((req, res) => {
    req.resume();
    if (!req.url.endsWith('/worker/heartbeat')) { parkedSocks.push(track(req.socket)); return json200(res); }
    hb.push(track(req.socket));
    if (hb.length % 2 === 1) return;                    // odd heartbeat attempts black-hole
    json200(res);
  }, async gate => {
    const { tls: t0 } = await mitmConnect(gate.port);
    const r0 = await request(t0, 'POST', HB, 8_000);    // H0: stalls, hedges, sweeps (stamps the debounce)
    assert.match(status(r0.raw), /^2/);
    const parked = await parkTwoDirect(gate, parkedSocks);
    assert.equal(parked.length, 2, 'two idle sockets parked after H0');
    const { tls: t1 } = await mitmConnect(gate.port);
    const r1 = await request(t1, 'POST', HB, 8_000);    // H1: attempt 1 takes a parked socket; stall sweep is debounced
    assert.match(status(r1.raw), /^2/);
    assert.equal(hb.length, 4);
    const parkedSet = new Set(parked.map(p => p.sock));
    assert.ok(parkedSet.has(hb[2].sock), 'H1 attempt 1 reused a pooled socket (premise)');
    const free = parked.find(p => p.sock !== hb[2].sock);
    assert.equal(free.closed, false, 'premise: the other pooled socket was not swept (debounced)');
    assert.ok(!parkedSet.has(hb[3].sock), 'the hedge must NOT land on a pooled idle socket');
  }, { RC_GATE_HEARTBEAT_STALL_MS: '1000' });
});

// ── (b) session CREATE: a stall is neither retried nor hedged ───────────────────
// Guard that passes before AND after the fix: it pins that the heartbeat hedge is not applied
// to other paths. Kills: dropping the `isHeartbeat` check in the stall branch (the create would
// be hedged -> a second POST) and making an own-stall replay-safe for creates.
gateTest('rc-gate: a stalled session create is neither retried nor hedged (a replayed create can double-create)', { timeout: 20_000 }, async () => {
  let creates = 0;
  await withUpstream(req => {
    req.resume();
    if (req.method === 'POST' && req.url === '/v1/code/sessions') creates++;   // never answers
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', '/v1/code/sessions', 8_000);
    assert.notEqual(r.how, 'timeout', 'the stalled create must settle (502 / tunnel closed), not hang');
    await sleep(2_500);                                  // well past any 500ms-backoff retry or hedge
    assert.equal(creates, 1, `create must reach upstream exactly once, saw ${creates}`);
    assert.match(gate.getLog(), /\[direct-stall\] \/v1\/code\/sessions.*destroying/);
  }, { RC_GATE_DIRECT_STALL_MS: '1000' });
});

// ── (b2) long-poll exemption: slow headers are neither stall-destroyed nor hedged ──
// Runs in CI (rc-gate.test.js' twin of this skips there). The upstream sends headers at ~8s,
// longer than BOTH the 1.5s direct stall budget and the 6s heartbeat budget. Kills: `if (!isLongPoll)`
// -> `if (true)` (the 1.5s stall timer destroys it -> 502, no 2xx); classing /worker/events as a
// heartbeat (hedged at 6s -> 2 upstream attempts).
gateTest('rc-gate: a long-poll (/worker/events) with headers after ~8s is not stall-destroyed and not hedged', { timeout: 30_000 }, async () => {
  let attempts = 0;
  await withUpstream((req, res) => {
    req.resume();
    attempts++;
    setTimeout(() => json200(res), 8_000);
  }, async gate => {
    const { tls: t } = await mitmConnect(gate.port);
    const r = await request(t, 'POST', '/v1/code/sessions/cse_x/worker/events', 13_000);
    assert.equal(r.how, 'response', `got ${r.how} after ${r.ms}ms. Gate log:\n${gate.getLog().slice(-400)}`);
    assert.match(status(r.raw), /^2/, `2xx expected, got: ${r.raw.slice(0, 90)}`);
    assert.ok(r.ms >= 7_500, `answered only when upstream sent headers (~8s), got ${r.ms}ms`);
    assert.equal(attempts, 1, `exactly one upstream attempt, saw ${attempts}`);
    assert.doesNotMatch(gate.getLog(), /\[direct-stall\]/, 'no stall timer fired on a long-poll');
  }, { RC_GATE_DIRECT_STALL_MS: '1500' });
});

// ── (c) a forced net-evac must not reset an in-flight request to a LOOPBACK maxpool ──
// Kills: removing the `!LOOPBACK_HOSTS.has(MAXPOOL_HOST)` guard around poolAgent.destroy()
// (Agent.destroy() kills the in-use socket: `[resp-break] UPSTREAM ...`, body truncated).
// Uses the gate's own FORCE_EVAC seam (flag file path is per-gate in this file).
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
  const gate = await startGate({ RC_GATE_MAXPOOL_PORT: String(mp.address().port), RC_GATE_PROFILE: 'claude' });
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
    writeFileSync(gate.evacFlag, '');
    const evacBy = Date.now() + 8_000;
    while (!/\[net-evac\]/.test(gate.getLog()) && Date.now() < evacBy) await sleep(100);
    assert.match(gate.getLog(), /\[net-evac\]/, 'the seam really fired the evacuation (else this test proves nothing)');
    const endBy = Date.now() + 14_000;
    while (!raw.includes('message_stop') && !closed && Date.now() < endBy) await sleep(100);
    assert.ok(raw.includes('message_stop'), `in-flight response must complete after the evac; closed=${closed}. Gate log:\n${gate.getLog().slice(-500)}`);
    assert.doesNotMatch(gate.getLog(), /\[resp-break\] UPSTREAM/, 'the pool leg was not reset');
  } finally { gate.kill(); await new Promise(r => mp.close(r)); }
});

// ── (d) a telemetry retry after a reset on a FRESH socket sweeps nothing ─────────
// The retry here is not a connect error and the failing socket was not reused, so no idle
// socket anywhere may be swept. Kills: the old global sweep (`directAgent.freeSockets`
// destroyed on every retry) - the idle direct keep-alive socket would close.
gateTest('rc-gate: a telemetry retry (reset on a fresh socket) leaves the direct agent\'s idle keep-alive socket alone', { timeout: 20_000 }, async () => {
  let direct = null;
  let telemetryAttempts = 0;
  await withUpstream((req, res) => {
    req.resume();
    if (req.url.startsWith('/api/event_logging')) {
      telemetryAttempts++;
      if (telemetryAttempts === 1) { req.socket.destroy(); return; }
    } else {
      direct = track(req.socket);
    }
    json200(res);
  }, async gate => {
    const { tls: t1 } = await mitmConnect(gate.port);
    const r1 = await request(t1, 'POST', '/v1/code/sessions/cse_k/bridge', 5_000);
    assert.equal(status(r1.raw), '200');
    assert.ok(direct && !direct.closed, 'direct socket parked idle upstream');
    const { tls: t2 } = await mitmConnect(gate.port);
    const r2 = await request(t2, 'POST', '/api/event_logging/v2/batch', 8_000);
    assert.equal(status(r2.raw), '200', `telemetry retried to success, got: ${r2.raw.slice(0, 90)}`);
    assert.equal(telemetryAttempts, 2);
    assert.match(gate.getLog(), /\[direct-retry\] \/api\/event_logging/, 'the retry path ran');
    await sleep(300);
    assert.equal(direct.closed, false, 'the telemetry retry must not destroy the direct agent\'s idle socket');
  });
});

// ── (d2) scoped + debounced idle sweep ─────────────────────────────────────────
// A connect-phase error cannot coexist with an idle socket of the SAME agent (the agent always
// hands out an idle socket first), so this drives the other arm of the sweep condition,
// `dir.reusedSocket`: park two idle sockets in an agent, let a third request reuse one and get
// reset, and see whether the OTHER idle one is swept. Three phases, all within 5s:
//   1. telemetry agent:  sweeps ITS idle socket                    (kills: never sweeping on reuse /
//                                                                   `connectPhase`-only condition)
//   2. direct agent, <5s after phase 1: sweeps its idle socket     (kills: ONE GLOBAL debounce stamp)
//   3. telemetry agent again, <5s after phase 1: NOT swept         (kills: no debounce)
// and in phases 1-2 the other agent's parked idle socket must survive (kills: sweeping the wrong
// or every agent).
gateTest('rc-gate: retry idle-sweep is scoped to the failing request\'s agent and debounced per agent', { timeout: 40_000 }, async () => {
  const socks = { tel: [], dir: [] };
  const mode = { tel: 'ok', dir: 'ok' };
  const resetSock = { tel: null, dir: null };
  const cls = url => (url.startsWith('/api/event_logging') ? 'tel' : 'dir');
  await withUpstream((req, res) => {
    req.resume();
    const c = cls(req.url);
    if (!socks[c].some(r => r.sock === req.socket)) socks[c].push(track(req.socket));
    if (mode[c] === 'park') { setTimeout(() => json200(res), 150); return; }
    if (mode[c] === 'reset') { mode[c] = 'ok'; resetSock[c] = req.socket; req.socket.destroy(); return; }
    json200(res);
  }, async gate => {
    const PATH = { tel: '/api/event_logging/v2/batch', dir: '/v1/code/sessions/cse_k/client/presence' };
    // park two idle sockets in the agent, then fail a reuse; return the parked sockets that were NOT the failing one
    async function scenario(c) {
      mode[c] = 'park';
      const [a, b] = await Promise.all([mitmConnect(gate.port), mitmConnect(gate.port)]);
      const [ra, rb] = await Promise.all([request(a.tls, 'POST', PATH[c], 5_000), request(b.tls, 'POST', PATH[c], 5_000)]);
      assert.equal(status(ra.raw) + status(rb.raw), '200200', `${c} park requests`);
      const parked = socks[c].filter(r => !r.closed);
      assert.ok(parked.length >= 2, `${c}: two idle sockets parked (got ${parked.length})`);
      mode[c] = 'reset';
      const t = await mitmConnect(gate.port);
      const r = await request(t.tls, 'POST', PATH[c], 8_000);
      assert.equal(status(r.raw), '200', `${c}: the reset request is retried to success, got ${r.raw.slice(0, 80)}`);
      await sleep(300);
      return parked.filter(p => p.sock !== resetSock[c]);
    }
    // phase 0: park one idle socket in the DIRECT agent first, to watch it through phase 1
    const dirIdle = await (async () => {
      const t = await mitmConnect(gate.port);
      const r = await request(t.tls, 'POST', PATH.dir, 5_000);
      assert.equal(status(r.raw), '200');
      return socks.dir[0];
    })();
    // phase 1
    const others1 = await scenario('tel');
    assert.ok(others1.length >= 1 && others1.every(p => p.closed), 'phase 1: telemetry\'s other idle socket was swept');
    assert.equal(dirIdle.closed, false, 'phase 1: the direct agent\'s idle socket was NOT swept by a telemetry failure');
    // phase 2 (direct agent, still inside telemetry's 5s window)
    const others2 = await scenario('dir');
    assert.ok(others2.length >= 1 && others2.every(p => p.closed), 'phase 2: the direct agent swept despite a telemetry sweep <5s ago (per-agent debounce)');
    // phase 3 (telemetry again, inside ITS 5s window)
    const others3 = await scenario('tel');
    assert.ok(others3.length >= 1 && others3.every(p => !p.closed), 'phase 3: second telemetry sweep within 5s is debounced');
  });
});
