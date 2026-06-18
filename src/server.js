import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
const TEAMCLAUDE_HEADER_PREFIX = 'x-teamclaude-';

const DEFAULT_RETRY = {
  maxAttemptsPerRequest: 0,
  maxRetryBufferBytes: 10 * 1024 * 1024,
};

const DEFAULT_QUEUE = {
  enabled: true,
  maxWaitMs: 6 * 60 * 60 * 1000,
  autoMaxWaitMs: 5 * 60 * 1000,
  pollMs: 1000,
};

export function createProxyServer(accountManager, config, hooks = {}) {
  const upstream = config.upstream || 'https://api.anthropic.com';
  const proxyApiKey = config.proxy?.apiKey;
  const logDir = config.logDir || null;
  let requestCounter = 0;

  if (logDir) {
    mkdir(logDir, { recursive: true }).catch(() => {});
  }

  const server = http.createServer(async (req, res) => {
    try {
      // Auth check — skip for localhost connections
      const clientKey = req.headers['x-api-key'];
      const remoteAddr = req.socket.remoteAddress;
      const isLocal = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';

      // Status exposes account names and quota state, so require the local
      // proxy key even for loopback callers.
      if (req.method === 'GET' && req.url === '/teamclaude/status') {
        if (proxyApiKey && clientKey !== proxyApiKey) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'Invalid proxy API key' },
          }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(accountManager.getStatus(), null, 2));
        return;
      }

      if (proxyApiKey && clientKey !== proxyApiKey && !isLocal) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'authentication_error', message: 'Invalid proxy API key' },
        }));
        return;
      }

      // Let client token refresh requests pass through to upstream untouched.
      // The proxy manages its own tokens via ensureTokenFresh(); intercepting
      // or rewriting client refreshes would cause token rotation conflicts.
      if (req.method === 'POST' && req.url === '/v1/oauth/token') {
        await relayRaw(req, res, upstream);
        return;
      }

      // Track request
      const reqId = ++requestCounter;
      hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });

      // Buffer request body (needed for retry on 429)
      const bodyChunks = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk);
      }
      const body = Buffer.concat(bodyChunks);
      const retryConfig = { ...DEFAULT_RETRY, ...(config.retry || {}) };
      const queueConfig = { ...DEFAULT_QUEUE, ...(config.queue || {}) };
      const canRetryBufferedBody = body.length <= retryConfig.maxRetryBufferBytes;
      const requestInfo = describeRequest(req, body);
      requestInfo.profile = getTeamClaudeProfile(req.headers);
      requestInfo.sessionKey = headerValue(req.headers, 'x-teamclaude-session');
      prepareRuntimeProviders(accountManager, req.headers);

      const ctx = { account: null, status: null };
      try {
        await forwardRequest(
          req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, new Set(),
        );
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[TeamClaude] Unhandled error:', err);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'proxy_error', message: 'Internal proxy error' },
          }));
        }
      } finally {
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error('[TeamClaude] Unhandled error:', err);
    }
  });

  return server;
}

/**
 * Relay a request to upstream with no header rewriting — pure passthrough.
 */
async function relayRaw(req, res, upstream) {
  const bodyChunks = [];
  for await (const chunk of req) bodyChunks.push(chunk);
  const body = Buffer.concat(bodyChunks);

  try {
    const upstreamRes = await fetch(`${upstream}${req.url}`, {
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || 'application/json',
        'user-agent': req.headers['user-agent'] || 'node',
      },
      body: body.length > 0 ? body : undefined,
    });

    const responseBody = await upstreamRes.text();
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      responseHeaders[key] = value;
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    res.end(responseBody);
  } catch (err) {
    console.error('[TeamClaude] Raw relay error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'Upstream unreachable' } }));
    }
  }
}


function logTimestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

async function writeRequestLog(logDir, reqId, sections) {
  if (!logDir) return;
  const ts = logTimestamp();
  const filename = `${ts}_${String(reqId).padStart(5, '0')}.log`;
  try {
    await writeFile(join(logDir, filename), sections.join('\n\n'), 'utf-8');
  } catch (err) {
    console.error(`[TeamClaude] Failed to write log: ${err.message}`);
  }
}

