#!/usr/bin/env node
// hop-probe — reproduces, once a second, the two TCP hops a `cc` session depends on:
//   CLI -> rc-gate (127.0.0.1:3457)   [the hop that leaves NO trace in any log when it fails]
//   gate -> maxpool (127.0.0.1:3456)
// plus a DNS+TCP reach test to each provider, so a stall can be attributed to a hop
// instead of reconstructed. Every line is UTC-stamped; only ANOMALIES are printed
// (a healthy second prints nothing) so the output is a signal, not a firehose.
//
// Why this exists: on 2026-09-07 a user-visible "will retry in Nm · check your network"
// left ZERO evidence in maxpool's log (it was serving 200s throughout) and zero in the
// gate's — meaning the request never reached either. Only a probe standing where the
// CLI stands can catch that.
import net from 'node:net';
import dns from 'node:dns/promises';

const SLOW_MS = Number(process.env.HOP_PROBE_SLOW_MS || 250);
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

function tcp(host, port, timeoutMs = 5000) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const s = new net.Socket();
    let done = false;
    const finish = (ok, err) => {
      if (done) return; done = true;
      try { s.destroy(); } catch {}
      resolve({ ok, ms: Date.now() - t0, err });
    };
    s.setTimeout(timeoutMs, () => finish(false, 'TIMEOUT'));
    s.once('error', e => finish(false, e.code || e.message));
    s.connect(port, host, () => finish(true));
  });
}

const targets = [
  { name: 'rc-gate',  host: '127.0.0.1', port: 3457 },
  { name: 'maxpool',  host: '127.0.0.1', port: 3456 },
];
const remote = [
  { name: 'anthropic', host: 'api.anthropic.com', port: 443 },
  { name: 'zai',       host: 'api.z.ai',          port: 443 },
];

let lastDnsCheck = 0;
console.log(`${now()} hop-probe started (slow>${SLOW_MS}ms; healthy seconds are silent)`);

setInterval(async () => {
  for (const t of targets) {
    const r = await tcp(t.host, t.port, 3000);
    if (!r.ok) console.log(`${now()} FAIL   ${t.name} ${t.host}:${t.port} — ${r.err} after ${r.ms}ms`);
    else if (r.ms > SLOW_MS) console.log(`${now()} SLOW   ${t.name} ${t.host}:${t.port} — connect took ${r.ms}ms`);
  }
  // Providers + DNS every 10s: the failure signature we chased was UND_ERR_CONNECT_TIMEOUT,
  // which is a connect-establish failure, so measure establish time not HTTP status.
  if (Date.now() - lastDnsCheck > 10_000) {
    lastDnsCheck = Date.now();
    for (const t of remote) {
      const d0 = Date.now();
      let ip;
      try { ip = (await dns.lookup(t.host)).address; }
      catch (e) { console.log(`${now()} DNSFAIL ${t.name} ${t.host} — ${e.code || e.message} after ${Date.now() - d0}ms`); continue; }
      const dnsMs = Date.now() - d0;
      if (dnsMs > 1000) console.log(`${now()} DNSSLOW ${t.name} ${t.host} — ${dnsMs}ms`);
      const r = await tcp(ip, t.port, 8000);
      if (!r.ok) console.log(`${now()} FAIL   ${t.name} ${ip}:${t.port} — ${r.err} after ${r.ms}ms`);
      else if (r.ms > 2000) console.log(`${now()} SLOW   ${t.name} ${ip}:${t.port} — connect took ${r.ms}ms`);
    }
  }
}, 1000);
