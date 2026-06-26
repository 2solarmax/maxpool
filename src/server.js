import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
const MAXPOOL_HEADER_PREFIX = 'x-maxpool-';

const DEFAULT_RETRY = {
  maxAttemptsPerRequest: 0,
  maxRetryBufferBytes: 10 * 1024 * 1024,
};

const DEFAULT_QUEUE = {
  enabled: true,
  maxWaitMs: 24 * 60 * 60 * 1000,
  autoMaxWaitMs: null,
  capacityMaxWaitMs: 15 * 60 * 1000,
  weeklyMaxWaitMs: 24 * 60 * 60 * 1000, // legacy bound; streaming holds use streamHoldMaxMs
  // STREAMING hold ceiling: how long a streaming request may be HELD ALIVE on
  // the SSE heartbeat waiting for any account to free up. Defaults to 7d (the
  // max weekly window) so a session is never killed while a real reset is on the
  // way — it resumes the instant any account frees. The hold is gated by the
  // nextRetryForRequest oracle: it ONLY holds when ≥1 eligible route has a finite
  // reset within this ceiling; permanent failures (all accounts logged out / no
  // eligible route / reset unknown) error fast instead of hanging. The heartbeat
  // resets idle-gap client timeouts; if a client uses a wall-clock total-request
  // deadline, lower this to just under it.
  streamHoldMaxMs: 7 * 24 * 60 * 60 * 1000,
  // Non-streaming requests have no SSE heartbeat to keep them alive, so a long
  // hold would die on the client timeout anyway. Cap their wait conservatively.
  nonStreamMaxWaitMs: 5 * 60 * 1000,
  // Backpressure: holds used to be 0ms, now they can be hours. Bound the queue
  // so 22 retrying agents can't grow the heap without limit.
  maxConcurrentQueued: 64,
  maxQueuedBytes: 1024 * 1024 * 1024, // 1 GiB aggregate across all held bodies
  pollMs: 1000,
  heartbeatMs: 10_000,
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
      if (req.method === 'GET' && req.url === '/maxpool/status') {
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
        const reqId = ++requestCounter;
        const ctx = { account: '(oauth relay)', status: null };
        const accepted = hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });
        if (accepted === false) {
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'retry-after': '1',
            Connection: 'close',
          });
          res.end(JSON.stringify({
            type: 'error',
            error: {
              type: 'restart_in_progress',
              message: 'Maxpool is restarting. Retry immediately.',
            },
          }));
          return;
        }
        hooks.onRequestRouted?.(reqId, { account: ctx.account });
        try {
          await relayRaw(req, res, upstream);
          ctx.status = res.statusCode;
        } finally {
          hooks.onRequestEnd?.(reqId, {
            method: req.method,
            path: req.url,
            account: ctx.account,
            status: ctx.status,
          });
        }
        return;
      }

      // Track request
      const reqId = ++requestCounter;
      const accepted = hooks.onRequestStart?.(reqId, { method: req.method, path: req.url });
      if (accepted === false) {
        res.writeHead(503, {
          'Content-Type': 'application/json',
          'retry-after': '1',
          Connection: 'close',
        });
        res.end(JSON.stringify({
          type: 'error',
          error: {
            type: 'restart_in_progress',
            message: 'Maxpool is restarting. Retry immediately.',
          },
        }));
        return;
      }

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
      const maxQueuedBodyBytes = queueConfig.maxQueuedBodyBytes == null
        ? Infinity
        : Math.max(0, Number(queueConfig.maxQueuedBodyBytes) || 0);
      const canQueueBufferedBody = body.length <= maxQueuedBodyBytes;
      if (!canQueueBufferedBody) {
        requestInfo.queueBlockedReason = `request body ${body.length} bytes exceeds queue.maxQueuedBodyBytes ${maxQueuedBodyBytes}`;
      }
      requestInfo.profile = getMaxpoolProfile(req.headers);
      requestInfo.sessionKey = headerValue(req.headers, 'x-maxpool-session');
      if (requestInfo.requiresAnthropicThinkingIntegrity && requestInfo.profile === 'all') {
        console.log('[Maxpool] Anthropic thinking detected; provider fallback disabled for this session/request');
      }
      prepareRuntimeProviders(accountManager, req.headers);

      const ctx = { account: null, status: null };
      try {
        await forwardRequest(
          req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, new Set(),
        );
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[Maxpool] Unhandled error:', err);
        sendErrorResponse(res, requestInfo, 502, {
          type: 'error',
          error: { type: 'proxy_error', message: 'Internal proxy error' },
        });
      } finally {
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error('[Maxpool] Unhandled error:', err);
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
    console.error('[Maxpool] Raw relay error:', err.message);
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
    console.error(`[Maxpool] Failed to write log: ${err.message}`);
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
  retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
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
      retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, 'quota',
    );
    if (queued) return;

    ctx.status = 429;
    ctx.account = '(none available)';
    const retryPlan = accountManager.nextRetryForRequest?.(requestInfo, new Set()) || {};
    const willRecoverSoon = Number.isFinite(retryPlan.retryAfterMs);
    const retryAfter = willRecoverSoon ? Math.max(1, Math.ceil(retryPlan.retryAfterMs / 1000)) : 60;
    // Surface the routing decision (logs go to the TUI; this is the only record
    // of WHY a request was rejected rather than queued).
    console.log(`[Maxpool] No route for request — returning 429 (cause: ${retryPlan.cause || 'unavailable'}, recovers-soon: ${willRecoverSoon})`);
    sendErrorResponse(res, requestInfo, 429, {
      type: 'error',
      error: {
        type: 'rate_limit_error',
        message: unavailableMessage(accountManager, requestInfo, retryAfter, willRecoverSoon),
      },
    }, { 'retry-after': String(retryAfter) });
    return;
  }

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed
  const tokenReady = await accountManager.ensureTokenFresh(account.index);
  if (!tokenReady) {
    accountManager.releaseAccount(lease);
    excludedIndexes.add(account.index);
    if (
      retryCount + 1 < maxAttempts &&
      hasEligibleRoute(accountManager, requestInfo, excludedIndexes)
    ) {
      return forwardRequest(
        req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
      );
    }

    const queued = await queueAndRetry(
      `OAuth token refresh unavailable for "${account.name}"`,
      req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
      retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, 'quota',
    );
    if (queued) return;

    ctx.status = 401;
    sendErrorResponse(res, requestInfo, 401, {
      type: 'error',
      error: {
        type: 'authentication_error',
        message: `Claude account "${account.name}" could not refresh its OAuth token. Run maxpool accounts -v or log in again.`,
      },
    });
    return;
  }

  // Build upstream request headers
  const isOAuth = account.type === 'oauth';
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lk = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lk)) continue;
    if (lk.startsWith(MAXPOOL_HEADER_PREFIX)) continue;
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
      const rateLimit = classifyRateLimit(account, rateLimitHeaders, errorBody);
      if (rateLimit.scope === 'upstream') {
        const parsedError = parseJsonError(errorBody);
        const fingerprint = `429:${rateLimit.fingerprint || overloadFingerprint(errorBody, body)}`;
        const incident = recordRequestIncident(requestInfo, fingerprint, account.index, retryAfter);
        accountManager.markProvisionalUpstreamFailure(account.index, 429, fingerprint, retryAfter);
        accountManager.releaseAccount(lease, {
          status: 429,
          error: 'upstream_throttled',
          neutral: true,
        });
        excludedIndexes.add(account.index);

        if (logDir) {
          logSections.push(`=== RESPONSE 429 — "${account.name}" server-throttled ${retryAfter}s ===\n${formatHeaders(upstreamRes.headers)}`);
          if (errorBody) logSections.push(`=== ERROR BODY ===\n${errorBody}`);
        }

        if (
          canRetryBufferedBody
          && retryCount + 1 < maxAttempts
          && !res.headersSent
          && hasEligibleRoute(accountManager, requestInfo, excludedIndexes)
        ) {
          return forwardRequest(
            req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
            retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
          );
        }

        if (accountManager.shouldPromoteUpstreamFailure(incident, requestInfo)) {
          accountManager.clearProvisionalUpstreamFailures(fingerprint, incident.accounts);
          accountManager.markUpstreamThrottled(
            incident.retryAfter,
            parsedError?.message || parsedError?.type || 'matching_request_wide_429s',
          );
          console.log('[Maxpool] Every eligible Claude account returned the same server-side 429; opening shared Anthropic throttle');

          const queued = await queueAndRetry(
            'Anthropic upstream is temporarily limiting requests',
            req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
            retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, 'upstream_throttle',
          );
          if (queued) return;

          ctx.status = 429;
          sendErrorResponse(res, requestInfo, 429, {
            type: 'error',
            error: {
              type: 'rate_limit_error',
              message: 'Anthropic is temporarily limiting requests. Maxpool will retry automatically when capacity returns.',
            },
          }, { 'retry-after': String(computeRetryAfter(accountManager, requestInfo)) });
          return;
        }

        const queued = await queueAndRetry(
          `all routes failed after server-side 429 from "${account.name}"`,
          req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, 'capacity',
        );
        if (queued) return;

        ctx.status = 429;
        sendErrorBody(res, requestInfo, 429, errorBody, upstreamRes.headers);
        return;
      }

      const promotedAmbiguous = rateLimit.scope === 'unknown'
        && accountManager.noteAmbiguousRateLimit(account.index, rateLimit.fingerprint, retryAfter);
      if (promotedAmbiguous) {
        const parsedError = parseJsonError(errorBody);
        accountManager.markUpstreamThrottled(
          retryAfter,
          parsedError?.message || parsedError?.type || 'matching_ambiguous_429s',
        );
        accountManager.releaseAccount(lease, {
          status: 429,
          error: 'upstream_throttled',
          upstreamThrottled: true,
          neutral: true,
        });

        const queued = await queueAndRetry(
          'Anthropic upstream is temporarily limiting requests',
          req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, 'upstream_throttle',
        );
        if (queued) return;

        ctx.status = 429;
        sendErrorBody(res, requestInfo, 429, errorBody, upstreamRes.headers);
        return;
      }

      accountManager.markRateLimited(account.index, retryAfter, {
        status: 429,
        recordFailure: false,
        fingerprint: rateLimit.scope === 'unknown' ? rateLimit.fingerprint : null,
      });
      accountManager.releaseAccount(lease, { status: 429, error: 'rate_limited' });

      if (logDir) {
        logSections.push(`=== RESPONSE 429 — "${account.name}" rate-limited ${retryAfter}s ===\n${formatHeaders(upstreamRes.headers)}`);
        if (errorBody) logSections.push(`=== ERROR BODY ===\n${errorBody}`);
      }
      console.log(`[Maxpool] 429 on "${account.name}" — failing over before first byte`);
      excludedIndexes.add(account.index);

      if (
        canRetryBufferedBody &&
        retryCount + 1 < maxAttempts &&
        !res.headersSent &&
        hasEligibleRoute(accountManager, requestInfo, excludedIndexes)
      ) {
        return forwardRequest(
          req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
        );
      }

      const queued = await queueAndRetry(
        `all routes failed after 429 from "${account.name}"`,
        req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canRetryBufferedBody, 'quota',
      );
      if (queued) return;

      ctx.status = 429;
      if (logDir) writeRequestLog(logDir, reqId, logSections);
      const retryPlan = accountManager.nextRetryForRequest?.(requestInfo, new Set()) || {};
      const willRecoverSoon = Number.isFinite(retryPlan.retryAfterMs);
      const clientRetryAfter = willRecoverSoon ? Math.max(1, Math.ceil(retryPlan.retryAfterMs / 1000)) : 60;
      console.log(`[Maxpool] No route after failover — returning 429 (cause: ${retryPlan.cause || 'unavailable'}, recovers-soon: ${willRecoverSoon})`);
      sendErrorResponse(res, requestInfo, 429, {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: unavailableMessage(accountManager, requestInfo, clientRetryAfter, willRecoverSoon),
        },
      }, { 'retry-after': String(clientRetryAfter) });
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
      console.log(`[Maxpool] ${upstreamRes.status} on provider "${account.name}" — disabled and failing over before first byte`);

      if (
        canRetryBufferedBody &&
        retryCount + 1 < maxAttempts &&
        !res.headersSent &&
        hasEligibleRoute(accountManager, requestInfo, excludedIndexes)
      ) {
        return forwardRequest(
          req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
        );
      }

      ctx.status = 502;
      if (logDir) writeRequestLog(logDir, reqId, logSections);
      sendErrorResponse(res, requestInfo, 502, {
        type: 'error',
        error: {
          type: 'provider_auth_error',
          message: `Fallback provider "${account.name}" returned HTTP ${upstreamRes.status}. Check its token, base URL, and model config.`,
        },
      });
      return;
    }

    if (upstreamRes.status === 529 && account.type !== 'provider') {
      const errorBody = await readErrorBody(upstreamRes);
      const retryAfter = parseRetryAfter(upstreamRes.headers.get('retry-after')) || 30;
      const fingerprint = overloadFingerprint(errorBody, body);
      const incident = recordRequestIncident(requestInfo, fingerprint, account.index, retryAfter);

      if (logDir) {
        logSections.push(`=== RESPONSE 529 — "${account.name}" overloaded ${retryAfter}s ===\n${formatHeaders(upstreamRes.headers)}`);
        if (errorBody) logSections.push(`=== ERROR BODY ===\n${errorBody}`);
      }

      accountManager.markProvisionalUpstreamFailure(account.index, 529, fingerprint, retryAfter);
      accountManager.releaseAccount(lease, {
        status: 529,
        error: 'upstream_overloaded',
        neutral: true,
      });
      excludedIndexes.add(account.index);

      if (
        canRetryBufferedBody
        && retryCount + 1 < maxAttempts
        && !res.headersSent
        && hasEligibleRoute(accountManager, requestInfo, excludedIndexes)
      ) {
        return forwardRequest(
          req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
        );
      }

      if (accountManager.shouldPromoteUpstreamFailure(incident, requestInfo)) {
        accountManager.clearProvisionalUpstreamFailures(fingerprint, incident.accounts);
        accountManager.markUpstreamThrottled(incident.retryAfter, 'matching_request_wide_529s');
        console.log('[Maxpool] Every eligible Claude account returned the same 529; opening shared Anthropic throttle');

        const queued = await queueAndRetry(
          'Anthropic upstream is overloaded',
          req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, 'upstream_throttle',
        );
        if (queued) return;

        ctx.status = 529;
        sendErrorResponse(res, requestInfo, 529, {
          type: 'error',
          error: {
            type: 'overloaded_error',
            message: 'Anthropic is temporarily overloaded. Maxpool will retry automatically when capacity returns.',
          },
        });
        return;
      }

      const queued = await queueAndRetry(
        `all routes failed after HTTP 529 from "${account.name}"`,
        req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, 'capacity',
      );
      if (queued) return;

      ctx.status = 529;
      sendErrorBody(res, requestInfo, 529, errorBody, upstreamRes.headers);
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
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
        );
      }

      const queued = await queueAndRetry(
        `all routes failed after ${upstreamRes.status} from "${account.name}"`,
        req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canRetryBufferedBody, 'capacity',
      );
      if (queued) return;

      ctx.status = upstreamRes.status;
      sendErrorResponse(res, requestInfo, upstreamRes.status, {
        type: 'error',
        error: { type: 'overloaded_error', message: `Upstream returned ${upstreamRes.status}` },
      });
      return;
    }

    if (upstreamRes.status >= 400 && upstreamRes.status < 500) {
      const errorBody = await readErrorBody(upstreamRes);
      const errorType = errorBody.includes('Invalid `signature` in `thinking` block')
        ? 'invalid_thinking_signature'
        : `HTTP ${upstreamRes.status}`;
      accountManager.releaseAccount(lease, { status: upstreamRes.status, error: errorType });

      if (logDir) {
        logSections.push(`=== RESPONSE ${upstreamRes.status} — non-retryable client error from "${account.name}" ===\n${formatHeaders(upstreamRes.headers)}`);
        if (errorBody) logSections.push(`=== ERROR BODY ===\n${errorBody}`);
        writeRequestLog(logDir, reqId, logSections);
      }
      if (errorType === 'invalid_thinking_signature') {
        console.log(`[Maxpool] Non-retryable Anthropic thinking signature error on "${account.name}"`);
      }

      ctx.status = upstreamRes.status;
      sendErrorBody(res, requestInfo, upstreamRes.status, errorBody, upstreamRes.headers);
      return;
    }

    if (upstreamRes.status < 400) {
      accountManager.confirmUpstreamProbe?.(lease);
      accountManager.markUpstreamAccepted?.(account.index);
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
      if (!res.headersSent) res.writeHead(upstreamRes.status, responseHeaders);
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
      await streamResponse(upstreamRes.body, res, upstreamRes.status, responseHeaders, account.index, accountManager, streamLog, requestInfo);
      accountManager.releaseAccount(lease, { success: true, status: upstreamRes.status });
      if (logDir) {
        logSections.push(`=== RESPONSE BODY (streamed) ===\n${streamLog.join('')}`);
        writeRequestLog(logDir, reqId, logSections);
      }
    } else {
      const buf = Buffer.from(await upstreamRes.arrayBuffer());
      extractUsageFromBody(buf, account.index, accountManager);
      markThinkingFromResponse(buf, accountManager, requestInfo);
      accountManager.releaseAccount(lease, { success: upstreamRes.status < 500, status: upstreamRes.status });
      if (logDir) {
        try {
          logSections.push(`=== RESPONSE BODY ===\n${JSON.stringify(JSON.parse(buf.toString()), null, 2)}`);
        } catch {
          logSections.push(`=== RESPONSE BODY (${buf.length} bytes) ===\n${buf.toString().slice(0, 8192)}`);
        }
        writeRequestLog(logDir, reqId, logSections);
      }
      if (requestInfo.queueHeartbeatActive) {
        clearQueueHeartbeat(requestInfo);
        if (!res.destroyed && !res.writableEnded) {
          res.write(`data: ${buf.toString()}\n\n`);
          res.end();
        }
      } else {
        if (!res.headersSent) res.writeHead(upstreamRes.status, responseHeaders);
        res.end(buf);
      }
    }
  } catch (err) {
    console.error(`[Maxpool] Upstream error (account "${account.name}"):`, err.message);

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
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
        );
      }
      const queued = await queueAndRetry(
        `all routes failed after network error from "${account.name}"`,
        req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canRetryBufferedBody, 'network',
      );
      if (queued) return;
      ctx.status = 503;
      sendErrorResponse(res, requestInfo, 503, {
        type: 'error',
        error: {
          type: 'connection_unavailable',
          message: 'Could not connect to Claude or a configured fallback provider. Check your internet connection and try again. This is not an account quota issue.',
        },
      });
      return;
    }

    accountManager.releaseAccount(lease, { error: err.message });
    if (canRetryBufferedBody && retryCount + 1 < maxAttempts && !res.headersSent) {
      account.status = 'error';
      excludedIndexes.add(account.index);
      return forwardRequest(
        req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
        retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
      );
    }
    const queued = await queueAndRetry(
      `all routes failed after proxy error from "${account.name}"`,
      req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
      retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canRetryBufferedBody, 'proxy',
    );
    if (queued) return;
    ctx.status = 502;

    sendErrorResponse(res, requestInfo, 502, {
      type: 'error',
      error: { type: 'proxy_error', message: `Upstream error: ${err.message}` },
    });
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
  return accountManager.hasAvailableRoute?.(requestInfo, excludedIndexes) || false;
}

function formatRetryDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s >= 86400) return `${Math.round(s / 86400)}d`;
  if (s >= 3600) return `${Math.round(s / 3600)}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${s}s`;
}

function unavailableMessage(accountManager, requestInfo = {}, retryAfter, willRecoverSoon = true) {
  const thinking = requestInfo.requiresAnthropicThinkingIntegrity
    || accountManager._requiresAnthropicThinkingIntegrity?.(requestInfo);
  const n = accountManager.accounts.length;

  // No route is expected to recover within the queue window — i.e. every Claude
  // account is at its own 5h/weekly limit. A short "retry in Ns" would be a lie;
  // tell the user the real fix.
  if (!willRecoverSoon) {
    const eta = Number.isFinite(retryAfter) && retryAfter > 0
      ? ` Soonest reset in ~${formatRetryDuration(retryAfter)}, beyond the hold window.`
      : '';
    const base = `No Claude account can take this request — all ${n} are at their 5h or weekly limit.${eta} Add another Claude account or wait for a quota reset.`;
    return thinking
      ? `${base} GLM/Kimi fallback is unavailable because this session contains Anthropic signed thinking blocks; start a fresh non-thinking session to use them.`
      : base;
  }

  if (thinking) {
    return `No Claude account could accept this request. Non-Claude fallback is disabled because this session contains Anthropic signed thinking blocks. Retry in ${retryAfter}s, wait for Claude capacity, or start a fresh non-thinking session to use GLM/Kimi.`;
  }
  return `All ${n} accounts exhausted. Retry in ${retryAfter}s.`;
}