function formatHeaders(headers) {
  if (headers.entries) {
    return [...headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join('\n');
  }
  return Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n');
}

async function forwardRequest(
  req, res, body, accountManager, upstream, retryCount, hooks, reqId, ctx, logDir,
  retryConfig, queueConfig, requestInfo, canRetryBufferedBody, excludedIndexes,
) {
  const configuredAttempts = Number(retryConfig.maxAttemptsPerRequest) || accountManager.accounts.length;
  const maxAttempts = Math.max(1, configuredAttempts);

  // Select account
  const lease = accountManager.acquireAccount(requestInfo, excludedIndexes);
  const account = lease?.account;
  if (!account) {
    const queued = await queueAndRetry(
      'no eligible account/provider currently available',
      req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
      retryConfig, queueConfig, requestInfo, canRetryBufferedBody, 'quota',
    );
    if (queued) return;

    ctx.status = 429;
    ctx.account = '(none available)';
    const status = accountManager.getStatus();
    const retryAfter = computeRetryAfter(status.accounts);
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'retry-after': String(retryAfter),
    });
    res.end(JSON.stringify({
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: `All ${accountManager.accounts.length} accounts exhausted. Retry in ${retryAfter}s.`,
      },
    }));
    return;
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed
  await accountManager.ensureTokenFresh(account.index);
  if (account.status === 'error' && retryCount + 1 < maxAttempts) {
    accountManager.releaseAccount(lease, { error: 'token_refresh_error' });
    excludedIndexes.add(account.index);
    return forwardRequest(
      req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
      retryConfig, queueConfig, requestInfo, canRetryBufferedBody, excludedIndexes,
    );
  }

  // Build upstream request headers
  const isOAuth = account.type === 'oauth';
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    if (lk.startsWith(TEAMCLAUDE_HEADER_PREFIX)) continue;
    if (lk === 'x-api-key') continue;
    if (lk === 'content-length') continue;
    if (account.stripBetaHeaders && lk === 'anthropic-beta') continue;
    // Strip accept-encoding: Node fetch auto-decompresses, which would
    // mismatch the Content-Encoding header we forward to the client
    if (lk === 'accept-encoding') continue;
    headers[key] = value;
  }

  if (account.authHeader === 'authorization' || account.type === 'provider' || isOAuth) {
    headers['authorization'] = `Bearer ${account.credential}`;
    delete headers['x-api-key'];
  } else if (account.authHeader === 'x-api-key' || !isOAuth) {
    headers['x-api-key'] = account.credential;
    delete headers['authorization'];
  }

  const upstreamUrl = `${account.upstream || upstream}${req.url}`;
  const method = req.method;
  const upstreamBody = rewriteBodyForAccount(body, account);

  // Build log sections
  const logSections = [];
  if (logDir) {
    const safeHeaders = { ...headers };
    // Mask credentials in logs
    if (safeHeaders['x-api-key']) {
      safeHeaders['x-api-key'] = safeHeaders['x-api-key'].slice(0, 15) + '...';
    }
    if (safeHeaders['authorization']) {
      safeHeaders['authorization'] = safeHeaders['authorization'].slice(0, 20) + '...';
    }
    logSections.push(
      `=== REQUEST (account: ${account.name}, retry: ${retryCount}) ===\n${method} ${upstreamUrl}\n${formatHeaders(safeHeaders)}`,
    );
    if (body.length > 0) {
      try {
        logSections.push(`=== REQUEST BODY ===\n${JSON.stringify(JSON.parse(body.toString()), null, 2)}`);
      } catch {
        logSections.push(`=== REQUEST BODY (${body.length} bytes) ===\n${body.toString().slice(0, 4096)}`);
      }
    }
  }

  try {
    const upstreamRes = await fetch(upstreamUrl, {
      method,
      headers,
      body: ['GET', 'HEAD'].includes(method) ? undefined : upstreamBody,
      redirect: 'manual',
    });

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      rateLimitHeaders[key] = value;
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // Retry/failover can only happen before response bytes are sent. Once a
    // streaming response starts, rerouting would corrupt Claude Code's stream.
    if (upstreamRes.status === 429) {
      const errorBody = await readErrorBody(upstreamRes);
      const retryAfter = parseRetryAfter(upstreamRes.headers.get('retry-after'))
        || parseProviderRetryAfter(errorBody, account.provider);
      accountManager.markRateLimited(account.index, retryAfter, { status: 429, recordFailure: false });
      accountManager.releaseAccount(lease, { status: 429, error: 'rate_limited' });

      if (logDir) {
        logSections.push(`=== RESPONSE 429 — "${account.name}" rate-limited ${retryAfter}s ===\n${formatHeaders(upstreamRes.headers)}`);
        if (errorBody) logSections.push(`=== ERROR BODY ===\n${errorBody}`);
      }
      console.log(`[TeamClaude] 429 on "${account.name}" — failing over before first byte`);
      excludedIndexes.add(account.index);

      if (
        canRetryBufferedBody &&
        retryCount + 1 < maxAttempts &&
        !res.headersSent &&
        hasEligibleRoute(accountManager, requestInfo, excludedIndexes)
      ) {
        return forwardRequest(
          req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, excludedIndexes,
        );
      }

      const queued = await queueAndRetry(
        `all routes failed after 429 from "${account.name}"`,
        req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, 'quota',
      );
      if (queued) return;

      ctx.status = 429;
      if (logDir) writeRequestLog(logDir, reqId, logSections);
      if (!res.headersSent) {
        const clientRetryAfter = computeRetryAfter(accountManager.getStatus().accounts);
        res.writeHead(429, {
          'Content-Type': 'application/json',
          'retry-after': String(clientRetryAfter),
        });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'rate_limit_error',
            message: `No account could accept this request. Retry in ${clientRetryAfter}s.`,
          },
        }));
      }
      return;
    }

    if (account.type === 'provider' && isProviderAuthStatus(upstreamRes.status)) {
      const errorBody = await readErrorBody(upstreamRes);
      const reason = upstreamRes.status === 401 ? 'auth_failed' : 'forbidden';
      accountManager.markAuthFailed(account.index, upstreamRes.status, reason);
      accountManager.releaseAccount(lease, { status: upstreamRes.status, error: reason });
      excludedIndexes.add(account.index);

      if (logDir) {
        logSections.push(`=== RESPONSE ${upstreamRes.status} — "${account.name}" disabled (${reason}), failing over ===\n${formatHeaders(upstreamRes.headers)}`);
        if (errorBody) logSections.push(`=== ERROR BODY ===\n${errorBody}`);
      }
      console.log(`[TeamClaude] ${upstreamRes.status} on provider "${account.name}" — disabled and failing over before first byte`);

      if (
        canRetryBufferedBody &&
        retryCount + 1 < maxAttempts &&
        !res.headersSent &&
        hasEligibleRoute(accountManager, requestInfo, excludedIndexes)
      ) {
        return forwardRequest(
          req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, excludedIndexes,
        );
      }

      ctx.status = 502;
      if (logDir) writeRequestLog(logDir, reqId, logSections);
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'provider_auth_error',
            message: `Fallback provider "${account.name}" returned HTTP ${upstreamRes.status}. Check its token, base URL, and model config.`,
          },
        }));
      }
      return;
    }

    if (isRetriableUpstreamStatus(upstreamRes.status)) {
      await upstreamRes.body?.cancel();
      accountManager.markTransientFailure(account.index, `HTTP ${upstreamRes.status}`);
      accountManager.releaseAccount(lease);
      excludedIndexes.add(account.index);

      if (logDir) {
        logSections.push(`=== RESPONSE ${upstreamRes.status} — "${account.name}" cooling down, failing over ===\n${formatHeaders(upstreamRes.headers)}`);
      }

      if (canRetryBufferedBody && retryCount + 1 < maxAttempts && !res.headersSent) {
        return forwardRequest(
          req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, excludedIndexes,
        );
      }

      const queued = await queueAndRetry(
        `all routes failed after ${upstreamRes.status} from "${account.name}"`,
        req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, 'capacity',
      );
      if (queued) return;

      ctx.status = upstreamRes.status;
      if (!res.headersSent) {
        res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: { type: 'overloaded_error', message: `Upstream returned ${upstreamRes.status}` },
        }));
      }
      return;
    }

    // Log response headers
    if (logDir) {
      logSections.push(`=== RESPONSE ${upstreamRes.status} ===\n${formatHeaders(upstreamRes.headers)}`);
    }

    ctx.status = upstreamRes.status;

    // Build response headers (skip hop-by-hop and encoding headers)
    const responseHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      if (key === 'transfer-encoding' || key === 'connection') continue;
      // Strip content-encoding/content-length since fetch may auto-decompress
      if (key === 'content-encoding' || key === 'content-length') continue;
      responseHeaders[key] = value;
    }

    if (!upstreamRes.body) {
      res.writeHead(upstreamRes.status, responseHeaders);
      accountManager.releaseAccount(lease, { success: upstreamRes.status < 500, status: upstreamRes.status });
      if (logDir) {
        logSections.push(`=== RESPONSE BODY ===\n(empty)`);
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end();
      return;
    }

    const isStreaming = (upstreamRes.headers.get('content-type') || '').includes('text/event-stream');

    if (isStreaming) {
      const streamLog = logDir ? [] : null;
      await streamResponse(upstreamRes.body, res, upstreamRes.status, responseHeaders, account.index, accountManager, streamLog);
      accountManager.releaseAccount(lease, { success: true, status: upstreamRes.status });
      if (logDir) {
        logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
        writeRequestLog(logDir, reqId, logSections);
      }
    } else {
      res.writeHead(upstreamRes.status, responseHeaders);
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      accountManager.releaseAccount(lease, { success: upstreamRes.status < 500, status: upstreamRes.status });
      if (logDir) {
        try {
          logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`);
        } catch {
          logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`);
        }
        writeRequestLog(logDir, reqId, logSections);
      }
      res.end(buf);
    }
  } catch (err) {
    console.error(`[TeamClaude] Upstream error (account "${account.name}"):`, err.message);

    if (logDir) {
      logSections.push(`=== ERROR ===\n${err.stack || err.message}`);
      writeRequestLog(logDir, reqId, logSections);
    }

    const isTransient = err instanceof Error &&
      (err.message.includes('fetch failed') ||
        err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
        err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        err.message.includes('terminated'));

    if (isTransient) {
      accountManager.markTransientFailure(account.index, err.code || err.message || 'network_error');
      accountManager.releaseAccount(lease);
      excludedIndexes.add(account.index);
      if (canRetryBufferedBody && retryCount + 1 < maxAttempts && !res.headersSent) {
        return forwardRequest(
          req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, excludedIndexes,
        );
      }
      const queued = await queueAndRetry(
        `all routes failed after network error from "${account.name}"`,
        req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, 'network',
      );
      if (queued) return;
      ctx.status = 503;
      if (!res.headersSent) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'connection_unavailable',
            message: 'Could not connect to Claude or a configured fallback provider. Check your internet connection and try again. This is not an account quota issue.',
          },
        }));
      }
      return;
    }

    accountManager.releaseAccount(lease, { error: err.message });
    if (canRetryBufferedBody && retryCount + 1 < maxAttempts && !res.headersSent) {
      account.status = 'error';
      excludedIndexes.add(account.index);
      return forwardRequest(
        req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, excludedIndexes,
      );
    }
    const queued = await queueAndRetry(
      `all routes failed after proxy error from "${account.name}"`,
      req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
      retryConfig, queueConfig, requestInfo, canRetryBufferedBody, 'proxy',
    );
    if (queued) return;
    ctx.status = 502;

    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: { type: 'proxy_error', message: `Upstream error: ${err.message}` },
      }));
    }
  }
}

