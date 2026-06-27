import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, __serverTest } from '../src/server.js';

const { unavailableMessage, isRetriableUpstreamStatus, ensureQueueHeartbeat, clearQueueHeartbeat } = __serverTest;

test('bug (ghost-leak): heartbeat reap releases the queue slot+bytes when the held client write throws EPIPE', async () => {
  // Binding test for reapDead: the heartbeat is the liveness probe. When the
  // held client's socket is gone, res.write throws and the reap MUST release the
  // queue slot + bytes via removeQueuedRequest — else a dead ticket squats the
  // queue for up to streamHoldMaxMs (7d), exhausting backpressure → "queue full".
  // (The independent res.once('close') path does NOT cover the write-throw/tick-
  // before-close window — only reapDead does, so this neuters green without it.)
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  const requestInfo = { stream: true, sessionKey: 'S' };
  // A real ticket occupying the queue (slot + bytes).
  am.registerQueuedRequest(requestInfo, { sessionKey: 'S', bytes: 4242, res: { destroyed: false, writableEnded: false } });
  assert.equal(am.queueState.waiting.length, 1, 'ticket queued');
  assert.equal(am.queueState.bytes, 4242, 'bytes accounted');

  // A live-looking res whose write throws (EPIPE) on the heartbeat tick — the
  // client vanished without the socket flipping destroyed/writableEnded first.
  let headersSent = false;
  const res = {
    get headersSent() { return headersSent; },
    writeHead() { headersSent = true; },
    flushHeaders() {},
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      if (chunk.includes('maxpool queued') && headersSent && this._ticked) {
        const e = new Error('write EPIPE'); e.code = 'EPIPE'; throw e;
      }
      this._ticked = true;
    },
  };

  ensureQueueHeartbeat(res, requestInfo, { heartbeatMs: 1000 }, am);
  // Heartbeat floors to 1000ms; wait for one tick (which throws) → reap.
  await new Promise(r => setTimeout(r, 1300));

  assert.equal(am.queueState.waiting.length, 0, 'reap released the queue slot');
  assert.equal(am.queueState.bytes, 0, 'reap released the queued bytes');
  assert.equal(requestInfo.queueHeartbeatActive, false, 'heartbeat timer cleared by reap');
  clearQueueHeartbeat(requestInfo);
});

test('unavailableMessage tells the truth when no account will recover soon', () => {
  const am = { accounts: [{}, {}], _requiresAnthropicThinkingIntegrity: () => false };

  // Recoverable soon -> a retry hint is honest.
  assert.match(unavailableMessage(am, {}, 60, true), /Retry in 60s/);

  // Not recoverable soon (every account at its 5h/weekly limit) -> no fake retry.
  const exhausted = unavailableMessage(am, {}, 60, false);
  assert.match(exhausted, /at their 5h or weekly limit/);
  assert.doesNotMatch(exhausted, /Retry in 60s/);
  assert.doesNotMatch(exhausted, /accounts exhausted\. Retry/);
});

test('500 is treated as a retriable upstream status', () => {
  assert.equal(isRetriableUpstreamStatus(500), true);
  assert.equal(isRetriableUpstreamStatus(529), true);
  assert.equal(isRetriableUpstreamStatus(400), false);
  assert.equal(isRetriableUpstreamStatus(200), false);
});

