#!/usr/bin/env node
// rc-gate — CONNECT-MITM front door that lets Claude Code Remote Control
// work through maxpool.
//
// WHY: Claude Code (≥2.1.196) disables Remote Control unless
// ANTHROPIC_BASE_URL is unset-or-api.anthropic.com (binary check is a literal
// host-string compare — M$()/NT() in v2.1.251). Pointing it at
// 127.0.0.1:3456 therefore kills RC. But the CLI fully honors HTTPS_PROXY
// CONNECT tunneling, and Remote Control's bridge (wss://bridge.claudeusercontent.com)
// is a separate host that must reach Anthropic DIRECT.
//
// HOW: sessions run with ANTHROPIC_BASE_URL UNSET + HTTPS_PROXY=this gate +
// NODE_EXTRA_CA_CERTS=mkcert root. The CLI connects to api.anthropic.com:443
// via CONNECT; we MITM exactly that host (cert minted by mkcert for
// api.anthropic.com), terminate TLS, and forward the decrypted HTTP request
// to maxpool with x-maxpool-* headers re-applied. CONNECTs to any other host
// are blind-tunneled untouched — bridge, statsig, sentry, everything else
// reaches the real internet directly.
//
// Upstream auth: maxpool routes by header profile and ignores client OAuth for
// account selection (cc wrappers already send x-maxpool-profile). The client's
// Authorization is stripped before forwarding so the pool's per-account tokens
// are the only credentials upstream sees.
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// KEEP-ALIVE AGENTS (2026-09-04 leak fix). Previously every forwarded request used
// `agent: false` = a brand-new TCP connection, and with ~200 live Remote Control
// sessions heart-beating every few seconds that churned thousands of sockets. Node
// held their fds after close: measured 7,568 CLOSED sockets on one gate process,
// which is what starved new CONNECTs and made Remote Control "keep dropping after
// each reconnect". Pooled agents reuse connections and bound the socket count.
const poolAgent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 64, maxFreeSockets: 16 });
const directAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 30_000, maxSockets: 64, maxFreeSockets: 16 });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_PORT = Number(process.env.RC_GATE_PORT || 3457);
const GATE_HOST = process.env.RC_GATE_HOST || '127.0.0.1';
const MAXPOOL_PORT = Number(process.env.RC_GATE_MAXPOOL_PORT || 3456);
const MITM_HOSTS = new Set((process.env.RC_GATE_MITM_HOSTS || 'api.anthropic.com').split(',').map(s => s.trim()).filter(Boolean));
const PROFILE = process.env.RC_GATE_PROFILE || 'claude';

const cert = readFileSync(path.join(__dirname, 'anthropic-mitm.crt'));
const key = readFileSync(path.join(__dirname, 'anthropic-mitm.key'));

// MITM forward: ONE path for every decrypted request. Direct requests are piped
// to https.request with a keep-alive agent that has NO idle timeout (a 60s agent
// timeout was killing long-lived /worker/events/stream connections mid-stream —
// the 09-05 regression) and NO custom retry (a replayed /bridge or /worker
// registration makes the server evict the existing connection with close code
// 4090 — the same-day second regression). If a pooled socket went stale, the
// request fails and the CLI retries it itself, which is correct: the CLI knows
// which of its requests are idempotent; a transport shim does not.
const mitmServer = http.createServer((creq, cres) => {
  const headers = { ...creq.headers };
  delete headers.authorization;           // pool accounts supply upstream auth
  delete headers['proxy-connection'];
  if (!headers['x-maxpool-profile']) headers['x-maxpool-profile'] = PROFILE;

  const isIdentityPath = !creq.url.startsWith('/v1/') || creq.url.startsWith('/v1/code/sessions');
  if (isIdentityPath) {
    const dirHeaders = { ...creq.headers, host: 'api.anthropic.com' };
    for (const h of Object.keys(dirHeaders)) if (h.startsWith('x-maxpool-')) delete dirHeaders[h];
    // Session-create responses: force identity encoding so the body is readable end-to-end.
    // The CLI negotiates zstd (server advertises zstd,gzip) and Node cannot decode zstd — a
    // zstd body reached the CLI un-decoded while the create-status tee failed to parse it
    // (bare "200" logs). identity keeps headers consistent and diagnosable.
    if (/\/v1\/code\/sessions$/.test(creq.url)) dirHeaders['accept-encoding'] = 'identity';
    // BUFFER-THEN-SEND for direct posts (2026-09-06): `creq.pipe(dir)` raced the keep-alive
    // agent — Node could emit the request 'finish' and the server 'complete' before every
    // body chunk was written, aborting the stream mid-body. Symptom (measured, CLI 2.1.263):
    // "Session create request failed: stream has been aborted" x3, then "Session creation
    // failed — see debug log". Direct-path bodies are small (identity paths: auth handshakes,
    // session CRUD, settings — all <64KB typical); buffer fully and send with explicit length.
    const dirSend = () => {
      const bodyBufs = [];
      creq.on('data', c => bodyBufs.push(c));
      creq.on('end', () => {
        const body = Buffer.concat(bodyBufs);
        const hdrs = { ...dirHeaders };
        delete hdrs['transfer-encoding'];
        if (body.length || creq.method !== 'GET') hdrs['content-length'] = String(body.length);
        const dir = https.request({
          host: 'api.anthropic.com', method: creq.method, path: creq.url,
          headers: hdrs, agent: directAgent,
        }, ures => {
      if (/\/v1\/code\/sessions$/.test(creq.url)) {
        const chunks = [];
        ures.on('data', c => chunks.push(c));
        ures.on('end', () => {
          const raw = Buffer.concat(chunks);
          try {
            const zlib = require('node:zlib');
            const enc = String(ures.headers['content-encoding'] || '');
            const body = enc.includes('gzip') ? zlib.gunzipSync(raw)
              : enc.includes('br') ? zlib.brotliDecompressSync(raw)
              : enc.includes('deflate') ? zlib.inflateSync(raw) : raw;
            const j = JSON.parse(body.toString('utf8'));
            console.log('[create-status]', ures.statusCode, 'id:', (j.id || '').slice(0, 12));
          } catch (e) { console.log('[create-status]', ures.statusCode, 'PARSE-FAIL:', JSON.stringify(body.toString('utf8').slice(0,200))); }
        });
      }
      cres.writeHead(ures.statusCode, ures.headers);
      ures.pipe(cres);
    });
        dir.on('error', err => {
          console.log('[direct-error]', creq.url, String(err?.message || err));
          try { cres.writeHead(502, { 'content-type': 'application/json' }); } catch {}
          cres.end(JSON.stringify({ type: 'error', error: { type: 'rc_gate_direct_error', message: String(err?.message || err) } }));
        });
        dir.end(body);
      });
    };
    dirSend();
    return;
  }

  // Inference paths go to maxpool: pool accounts supply upstream auth.
  const opts = {
    host: '127.0.0.1', port: MAXPOOL_PORT, method: creq.method,
    path: creq.url, headers, agent: poolAgent,
  };
  console.log(`[mitm] ${creq.method} https://${creq.headers.host}${creq.url}`);
  const up = http.request(opts, ures => {
    cres.writeHead(ures.statusCode, ures.headers);
    ures.pipe(cres);
  });
  up.on('error', err => {
    try { cres.writeHead(502, { 'content-type': 'application/json' }); } catch {}
    cres.end(JSON.stringify({ type: 'error', error: { type: 'rc_gate_upstream_error', message: String(err?.message || err) } }));
  });
  creq.pipe(up);
});
mitmServer.headersTimeout = 0;
mitmServer.requestTimeout = 0;
mitmServer.keepAliveTimeout = 0;

