import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => s.close(r));
const accounts = () => Array.from({ length: 3 }, (_, i) => ({
  name: `a${i}`, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5,
}));

// THE TEST THAT WOULD HAVE CAUGHT THE HANG. A first attempt at this soak looped forever
// against a dead upstream and wedged the suite for 400s+. An unbounded soak presents to the
// user as a frozen session — strictly worse than a fast error. Termination is the contract.
test('a network soak against a permanently dead upstream TERMINATES', { timeout: 30_000 }, async () => {
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:1',              // nothing listening, ever
    queue: { enabled: true, maxWaitMs: 3000, autoMaxWaitMs: 3000, nonStreamMaxWaitMs: 3000, pollMs: 25 },
  });
  const port = await listen(proxy);
  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    const elapsed = Date.now() - started;
    assert.ok(res.status >= 400, `terminates with an error status (got ${res.status})`);
    assert.ok(elapsed < 25_000, `must not hang — took ${elapsed}ms`);
    const body = await res.json();
    assert.equal(body.error.type, 'connection_unavailable', 'still names the real cause');
  } finally {
    await close(proxy);
  }
});

test('a RECOVERING upstream is soaked through instead of failed', { timeout: 30_000 }, async () => {
  // The whole point: a brief blip must not throw away the turn.
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts++;
    if (attempts <= 2) { req.destroy(); return; }            // two resets, then healthy
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [] }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 10_000, autoMaxWaitMs: 10_000, nonStreamMaxWaitMs: 10_000, pollMs: 25 },
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 200, 'the blip was ridden out instead of killing the turn');
    assert.ok(attempts >= 3, `retried through the resets (attempts=${attempts})`);
  } finally {
    await close(proxy); await close(upstream);
  }
});

test('the non-streaming soak budget stays well under the client 300s floor', () => {
  // With no keepalive nothing resets the client's watchdog, so maxpool must give up first
  // or the user gets a silent timeout instead of our error.
  const SRC = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  const m = /const NETWORK_SOAK_NONSTREAM_MS = Math\.max\(5_000,\s*Number\(process\.env\.MAXPOOL_NETWORK_SOAK_NONSTREAM_MS\) \|\| ([0-9_]+)\)/.exec(SRC);
  assert.ok(m, 'the budget is a named constant');
  assert.ok(Number(m[1].replace(/_/g, '')) < 300_000, 'strictly under the client floor');
});

test('the soak deadline is stamped once and never reset by a re-queue', () => {
  const SRC = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(SRC, /requestInfo\.networkSoakDeadline \|\|= Date\.now\(\) \+ budgetMs/,
    'uses ||= so a re-queue cannot extend the budget — that is what made it unbounded');
});