function listen(server, host = '127.0.0.1') {
  return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function accounts() {
  return [
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'a2', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ];
}

test('429 on one account fails over to another before sending response bytes', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t1') {
      res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 1024 * 1024 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
    assert.equal(am.accounts[0].status, 'throttled');
    assert.equal(am.accounts[0].inFlight, 0);
    assert.equal(am.accounts[1].inFlight, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('temporary server 429 fails over before opening shared breaker', async () => {
  const seen = [];
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    attempts++;
    if (attempts === 1) {
      res.writeHead(429, {
        'retry-after': '1',
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'allowed',
      });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Server is temporarily limiting requests (not your usage limit)',
        },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 3000, pollMs: 20 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 2);
    assert.ok(am.accounts[0].provisionalUpstreamUntil > Date.now());
    assert.deepEqual(am.accounts.map(a => a.status), ['active', 'active']);
    assert.deepEqual(am.accounts.map(a => a.failedRequests), [0, 0]);
    assert.equal(am.getStatus().upstreamThrottle.active, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('Anthropic 529 fails over to another Claude account before opening shared breaker', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t1') {
      res.writeHead(529, { 'retry-after': '10', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded' },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 3000, pollMs: 20, heartbeatMs: 50 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /message_delta/);
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
    assert.ok(am.accounts[0].provisionalUpstreamUntil > Date.now());
    assert.equal(am.accounts[0].lastError, 'upstream_throttled');
    assert.equal(am.accounts[1].provisionalUpstreamUntil, null);
    assert.equal(am.getStatus().upstreamThrottle.active, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('Anthropic 500 fails over to another Claude account instead of passing through', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t1') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'Internal server error' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 3000, pollMs: 20, heartbeatMs: 50 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /message_delta/);
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
    assert.ok(am.accounts[0].cooldownUntil > Date.now());
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('matching Anthropic 529s from two Claude accounts promote to shared breaker', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(529, { 'retry-after': '10', 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: 'Overloaded incident 12345' },
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: false },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 529);
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
    assert.equal(am.getStatus().upstreamThrottle.active, true);
    assert.deepEqual(am.accounts.map(a => a.cooldownUntil), [null, null]);
    assert.deepEqual(am.accounts.map(a => a.lastError), [null, null]);
    assert.deepEqual(am.accounts.map(a => a.failedRequests), [0, 0]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('Anthropic 529s keep failing over when another Claude account can succeed', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization !== 'Bearer t3') {
      res.writeHead(529, { 'retry-after': '10', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Overloaded incident 12345' },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    ...accounts(),
    { name: 'a3', type: 'oauth', accessToken: 't3', refreshToken: 'r3', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: false },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2', 'Bearer t3']);
    assert.equal(am.getStatus().upstreamThrottle.active, false);
    assert.deepEqual(am.accounts.map(a => a.failedRequests), [0, 0, 0]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('different Anthropic 529 fingerprints remain account-scoped', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    const suffix = req.headers.authorization === 'Bearer t1' ? 'alpha' : 'beta';
    res.writeHead(529, { 'retry-after': '10', 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'overloaded_error', message: `Overloaded ${suffix}` },
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: false },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 529);
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
    assert.equal(am.getStatus().upstreamThrottle.active, false);
    assert.ok(am.accounts.every(account => account.provisionalUpstreamUntil > Date.now()));
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('provider 529 remains provider-scoped and fails over', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer provider-token') {
      res.writeHead(529, { 'retry-after': '10', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'overloaded_error', message: 'Provider overloaded' },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    {
      name: 'provider',
      type: 'provider',
      provider: 'zai',
      apiKey: 'provider-token',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      profiles: ['all'],
      priority: 0,
    },
    {
      name: 'provider-2',
      type: 'provider',
      provider: 'kimi',
      apiKey: 'provider-token-2',
      upstream: `http://127.0.0.1:${upstreamPort}`,
      profiles: ['all'],
      priority: 1,
    },
  ], 0.90, { cooldownMs: 100, maxCooldownMs: 100 });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: false },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-maxpool-profile': 'all',
      },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['Bearer provider-token', 'Bearer provider-token-2']);
    assert.equal(am.getStatus().upstreamThrottle.active, false);
    assert.ok(am.accounts[0].cooldownUntil > Date.now());
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('multiple queued streaming requests all recover without rotating out of the queue', async () => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts++;
    if (attempts <= 2) {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Server is temporarily limiting requests (not your usage limit)',
        },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: {"type":"message_delta","attempt":${attempts}}\n\n`);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 5000, pollMs: 20, heartbeatMs: 50 },
  });
  const proxyPort = await listen(proxy);

  try {
    const request = () => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
      signal: AbortSignal.timeout(6000),
    }).then(res => res.text());
    const first = request();
    await new Promise(resolve => setTimeout(resolve, 100));
    const second = request();
    const third = request();
    const bodies = await Promise.all([first, second, third]);

    assert.equal(attempts, 5);
    for (const body of bodies) {
      assert.match(body, /"type":"message_delta"/);
      assert.doesNotMatch(body, /event: error/);
    }
    assert.equal(am.getStatus().upstreamThrottle.queued, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('successful streaming probe clears breaker on response acceptance before stream end', async () => {
  let attempts = 0;
  let finishStream;
  const upstream = http.createServer((req, res) => {
    attempts++;
    if (attempts <= 2) {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Server is temporarily limiting requests (not your usage limit)',
        },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"message_start"}\n\n');
    finishStream = () => res.end('data: {"type":"message_stop"}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 5000, pollMs: 20, heartbeatMs: 50 },
  });
  const proxyPort = await listen(proxy);

  try {
    const responsePromise = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    assert.equal(am.getStatus().upstreamThrottle.active, false);
    assert.equal(am.getStatus().upstreamThrottle.probeInFlight, false);
    finishStream();
    const res = await responsePromise;
    assert.match(await res.text(), /message_stop/);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('matching ambiguous 429s promote to shared throttle without poisoning all accounts', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message: 'Request pressure incident 12345' },
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: false },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 429);
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
    assert.equal(am.getStatus().upstreamThrottle.active, true);
    assert.deepEqual(am.accounts.map(a => a.status), ['active', 'active']);
    assert.deepEqual(am.accounts.map(a => a.rateLimitedUntil), [null, null]);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('queued streaming request receives heartbeats and then the recovered upstream stream', async () => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts++;
    if (attempts <= 2) {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Server is temporarily limiting requests (not your usage limit)',
        },
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 3000, pollMs: 20, heartbeatMs: 50 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /: maxpool queued/);
    assert.match(text, /"type":"message_delta"/);
    assert.ok(text.match(/: maxpool queued/g).length >= 2);
    assert.equal(am.getStatus().upstreamThrottle.active, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('queued streaming request terminates with SSE error when recovery returns 400', async () => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts++;
    if (attempts <= 2) {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Server is temporarily limiting requests (not your usage limit)',
        },
      }));
      return;
    }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: { type: 'invalid_request_error', message: 'bad request' },
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 3000, pollMs: 20, heartbeatMs: 50 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
      signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    assert.match(text, /: maxpool queued/);
    assert.match(text, /event: error/);
    assert.match(text, /invalid_request_error/);
    assert.equal(am.getStatus().upstreamThrottle.probeInFlight, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('queued streaming request terminates with SSE error when recovery connection fails', async () => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts++;
    if (attempts <= 2) {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Server is temporarily limiting requests (not your usage limit)',
        },
      }));
      return;
    }
    req.socket.destroy();
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 3000, pollMs: 20, heartbeatMs: 50 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
      signal: AbortSignal.timeout(4000),
    });
    const text = await res.text();
    assert.match(text, /: maxpool queued/);
    assert.match(text, /event: error/);
    assert.match(text, /connection_unavailable/);
    assert.equal(am.getStatus().upstreamThrottle.probeInFlight, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('disconnecting a queued client removes it from queue telemetry', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, { 'retry-after': '2', 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Server is temporarily limiting requests (not your usage limit)',
      },
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 3000, pollMs: 20, heartbeatMs: 50 },
  });
  const proxyPort = await listen(proxy);

  try {
    const disconnected = new Promise((resolve, reject) => {
      const clientReq = http.request({
        host: '127.0.0.1',
        port: proxyPort,
        path: '/v1/messages',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, clientRes => {
        clientRes.once('data', () => {
          try {
            assert.equal(am.getStatus().upstreamThrottle.queued, 1);
            clientReq.destroy();
            clientRes.destroy();
            resolve();
          } catch (error) {
            reject(error);
          }
        });
      });
      clientReq.on('error', error => {
        if (error.code !== 'ECONNRESET') reject(error);
      });
      clientReq.end(JSON.stringify({ model: 'test', stream: true, messages: [] }));
    });
    await disconnected;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(am.getStatus().upstreamThrottle.queued, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('explicit quota exhaustion overrides temporary-limit wording', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: 'Weekly quota exhausted while server is temporarily limiting requests',
      },
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: false },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 429);
    assert.equal(am.getStatus().upstreamThrottle.active, false);
    assert.deepEqual(am.accounts.map(a => a.status), ['throttled', 'throttled']);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('streaming response is not committed until first upstream chunk is available', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t1') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.destroy();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('429 does not retry buffered bodies larger than configured retry limit', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 10 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ content: 'this body is intentionally over ten bytes' }] }),
    });
    assert.equal(res.status, 429);
    assert.deepEqual(seen, ['Bearer t1']);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('request queues instead of returning 429 when all routes are temporarily unavailable', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 150;
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 2000, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['Bearer t1']);
    assert.ok(Date.now() - startedAt >= 100);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('request queues while an expired OAuth token recovers from temporary refresh failure', async () => {
  let refreshAttempts = 0;
  const refreshAccessToken = async () => {
    refreshAttempts++;
    if (refreshAttempts === 1) {
      const error = new Error('Token refresh failed (429)');
      error.status = 429;
      error.retryable = true;
      throw error;
    }
    return { accessToken: 'fresh-token', refreshToken: 'fresh-refresh', expiresAt: Date.now() + 3600_000 };
  };
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 'expired', refreshToken: 'r1', expiresAt: Date.now() - 1000 },
  ], 0.90, { cooldownMs: 20, maxCooldownMs: 20 }, { refreshAccessToken });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 2000, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['Bearer fresh-token']);
    assert.equal(refreshAttempts, 2);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('large request can queue before upstream send even when it is too large for retry', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    seen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 150;
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 10 },
    queue: { enabled: true, maxWaitMs: 2000, maxQueuedBodyBytes: 2048, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ content: 'this body is intentionally over ten bytes' }] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['Bearer t1']);
    assert.ok(Date.now() - startedAt >= 100);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('request does not queue when reset is beyond auto queue window', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 10 * 60_000;
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 60 * 60_000, autoMaxWaitMs: 100, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 429);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('capacity failures use capacity queue window instead of long quota window', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90, { cooldownMs: 150, maxCooldownMs: 150 });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 2000, capacityMaxWaitMs: 50, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 503);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('weekly exhaustion queues and recovers when the reset is near (was a fail-fast bug)', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].quota.unified7d = 1;
  am.accounts[0].quota.unified7dReset = Date.now() + 200;
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    // weeklyMaxWaitMs now defaults to 24h, so a near weekly reset is waited out.
    queue: { enabled: true, maxWaitMs: 5000, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    const elapsed = Date.now() - startedAt;
    assert.equal(res.status, 200);              // it waited for the reset, didn't kill the session
    assert.ok(elapsed >= 150, `expected a wait for the weekly reset, got ${elapsed}ms`);
    assert.ok(elapsed < 5000, `should recover well inside the window, got ${elapsed}ms`);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('weekly exhaustion with reset FAR beyond the window errors promptly (no pointless spin)', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].quota.unified7d = 1;
  am.accounts[0].quota.unified7dReset = Date.now() + 3 * 24 * 60 * 60 * 1000; // 3 days out
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 2000, weeklyMaxWaitMs: 2000, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 429);                 // nothing recovers in the window → honest prompt error
    assert.ok(Date.now() - startedAt < 800, 'should not spin');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('weekly exhaustion with UNKNOWN reset errors honestly, does not wait forever', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].quota.unified7d = 1;
  am.accounts[0].quota.unified7dReset = null; // reset time unknown (cold start)
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 5000, weeklyMaxWaitMs: 5000, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 429);
    assert.ok(Date.now() - startedAt < 800, 'must not wait forever on an unknown reset');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('network failures return connection unavailable instead of quota exhaustion', async () => {
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:1',
    queue: { enabled: true, maxWaitMs: 2000, autoMaxWaitMs: 2000, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.error.type, 'connection_unavailable');
    assert.match(body.error.message, /not an account quota issue/i);
  } finally {
    await close(proxy);
  }
});

test('nonretryable 400 is recorded as failure and passed through', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: 'messages.41.content.0: Invalid `signature` in `thinking` block',
      },
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 2000, pollMs: 25 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error.message, /Invalid `signature`/);
    assert.equal(am.accounts[0].failedRequests, 1);
    assert.equal(am.accounts[0].lastError, 'invalid_thinking_signature');
    assert.equal(am.accounts[1].usage.totalRequests, 0);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('all profile adds runtime GLM fallback and rewrites provider request', async () => {
  const claudeSeen = [];
  const glmSeen = [];

  const claudeUpstream = http.createServer((req, res) => {
    claudeSeen.push(req.headers.authorization);
    res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const glmUpstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    glmSeen.push({
      auth: req.headers.authorization,
      internalHeader: req.headers['x-maxpool-zai-token'],
      beta: req.headers['anthropic-beta'],
      body: JSON.parse(Buffer.concat(chunks).toString()),
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-ratelimit-limit': '100',
      'x-ratelimit-remaining': '99',
      'x-ratelimit-reset': '60',
    });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const claudePort = await listen(claudeUpstream);
  const glmPort = await listen(glmUpstream);
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${claudePort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-beta': 'test-beta',
        'x-maxpool-profile': 'all',
        'x-maxpool-zai-token': 'zg',
        'x-maxpool-zai-base-url': `http://127.0.0.1:${glmPort}`,
        'x-maxpool-zai-opus-model': 'glm-opus',
        'x-maxpool-zai-sonnet-model': 'glm-sonnet',
        'x-maxpool-zai-haiku-model': 'glm-haiku',
      },
      body: JSON.stringify({ model: 'claude-sonnet-test', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(claudeSeen, ['Bearer tc']);
    assert.equal(glmSeen.length, 1);
    assert.equal(glmSeen[0].auth, 'Bearer zg');
    assert.equal(glmSeen[0].internalHeader, undefined);
    assert.equal(glmSeen[0].beta, undefined);
    assert.equal(glmSeen[0].body.model, 'glm-sonnet');
    const glmAccount = am.accounts.find(a => a.name === 'glm-fallback');
    assert.ok(glmAccount);
    assert.equal(glmAccount.completedRequests, 1);
    assert.equal(glmAccount.lastStatus, 200);
    assert.ok(glmAccount.lastResponseMs >= 0);
    assert.equal(glmAccount.quota.genericLimit, 100);
    assert.equal(glmAccount.quota.genericRemaining, 99);
  } finally {
    await close(proxy);
    await close(claudeUpstream);
    await close(glmUpstream);
  }
});

test('thinking history disables provider fallback in all profile', async () => {
  const claudeSeen = [];
  const glmSeen = [];

  const claudeUpstream = http.createServer((req, res) => {
    claudeSeen.push(req.headers.authorization);
    res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
  });
  const glmUpstream = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    glmSeen.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const claudePort = await listen(claudeUpstream);
  const glmPort = await listen(glmUpstream);
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${claudePort}`,
    queue: { enabled: false },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-maxpool-profile': 'all',
        'x-maxpool-session': 'thinking-session',
        'x-maxpool-zai-token': 'zg',
        'x-maxpool-zai-base-url': `http://127.0.0.1:${glmPort}`,
      },
      body: JSON.stringify({
        model: 'claude-sonnet-test',
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'summary', signature: 'signed-by-anthropic' },
              { type: 'text', text: 'done' },
            ],
          },
          { role: 'user', content: 'continue' },
        ],
      }),
    });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.match(body.error.message, /Non-Claude fallback is disabled/i);
    assert.deepEqual(claudeSeen, ['Bearer tc']);
    assert.deepEqual(glmSeen, []);
    assert.equal(am.getStatus().sessions.thinkingProtected, 1);
  } finally {
    await close(proxy);
    await close(claudeUpstream);
    await close(glmUpstream);
  }
});

test('Claude thinking response marks session as provider-protected', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      content: [
        { type: 'thinking', thinking: 'summary', signature: 'signed-by-anthropic' },
        { type: 'text', text: 'done' },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-maxpool-profile': 'all',
        'x-maxpool-session': 'response-thinking-session',
      },
      body: JSON.stringify({ model: 'claude-sonnet-test', messages: [{ role: 'user', content: 'think' }] }),
    });
    assert.equal(res.status, 200);
    assert.equal(am.getStatus().sessions.thinkingProtected, 1);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('Z.AI 429 body reset hint controls provider cooldown when retry-after is missing', async () => {
  const resetAt = new Date(Date.now() + 120_000).toISOString();
  const zaiUpstream = http.createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        code: '1310',
        message: `Weekly/Monthly Limit Exhausted. Your limit will reset at ${resetAt}`,
      },
    }));
  });
  const zaiPort = await listen(zaiUpstream);
  const am = new AccountManager([], 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:1',
    queue: { enabled: false },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-maxpool-profile': 'all',
        'x-maxpool-zai-token': 'zg',
        'x-maxpool-zai-base-url': `http://127.0.0.1:${zaiPort}`,
      },
      body: JSON.stringify({ model: 'claude-sonnet-test', messages: [] }),
    });
    assert.equal(res.status, 429);
    const account = am.accounts.find(a => a.name === 'glm-fallback');
    assert.ok(account.rateLimitedUntil - Date.now() > 90_000);
    assert.equal(account.failedRequests, 1);
    assert.equal(account.lastStatus, 429);
    assert.equal(account.lastError, 'rate_limited');
    assert.equal(account.loadEvents.at(-1).success, false);
    assert.equal(account.loadEvents.at(-1).status, 429);
  } finally {
    await close(proxy);
    await close(zaiUpstream);
  }
});

