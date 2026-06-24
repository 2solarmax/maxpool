import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

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

test('temporary server 429 opens shared breaker, queues, and recovers with one probe', async () => {
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
    const startedAt = Date.now();
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, 2);
    assert.ok(Date.now() - startedAt >= 900);
    assert.deepEqual(am.accounts.map(a => a.status), ['active', 'active']);
    assert.deepEqual(am.accounts.map(a => a.failedRequests), [0, 0]);
    assert.equal(am.getStatus().upstreamThrottle.active, false);
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

test('multiple queued streaming requests all recover without rotating out of the queue', async () => {
  let attempts = 0;
  const upstream = http.createServer((req, res) => {
    attempts++;
    if (attempts === 1) {
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

    assert.equal(attempts, 4);
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
    if (attempts === 1) {
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
    if (attempts === 1) {
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
    assert.match(text, /: teamclaude queued/);
    assert.match(text, /"type":"message_delta"/);
    assert.ok(text.match(/: teamclaude queued/g).length >= 2);
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
    if (attempts === 1) {
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
    assert.match(text, /: teamclaude queued/);
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
    if (attempts === 1) {
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
    assert.match(text, /: teamclaude queued/);
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

test('weekly exhaustion does not queue by default even when reset is near', async () => {
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.accounts[0].quota.unified7d = 1;
  am.accounts[0].quota.unified7dReset = Date.now() + 150;
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
    assert.equal(res.status, 429);
    assert.ok(Date.now() - startedAt < 500);
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
      internalHeader: req.headers['x-teamclaude-zai-token'],
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
        'x-teamclaude-profile': 'all',
        'x-teamclaude-zai-token': 'zg',
        'x-teamclaude-zai-base-url': `http://127.0.0.1:${glmPort}`,
        'x-teamclaude-zai-opus-model': 'glm-opus',
        'x-teamclaude-zai-sonnet-model': 'glm-sonnet',
        'x-teamclaude-zai-haiku-model': 'glm-haiku',
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
        'x-teamclaude-profile': 'all',
        'x-teamclaude-session': 'thinking-session',
        'x-teamclaude-zai-token': 'zg',
        'x-teamclaude-zai-base-url': `http://127.0.0.1:${glmPort}`,
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
        'x-teamclaude-profile': 'all',
        'x-teamclaude-session': 'response-thinking-session',
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
        'x-teamclaude-profile': 'all',
        'x-teamclaude-zai-token': 'zg',
        'x-teamclaude-zai-base-url': `http://127.0.0.1:${zaiPort}`,
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
        'x-teamclaude-profile': 'all',
        'x-teamclaude-kimi-token': 'kk',
        'x-teamclaude-kimi-base-url': `http://127.0.0.1:${kimiPort}`,
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
        'x-teamclaude-profile': 'all',
        'x-teamclaude-kimi-token': 'kk',
        'x-teamclaude-kimi-base-url': `http://127.0.0.1:${kimiPort}`,
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
    const noKey = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`);
    assert.equal(noKey.status, 401);

    const withKey = await fetch(`http://127.0.0.1:${proxyPort}/teamclaude/status`, {
      headers: { 'x-api-key': 'tc-test' },
    });
    assert.equal(withKey.status, 200);
    const status = await withKey.json();
    assert.equal(status.scheduler.mode, 'adaptive-least-loaded');
  } finally {
    await close(proxy);
  }
});