function parseRetryAfter(value) {
  if (value == null) return null;
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return null;
  return Math.min(Math.max(n, 1), 24 * 60 * 60);
}

function isProviderAuthStatus(status) {
  return status === 401 || status === 403;
}

function hasEligibleRoute(accountManager, requestInfo = {}, excludedIndexes = new Set()) {
  const profile = requestInfo.profile || 'claude';
  return accountManager.accounts.some(account => {
    if (excludedIndexes.has(account.index)) return false;
    if (accountManager._matchesProfile && !accountManager._matchesProfile(account, profile)) return false;
    if (accountManager._isAvailable && !accountManager._isAvailable(account, { allowWeeklyReserve: true })) return false;
    return true;
  });
}

async function readErrorBody(upstreamRes, limitBytes = 64 * 1024) {
  if (!upstreamRes.body) return '';
  try {
    const reader = upstreamRes.body.getReader();
    const chunks = [];
    let total = 0;
    while (total < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const slice = value.length > limitBytes - total ? value.slice(0, limitBytes - total) : value;
      chunks.push(slice);
      total += slice.length;
      if (slice.length !== value.length) break;
    }
    reader.cancel().catch(() => {});
    return Buffer.concat(chunks).toString('utf8');
  } catch {
    return '';
  }
}

function parseProviderRetryAfter(body, provider) {
  const parsed = parseJsonError(body);
  const code = parsed?.code;
  const message = parsed?.message || '';

  if (provider === 'zai') {
    const nextFlush = message.match(/reset at\s+`?([^`\n]+?)`?$/i)?.[1]
      || message.match(/next_flush_time[:\s]+`?([^`\n]+?)`?$/i)?.[1];
    const resetSeconds = secondsUntilParsedTime(nextFlush);
    if (resetSeconds) return resetSeconds;

    if (['1302', '1303', '1305'].includes(String(code))) return 60;
    if (['1304', '1308', '1310'].includes(String(code))) return 60 * 60;
  }

  if (provider === 'kimi') {
    const seconds = message.match(/after\s+(\d+)\s+seconds?/i)?.[1];
    if (seconds) return Math.min(Math.max(parseInt(seconds, 10), 1), 24 * 60 * 60);
    if (parsed?.type === 'rate_limit_reached_error' || parsed?.type === 'engine_overloaded_error') return 60;
    if (parsed?.type === 'exceeded_current_quota_error') return 60 * 60;
  }

  return 60;
}