test('Kimi 429 body wait hint controls provider cooldown when retry-after is missing', async () => {
  const kimiUpstream = http.createServer((_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'rate_limit_reached_error',
        message: 'Your account org<ak> request reached organization max RPM: 20, please try again after 75 seconds',
      },
    }));
  });
  const kimiPort = await listen(kimiUpstream);
  const am = new AccountManager([], 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:1',
    queue: { enabled: false },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-maxpool-profile': 'all',
        'x-maxpool-kimi-token': 'kk',
        'x-maxpool-kimi-base-url': `http://127.0.0.1:${kimiPort}`,
      },
      body: JSON.stringify({ model: 'claude-sonnet-test', messages: [] }),
    });
    assert.equal(res.status, 429);
    const account = am.accounts.find(a => a.name === 'kimi-fallback');
    assert.ok(account.rateLimitedUntil - Date.now() > 60_000);
    assert.ok(account.rateLimitedUntil - Date.now() < 90_000);
  } finally {
    await close(proxy);
    await close(kimiUpstream);
  }
});

test('provider 403 disables fallback and is not counted as success', async () => {
  const kimiUpstream = http.createServer((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        type: 'permission_error',
        message: 'forbidden',
      },
    }));
  });
  const kimiPort = await listen(kimiUpstream);
  const am = new AccountManager([], 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:1',
    queue: { enabled: false },
    retry: { maxAttemptsPerRequest: 2 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-maxpool-profile': 'all',
        'x-maxpool-kimi-token': 'kk',
        'x-maxpool-kimi-base-url': `http://127.0.0.1:${kimiPort}`,
      },
      body: JSON.stringify({ model: 'claude-sonnet-test', messages: [] }),
    });
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error.type, 'provider_auth_error');

    const account = am.accounts.find(a => a.name === 'kimi-fallback');
    assert.equal(account.status, 'error');
    assert.equal(account.lastError, 'forbidden');
    assert.equal(account.completedRequests, 0);
    assert.equal(account.failedRequests, 1);
    assert.equal(account.lastStatus, 403);
  } finally {
    await close(proxy);
    await close(kimiUpstream);
  }
});

