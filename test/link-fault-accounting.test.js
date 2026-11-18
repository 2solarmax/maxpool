// Link drops are not account failures (2026-11-12). The Mac pool showed 10-26 "failed"
// on nearly every cloud (☁) row while the cloud's own failure rate was ≈6 of ~2,100
// requests: every give-up on the Mac↔cloud link (link_ttfb / link_idle /
// pool_link_unreachable) was booked as the cloud ACCOUNT failing. They are now tallied
// as link drops, shown separately; a client leaving counts as neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { __tuiTest } from '../src/tui.js';
import { remotePool, bootLink, bigBody, captureLog, attempts, listen, close } from './link-fixture.js';

const { loadText, strip } = __tuiTest;
const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function oneAccount() {
  const am = new AccountManager([{ name: 'c1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 }], 0.9);
  return { am, a: am.accounts[0] };
}
const lease = (account, heldMs) => { account.inFlight++; return { account, weight: 1, startedAt: Date.now() - heldMs }; };

test('a link-transport fault is a link drop, not an account failure', () => {
  const { am, a } = oneAccount();
  am.releaseAccount(lease(a, 1000), { success: true, status: 200 });
  const before = { lastStatus: a.lastStatus, lastError: a.lastError, consecutiveFailures: a.consecutiveFailures };
  am.releaseAccount(lease(a, 120_000), { linkFault: true, status: 502, error: 'link_ttfb', scope: 'request' });
  assert.equal(a.failedRequests, 0, 'failedRequests untouched');
  assert.equal(a.consecutiveFailures, before.consecutiveFailures, 'no failure streak');
  assert.equal(a.lastError, before.lastError, 'error text untouched');
  assert.equal(a.lastStatus, before.lastStatus, 'last status untouched');
  assert.equal(a.inFlight, 0, 'the lease is still released');
  const w = am._loadSummary(a, 15 * 60_000);
  assert.equal(w.failed, 0, 'not in the 15m failed count');
  assert.equal(w.linkFailed, 1, 'counted as a link drop');
  assert.equal(w.requests, 2, 'still an attempt on this row');
  assert.ok(w.avgMs >= 900 && w.avgMs < 5000, `a 120s give-up does not drag the average (avgMs=${w.avgMs})`);
});

test('a real account failure still counts as failed (not a link drop)', () => {
  const { am, a } = oneAccount();
  am.releaseAccount(lease(a, 500), { status: 500, error: 'upstream_500' });
  const w = am._loadSummary(a, 15 * 60_000);
  assert.equal(a.failedRequests, 1);
  assert.equal(a.lastError, 'upstream_500');
  assert.equal(w.failed, 1);
  assert.equal(w.linkFailed, 0);
});

test('TUI row shows link drops beside failures, and alone', () => {
  assert.equal(strip(loadText({ last1h: { requests: 4 }, last15m: { failed: 1, linkFailed: 2 } })), '4 req/hr · 1 failed · 2 link drops');
  // A row whose only recent activity is link drops must not render blank.
  assert.equal(strip(loadText({ last15m: { linkFailed: 1 } })), '1 link drop');
  assert.match(loadText({ last15m: { linkFailed: 3 } }), /\x1b\[33m3 link drops/, 'link drops are yellow');
  assert.equal(loadText({ last15m: { failed: 0, linkFailed: 0 } }), '', 'idle row stays blank');
});

test('a link connection drop: cloud row not failed, counted as a link drop, line says streaming or not', async () => {
  for (const stream of [true, false]) {
    const remote = remotePool(pin => (pin === 'reports@gomokka.com' ? 'reset' : (stream ? 'sse' : 'ok')));
    const { am, port, cleanup } = await bootLink(remote);
    try {
      let status = 0;
      const lines = await captureLog(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: bigBody(2_000, stream),
        });
        status = r.status; await r.text();
      });
      assert.equal(status, 200, 'moved to the other row and answered');
      const a = attempts(lines);
      assert.equal(a.length, 1, a.join('\n'));
      assert.match(a[0], /\(pool_link_unreachable\) on "reports@gomokka\.com ☁"/);
      assert.match(a[0], new RegExp(`\\[.*\\b${stream ? 'streaming' : 'non-streaming'}\\]`), `stream=${stream}: ${a[0]}`);
      assert.match(a[0], /\b(UND_ERR_SOCKET|ECONNRESET|UND_ERR_CLOSED|TypeError|Error)\b/, `the error is named: ${a[0]}`);
      const row = am.accounts.find(x => x.name === 'reports@gomokka.com ☁');
      assert.equal(row.failedRequests, 0, 'the cloud account did not fail');
      assert.equal(row.lastError, null, 'no error text on the cloud row');
      const w = am._loadSummary(row, 15 * 60_000);
      assert.equal(w.failed, 0);
      assert.equal(w.linkFailed, 1);
    } finally { await cleanup(); }
  }
});

test('a client that leaves mid-answer on the link counts as neither a failure nor a link drop', async () => {
  const remote = remotePool(() => 'partial');
  const { am, port, cleanup } = await bootLink(remote);
  try {
    const ctl = new AbortController();
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: bigBody(2_000, true), signal: ctl.signal,
    });
    const reader = r.body.getReader();
    const first = await reader.read();   // a real byte reached the client
    assert.ok(first.value?.length > 0);
    ctl.abort();
    const row = am.accounts.find(x => x.name === remote.hits[0] + ' ☁');
    for (let i = 0; i < 50 && row.inFlight > 0; i++) await new Promise(res => setTimeout(res, 20));
    assert.equal(row.inFlight, 0, 'the lease was released');
    const w = am._loadSummary(row, 15 * 60_000);
    assert.equal(row.failedRequests, 0, 'not a failure');
    assert.equal(w.failed, 0);
    assert.equal(w.linkFailed, 0, 'not a link drop either');
  } finally { await cleanup(); }
});

test('`maxpool status` shows link drops beside failures', async () => {
  const { am, a } = oneAccount();
  am.releaseAccount(lease(a, 1000), { linkFault: true, status: 502, error: 'link_idle', scope: 'request' });
  am.releaseAccount(lease(a, 1000), { linkFault: true, status: 502, error: 'link_ttfb', scope: 'request' });
  am.releaseAccount(lease(a, 500), { status: 500, error: 'upstream_500' });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-status-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' }, accounts: [] }) + '\n');
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      const child = spawn(process.execPath, [cliPath, 'status'], { env: { ...process.env, MAXPOOL_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', d => buf += d);
      child.stderr.on('data', d => buf += d);
      child.on('error', reject);
      child.on('exit', () => resolve(buf));
    });
    assert.match(out, /15m 3 req avg [^,]+, 1 failed, 2 link drops/, out);
  } finally { await close(proxy); }
});