function parseJsonError(body) {
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    const error = json.error || json;
    return {
      type: error.type,
      code: error.code,
      message: error.message || '',
    };
  } catch {
    return { message: body };
  }
}

function secondsUntilParsedTime(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.min(Math.max(Math.ceil((dateMs - Date.now()) / 1000), 1), 24 * 60 * 60);
  }
  const n = Number(trimmed);
  if (Number.isFinite(n)) {
    const ms = n > 10_000_000_000 ? n : n > 1_000_000_000 ? n * 1000 : Date.now() + n * 1000;
    return Math.min(Math.max(Math.ceil((ms - Date.now()) / 1000), 1), 24 * 60 * 60);
  }
  return null;
}

function isRetriableUpstreamStatus(status) {
  return status === 529 || status === 502 || status === 503 || status === 504;
}

async function queueAndRetry(
  reason, req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
  retryConfig, queueConfig, requestInfo, canRetryBufferedBody, cause = 'quota',
) {
  if (!queueConfig.enabled || !canRetryBufferedBody || res.headersSent || res.destroyed) return false;
  if (cause === 'network' || cause === 'proxy') return false;

  const maxWaitMs = Math.max(0, Number(queueConfig.maxWaitMs) || 0);
  const autoMaxWaitMs = Math.max(0, Number(queueConfig.autoMaxWaitMs) || 0);
  const queueWindowMs = Math.min(maxWaitMs, autoMaxWaitMs || maxWaitMs);
  if (queueWindowMs <= 0) return false;

  const status = accountManager.getStatus();
  const retryAfterMs = computeRetryAfterMs(status.accounts);
  if (!Number.isFinite(retryAfterMs) || retryAfterMs > queueWindowMs) return false;

  requestInfo.queueStartedAt ||= Date.now();
  const elapsed = Date.now() - requestInfo.queueStartedAt;
  const remaining = queueWindowMs - elapsed;
  if (remaining <= 0) return false;

  ctx.account = '(queued)';
  hooks.onRequestRouted?.(reqId, { account: '(queued)' });
  console.log(`[TeamClaude] ${reason}; queueing request for up to ${Math.ceil(remaining / 1000)}s (cause: ${cause})`);

  const available = await waitForAvailableRoute(req, res, accountManager, requestInfo, queueConfig, remaining);
  if (!available) return res.destroyed || req.destroyed;

  return forwardRequest(
    req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir,
    retryConfig, queueConfig, requestInfo, canRetryBufferedBody, new Set(),
  ).then(() => true);
}