test('status endpoint requires proxy api key even from loopback', async () => {
  const am = new AccountManager(accounts(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: 'http://127.0.0.1:1',
  });
  const proxyPort = await listen(proxy);

  try {
    const noKey = await fetch(`http://127.0.0.1:${proxyPort}/maxpool/status`);
    assert.equal(noKey.status, 401);

    const withKey = await fetch(`http://127.0.0.1:${proxyPort}/maxpool/status`, {
      headers: { 'x-api-key': 'tc-test' },
    });
    assert.equal(withKey.status, 200);
    const status = await withKey.json();
    assert.equal(status.scheduler.mode, 'adaptive-least-loaded');
  } finally {
    await close(proxy);
  }
});

test('headerValue falls back to legacy x-teamclaude-* names (backward compat)', () => {
  const { headerValue, getMaxpoolProfile } = __serverTest;
  // New name present → used.
  assert.equal(headerValue({ 'x-maxpool-zai-token': 'new' }, 'x-maxpool-zai-token'), 'new');
  // Only legacy name present → falls back.
  assert.equal(headerValue({ 'x-teamclaude-zai-token': 'old' }, 'x-maxpool-zai-token'), 'old');
  // New name wins when both present.
  assert.equal(headerValue({ 'x-maxpool-zai-token': 'new', 'x-teamclaude-zai-token': 'old' }, 'x-maxpool-zai-token'), 'new');
  // Profile from a legacy session still resolves to 'all'.
  assert.equal(getMaxpoolProfile({ 'x-teamclaude-profile': 'all' }), 'all');
  // Non-maxpool header names do not get a legacy fallback.
  assert.equal(headerValue({ 'x-teamclaude-other': 'x' }, 'x-other'), '');
});