export const __serverTest = { unavailableMessage, isRetriableUpstreamStatus, headerValue, getMaxpoolProfile };

async function readErrorBody(upstreamRes, limitBytes = 64 * 1024) {
  if (!upstreamRes.body) return '';
  try {
    const reader = upstreamRes.body.getReader();
    const chunks = [];
    let total = 0;
    while (limitBytes == null || total < limitBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const slice = limitBytes != null && value.length > limitBytes - total
        ? value.slice(0, limitBytes - total)
        : value;
      chunks.push(slice);
      total += slice.length;
      if (limitBytes != null && slice.length !== value.length) break;
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

function classifyRateLimit(account, headers, body) {
  if (account.type === 'provider') return { scope: 'account', fingerprint: null };

  const parsed = parseJsonError(body);
  const message = String(parsed?.message || '').toLowerCase();
  const type = String(parsed?.type || '').toLowerCase();
  const unifiedStatus = String(headers['anthropic-ratelimit-unified-status'] || '').toLowerCase();
  const fiveHour = Number(headers['anthropic-ratelimit-unified-5h-utilization']);
  const weekly = Number(headers['anthropic-ratelimit-unified-7d-utilization']);
  const tokensRemaining = Number(headers['anthropic-ratelimit-tokens-remaining']);
  const requestsRemaining = Number(headers['anthropic-ratelimit-requests-remaining']);

  const quotaHeaderExhaustion =
    unifiedStatus === 'rejected'
    || (Number.isFinite(fiveHour) && fiveHour >= 0.985)
    || (Number.isFinite(weekly) && weekly >= 0.985)
    || (headers['anthropic-ratelimit-tokens-remaining'] != null && tokensRemaining <= 0)
    || (headers['anthropic-ratelimit-requests-remaining'] != null && requestsRemaining <= 0);
  if (quotaHeaderExhaustion) return { scope: 'account', fingerprint: null };

  const quotaBodyExhaustion =
    /\b(account|plan|session|weekly|quota)\b.{0,40}\b(exhausted|limit|exceeded|reached)\b/i.test(message)
    || /\busage\b.{0,40}\b(exhausted|exceeded|reached)\b/i.test(message);
  if (quotaBodyExhaustion) return { scope: 'account', fingerprint: null };

  const explicitSharedThrottle =
    message.includes('not your usage limit')
    || message.includes('temporarily limiting requests')
    || message.includes('server is temporarily limiting')
    || type === 'overloaded_error';
  const normalized = `${type}:${message}`
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  if (explicitSharedThrottle) return { scope: 'upstream', fingerprint: normalized || 'explicit_429' };
  return { scope: 'unknown', fingerprint: normalized || 'unknown_429' };
}

function overloadFingerprint(errorBody, requestBody) {
  const parsed = parseJsonError(errorBody);
  let model = '';
  try {
    model = JSON.parse(requestBody.toString())?.model || '';
  } catch {
    // The response fingerprint still works when the request is not JSON.
  }
  return `529:${model}:${parsed?.type || ''}:${parsed?.message || ''}`
    .toLowerCase()
    .replace(/\b[0-9a-f]{8,}\b/gi, '#')
    .replace(/\b\d+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function recordRequestIncident(requestInfo, fingerprint, accountIndex, retryAfter) {
  requestInfo.upstreamIncidents ||= new Map();
  const incident = requestInfo.upstreamIncidents.get(fingerprint) || {
    accounts: new Set(),
    firstAt: Date.now(),
    retryAfter: 0,
  };
  incident.accounts.add(accountIndex);
  incident.retryAfter = Math.max(incident.retryAfter, retryAfter);
  requestInfo.upstreamIncidents.set(fingerprint, incident);
  return incident;
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
  // 500 included: Anthropic 500s are transient server errors (same class as
  // 502/503/504). Without this they were passed straight through to the client
  // ("Internal server error") instead of failing over to another account.
  return status === 500 || status === 529 || status === 502 || status === 503 || status === 504;
}

function sendErrorResponse(res, requestInfo, status, payload, headers = {}) {
  if (requestInfo.queueHeartbeatActive || res.headersSent) {
    clearQueueHeartbeat(requestInfo);
    if (!res.destroyed && !res.writableEnded) {
      res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      res.end();
    }
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

function sendErrorBody(res, requestInfo, status, body, headers) {
  if (requestInfo.queueHeartbeatActive || res.headersSent) {
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      payload = {
        type: 'error',
        error: { type: 'upstream_error', message: body || `Upstream returned ${status}` },
      };
    }
    sendErrorResponse(res, requestInfo, status, payload);
    return;
  }

  const responseHeaders = {};
  for (const [key, value] of headers.entries()) {
    if (key === 'transfer-encoding' || key === 'connection') continue;
    if (key === 'content-encoding' || key === 'content-length') continue;
    responseHeaders[key] = value;
  }
  responseHeaders['content-type'] ||= 'application/json';
  res.writeHead(status, responseHeaders);
  res.end(body);
}

async function queueAndRetry(
  reason, req, res, body, accountManager, upstream, hooks, reqId, ctx, logDir,
  retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody = canRetryBufferedBody, cause = 'quota',
) {
  if (!queueConfig.enabled || !canQueueBufferedBody || (res.headersSent && !requestInfo.queueHeartbeatActive) || res.destroyed) {
    if (queueConfig.enabled && !canQueueBufferedBody && requestInfo.queueBlockedReason) {
      console.log(`[Maxpool] Not queueing request: ${requestInfo.queueBlockedReason}`);
    }
    return false;
  }
  if (cause === 'network' || cause === 'proxy') return false;

  const maxWaitMs = Math.max(0, Number(queueConfig.maxWaitMs) || 0);
  const autoMaxWaitMs = queueConfig.autoMaxWaitMs == null
    ? maxWaitMs
    : Math.max(0, Number(queueConfig.autoMaxWaitMs) || 0);
  const capacityMaxWaitMs = queueConfig.capacityMaxWaitMs == null
    ? autoMaxWaitMs
    : Math.max(0, Number(queueConfig.capacityMaxWaitMs) || 0);
  const nonStreamMaxWaitMs = queueConfig.nonStreamMaxWaitMs == null
    ? 5 * 60_000
    : Math.max(0, Number(queueConfig.nonStreamMaxWaitMs) || 0);
  const retryPlan = accountManager.nextRetryForRequest?.(requestInfo, new Set()) || {
    retryAfterMs: Infinity,
    cause: 'unavailable',
  };

  // Honest, cause-/thinking-aware message used for every give-up path below.
  const honestMessage = unavailableMessage(
    accountManager, requestInfo,
    Math.ceil((Number.isFinite(retryPlan.retryAfterMs) ? retryPlan.retryAfterMs : 0) / 1000),
    false,
  );

  // Weekly-capped but the reset time is unknown (cold start / probe failure):
  // we can't estimate a wait, so don't pretend to — error honestly now.
  if (retryPlan.cause === 'weekly_reset_unknown') {
    return finishQueuedStreamIfNeeded(res, requestInfo, honestMessage);
  }

  const streamHoldMaxMs = queueConfig.streamHoldMaxMs == null
    ? 7 * 24 * 60 * 60 * 1000
    : Math.max(0, Number(queueConfig.streamHoldMaxMs) || 0);
  // Pick the hold ceiling:
  //   capacity (upstream 529/overload) → its own short cap, never a long hold
  //   non-streaming (no heartbeat)      → short cap (would die on client timeout)
  //   streaming                         → up to streamHoldMaxMs (7d), kept alive
  //                                       by the heartbeat
  let queueWindowMs;
  if (cause === 'capacity') {
    queueWindowMs = Math.min(maxWaitMs, capacityMaxWaitMs);
  } else if (!requestInfo.stream) {
    queueWindowMs = nonStreamMaxWaitMs;
  } else {
    queueWindowMs = streamHoldMaxMs;
  }
  // A non-streaming request has no heartbeat regardless of cause, so it must
  // never outlast nonStreamMaxWaitMs even under capacity (it would occupy a
  // slot 3x its documented cap with nothing to reap it).
  if (!requestInfo.stream) queueWindowMs = Math.min(queueWindowMs, nonStreamMaxWaitMs);

  if (queueWindowMs <= 0) return finishQueuedStreamIfNeeded(res, requestInfo, honestMessage);

  // HOLD-vs-ERROR oracle (from nextRetryForRequest): HOLD only when a TEMPORARY
  // cause has a finite real reset within the ceiling. ERROR FAST for permanent /
  // unsatisfiable cases — nextRetryForRequest returns retryAfterMs === Infinity
  // for no_eligible_route, weekly_reset_unknown, and "all matching routes are
  // terminal (disabled / error / auth-dead)". This is what stops an indefinite
  // hold from silently hanging every session when something is actually broken
  // (all accounts logged out, the only healthy account removed, etc.).
  const retryAfterMs = retryPlan.retryAfterMs;
  if (!Number.isFinite(retryAfterMs) || retryAfterMs > queueWindowMs) {
    return finishQueuedStreamIfNeeded(res, requestInfo, honestMessage);
  }

  requestInfo.queueStartedAt ||= Date.now();
  const ticket = accountManager.registerQueuedRequest?.(requestInfo, {
    bytes: body?.length || 0,
    deadlineAt: requestInfo.queueStartedAt + queueWindowMs,
    sessionKey: requestInfo.sessionKey,
    res, // liveness check for ghost-only eviction
    maxConcurrentQueued: queueConfig.maxConcurrentQueued,
    maxQueuedBytes: queueConfig.maxQueuedBytes,
  });
  if (ticket === null) {
    // Backpressure: too many requests already waiting / too many bytes buffered.
    // Reject honestly instead of growing the heap unbounded.
    return finishQueuedStreamIfNeeded(res, requestInfo,
      'Maxpool queue is full — too many requests are already waiting for capacity. Try again shortly.');
  }
  const elapsed = Date.now() - requestInfo.queueStartedAt;
  const remaining = queueWindowMs - elapsed;
  if (remaining <= 0) {
    accountManager.removeQueuedRequest?.(requestInfo);
    return finishQueuedStreamIfNeeded(res, requestInfo, honestMessage);
  }

  ctx.account = '(queued)';
  hooks.onRequestRouted?.(reqId, { account: '(queued)' });
  console.log(`[Maxpool] ${reason}; queueing request for up to ${Math.ceil(remaining / 1000)}s (cause: ${cause}, retry: ${retryPlan.cause})`);
  ensureQueueHeartbeat(res, requestInfo, queueConfig, accountManager);

  const available = await waitForAvailableRoute(req, res, accountManager, requestInfo, queueConfig, remaining);
  if (!available) {
    if (res.destroyed || req.destroyed) return true;
    accountManager.removeQueuedRequest?.(requestInfo);
    return finishQueuedStreamIfNeeded(res, requestInfo, honestMessage);
  }

  // Stop the heartbeat BEFORE streaming real bytes. The heartbeat already sent
  // the SSE headers (the resumed forward writes onto the committed stream); if
  // the setInterval keeps firing it injects ': maxpool queued' comments INTO the
  // live SSE body and corrupts every resumed completion longer than heartbeatMs.
  // Comments already written before this point are harmless (clients ignore ':').
  clearQueueHeartbeat(requestInfo);

  return forwardRequest(
    req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir,
    retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, new Set(),
  ).then(() => true);
}

function ensureQueueHeartbeat(res, requestInfo, queueConfig, accountManager) {
  if (!requestInfo.stream || requestInfo.queueHeartbeatActive || res.headersSent) return;
  const heartbeatMs = Math.max(1000, Number(queueConfig.heartbeatMs) || 10_000);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': maxpool queued\n\n');
  requestInfo.queueHeartbeatActive = true;
  // The heartbeat is the liveness probe: if the client is gone (socket
  // destroyed/ended, or the write throws EPIPE/ERR_STREAM_DESTROYED), release
  // the queue slot + bytes IMMEDIATELY rather than letting a dead ticket occupy
  // the queue until its (up to 7d) deadline — the ghost-leak guard.
  const reapDead = () => {
    clearQueueHeartbeat(requestInfo);
    accountManager?.removeQueuedRequest?.(requestInfo);
  };
  requestInfo.queueHeartbeatTimer = setInterval(() => {
    if (res.destroyed || res.writableEnded) { reapDead(); return; }
    try {
      res.write(': maxpool queued\n\n');
    } catch {
      reapDead();
    }
  }, heartbeatMs);
  requestInfo.queueHeartbeatTimer.unref?.();
}

function clearQueueHeartbeat(requestInfo) {
  if (requestInfo.queueHeartbeatTimer) clearInterval(requestInfo.queueHeartbeatTimer);
  requestInfo.queueHeartbeatTimer = null;
  requestInfo.queueHeartbeatActive = false;
}

function finishQueuedStreamIfNeeded(res, requestInfo, message) {
  if (!requestInfo.queueHeartbeatActive) return false;
  clearQueueHeartbeat(requestInfo);
  if (!res.destroyed && !res.writableEnded) {
    res.write(`event: error\ndata: ${JSON.stringify({
      type: 'error',
      error: { type: 'rate_limit_error', message },
    })}\n\n`);
    res.end();
  }
  return true;
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
      if (
        accountManager.hasAvailableRoute(requestInfo, new Set())
        && accountManager.canAdmitQueuedRequest?.(requestInfo) !== false
      ) return true;

      // Re-classify each tick: if no eligible route can EVER recover (every
      // matching account went terminal/auth-dead, the only healthy account was
      // removed, or the reset is unknown → retryAfterMs Infinity), stop holding
      // and error fast instead of spinning to the 7d ceiling. Hold is valid only
      // while ≥1 eligible route has a finite, known reset.
      const plan = accountManager.nextRetryForRequest?.(requestInfo, new Set());
      if (plan && plan.cause !== 'available' && !Number.isFinite(plan.retryAfterMs)) return false;

      const remaining = maxWaitMs - (Date.now() - startedAt);
      // Jitter the poll so a synchronized weekly-reset event doesn't re-align
      // every waiter's poll into the same instant (thundering scan).
      const jittered = pollMs * (0.8 + Math.random() * 0.4);
      await sleep(Math.min(jittered, remaining));
    }

    return accountManager.hasAvailableRoute(requestInfo, new Set())
      && accountManager.canAdmitQueuedRequest?.(requestInfo) !== false;
  } finally {
    if (closed || res.destroyed) {
      accountManager.removeQueuedRequest?.(requestInfo);
      clearQueueHeartbeat(requestInfo);
    }
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
    if (requiresAnthropicThinkingIntegrity(json)) {
      info.requiresAnthropicThinkingIntegrity = true;
    }
  } catch {
    // Non-JSON requests are rare; body size still gives a useful load signal.
  }
  info.weight = Math.max(1, weight);
  return info;
}

function requiresAnthropicThinkingIntegrity(json) {
  if (!json || typeof json !== 'object') return false;
  if (json.thinking || json.effort) return true;
  return containsThinkingBlock(json.messages);
}

function containsThinkingBlock(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(containsThinkingBlock);
  if (typeof value !== 'object') return false;

  if (value.type === 'thinking' || value.type === 'redacted_thinking') return true;
  if (value.type === 'signature_delta') return true;
  if (value.signature && (value.thinking != null || value.type == null)) return true;

  if (value.content && containsThinkingBlock(value.content)) return true;
  if (value.messages && containsThinkingBlock(value.messages)) return true;
  return false;
}

function getMaxpoolProfile(headers) {
  // headerValue() handles the x-teamclaude-* legacy fallback.
  const profile = String(headerValue(headers, 'x-maxpool-profile') || 'claude').trim().toLowerCase();
  return profile || 'claude';
}

function prepareRuntimeProviders(accountManager, headers) {
  if (getMaxpoolProfile(headers) !== 'all') return;

  const zaiToken = headerValue(headers, 'x-maxpool-zai-token');
  if (zaiToken) {
    const opus = headerValue(headers, 'x-maxpool-zai-opus-model') || headerValue(headers, 'x-maxpool-zai-model') || 'glm-5.2';
    const sonnet = headerValue(headers, 'x-maxpool-zai-sonnet-model') || headerValue(headers, 'x-maxpool-zai-model') || opus;
    const haiku = headerValue(headers, 'x-maxpool-zai-haiku-model') || 'glm-5.1';
    accountManager.upsertRuntimeAccount({
      name: 'glm-fallback',
      type: 'provider',
      provider: 'zai',
      authToken: zaiToken,
      upstream: trimTrailingSlash(headerValue(headers, 'x-maxpool-zai-base-url') || 'https://api.z.ai/api/anthropic'),
      authHeader: 'authorization',
      profiles: ['all'],
      priority: 10,
      modelMap: { opus, sonnet, haiku, default: sonnet },
      stripBetaHeaders: true,
    });
  }

  const kimiToken = headerValue(headers, 'x-maxpool-kimi-token');
  if (kimiToken) {
    const model = headerValue(headers, 'x-maxpool-kimi-model') || 'kimi-k2.7';
    accountManager.upsertRuntimeAccount({
      name: 'kimi-fallback',
      type: 'provider',
      provider: 'kimi',
      authToken: kimiToken,
      upstream: trimTrailingSlash(headerValue(headers, 'x-maxpool-kimi-base-url') || 'https://api.kimi.com/coding'),
      authHeader: 'authorization',
      profiles: ['all'],
      priority: 20,
      model,
      stripBetaHeaders: true,
    });
  }
}

function headerValue(headers, name) {
  const lname = name.toLowerCase();
  let value = headers[lname];
  // Backward compatibility: sessions launched before the teamclaude→maxpool
  // rename send x-teamclaude-* headers (a process's ANTHROPIC_CUSTOM_HEADERS is
  // fixed at launch). Fall back to the legacy name so already-running sessions
  // keep full routing/fallback without needing a restart.
  if ((value == null || value === '') && lname.startsWith('x-maxpool-')) {
    value = headers['x-teamclaude-' + lname.slice('x-maxpool-'.length)];
  }
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
async function streamResponse(webStream, res, status, responseHeaders, accountIndex, accountManager, streamLog, requestInfo = {}) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let committed = res.headersSent;
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
        parseSSEEvent(event, accountIndex, accountManager, requestInfo);
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
      parseSSEEvent(sseBuffer, accountIndex, accountManager, requestInfo);
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

function parseSSEEvent(event, accountIndex, accountManager, requestInfo = {}) {
  const dataLine = event.split('\n').find(l => l.startsWith('data: '));
  if (!dataLine) return;

  try {
    const data = JSON.parse(dataLine.slice(6));
    if (data.type === 'message_start' && data.message?.usage) {
      accountManager.updateUsage(accountIndex, data.message.usage.input_tokens, 0);
    } else if (data.type === 'message_delta' && data.usage) {
      accountManager.updateUsage(accountIndex, 0, data.usage.output_tokens);
    }
    if (sseEventContainsThinking(data)) {
      accountManager.markSessionThinkingProtected?.(requestInfo.sessionKey, requestInfo.model);
    }
  } catch {
    // not valid JSON, skip
  }
}

function sseEventContainsThinking(data) {
  return data?.content_block?.type === 'thinking'
    || data?.content_block?.type === 'redacted_thinking'
    || data?.delta?.type === 'signature_delta';
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

function markThinkingFromResponse(buffer, accountManager, requestInfo = {}) {
  try {
    const json = JSON.parse(buffer.toString());
    if (containsThinkingBlock(json?.content)) {
      accountManager.markSessionThinkingProtected?.(requestInfo.sessionKey, requestInfo.model);
    }
  } catch {
    // not JSON
  }
}

function computeRetryAfter(accountManager, requestInfo = {}) {
  const ms = accountManager.nextRetryForRequest?.(requestInfo, new Set())?.retryAfterMs ?? Infinity;
  return ms === Infinity ? 60 : Math.max(1, Math.ceil(ms / 1000));
}