async function waitForAvailableRoute(req, res, accountManager, requestInfo, queueConfig, maxWaitMs) {
  const startedAt = Date.now();
  const pollMs = Math.max(100, Number(queueConfig.pollMs) || 1000);
  let closed = false;
  const markClosed = () => { closed = true; };
  req.once('aborted', markClosed);
  res.once('close', markClosed);

  try {
    while (Date.now() - startedAt < maxWaitMs) {
      if (closed || res.destroyed) return false;
      if (accountManager.getActiveAccount(requestInfo, new Set())) return true;

      const remaining = maxWaitMs - (Date.now() - startedAt);
      await sleep(Math.min(pollMs, remaining));
    }

    return accountManager.getActiveAccount(requestInfo, new Set()) != null;
  } finally {
    req.off('aborted', markClosed);
    res.off('close', markClosed);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function describeRequest(req, body) {
  let weight = Math.max(1, Math.ceil(body.length / 64_000));
  const info = {
    method: req.method,
    path: req.url,
    bodyBytes: body.length,
    weight,
  };
  try {
    const json = JSON.parse(body.toString());
    if (json.model) info.model = json.model;
    if (json.stream) info.stream = true;
    if (json.max_tokens && json.max_tokens > 16_000) weight += 1;
    if (json.thinking || json.effort) weight += 1;
  } catch {
    // Non-JSON requests are rare; body size still gives a useful load signal.
  }
  info.weight = Math.max(1, weight);
  return info;
}

function getTeamClaudeProfile(headers) {
  const profile = String(headers['x-teamclaude-profile'] || 'claude').trim().toLowerCase();
  return profile || 'claude';
}

function prepareRuntimeProviders(accountManager, headers) {
  if (getTeamClaudeProfile(headers) !== 'all') return;

  const zaiToken = headerValue(headers, 'x-teamclaude-zai-token');
  if (zaiToken) {
    const opus = headerValue(headers, 'x-teamclaude-zai-opus-model') || headerValue(headers, 'x-teamclaude-zai-model') || 'glm-5.2';
    const sonnet = headerValue(headers, 'x-teamclaude-zai-sonnet-model') || headerValue(headers, 'x-teamclaude-zai-model') || opus;
    const haiku = headerValue(headers, 'x-teamclaude-zai-haiku-model') || 'glm-5.1';
    accountManager.upsertRuntimeAccount({
      name: 'glm-fallback',
      type: 'provider',
      provider: 'zai',
      authToken: zaiToken,
      upstream: trimTrailingSlash(headerValue(headers, 'x-teamclaude-zai-base-url') || 'https://api.z.ai/api/anthropic'),
      authHeader: 'authorization',
      profiles: ['all'],
      priority: 10,
      modelMap: { opus, sonnet, haiku, default: sonnet },
      stripBetaHeaders: true,
    });
  }

  const kimiToken = headerValue(headers, 'x-teamclaude-kimi-token');
  if (kimiToken) {
    const model = headerValue(headers, 'x-teamclaude-kimi-model') || 'kimi-k2.7';
    accountManager.upsertRuntimeAccount({
      name: 'kimi-fallback',
      type: 'provider',
      provider: 'kimi',
      authToken: kimiToken,
      upstream: trimTrailingSlash(headerValue(headers, 'x-teamclaude-kimi-base-url') || 'https://api.kimi.com/coding'),
      authHeader: 'authorization',
      profiles: ['all'],
      priority: 20,
      model,
      stripBetaHeaders: true,
    });
  }
}

function headerValue(headers, name) {
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return value ? String(value).trim() : '';
}

function trimTrailingSlash(value) {
  return String(value).replace(/\/+$/, '');
}

function rewriteBodyForAccount(body, account) {
  if (!body.length || (!account.model && !account.modelMap)) return body;

  try {
    const json = JSON.parse(body.toString());
    if (!json || typeof json !== 'object' || !json.model) return body;
    json.model = mappedModel(json.model, account);
    return Buffer.from(JSON.stringify(json));
  } catch {
    return body;
  }
}

function mappedModel(originalModel, account) {
  if (account.model) return account.model;
  const map = account.modelMap || {};
  const model = String(originalModel || '').toLowerCase();
  if (model.includes('haiku')) return map.haiku || map.default || originalModel;
  if (model.includes('opus')) return map.opus || map.default || originalModel;
  if (model.includes('sonnet')) return map.sonnet || map.default || originalModel;
  return map.default || originalModel;
}

/**
 * Stream an SSE response to the client, parsing usage data along the way.
 */
async function streamResponse(webStream, res, status, responseHeaders, accountIndex, accountManager, streamLog) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let committed = false;
  let readFailed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Client disconnected — stop reading from upstream
      if (res.destroyed) break;

      if (!committed) {
        res.writeHead(status, responseHeaders);
        committed = true;
      }

      // Forward chunk immediately
      const ok = res.write(value);

      const text = decoder.decode(value, { stream: true });

      // Capture for logging
      if (streamLog) streamLog.push(text);

      // Parse SSE events for usage tracking
      sseBuffer += text;
      const events = sseBuffer.split('\n\n');
      sseBuffer = events.pop(); // keep incomplete event

      for (const event of events) {
        parseSSEUsage(event, accountIndex, accountManager);
      }

      // Handle backpressure — also bail out if client disconnects,
      // because 'drain' will never fire on a destroyed socket
      if (!ok) {
        await new Promise(resolve => {
          res.once('drain', resolve);
          res.once('close', resolve);
        });
        if (res.destroyed) break;
      }
    }

    // Parse any remaining buffer
    if (sseBuffer.trim()) {
      parseSSEUsage(sseBuffer, accountIndex, accountManager);
    }
  } catch (err) {
    readFailed = true;
    throw err;
  } finally {
    // Cancel upstream reader to stop consuming data nobody needs
    reader.cancel().catch(() => {});
    if (!readFailed) {
      if (!committed && !res.headersSent) res.writeHead(status, responseHeaders);
      if (!res.writableEnded) res.end();
    }
  }
}

function parseSSEUsage(event, accountIndex, accountManager) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(accountIndex, data.message.usage.input_tokens, 0);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens);
    }
  } catch {
    // not valid JSON, skip
  }
}

function extractUsageFromBody(buffer, accountIndex, accountManager) {
  try {
    const json = JSON.parse(buffer.toString());
    if (json.usage) {
      accountManager.updateUsage(accountIndex, json.usage.input_tokens, json.usage.output_tokens);
    }
  } catch {
    // not JSON or no usage
  }
}

function computeRetryAfter(accounts) {
  const ms = computeRetryAfterMs(accounts);
  return ms === Infinity ? 60 : Math.max(1, Math.ceil(ms / 1000));
}

function computeRetryAfterMs(accounts) {
  let soonest = Infinity;
  for (const acct of accounts) {
    const reset = acct.rateLimitedUntil
      || acct.cooldownUntil
      || acct.quota?.unified5hReset
      || acct.quota?.unified7dReset
      || acct.quota?.genericReset
      || acct.quota?.resetsAt;
    if (reset) {
      const ms = typeof reset === 'number' ? reset - Date.now() : new Date(reset).getTime() - Date.now();
      if (ms < soonest) soonest = ms;
    }
  }
  return soonest;
}