test('bug A: resumed stream has NO heartbeat comment interleaved between real events', async () => {
  // Real red-green for the clear-before-forward fix (server.js, resume path).
  // ensureQueueHeartbeat floors heartbeatMs to 1000ms (Math.max(1000, ...)), so
  // the timer only ticks mid-stream when the upstream's inter-event gap exceeds
  // ~1s. The upstream below spaces message_delta 1300ms after message_start, so a
  // surviving heartbeat WOULD inject `: maxpool queued` between them. With the fix
  // the heartbeat is stopped at resume → clean stream. (Verified RED on the
  // pre-fix code, GREEN here — this defeats the old tautological 240ms test.)
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"message_start"}\n\n');
    setTimeout(() => res.write('data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n'), 1300);
    setTimeout(() => res.end('data: {"type":"message_stop"}\n\n'), 2600);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  // Only account is briefly throttled → the streaming request must QUEUE first
  // (heartbeat fires), then recover and RESUME onto the committed SSE stream.
  am.accounts[0].status = 'throttled';
  am.accounts[0].lastError = 'rate_limited';
  am.accounts[0].rateLimitedUntil = Date.now() + 150;
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 5000, pollMs: 20, heartbeatMs: 1000 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /message_stop/, 'the resumed stream completed');
    // Heartbeat comments may appear BEFORE the first real event (while queued),
    // but NEVER after — interleaving mid-stream is the corruption bug.
    const after = body.slice(body.indexOf('data:'));
    assert.ok(!after.includes(': maxpool queued'),
      'no heartbeat comment interleaved into the live SSE body after the first event');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('major: a concurrency-cap hold is bounded by the capacity window, not the 7d streaming hold', async () => {
  // A streaming request blocked only by a SATURATED concurrency cap must shed load
  // within the short capacity window — never spin a queue slot for the multi-day
  // streaming hold (the soft-deadlock guard). Here the only account is pinned at its
  // cap and never frees, so the request must give up promptly with an SSE error.
  const upstream = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {}\n\n'); });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].inFlight = am.scheduler.safetyMaxActivePerAccount; // pinned at the cap, never frees
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 7 * 24 * 3600 * 1000, streamHoldMaxMs: 7 * 24 * 3600 * 1000, capacityMaxWaitMs: 300, pollMs: 50, heartbeatMs: 1000 },
  });
  const proxyPort = await listen(proxy);

  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
      signal: AbortSignal.timeout(5000),
    });
    const body = await res.text();
    const elapsed = Date.now() - started;
    // The decisive signal: the request RESOLVES bounded (vs hanging until the 7d
    // streamHoldMaxMs deadline, which would trip the 5s client timeout → throw).
    assert.ok(elapsed < 3000, `concurrency-cap hold bounded by the capacity window (${elapsed}ms), not the 7d streaming hold`);
    assert.equal(res.status, 429, 'shed load with a rate-limit error, not an indefinite hold');
    assert.match(body, /Retry in|rate_limit|error/i, 'gave up with an error response');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('major (lease): client disconnect during the resumed pre-stream window releases the account lease', async () => {
  // A resumed forward acquires a lease (inFlight++) then awaits the upstream. If
  // the client disconnects during that pre-first-byte window, the lease must be
  // released promptly (abort the fetch), NOT pinned until the upstream resolves on
  // its own (~undici timeout) — which would bench the scarce account it targets.
  let upstreamReqs = 0;
  const upstream = http.createServer((_req, res) => {
    upstreamReqs++;
    // Hold the response open well past the client's disconnect.
    setTimeout(() => { try { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: {}\n\n'); } catch { /* client gone */ } }, 3000);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].status = 'throttled';
  am.accounts[0].lastError = 'rate_limited';
  am.accounts[0].rateLimitedUntil = Date.now() + 100;
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 8000, pollMs: 20, heartbeatMs: 1000 },
  });
  const proxyPort = await listen(proxy);

  try {
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
      signal: ac.signal,
    }).catch(() => {});
    // Let it queue, resume, acquire the lease, and enter the slow upstream fetch.
    await new Promise(r => setTimeout(r, 600));
    assert.ok(upstreamReqs >= 1, 'request resumed and reached the upstream (lease acquired)');
    ac.abort();                       // client disconnects mid-fetch
    await p;
    await new Promise(r => setTimeout(r, 500));
    assert.equal(am.accounts[0].inFlight, 0, 'lease released on client disconnect — inFlight not pinned by the 3s upstream');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('minor: a non-streaming resumed response is framed as an SSE error, not a raw data blob', async () => {
  // After the heartbeat committed 200 text/event-stream, the resumed upstream
  // returns a NON-streaming JSON body. It must be emitted as a proper SSE
  // `event: error` (parseable), never a lone `data: {raw json}` that corrupts the
  // client's SSE state machine (no message_start envelope).
  let attempts = 0;
  const upstream = http.createServer((_req, res) => {
    attempts++;
    if (attempts === 1) {
      res.writeHead(429, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }));
      return;
    }
    // Non-streaming JSON body for a stream request (an upstream contract quirk).
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].status = 'throttled';
  am.accounts[0].lastError = 'rate_limited';
  am.accounts[0].rateLimitedUntil = Date.now() + 120;
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 8000, pollMs: 20, heartbeatMs: 1000, capacityMaxWaitMs: 8000 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
      signal: AbortSignal.timeout(7000),
    });
    const body = await res.text();
    const after = body.slice(body.indexOf('data:') >= 0 ? body.indexOf('data:') : 0);
    assert.match(body, /event: error/, 'non-streaming resume framed as a proper SSE error event');
    // The raw upstream JSON must NOT appear as a bare data line (would corrupt the parser).
    assert.ok(!/data: \{"type":"message"/.test(body), 'raw non-SSE JSON not written as a lone data blob');
    void after;
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('major: a post-resume failover RE-HOLDS the session instead of dropping it', async () => {
  // The feature's core promise: a held stream that resumes onto a freed account,
  // and that account 529s on the very first forwarded request, must be RE-HELD
  // (the heartbeat stays alive through the failover) and ultimately complete on
  // another account — NOT terminate abruptly. Pre-fix, clearQueueHeartbeat ran
  // before forwardRequest, so the post-529 queueAndRetry guard
  // (`headersSent && !heartbeatActive`) bailed and the session was dropped.
  let attempts = 0;
  const upstream = http.createServer((_req, res) => {
    attempts++;
    if (attempts === 1) {
      // First forwarded request (the resume) overloads → must re-hold, not drop.
      res.writeHead(529, { 'retry-after': '1', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: {"type":"message_start"}\n\ndata: {"type":"message_stop"}\n\n');
  });
  const upstreamPort = await listen(upstream);
  // Two accounts: both briefly throttled so the request queues+holds first; when
  // they free, the resume hits account-1's 529, re-holds, then completes on the
  // other account.
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'a2', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  for (const a of am.accounts) {
    a.status = 'throttled';
    a.lastError = 'rate_limited';
    a.rateLimitedUntil = Date.now() + 120;
  }
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: true, maxWaitMs: 8000, pollMs: 20, heartbeatMs: 1000, capacityMaxWaitMs: 8000 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }),
      signal: AbortSignal.timeout(7000),
    });
    assert.equal(res.status, 200);
    const body = await res.text();
    // Re-held and completed on the retry, NOT dropped after the 529.
    assert.match(body, /message_stop/, 'session re-held after the post-resume 529 and completed');
    assert.ok(!/overloaded_error/.test(body.slice(body.indexOf('data:') >= 0 ? body.indexOf('data:') : 0)) || /message_stop/.test(body),
      'did not terminate on the 529');
    assert.ok(attempts >= 2, 'the request was actually retried (re-held), not dropped on the first 529');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('describeRequest marks bodyThinkingScanned only on a fully-scanned body (migration fail-closed)', () => {
  const { describeRequest } = __serverTest;
  const req = { method: 'POST', url: '/v1/messages' };
  // Plain JSON, no thinking → scanned + safe to migrate.
  const plain = describeRequest(req, Buffer.from(JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] })));
  assert.equal(plain.bodyThinkingScanned, true);
  assert.notEqual(plain.requiresAnthropicThinkingIntegrity, true);
  // Body carrying a signed thinking block → scanned but NOT migration-safe.
  const thinking = describeRequest(req, Buffer.from(JSON.stringify({ model: 'x', messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '…', signature: 'sig' }] }] })));
  assert.equal(thinking.bodyThinkingScanned, true);
  assert.equal(thinking.requiresAnthropicThinkingIntegrity, true);
  // Non-JSON body → NOT scanned → fails closed (never migrates).
  const garbage = describeRequest(req, Buffer.from('not json at all'));
  assert.notEqual(garbage.bodyThinkingScanned, true);
});