const gate = http.createServer((req, res) => {
  // Plain (non-CONNECT) requests shouldn't arrive; answer honestly.
  res.writeHead(405).end('rc-gate: CONNECT only');
});
gate.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = Number(portStr || 443);

  if (MITM_HOSTS.has(host)) {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    const tlsSock = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext: tls.createSecureContext({ cert, key }),
    });
    // Handle TLS handshake errors without crashing the gate.
    tlsSock.on('error', () => { try { clientSocket.destroy(); } catch {} });
    // Hand the TLS server socket to the MITM HTTP server: it parses requests
    // off the decrypted stream and runs the forward-to-maxpool handler.
    // Tie the two lifetimes together: without this the raw clientSocket fd
    // outlives the TLS socket (same CLOSED-fd leak as the blind tunnel).
    tlsSock.on('close', () => { try { clientSocket.destroy(); } catch {} });
    clientSocket.on('close', () => { try { tlsSock.destroy(); } catch {} });
    clientSocket.setKeepAlive(true, 30_000);
    mitmServer.emit('connection', tlsSock);
    if (head && head.length) tlsSock.unshift(head);
    return;
  }

  // Blind tunnel: connect to the REAL host (gate's own traffic must not loop).
  const up = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    up.write(head);
    up.pipe(clientSocket);
    clientSocket.pipe(up);
  });
  // Destroy BOTH ends whenever EITHER ends — on 'close' as well as 'error'. pipe()
  // only end()s the peer, which leaves its fd held after the TCP socket is already
  // CLOSED; that is the leak (7,568 CLOSED fds measured 2026-09-04). Keepalive
  // probes also stop a silently-vanished peer (laptop sleep, Wi-Fi drop) from
  // pinning a tunnel forever, since a WSS bridge can idle between heartbeats.
  const kill = () => { try { clientSocket.destroy(); } catch {} try { up.destroy(); } catch {} };
  up.on('error', kill);
  clientSocket.on('error', kill);
  up.on('close', kill);
  clientSocket.on('close', kill);
  up.setKeepAlive(true, 30_000);
  clientSocket.setKeepAlive(true, 30_000);
});

// A gate crash drops Remote Control for EVERY live session at once, so no single
// stray socket error may take the process down. EADDRINUSE is the benign case —
// two `cc` launches racing to start the gate; the loser exits quietly (the log had
// 10 stack-trace crashes from this before).
gate.on('error', err => {
  if (err?.code === 'EADDRINUSE') { console.log('rc-gate: port already served by another instance — exiting quietly'); process.exit(0); }
  console.error('rc-gate server error:', err?.message || err);
});
mitmServer.on('clientError', (err, sock) => { try { sock.destroy(); } catch {} });
process.on('uncaughtException', err => {
  if (err?.code === 'EADDRINUSE') { console.log('rc-gate: port already in use — exiting quietly'); process.exit(0); }
  console.error('rc-gate uncaught:', err?.message || err);
});

gate.listen(GATE_PORT, GATE_HOST, () => {
  console.log(`rc-gate listening on ${GATE_HOST}:${GATE_PORT}`);
  console.log(`  MITM hosts: ${[...MITM_HOSTS].join(', ')} -> maxpool 127.0.0.1:${MAXPOOL_PORT} (profile: ${PROFILE})`);
  console.log(`  everything else: blind tunnel`);
});
