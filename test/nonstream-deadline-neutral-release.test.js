// Release B, red-team round 1, F7: the deadline-cut release is NEUTRAL at the REAL call sites (B12),
// not just in a hand-built `{ neutral: true }` call. Each test drives a real request through a real
// pool until the client's deadline cuts the wait, spies on the outcome the call site passes to
// releaseAccount, and then reads the row: no failed count, no streak, no cooldown, no link-fault event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
async function captureLog(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig.log; console.error = orig.error; }
  return lines;
}
const BODY = JSON.stringify({ model: 'claude-opus-5-5', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });

/** Record every outcome object a call site hands to releaseAccount. */
function spyReleases(am) {
  const outcomes = [];
  const orig = am.releaseAccount.bind(am);
  am.releaseAccount = (lease, outcome) => { outcomes.push(outcome ?? null); return orig(lease, outcome); };
  return outcomes;
}

function assertRowUntouched(am, row, label) {
  assert.equal(row.inFlight, 0, `${label}: lease returned`);
  assert.equal(row.failedRequests || 0, 0, `${label}: failedRequests`);
  assert.equal(row.consecutiveFailures || 0, 0, `${label}: consecutiveFailures (streak)`);
  assert.equal(row.requestFaultStreak || 0, 0, `${label}: no markTransientFailure streak`);
  assert.ok(!(row.cooldownUntil > Date.now()) && !(row.softCooldownUntil > Date.now()), `${label}: no cooldown`);
  const w = am._loadSummary(row, 15 * 60_000);
  assert.equal(w.failed, 0, `${label}: last15m.failed`);
  assert.equal(w.linkFailed || 0, 0, `${label}: no link-fault load event`);
}

test('B12 direct call site: the deadline cut releases NEUTRAL with kind "deadline" and leaves the row untouched', async () => {
  const hung = http.createServer((req) => { req.resume(); /* never answers */ });
  const upPort = await listen(hung);
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000 }], 0.9);
  const outcomes = spyReleases(am);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    let status; let text;
    await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-stainless-timeout': '40' }, body: BODY,
        signal: AbortSignal.timeout(45_000),
      });
      status = r.status; text = await r.text();
    });
    assert.equal(status, 504, text.slice(0, 200));
    assert.equal(outcomes.length, 1, `exactly one release: ${JSON.stringify(outcomes)}`);
    assert.equal(outcomes[0].neutral, true, 'the call site itself passes neutral');
    assert.equal(outcomes[0].kind, 'deadline');
    assert.equal(outcomes[0].linkFault, undefined, 'a deadline is not a link fault');
    assertRowUntouched(am, am.accounts[0], 'direct');
  } finally { await close(proxy); await close(hung); }
});

test('B12 link call site: the Mac\'s own deadline cut of a cloud that never answers releases NEUTRAL, no link-fault event', async () => {
  // Cloud: answers the keyless status poll, then holds every message request open forever.
  const cloud = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [{ name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } }] }));
      return;
    }
    req.resume();
  });
  const cloudPort = await listen(cloud);
  const dead = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const deadPort = await listen(dead);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${cloudPort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const outcomes = spyReleases(am);
  const mac = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${deadPort}`, queue: { enabled: false } });
  const macPort = await listen(mac);
  try {
    let status; let text; let elapsedMs;
    const lines = await captureLog(async () => {
      const t0 = Date.now();
      const r = await fetch(`http://127.0.0.1:${macPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-stainless-timeout': '40' }, body: BODY,
        signal: AbortSignal.timeout(45_000),
      });
      status = r.status; text = await r.text(); elapsedMs = Date.now() - t0;
    });
    assert.equal(status, 504, `${status} ${text.slice(0, 200)}\n${lines.slice(-6).join('\n')}`);
    assert.equal(JSON.parse(text).error.type, 'timeout_error');
    assert.ok(elapsedMs <= 26_000, `answered inside patience − margin: ${elapsedMs}ms`);
    assert.equal(outcomes.length, 1, `exactly one release: ${JSON.stringify(outcomes)}`);
    assert.equal(outcomes[0].neutral, true);
    assert.equal(outcomes[0].kind, 'deadline');
    assert.ok(!outcomes[0].linkFault, 'not booked as a link fault');
    assert.ok(am.accounts.length >= 1, 'the Mac has its cloud mirror row');
    for (const row of am.accounts) assertRowUntouched(am, row, `link/${row.name}`);
  } finally { am.setPoolLinks([]); await close(mac); await close(dead); await close(cloud); }
});
