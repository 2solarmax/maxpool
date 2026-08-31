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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GATE_PORT = Number(process.env.RC_GATE_PORT || 3457);
const GATE_HOST = process.env.RC_GATE_HOST || '127.0.0.1';
const MAXPOOL_PORT = Number(process.env.RC_GATE_MAXPOOL_PORT || 3456);
const MITM_HOSTS = new Set((process.env.RC_GATE_MITM_HOSTS || 'api.anthropic.com').split(',').map(s => s.trim()).filter(Boolean));
const PROFILE = process.env.RC_GATE_PROFILE || 'claude';

const cert = readFileSync(path.join(__dirname, 'anthropic-mitm.crt'));
const key = readFileSync(path.join(__dirname, 'anthropic-mitm.key'));

const mitmServer = http.createServer((creq, cres) => {
  // Forward decrypted request to maxpool as plain HTTP, re-applying the
  // profile headers the cc wrapper would normally set.
  const headers = { ...creq.headers };
  delete headers.authorization;           // pool accounts supply upstream auth
  delete headers['proxy-connection'];
  // Only default the profile; a client-sent x-maxpool-profile (cc all vs claude) wins.
  if (!headers['x-maxpool-profile']) headers['x-maxpool-profile'] = PROFILE;
  const opts = {
    host: '127.0.0.1', port: MAXPOOL_PORT, method: creq.method,
    path: creq.url, headers, agent: false,
  };
  console.log(`[mitm] ${creq.method} https://${creq.headers.host}${creq.url}`);

  // Identity/session-CRUD paths carry the user's own OAuth semantics (flag
  // targeting, session ownership) — send them DIRECT. Only true inference
  // calls belong to the pool. /v1/code/sessions* 404s through the pool because
  // the pool account doesn't own the Remote Control session (measured 2026-08-31).
  const isIdentityPath = !creq.url.startsWith('/v1/') || creq.url.startsWith('/v1/code/sessions');
  if (isIdentityPath) {
    // Identity/eval/settings paths must reach the REAL api.anthropic.com with the
    // client's OWN OAuth token: feature-flag targeting (tengu_ccr_bridge et al.)
    // is keyed to the signed-in identity, and account settings must reflect the
    // real user. Routing these through maxpool would swap the token for a pool
    // account's and silently flip Remote Control flags off (measured 2026-08-31).
    const dirHeaders = { ...creq.headers, host: 'api.anthropic.com' };
    for (const h of Object.keys(dirHeaders)) if (h.startsWith('x-maxpool-')) delete dirHeaders[h];
    const dirOpts = {
      host: 'api.anthropic.com', method: creq.method, path: creq.url,
      headers: dirHeaders, agent: false,
    };
    const dir = https.request(dirOpts, ures => {
      cres.writeHead(ures.statusCode, ures.headers);
      ures.pipe(cres);
    });
    dir.on('error', err => {
      try { cres.writeHead(502, { 'content-type': 'application/json' }); } catch {}
      cres.end(JSON.stringify({ type: 'error', error: { type: 'rc_gate_direct_error', message: String(err?.message || err) } }));
    });
    creq.pipe(dir);
    return;
  }

  // Inference paths go to maxpool: pool accounts supply upstream auth.
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
// SSE-friendly: no request buffering beyond what streaming needs.
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
  const kill = () => { try { clientSocket.destroy(); up.destroy(); } catch {} };
  up.on('error', kill);
  clientSocket.on('error', kill);
});

gate.listen(GATE_PORT, GATE_HOST, () => {
  console.log(`rc-gate listening on ${GATE_HOST}:${GATE_PORT}`);
  console.log(`  MITM hosts: ${[...MITM_HOSTS].join(', ')} -> maxpool 127.0.0.1:${MAXPOOL_PORT} (profile: ${PROFILE})`);
  console.log(`  everything else: blind tunnel`);
});
