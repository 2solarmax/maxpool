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
    res.writeHead(200, { 'content-type': 'application/json' });
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
    assert.equal(am.accounts.some(a => a.name === 'glm-fallback'), true);
  } finally {
    await close(proxy);
    await close(claudeUpstream);
    await close(glmUpstream);
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
