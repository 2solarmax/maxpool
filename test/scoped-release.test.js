import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function manager(count = 2) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`,
      type: 'oauth',
      accessToken: `t${i + 1}`,
      refreshToken: `r${i + 1}`,
      expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

function lease(am, index = 0) {
  const l = am.acquireAccount({ profile: 'claude' });
  assert.ok(l, 'acquire returned a lease');
  assert.equal(l.account, am.accounts[index], 'lease is on the expected account');
  return l;
}

test('request-scoped failure is recorded but never extends the failure streak / hold-release gate (T9)', () => {
  const am = manager(1);
  const l = lease(am);
  am.releaseAccount(l, { status: 502, error: 'pool_link_unreachable', scope: 'request' });
  // The attempt IS visible as a failed request…
  assert.equal(am.accounts[0].failedRequests, 1);
  // …but the streak the hold-release gate reads is untouched, so the account's
  // other held conversations keep their hold.
  assert.equal(am.accounts[0].consecutiveFailures, 0);
  assert.equal(am._affinityRelease(am.accounts[0]), null, 'failures-N gate stays closed');
});

test('account-scoped failure (default scope) still trips the failures-N gate (T9)', () => {
  const am = manager(1);
  const l = lease(am);
  am.releaseAccount(l, { status: 502, error: 'pool_link_unreachable' });
  assert.equal(am.accounts[0].consecutiveFailures, 1);
  assert.equal(am._affinityRelease(am.accounts[0]), 'failures-1', 'gate opens — held conversations released');
});

test('a 429 keeps releasing every held conversation: release-side 429 and markRateLimited both trip the gate (T9/T12)', () => {
  const am = manager(1);
  // Release-side: the link catch carrying a remote 429 must stay account-scoped.
  let l = lease(am);
  am.releaseAccount(l, { status: 429, error: 'rate_limited' });
  assert.ok(am.accounts[0].consecutiveFailures > 0, '429 release bumps the streak');
  assert.match(am._affinityRelease(am.accounts[0]), /^failures-/);
  // The canonical throttle path (markRateLimited) does the same.
  l = lease(am);
  am.releaseAccount(l, { success: false, status: 200 });
  am.accounts[0].consecutiveFailures = 0;
  am.markRateLimited(0, 60);
  assert.ok(am.accounts[0].consecutiveFailures > 0, 'markRateLimited bumps the streak');
  assert.match(am._affinityRelease(am.accounts[0]), /^failures-/);
});

test('neutral release leaves consecutiveFailures and failedRequests unchanged (T11 / pre-mortem P3)', () => {
  const am = manager(1);
  const l = lease(am);
  am.releaseAccount(l, { status: 502, error: 'client_cancelled', neutral: true });
  assert.equal(am.accounts[0].failedRequests, 0);
  assert.equal(am.accounts[0].consecutiveFailures, 0);
  assert.equal(am._affinityRelease(am.accounts[0]), null);
  // And the pre-existing neutral caller shape (request-shape refusal) is unchanged.
  const l2 = lease(am);
  am.releaseAccount(l2, { status: 429, error: 'request_shape_refused', neutral: true });
  assert.equal(am.accounts[0].failedRequests, 0);
  assert.equal(am.accounts[0].consecutiveFailures, 0);
});

test('a request-scoped failure followed by a success leaves a healthy account (streak stays pure)', () => {
  const am = manager(1);
  am.releaseAccount(lease(am), { status: 502, error: 'pool_link_unreachable', scope: 'request' });
  am.releaseAccount(lease(am), { success: true, status: 200 });
  assert.equal(am.accounts[0].consecutiveFailures, 0);
  assert.equal(am._affinityRelease(am.accounts[0]), null);
});

// Server wiring (D4 on the link path): a link blip — the linked pool drops the socket
// with no answer — is request-scoped. The row is skipped for THIS request (moved), but
// its failure streak stays 0, so the conversations held on it keep their hold.
test('link blip releases request-scoped: the failed mirror row keeps consecutiveFailures 0 (T9 wiring)', async () => {
  const http = await import('node:http');
  const { createProxyServer } = await import('../src/server.js');
  const { PoolLink } = await import('../src/pool-link.js');
  const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
  const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
  let n = 0;
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [
        { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
        { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
      ] }));
      return;
    }
    if (req.url === '/v1/messages') {
      if (++n === 1) { req.socket.destroy(); return; }   // blip: no answer at all
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  const remotePort = await listen(remote);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  const orig = console.log; console.log = () => {};
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
      body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
    });
    await res.text();
    assert.equal(res.status, 200, 'moved to the other row and served');
    assert.equal(n, 2, 'one blip, one successful hop');
    const rows = am.accounts.filter(a => a.remote);
    // 2026-11-12 (link drops): a link blip is no longer an account failure at all —
    // it is recorded as a LINK DROP on its row (failedRequests stays 0).
    const failedRow = rows.find(a => am._loadSummary(a, 15 * 60_000).linkFailed > 0);
    assert.ok(failedRow, 'the blip is recorded as a link drop on its row');
    assert.equal(failedRow.failedRequests, 0, 'a link blip is not an account failure');
    assert.equal(failedRow.consecutiveFailures, 0, 'request-scoped: no streak, held conversations keep their hold');
    assert.equal(am._affinityRelease(failedRow), null);
  } finally { console.log = orig; am.setPoolLinks([]); await close(proxy); await close(remote); await close(upstream); }
});
