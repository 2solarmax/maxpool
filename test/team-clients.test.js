import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function close(server) {
  return new Promise(resolve => server.close(resolve));
}

// A tiny upstream that answers any POST /v1/messages with a 200 usage body, so a
// fully-authenticated proxy request completes and lands in getStatus().
function okUpstream() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}

const accounts = () => [
  { name: 't1', type: 'apikey', apiKey: 'k1' },
  { name: 't2', type: 'apikey', apiKey: 'k2' },
];

const msgBody = JSON.stringify({ model: 'test', messages: [] });

test('LOCAL DEFAULT unchanged: loopback caller needs NO key when legacy key is set', async () => {
  const upstream = okUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  // No `clients`, loopback host omitted → strict OFF → legacy trust model.
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: msgBody,
    });
    assert.equal(res.status, 200, 'loopback keyless must still be trusted (today\'s behavior)');
  } finally { await close(proxy); await close(upstream); }
});

test('LOCAL DEFAULT unchanged: legacy key still works for /maxpool/status', async () => {
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' } });
  const port = await listen(proxy);
  try {
    const good = await fetch(`http://127.0.0.1:${port}/maxpool/status`, { headers: { 'x-api-key': 'tc-test' } });
    assert.equal(good.status, 200);
    const bad = await fetch(`http://127.0.0.1:${port}/maxpool/status`, { headers: { 'x-api-key': 'wrong' } });
    assert.equal(bad.status, 401);
  } finally { await close(proxy); }
});

test('STRICT (clients set): keyless loopback proxy request rejected 401', async () => {
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { host: '127.0.0.1', apiKey: 'tc-test', clients: [{ name: 'max', key: 'mp-max' }] },
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: msgBody,
    });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.match(body.error.message, /pool key/i);
  } finally { await close(proxy); }
});

test('STRICT (clients set): named key authenticates AND attributes the request', async () => {
  const upstream = okUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test', clients: [{ name: 'max', key: 'mp-max' }, { name: 'ahmed', key: 'mp-ahmed' }] },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'mp-max' },
      body: msgBody,
    });
    assert.equal(res.status, 200);
    const status = await (await fetch(`http://127.0.0.1:${port}/maxpool/status`, { headers: { 'x-api-key': 'mp-max' } })).json();
    assert.equal(status.callers?.max?.requests, 1, 'request attributed to named caller max');
    assert.equal(status.callers?.ahmed, undefined);
  } finally { await close(proxy); await close(upstream); }
});

test('STRICT (clients set): legacy single key still accepted (solo user on shared host)', async () => {
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test', clients: [{ name: 'max', key: 'mp-max' }] },
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/maxpool/status`, { headers: { 'x-api-key': 'tc-test' } });
    assert.equal(res.status, 200);
  } finally { await close(proxy); }
});

test('STRICT (non-loopback host, no clients): keyless loopback rejected, named-less legacy key accepted', async () => {
  const am = new AccountManager(accounts(), 0.90);
  // host '0.0.0.0'-like non-loopback listen config forces strict even without clients.
  // Listen itself still binds 127.0.0.1 in the harness; only the CONFIG is what flips strict.
  const proxy = createProxyServer(am, { proxy: { host: '10.0.0.5', apiKey: 'tc-test' } });
  const port = await listen(proxy);
  try {
    const keyless = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: msgBody,
    });
    assert.equal(keyless.status, 401, 'non-loopback host ⇒ loopback bypass removed');
    const keyed = await fetch(`http://127.0.0.1:${port}/maxpool/status`, { headers: { 'x-api-key': 'tc-test' } });
    assert.equal(keyed.status, 200, 'legacy key still works in host-strict mode');
  } finally { await close(proxy); }
});

test('SCREEN: served keyless at /maxpool/screen; contains no account data', async () => {
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' } });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/maxpool/screen`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /Maxpool accounts/i);
    // No account names may be baked into the shell — it is static; data comes
    // only through the key-gated status endpoint at runtime.
    assert.ok(!html.includes('t1') && !html.includes('tc-test'));
  } finally { await close(proxy); }
});

test('STATUS under strict clients: wrong key AND missing key both 401', async () => {
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test', clients: [{ name: 'max', key: 'mp-max' }] },
  });
  const port = await listen(proxy);
  try {
    for (const key of ['wrong', undefined]) {
      const res = await fetch(`http://127.0.0.1:${port}/maxpool/status`, key ? { headers: { 'x-api-key': key } } : {});
      assert.equal(res.status, 401, `key=${key} must be rejected`);
    }
  } finally { await close(proxy); }
});

test('STRICT: legacy single key is attributed as "legacy-key", never anonymous (redteam 2026-10-29)', async () => {
  const upstream = okUpstream();
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test', clients: [{ name: 'max', key: 'mp-max' }] },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: msgBody,
    });
    assert.equal(res.status, 200);
    await res.text();
    const st = await (await fetch(`http://127.0.0.1:${port}/maxpool/status`, { headers: { 'x-api-key': 'mp-max' } })).json();
    assert.equal(st.callers['legacy-key']?.requests, 1);
  } finally { await close(proxy); await close(upstream); }
});


test('STRICT fails CLOSED on malformed clients entries (a typo never reverts to keyless loopback)', async () => {
  const am = new AccountManager(accounts(), 0.90);
  // key not a string → the entry is unusable, but `clients` was ASKED FOR: strict stays ON.
  const proxy = createProxyServer(am, { proxy: { clients: [{ name: 'max', key: 12345 }] } });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/maxpool/status`);
    assert.equal(res.status, 401, 'loopback keyless rejected even though no usable key exists');
  } finally { await close(proxy); }
});
