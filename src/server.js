import http from 'node:http';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { modelFamily } from './oauth.js';


const HOP_BY_HOP_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate',
]);
const MAXPOOL_HEADER_PREFIX = 'x-maxpool-';

const DEFAULT_RETRY = {
  maxAttemptsPerRequest: 0,
  maxRetryBufferBytes: 10 * 1024 * 1024,
};

// Upstream-hang guards. A half-open upstream (headers then silence, never closes)
// would block the request forever and LEAK its in-flight lease — the account climbs
// to safetyMaxActivePerAccount and is falsely "full", breaking routing (the "106
// phantom active" incident). Env-overridable with conservative defaults: this path
// serves EVERY provider (Anthropic/GLM/Kimi), so the idle gap is generous enough
// that a legitimately-slow-but-alive stream is never cut (each chunk resets it).
const UPSTREAM_TTFB_MS = Math.max(5_000, Number(process.env.MAXPOOL_TTFB_MS) || 120_000);        // headers must arrive within this
// A real SSE EVENT, not a `:` comment. Claude Code's stall watchdog is reset only when its
// SSE iterator YIELDS an event; per the spec a comment line is discarded by the parser and
// never yields, so a comment keepalive resets nothing. That is why held requests died at
// EXACTLY 300.0s — the client's floor — despite a 10s heartbeat (60 such deaths in 2.4
// days). `ping` is an unknown event type the client ignores semantically while still
// counting as traffic.
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'ECONNABORTED', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);
const isNetworkCode = c => Boolean(c) && NETWORK_ERROR_CODES.has(c);
const QUEUE_KEEPALIVE = 'event: ping\ndata: {}\n\n';
// 240s, strictly BELOW Claude Code's hard 300s stall floor. At the old 300_000 the two
// timers were a dead heat and the client always won — maxpool's clock starts when a chunk
// is READ from upstream, strictly before the client parses it. Result: `upstream idle
// timeout` fired 0 times in 2.4 days while 60 requests died silently client-side. Below the
// floor maxpool wins and turns a silent stall into a labelled error. Anthropic pings during
// extended thinking, so real gaps never approach 4 minutes.
const STREAM_IDLE_MS = Math.max(30_000, Number(process.env.MAXPOOL_STREAM_IDLE_MS) || 240_000);  // max gap BETWEEN streamed chunks (reset per chunk)
const UPSTREAM_BODY_MS = Math.max(30_000, Number(process.env.MAXPOOL_BODY_MS) || 300_000);       // non-streaming body read
const CLIENT_DRAIN_MS = Math.max(5_000, Number(process.env.MAXPOOL_DRAIN_MS) || 60_000);         // max wait for a backpressured client to drain (half-open client → free the lease)
// A provider 403 is (unlike a 401) almost always transient QUOTA/PLAN exhaustion — cool
// the provider down RECOVERABLY for this window, then re-probe, instead of permanently
// disabling it. Short (not reset-length) so a provider-pinned session's hold window
// isn't blown, and a still-exhausted provider just re-benches on the next single retry.
const PROVIDER_FORBIDDEN_COOLDOWN_SEC = Math.max(60, Number(process.env.MAXPOOL_PROVIDER_403_COOLDOWN_SEC) || 1800);
// Backstop reaper idle ceiling. Floored WELL above the longest a legit NON-streaming
// request can go silent (no heartbeat there): TTFB 120s + nonStreamMaxWaitMs 300s +
// UPSTREAM_BODY_MS 300s ≈ 720s — so a slow-but-alive non-streaming request is never
// reaped at completion. Streaming holds heartbeat, so they're safe at any ceiling.
// Exported so index.js sizes RELOAD_DRAIN_MS off the SAME value (no drift).
export const REQUEST_IDLE_MAX_MS = Math.max(900_000, Number(process.env.MAXPOOL_REQUEST_IDLE_MAX_MS) || 1_200_000);

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
  // HARD ceiling on EVERY streaming hold (capacity/quota/throttle/concurrency alike).
  // maxpool CANNOT keep a client alive past its own stream watchdog — Claude Code aborts
  // "Stream idle timeout - no chunks received" after CLAUDE_STREAM_IDLE_TIMEOUT_MS of no
  // real content EVENTS, and it drops SSE ping/comment keep-alives before the watchdog
  // sees them (anthropic-sdk-typescript#998). So a 7-day/24h server-side hold only parks
  // a request the client already abandoned. Bound it to the wait the user actually wants
  // (front-loaded work waiting for a free account ≈ a few hours) so beyond that the
  // request error-fasts with an honest retryable 429 instead of a silent multi-day park.
  // Pair with a raised client watchdog (the cc launch sets CLAUDE_STREAM_IDLE_TIMEOUT_MS).
  // Only trust a long hold when the client's watchdog was ACTUALLY raised. The `cc` alias
  // exports CLAUDE_STREAM_IDLE_TIMEOUT_MS=3h, but a session started any other way keeps the
  // 300s floor — holding its request for hours just parks a caller that left at 5 minutes.
  // Derive from the env we can observe; otherwise stay under the real floor.
  streamClientToleranceMs: Math.max(60_000, Number(process.env.MAXPOOL_STREAM_CLIENT_TOLERANCE_MS)
    || (Number(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS) > 300_000
      ? Math.floor(Number(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS) * 0.8)
      : 240_000)),
  // Non-streaming requests have no SSE heartbeat to keep them alive, so a long
  // hold would die on the client timeout anyway. Cap their wait conservatively.
  nonStreamMaxWaitMs: 5 * 60 * 1000,
  // Proactive streaming keep-alive: a STREAMING request gets ZERO client bytes
  // while maxpool selects a route, cycles failover, and waits for the upstream's
  // first byte (up to UPSTREAM_TTFB_MS=120s) — the queue heartbeat only starts
  // once a request is QUEUED. If that client-silent window exceeds the client's
  // own idle timeout (Claude Code aborts "Stream idle timeout - no chunks
  // received", observed as low as ~23s), the client gives up on a request maxpool
  // is still patiently serving. If the upstream hasn't delivered bytes within this
  // grace, commit the SSE stream + start the heartbeat so the client never idles
  // out. Kept above a normal fast TTFB (1-5s → common case never early-commits,
  // behavior unchanged) and well below the client idle floor. Env-overridable.
  streamForwardGraceMs: Math.max(1000, Number(process.env.MAXPOOL_STREAM_FORWARD_GRACE_MS) || 10000),
  // count_tokens is cheap non-streaming metadata — cap its queue wait VERY low so it
  // fast-fails with a retryable 429 instead of hanging silently past the client's idle
  // window. Kept well under any plausible client idle timeout (observed errors as low
  // as ~23s). Env-overridable for tuning as the "Stream idle timeout" reports resolve.
  countTokensMaxWaitMs: Math.max(1000, Number(process.env.MAXPOOL_COUNT_TOKENS_MAX_WAIT_MS) || 8000),
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

  // Reload drain flag. When the worker releases the baton it sets this so every
  // remaining response carries `Connection: close`, retiring the client's
  // keep-alive socket instead of letting it pipeline a NEW request onto a worker
  // that's shutting down. `connection` is hop-by-hop so it's stripped from the
  // upstream response headers — a setHeader here survives the later writeHead.
  let draining = false;

  // Identifies the WORKER process that served a response — proves the supervisor
  // (which holds the socket but does not serve) never swallowed the request. Set
  // before any writeHead; `x-maxpool-*` is informative-only and stripped from
  // upstream-bound request headers elsewhere.
  const workerStamp = String(process.pid);

  const server = http.createServer(async (req, res) => {
    try {
      // Disable Nagle on the client socket: flush each SSE event immediately instead
      // of coalescing small writes into bursts. Smooths streaming cadence toward the
      // HTTP/2-direct shape, reducing how often a client terminal's re-render churns
      // on long streams. Same underlying socket as res, so this covers the write path.
      try { req.socket?.setNoDelay(true); } catch { /* socket may already be gone */ }
      try { res.setHeader('x-maxpool-worker', workerStamp); } catch { /* headers sent */ }
      if (draining) {
        try { res.setHeader('Connection', 'close'); } catch { /* headers may be sent */ }
      }
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
        const accepted = hooks.onRequestStart?.(reqId, { method: req.method, path: req.url, sessionKey: headerValue(req.headers, 'x-maxpool-session') });
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
      // sessionKey (from the per-terminal x-maxpool-session header) lets the TUI show
      // how many distinct client sessions the in-flight requests span — so "N in-flight"
      // isn't misread as "N sessions" (subagents of one terminal share one session key).
      const accepted = hooks.onRequestStart?.(reqId, { method: req.method, path: req.url, sessionKey: headerValue(req.headers, 'x-maxpool-session') });
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

      // The request is now TRACKED (onRequestStart accepted → tui.active +
      // restartController.activeRequests both hold it). EVERYTHING that can throw —
      // including body buffering — must run inside the try whose finally fires
      // onRequestEnd, or a client that dies mid-body-read throws to the OUTER catch
      // and leaks the active entry AND the restart drain counter (hangs a reload's
      // drain). requestInfo starts as {} so the error path never dereferences an
      // undefined (a body-read throw lands before describeRequest runs).
      const ctx = { account: null, status: null };
      let requestInfo = {};
      // Backstop reaper (defense-in-depth for any UNKNOWN future hang the specific
      // TTFB/idle/body/drain guards don't cover). See startIdleRequestReaper.
      const reaperTimer = startIdleRequestReaper(res, reqId, REQUEST_IDLE_MAX_MS);
      try {
        // Buffer request body (needed for retry on 429)
        const bodyChunks = [];
        for await (const chunk of req) {
          bodyChunks.push(chunk);
        }
        const body = Buffer.concat(bodyChunks);
        const retryConfig = { ...DEFAULT_RETRY, ...(config.retry || {}) };
        const queueConfig = { ...DEFAULT_QUEUE, ...(config.queue || {}) };
        const canRetryBufferedBody = body.length <= retryConfig.maxRetryBufferBytes;
        requestInfo = describeRequest(req, body);
        const maxQueuedBodyBytes = queueConfig.maxQueuedBodyBytes == null
          ? Infinity
          : Math.max(0, Number(queueConfig.maxQueuedBodyBytes) || 0);
        const canQueueBufferedBody = body.length <= maxQueuedBodyBytes;
        if (!canQueueBufferedBody) {
          requestInfo.queueBlockedReason = `request body ${body.length} bytes exceeds queue.maxQueuedBodyBytes ${maxQueuedBodyBytes}`;
        }
        requestInfo.profile = getMaxpoolProfile(req.headers);
        requestInfo.sessionKey = headerValue(req.headers, 'x-maxpool-session');
        // (Removed a FALSE "provider fallback disabled for signed thinking" log here: it
        // fired on every thinking `all` request but was untrue under the default
        // when-exhausted/always policies — providers DO serve thinking requests — and it
        // repeatedly misdirected diagnosis of the "Stream idle timeout" reports.)
        prepareRuntimeProviders(accountManager, req.headers);

        await forwardRequest(
          req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, new Set(),
        );
      } catch (err) {
        ctx.status = ctx.status || 502;
        console.error('[Maxpool] Unhandled error:', err);
        // Only attempt an error body if the socket is still writable — a client
        // that aborted during body-read leaves res destroyed; writing then throws.
        if (!res.destroyed && !res.writableEnded && !res.headersSent) {
          sendErrorResponse(res, requestInfo, 502, {
            type: 'error',
            error: { type: 'proxy_error', message: 'Internal proxy error' },
          });
        }
      } finally {
        clearInterval(reaperTimer);
        hooks.onRequestEnd?.(reqId, {
          method: req.method, path: req.url,
          account: ctx.account, status: ctx.status,
        });
      }
    } catch (err) {
      console.error('[Maxpool] Unhandled error:', err);
    }
  });

  // Begin reload drain: every subsequent response gets `Connection: close` so
  // keep-alive clients retire their socket and don't pipeline a new request onto
  // this releasing worker.
  server.maxpoolBeginDrain = () => { draining = true; };

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

  // PRE-STRIP a session already known to carry provider-authored thinking. The client
  // resends the whole poisoned history every turn, so without this each turn pays another
  // rejected round-trip before the reactive repair kicks in. Latched by the first repair.
  // Apply the effort level this session's model already proved it accepts, so later turns
  // skip the rejected round-trip entirely (the client resends the same setting every turn).
  if (retryCount === 0 && !requestInfo.effortRepaired) {
    const latched = accountManager.getSessionEffort?.(requestInfo.sessionKey, requestInfo.model);
    if (latched) {
      const pre = repairEffort(body, latched.effort ? 'downgrade' : 'drop',
        latched.effort ? `Supported levels: ${latched.effort}` : '');
      if (pre.body) {
        body = pre.body;
        requestInfo = { ...requestInfo, effortRepaired: true };
      }
    }
  }

  // ALSO repairs a transcript maxpool predicts Anthropic will reject (a provider web
  // search). That prediction happens BEFORE any request is sent and bars every Claude
  // account, so the reactive repair in the 4xx handler could never be reached for it —
  // the session stayed exiled to GLM/Kimi, or got NO ROUTE AT ALL when they're disabled
  // (8 healthy Claude accounts idle while the user is told nothing is available).
  // Repairing here, ahead of routing, is what makes that case recoverable.
  if (retryCount === 0 && !requestInfo.thinkingStripped
    && (requestInfo.anthropicIncompatible
      || accountManager.isSessionThinkingContaminated?.(requestInfo.sessionKey))) {
    const pre = stripForeignThinkingBlocks(body);
    if (pre.body) {
      body = pre.body;
      requestInfo = { ...requestInfo, thinkingStripped: true };
      if (pre.converted) {
        // The body now replays cleanly on Claude, so drop the predictive verdict —
        // otherwise routing still exiles it and _noteRequestPolicy latches it sticky.
        requestInfo = { ...requestInfo, anthropicIncompatible: false };
        // And un-latch a session pinned by an EARLIER turn: the sticky policy is ORed in
        // and never downgrades, so without this the user's already-broken sessions stay
        // pinned forever even though we can now repair them.
        accountManager.clearSessionIncompatible?.(requestInfo.sessionKey);
      }
    }
  }

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

  // The admission (if this was a resumed queued request) has now been CONSUMED —
  // it got its account. Clear queueAdmitted so any subsequent internal failover
  // recursion (excludedIndexes path) re-enters the fairness gate as a normal
  // waiter instead of preferentially jumping ahead of the FIFO for the rest of
  // this request's failover chain.
  requestInfo.queueAdmitted = false;

  // Abort the upstream fetch and release the lease if the CLIENT disconnects during
  // the pre-response window (token refresh + connect + waiting for the upstream's
  // first byte). Without this, a client that drops mid-flight leaves account.inFlight
  // pinned until the fetch resolves on its own (~undici body timeout), benching
  // scarce capacity — acute for the hold feature, which targets already-scarce
  // accounts. The listener is removed once the response arrives; mid-stream
  // disconnects are handled by streamResponse's res.destroyed checks.
  const clientGone = new AbortController();
  const onClientClose = () => clientGone.abort();
  res.once('close', onClientClose);
  const releaseOnClientGone = () => {
    res.off('close', onClientClose);
    // The client vanished — we never got an upstream answer, so this carries ZERO
    // evidence about Anthropic's health. Hand the recovery probe back instead of
    // letting releaseAccount score it as a FAILED probe (which would re-arm the
    // fleet-wide throttle for 5s on every disconnect — a second deadlock amplifier).
    accountManager.relinquishUpstreamProbe?.(lease);
    accountManager.releaseAccount(lease);
    clearQueueHeartbeat(requestInfo);
    accountManager.removeQueuedRequest?.(requestInfo);
  };

  // Track which account handles this request
  ctx.account = account.name;
  hooks.onRequestRouted?.(reqId, { account: account.name });

  // Refresh OAuth token if needed
  const tokenReady = await accountManager.ensureTokenFresh(account.index);
  if (clientGone.signal.aborted) { releaseOnClientGone(); return; }
  if (!tokenReady) {
    // Token refresh failed (not a client disconnect). This frame is leaving via
    // recursion / queue / error WITHOUT reaching the post-fetch off() — drop the
    // 'close' listener now so it doesn't accumulate one-per-failover-hop on `res`
    // (MaxListenersExceededWarning + leak); the recursive/resumed frame registers
    // its own.
    res.off('close', onClientClose);
    // Token refresh failed — the request never reached Anthropic, so this is no
    // evidence about upstream health. Relinquish rather than fail the probe.
    accountManager.relinquishUpstreamProbe?.(lease);
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

  // TTFB guard: an upstream that accepts the connection but never sends response
  // headers would hang `await fetch` forever (signal only covers client-disconnect)
  // and leak the lease. Abort via a DEDICATED controller (so the caller can tell a
  // TTFB timeout apart from a client-gone abort) and CLEAR it the moment headers
  // arrive — the streaming body is then governed by the per-chunk idle guard, never
  // this fixed clock, so a long healthy stream is never cut.
  const ttfbController = new AbortController();
  const ttfbTimer = setTimeout(
    () => ttfbController.abort(Object.assign(new Error('upstream TTFB timeout'), { code: 'UPSTREAM_TTFB' })),
    UPSTREAM_TTFB_MS,
  );
  ttfbTimer.unref?.();
  // Proactive streaming keep-alive. UPSTREAM_TTFB_MS (120s) is FAR above the
  // client's own idle timeout (~23-60s), and the queue heartbeat only starts once
  // a request is QUEUED — so a streaming request whose selected upstream is slow to
  // first byte, or that burns the client's timeout cycling failover, sends the
  // client ZERO bytes and is aborted ("Stream idle timeout - no chunks received")
  // on a request maxpool is still serving. If bytes haven't arrived within the
  // grace, commit the SSE stream + heartbeat so the client stays alive. The
  // deadline is anchored ONCE per request (??=) so it also bounds CUMULATIVE
  // failover time across re-forwards, not each attempt independently.
  const streamForwardGraceMs = queueConfig?.streamForwardGraceMs == null
    ? 10000
    : Math.max(0, Number(queueConfig.streamForwardGraceMs) || 0);
  let streamGraceTimer = null;
  if (requestInfo.stream && !res.headersSent) {
    requestInfo.streamGraceDeadline ??= Date.now() + streamForwardGraceMs;
    const graceDelay = Math.max(0, requestInfo.streamGraceDeadline - Date.now());
    streamGraceTimer = setTimeout(
      () => commitStreamGraceHeartbeat(res, requestInfo, queueConfig, accountManager),
      graceDelay,
    );
    streamGraceTimer.unref?.();
  }
  try {
    let upstreamRes;
    try {
      upstreamRes = await fetch(upstreamUrl, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : upstreamBody,
        redirect: 'manual',
        signal: AbortSignal.any([clientGone.signal, ttfbController.signal]),
      });
    } finally {
      clearTimeout(ttfbTimer);
      // Stop the grace timer for THIS attempt — but LEAVE streamGraceDeadline set so
      // a re-forward (failover) re-arms for the REMAINING time to the shared deadline.
      if (streamGraceTimer) clearTimeout(streamGraceTimer);
    }
    // Response arrived — the pre-response leak window is over. Stop guarding for
    // client-disconnect via abort (streamResponse handles mid-stream disconnects).
    res.off('close', onClientClose);

    // Extract rate limit headers
    const rateLimitHeaders = {};
    for (const [key, value] of upstreamRes.headers.entries()) {
      rateLimitHeaders[key] = value;
    }
    accountManager.updateQuota(account.index, rateLimitHeaders);

    // SETTLE THE SHARED BREAKER AT THE HEADER BOUNDARY. Anthropic ANSWERED, so unless
    // the status is itself a capacity signal, the upstream is provably reachable and
    // serving — a per-request verdict (400 bad transcript, 401, 404, 413, 422) says
    // NOTHING about capacity and must never keep the fleet-wide throttle armed.
    // Without this, a poisoned request (e.g. a provider-authored thinking block that
    // Anthropic 400s) claimed the recovery probe, "failed" it, re-armed the shared
    // throttle every 5s, and benched EVERY healthy account indefinitely — a hard
    // production-down deadlock (2026-07-25: 6 of 13 re-arms were client-side 400s
    // while accounts sat at 2%/11%/25% weekly). confirmUpstreamProbe also clears
    // lease.upstreamThrottleProbe, so the releaseAccount probe branch below no-ops.
    if (!isCapacitySignalStatus(upstreamRes.status)) accountManager.confirmUpstreamProbe?.(lease);

    // Retry/failover can only happen before response bytes are sent. Once a
    // streaming response starts, rerouting would corrupt Claude Code's stream.
    if (upstreamRes.status === 429) {
      const errorBody = await readErrorBody(upstreamRes);
      const retryAfter = parseRetryAfter(upstreamRes.headers.get('retry-after'))
        || parseProviderRetryAfter(errorBody, account.provider);
      const rateLimit = classifyRateLimit(account, rateLimitHeaders, errorBody, { model: requestInfo.model, retryAfter });
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
        modelScope: rateLimit.modelScope || null,
      });
      accountManager.releaseAccount(lease, { status: 429, error: rateLimit.modelScope ? 'model_rate_limited' : 'rate_limited' });

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
      const forbidden = upstreamRes.status === 403;
      if (forbidden) {
        // 403 = almost always QUOTA/PLAN exhaustion (e.g. Kimi Coding-Plan weekly maxed),
        // NOT bad credentials — the usage probe still succeeds with the same key. Cool it
        // down RECOVERABLY (rides the rate-limit recovery in _isAvailable → auto-un-benches
        // at expiry) instead of the permanent auth-disable that stranded it until restart.
        // `neutral` release so a transient quota-403 doesn't bump failure/scoring counters.
        accountManager.markRateLimited(account.index, PROVIDER_FORBIDDEN_COOLDOWN_SEC, { status: 403, recordFailure: false });
        accountManager.releaseAccount(lease, { neutral: true });
      } else {
        // 401 = genuinely bad/missing credentials → permanent disable (needs re-auth).
        accountManager.markAuthFailed(account.index, upstreamRes.status, 'auth_failed');
        accountManager.releaseAccount(lease, { status: upstreamRes.status, error: 'auth_failed' });
      }
      excludedIndexes.add(account.index);

      if (logDir) {
        logSections.push(`=== RESPONSE ${upstreamRes.status} — "${account.name}" ${forbidden ? `cooled down ${PROVIDER_FORBIDDEN_COOLDOWN_SEC}s (quota/forbidden)` : 'disabled (auth)'}, failing over ===\n${formatHeaders(upstreamRes.headers)}`);
        if (errorBody) logSections.push(`=== ERROR BODY ===\n${errorBody}`);
      }
      console.log(`[Maxpool] ${upstreamRes.status} on provider "${account.name}" — ${forbidden ? `cooled down ${PROVIDER_FORBIDDEN_COOLDOWN_SEC}s (recoverable)` : 'disabled'} and failing over before first byte`);

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
      // A transcript a lenient provider (GLM/Kimi) produced can be rejected by
      // Anthropic on replay (a non-srvtoolu_ server_tool_use id, or a thinking
      // signature it can't validate). Detect it on an Anthropic account so we can
      // self-heal onto a provider instead of surfacing the 400.
      const anthropicIncompat = account.type !== 'provider' && isAnthropicIncompatBody(errorBody);
      // A provider (GLM ~200K / Kimi 256K context) rejecting an oversized request that
      // only a large-context Claude (1M) can hold — e.g. "exceeded model token limit:
      // 262144". Detect it ONLY on a provider (a Claude account's context-length 400 is
      // terminal — nothing bigger to fall to) so we can pin the session to Claude.
      const providerTooSmall = account.type === 'provider' && isContextLengthError(errorBody);
      // DETERMINISTIC signature rejection (exact Anthropic wording) — the only trigger
      // for the strip-and-recover retry below. Deliberately NOT the fuzzy
      // isAnthropicIncompatBody heuristic, so a merely malformed request can never cause
      // us to rewrite a user's transcript.
      // Two deterministic shapes, both repairable by stripping: a signature Anthropic
      // can't validate, AND a provider block that carries NO signature field at all
      // ("messages.4.content.0.thinking.signature: Field required"). The second variant
      // used to fall straight through to a PERMANENT provider pin even though stripping
      // fixes it. Still deterministic — never the fuzzy isAnthropicIncompatBody heuristic.
      const isSignatureRejection = account.type !== 'provider'
        && (/invalid `signature` in `thinking`/i.test(errorBody)
          || /content\.\d+\.thinking\.signature/i.test(errorBody)
          // A provider web search: `server_tool_use.id: String should match pattern
          // '^srvtoolu_…'`. Repairable by converting the pair to text (verified 200 OK) —
          // it used to fall through to a PERMANENT provider pin.
          || /server_tool_use\.id: String should match pattern/i.test(errorBody));
      // LOG THE ACTUAL REASON. Previously a 4xx recorded only "HTTP 400" and the upstream
      // message was never written anywhere, so a whole class of failures (e.g. a rejected
      // effort level breaking every web search) was invisible in the log — you could not
      // even grep for it. Truncated so a huge validation dump can't wall the file.
      if (upstreamRes.status >= 400 && upstreamRes.status !== 429) {
        const why = (() => {
          try { return JSON.parse(errorBody)?.error?.message || errorBody; } catch { return errorBody; }
        })();
        console.log(`[Maxpool] ${upstreamRes.status} from "${account.name}": ${String(why).slice(0, 300)}`);
      }
      const errorType = errorBody.includes('Invalid `signature` in `thinking` block')
        ? 'invalid_thinking_signature'
        : anthropicIncompat ? 'anthropic_incompatible_transcript'
        : providerTooSmall ? 'provider_context_too_small'
        : `HTTP ${upstreamRes.status}`;
      const effortMode = classifyEffortRejection(errorBody);
      // A rejected effort level is a REQUEST-shaped fault, not an account-health signal —
      // release neutral so it never charges a consecutive-failure to a healthy account.
      accountManager.releaseAccount(lease, effortMode
        ? { status: upstreamRes.status, error: errorType, neutral: true }
        : { status: upstreamRes.status, error: errorType });

      if (logDir) {
        logSections.push(`=== RESPONSE ${upstreamRes.status} — non-retryable client error from "${account.name}" ===\n${formatHeaders(upstreamRes.headers)}`);
        if (errorBody) logSections.push(`=== ERROR BODY ===\n${errorBody}`);
        writeRequestLog(logDir, reqId, logSections);
      }
      if (errorType === 'invalid_thinking_signature') {
        console.log(`[Maxpool] Non-retryable Anthropic thinking signature error on "${account.name}"`);
        // Fail-safe: if this request had been MIGRATED to a different Claude account
        // this turn (cross-account thinking rebalance), the rejected block was issued
        // by the PRE-MIGRATION account. Revert the session there, exclude the failed
        // target, and retry PINNED to the issuer — so a rejected cross-account replay
        // self-heals instead of poisoning the session into a 400 loop. Signatures are
        // portable in practice (verified 2026-07-02); this only fires if Anthropic
        // ever account-binds them.
        if (lease.migratedFromName && requestInfo.sessionKey
          && canRetryBufferedBody && retryCount + 1 < maxAttempts && !res.headersSent) {
          accountManager.revertSessionBinding(requestInfo.sessionKey, lease.migratedFromName);
          excludedIndexes.add(account.index);
          console.log(`[Maxpool] Thinking-signature fail-safe: reverting session to issuer "${lease.migratedFromName}" and retrying`);
          return forwardRequest(
            req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
            retryConfig, queueConfig, { ...requestInfo, pinnedAccountName: lease.migratedFromName },
            canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
          );
        }
      }

      // EFFORT REPAIR. A rejected output_config.effort is a hard failure of whatever the
      // client was doing (a web search, a tool call) — worth healing rather than surfacing.
      if (effortMode && !requestInfo.effortRepaired
        && canRetryBufferedBody && retryCount + 1 < maxAttempts && !res.headersSent) {
        const fix = repairEffort(body, effortMode, errorBody);
        if (fix.body) {
          // Latch it so LATER turns apply the working level up front: the client resends the
          // same rejected setting every turn, and each rejection would otherwise charge a
          // consecutive-failure to a healthy account and deprioritise it in the router.
          accountManager.markSessionEffort?.(requestInfo.sessionKey, requestInfo.model, fix.effort);
          console.log(`[Maxpool] "${requestInfo.model || 'model'}" rejected effort "${requestInfo.effort || 'xhigh'}" (via ${account.name}); retrying with ${fix.effort ? `effort "${fix.effort}"` : 'the effort setting removed'}`);
          return forwardRequest(
            req, res, fix.body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
            retryConfig, queueConfig, { ...requestInfo, effortRepaired: true },
            canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
          );
        }
      }

      // RECOVER-ON-CLAUDE (preferred over the provider pin below): the transcript
      // carries provider-authored thinking blocks whose signature Anthropic rejects.
      // Strip exactly those blocks and retry on Claude, so a session that took even one
      // GLM/Kimi fallback turn is NOT bricked (or exiled to a provider) for the rest of
      // its life. Verified against the real API — the stripped history returns 200, with
      // text + tool_use preserved. Tried once per request (thinkingStripped guard); if it
      // still fails, the provider pin below is the fallback.
      if (isSignatureRejection && !requestInfo.thinkingStripped
        && canRetryBufferedBody && retryCount + 1 < maxAttempts && !res.headersSent) {
        const { body: cleanBody, removed, converted } = stripForeignThinkingBlocks(body);
        if (cleanBody) {
          // Latch it so EVERY later turn is stripped up front instead of re-paying this
          // rejected round-trip (the client resends the full poisoned history each turn).
          accountManager.markSessionThinkingContaminated?.(requestInfo.sessionKey);
          console.log(`[Maxpool] Recovering session on Claude: stripped ${removed} provider thinking block(s), converted ${converted} provider search block(s) to text`);
          return forwardRequest(
            req, res, cleanBody, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
            retryConfig, queueConfig, { ...requestInfo, thinkingStripped: true },
            canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
          );
        }
      }

      // React-and-heal: this transcript can't run on Claude (foreign server_tool_use
      // id / thinking Anthropic can't validate). The 400 is pre-stream and the body
      // is buffered, so latch the session Anthropic-incompatible (sticky → once per
      // session) and retry PROVIDER-only, rather than surfacing the 400. Only worth
      // it when a provider can actually serve it (profile=all with a GLM/Kimi token).
      const providerAvailable = accountManager.accounts?.some(a => a.type === 'provider' && a.enabled !== false);
      if (anthropicIncompat && requestInfo.sessionKey && providerAvailable
        && canRetryBufferedBody && retryCount + 1 < maxAttempts && !res.headersSent) {
        accountManager.markSessionIncompatible?.(requestInfo.sessionKey, requestInfo.homeProvider);
        excludedIndexes.add(account.index);
        console.log(`[Maxpool] Anthropic rejected this transcript (server_tool_use/thinking); pinning session to GLM/Kimi and retrying`);
        return forwardRequest(
          req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, { ...requestInfo, anthropicIncompatible: true },
          canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
        );
      }

      // React-and-heal: a PROVIDER (GLM/Kimi coding endpoint, fixed ~256K context)
      // rejected an oversized request only a 1M-context Claude can hold — e.g. Kimi's
      // "exceeded model token limit: 262144 (requested: 643557)". The coding leg IGNORES
      // the model id, so a K3/GLM-1M plan doesn't lift its ceiling. Latch the session
      // large-context (so its follow-up turns skip the too-small providers) and retry
      // EXCLUDING every provider → routes to Claude, or HOLDS for a Claude account,
      // instead of surfacing a 400 the client just retry-loops on. Only worth it when a
      // Claude account exists to serve it; with none, the 400 surfaces (nothing bigger).
      const claudeAvailable = accountManager.accounts?.some(a => a.type !== 'provider' && a.enabled !== false);
      if (providerTooSmall && requestInfo.sessionKey && claudeAvailable
        && canRetryBufferedBody && retryCount + 1 < maxAttempts && !res.headersSent) {
        accountManager.markSessionLargeContext?.(requestInfo.sessionKey);
        // Bench EVERY provider: today's GLM + Kimi coding legs both cap at ~256K, so once
        // one 400s on size the others can't hold it either. If a genuine 1M-context
        // provider is ever added, make this exclusion context-limit-aware instead of
        // type-wide (the _isRequestCompatible gate would need the same treatment).
        for (const a of (accountManager.accounts || [])) {
          if (a.type === 'provider') excludedIndexes.add(a.index);
        }
        console.log(`[Maxpool] Provider "${account.name}" context too small for this request; pinning session to Claude and retrying`);
        return forwardRequest(
          req, res, body, accountManager, upstream, retryCount + 1, hooks, reqId, ctx, logDir,
          retryConfig, queueConfig, { ...requestInfo, largeContext: true },
          canRetryBufferedBody, canQueueBufferedBody, excludedIndexes,
        );
      }

      // Nothing could heal it — replace the cryptic upstream 400 with the real cause and
      // the actual way out. This is what the user saw for hours as a bare
      // "400 messages.51.content.8: Invalid `signature` in `thinking` block".
      // Trigger on the DETERMINISTIC signature rejection only — never the fuzzy
      // isAnthropicIncompatBody heuristic, so an unrelated malformed request keeps its
      // own upstream error instead of being mislabelled a provider-contamination.
      if (isSignatureRejection && !res.headersSent) {
        const provs = (accountManager.accounts || []).filter(a => a.type === 'provider');
        // Say only what ACTUALLY happened. `thinkingStripped` is set only when the strip
        // ran; without it we found nothing provider-shaped, so claiming we stripped —
        // or blaming GLM/Kimi — would misdirect the user.
        const what = requestInfo.thinkingStripped
          ? 'This session ran on GLM/Kimi earlier, and Anthropic will not accept parts of what they wrote. Maxpool repaired what it could and retried on Claude, but Anthropic still rejected the history.'
          : "Anthropic rejected part of this session's history that maxpool could not repair automatically.";
        const hint = provs.length === 0
          ? ''
          : provs.every(a => a.enabled === false)
            ? ' If this session previously ran on GLM/Kimi, re-enabling that provider in the maxpool TUI (a → t) lets it continue there.'
            : '';
        ctx.status = 400;
        sendErrorResponse(res, requestInfo, 400, {
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: `Start a new session to keep working — this one cannot continue. ${what}${hint}`,
          },
        });
        return;
      }

      ctx.status = upstreamRes.status;
      sendErrorBody(res, requestInfo, upstreamRes.status, errorBody, upstreamRes.headers);
      return;
    }

    if (upstreamRes.status < 400) {
      // (the probe was already settled at the header boundary above — this only
      // records the account-level "upstream accepted us" signal)
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
      // Bound the non-streaming body read so a mid-body upstream stall can't hang
      // the request forever and leak the lease (same class as the streaming idle
      // guard). On timeout → UPSTREAM_BODY → the caller frees the lease.
      const bodyP = upstreamRes.arrayBuffer();
      bodyP.catch(() => {});
      let bodyTimer;
      const bodyTimeout = new Promise((_, reject) => {
        bodyTimer = setTimeout(
          () => reject(Object.assign(new Error('upstream body timeout'), { code: 'UPSTREAM_BODY' })),
          UPSTREAM_BODY_MS,
        );
        bodyTimer.unref?.();
      });
      let arr;
      try {
        arr = await Promise.race([bodyP, bodyTimeout]);
      } finally {
        clearTimeout(bodyTimer);
      }
      const buf = Buffer.from(arr);
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
          // We already committed `200 text/event-stream` (the queue heartbeat), but
          // the resumed upstream returned a NON-streaming body. Writing the raw JSON
          // as a lone `data:` line corrupts the client's SSE parser (no message_start
          // envelope, no message_stop). Frame it as a proper SSE error event so the
          // client fails cleanly instead of hanging/mis-parsing. (Rare: an upstream
          // honoring stream:true never lands here; reachable on a fallback upstream
          // quirk.)
          res.write(`event: error\ndata: ${JSON.stringify({
            type: 'error',
            error: {
              type: 'api_error',
              message: `Upstream returned a non-streaming ${upstreamRes.status} response for a streaming request`,
            },
          })}\n\n`);
          res.end();
        }
      } else {
        if (!res.headersSent) res.writeHead(upstreamRes.status, responseHeaders);
        res.end(buf);
      }
    }
  } catch (err) {
    res.off('close', onClientClose);
    // Client disconnected mid-flight → we aborted the upstream fetch. Release the
    // lease (free the scarce account) and STOP: no retry (the client is gone), no
    // write (the socket is dead).
    if (clientGone.signal.aborted) {
      // LOG IT. This silent return hid every client-side give-up: 60 requests in 2.4 days
      // died here leaving only an indistinguishable `(null, 300.0s)` line. `committed`
      // separates "the user saw a partial answer" (real harm, unretryable) from "the user
      // was still waiting" — and the elapsed time is what exposes a client watchdog firing
      // at its floor while maxpool was still happily holding the request.
      const heldMs = Date.now() - (requestInfo.startedAt || Date.now());
      console.log(`[Maxpool] Client left after ${(heldMs / 1000).toFixed(1)}s on "${account.name}" `
        + `(${res.headersSent ? 'mid-response — output already sent' : 'still waiting, nothing sent'})`);
      releaseOnClientGone();
      return;
    }
    // undici reports every socket/DNS/TLS failure as the bare string "fetch failed" and
    // hangs the REAL reason off err.cause. Logging err.message alone threw that away: 588
    // "fetch failed" lines and ZERO ECONNRESET/ENOTFOUND/UND_ERR in the whole log, leaving
    // every incident unattributable (DNS? TLS? socket exhaustion?).
    const rootCause = err.cause?.code || err.cause?.message || err.code || '';
    console.error(`[Maxpool] Upstream error (account "${account.name}"):`, err.message
      + (rootCause && !String(err.message).includes(rootCause) ? ` (cause: ${rootCause})` : ''));

    if (logDir) {
      logSections.push(`=== ERROR ===\n${err.stack || err.message}`);
      writeRequestLog(logDir, reqId, logSections);
    }

    const isTransient = err instanceof Error &&
      (err.message.includes('fetch failed') ||
        // Read BOTH: on an undici fetch rejection err.code is undefined and the code lives
        // on err.cause, so the bare err.code branches were dead — only the 'fetch failed'
        // string match kept this classification alive.
        isNetworkCode(err.code) || isNetworkCode(err.cause?.code) ||
        // Upstream-hang guards: a stalled connection is network-class, not the
        // account's fault → 5s cooldown + release + (pre-headers) retry elsewhere;
        // once committed, isTransient falls through to sendErrorResponse which ends
        // the client's SSE cleanly (frees the lease AND unhangs the client).
        err.code === 'UPSTREAM_TTFB' || err.code === 'UPSTREAM_IDLE' || err.code === 'UPSTREAM_BODY' ||
        err.message.includes('terminated'));

    if (isTransient) {
      // Network-class (ECONNRESET / fetch failed / timeout / terminated): short fixed
      // cooldown, no exponential escalation — the fleet auto-recovers seconds after
      // connectivity returns instead of being benched for up to 15 min.
      accountManager.markTransientFailure(account.index, err.code || err.message || 'network_error', { network: true });
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
      // Record the user-facing failure explicitly so it's greppable in the event
      // log (the in-memory TUI feed scrolls away). `err` is the last network error.
      console.error(`[Maxpool] Returned connection_unavailable (503) after network errors on all routes (last: "${account.name}" — ${err.code || err.message})`);
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

/**
 * Hold-window ceiling for a queued request. The soonest-recovery oracle
 * (nextRetryForRequest) is the real governor — this is the backstop ceiling that
 * bounds how long a request may WAIT for that recovery.
 *
 *   non-streaming (no heartbeat)  → short cap (would die on the client's own timeout)
 *   streaming + capacity/429/throttle → maxWaitMs (24h): HELD on the SSE heartbeat
 *       until an account frees. This is the "hold, don't fail" fix — a throttle clears
 *       in seconds and a 5h session-cap in hours, both far under 24h; only a multi-day
 *       weekly reset exceeds it and error-fasts with the honest "add an account"
 *       message. Previously capped at the short capacityMaxWaitMs (15m), which failed
 *       the MOST-clearly-temporary throttle sooner than an ordinary per-account 429.
 *   streaming + other (quota)     → streamHoldMaxMs (7d)
 *   retryPlanCause==='concurrency_cap' → clamped to the short capacity window (a LOCAL
 *       transient: a slot frees in seconds; never spin a multi-day hold on it).
 */
function computeQueueWindowMs({
  cause, stream, retryPlanCause,
  maxWaitMs, capacityMaxWaitMs, nonStreamMaxWaitMs, streamHoldMaxMs, streamClientToleranceMs,
  isCountTokens, countTokensMaxWaitMs,
}) {
  let windowMs;
  if (!stream) {
    windowMs = cause === 'capacity' ? Math.min(nonStreamMaxWaitMs, capacityMaxWaitMs) : nonStreamMaxWaitMs;
  } else if (cause === 'capacity') {
    windowMs = maxWaitMs;
  } else {
    windowMs = streamHoldMaxMs;
  }
  if (retryPlanCause === 'concurrency_cap') windowMs = Math.min(windowMs, capacityMaxWaitMs);
  // Bound EVERY streaming cause to the client-tolerance ceiling — the client's own
  // watchdog kills the stream well before a 24h/7d server hold, so anything past this
  // just parks an abandoned request. A finite reset WITHIN the ceiling still holds +
  // resumes (via the nextRetryForRequest oracle); a reset beyond it error-fasts (a real
  // retryable 429 at the pre-heartbeat gate) instead of hanging.
  if (stream && streamClientToleranceMs != null) windowMs = Math.min(windowMs, streamClientToleranceMs);
  // count_tokens: cap the QUEUE wait low (bounds only the wait-for-an-account, never
  // the upstream processing once acquired) so a non-heartbeated metadata call fast-
  // fails with a retryable 429 instead of hanging past the client's idle window.
  if (isCountTokens && countTokensMaxWaitMs != null) windowMs = Math.min(windowMs, countTokensMaxWaitMs);
  return windowMs;
}

function unavailableMessage(accountManager, requestInfo = {}, retryAfter, willRecoverSoon = true) {
  const incompat = accountManager._effectiveIncompatible?.(requestInfo) || { incompatible: false, homeProvider: null };

  // An Anthropic-incompatible session is pinned to provider accounts — Anthropic
  // 400s on its server_tool_use id / foreign thinking. "All Claude at limit" would
  // be the wrong story (Claude is irrelevant to it); say what actually blocks it.
  if (incompat.incompatible) {
    const fam = incompat.homeProvider === 'zai' ? 'GLM' : incompat.homeProvider === 'kimi' ? 'Kimi' : 'GLM/Kimi';
    const eta = Number.isFinite(retryAfter) && retryAfter > 0 ? ` Retry in ${retryAfter}s.` : '';
    return `This session's transcript can only run on ${fam} — Claude rejects its server-tool ids/thinking on replay. No ${fam} provider is available right now.${eta} Check the x-maxpool-zai-token / x-maxpool-kimi-token headers, or resume with 'cc ${incompat.homeProvider === 'kimi' ? 'kimi' : 'glm'}'.`;
  }

  // A large-context session (a provider already 400'd it as too big for its ~256K leg):
  // only a 1M-context Claude can hold it — the providers are structurally BARRED, not
  // merely "at their limit". Say the oversized truth + the two real ways out (wait for a
  // Claude account, or /compact), instead of the misleading "providers at limit" line.
  if (accountManager._isSessionLargeContext?.(requestInfo)) {
    const eta = Number.isFinite(retryAfter) && retryAfter > 0
      ? ` A Claude account should free in ~${formatRetryDuration(retryAfter)}.` : '';
    return `This session is too large for the GLM/Kimi fallbacks (their ~256K limit) — it needs a 1M-context Claude account, and they're all busy right now.${eta} It sends as soon as one frees; /compact shortens the session if you'd rather not wait.`;
  }

  const claudeCount = accountManager.accounts.filter(a => a.type !== 'provider').length;
  // Only name the providers when this pool actually HAS them (`cc all`). On `cc ma`
  // (Claude-only) there are none, so the old hardcoded "and the GLM/Kimi providers"
  // was a lie. When present they DO serve (not barred), so they're saturated too.
  const providersClause = accountManager.accounts.some(a => a.type === 'provider')
    ? ' and the GLM/Kimi providers' : '';

  // No route is expected to recover within the queue window — i.e. every Claude
  // account is at its own 5h/weekly limit. A short "retry in Ns" would be a lie;
  // tell the user the real fix.
  if (!willRecoverSoon) {
    const eta = Number.isFinite(retryAfter) && retryAfter > 0
      ? ` Soonest reset in ~${formatRetryDuration(retryAfter)}, beyond the hold window.`
      : '';
    return `No account can take this request — all ${claudeCount} Claude accounts${providersClause} are at their limit.${eta} Add another Claude account or wait for a quota reset.`;
  }

  return `No account can take this request right now — all ${claudeCount} Claude accounts${providersClause} are momentarily at their limit. Retry in ${retryAfter}s.`;
}

// A provider (GLM/Kimi) rejecting a request whose token count exceeds its context
// window — Kimi's coding leg ("exceeded model token limit: 262144"), GLM's, or an
// OpenAI-style "maximum context length". Kept narrow (specific context-overflow
// phrasings, NOT a bare "token limit" which a rate-limit body also carries) so the
// pin-to-Claude heal only fires on a genuine size overflow, not any 400. Rate-limit
// 429s are intercepted earlier (classifyRateLimit) and never reach this check.
function isContextLengthError(errorBody) {
  if (!errorBody) return false;
  return /exceeded model token limit|maximum context length|context length exceeded|context window (?:size )?(?:exceeded|too)|prompt is too long|input is too long|reduce the length of|too many (?:input )?tokens|request too large/i.test(errorBody);
}

export const __serverTest = { unavailableMessage, computeQueueWindowMs, isRetriableUpstreamStatus, classifyEffortRejection, repairEffort, isCapacitySignalStatus, isStrippableThinkingBlock, stripForeignThinkingBlocks, headerValue, getMaxpoolProfile, ensureQueueHeartbeat, clearQueueHeartbeat, commitStreamGraceHeartbeat, describeRequest, classifyRateLimit, detectTranscriptOrigin, isAnthropicIncompatBody, isContextLengthError, streamResponse, startIdleRequestReaper };

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

function classifyRateLimit(account, headers, body, opts = {}) {
  if (account.type === 'provider') return { scope: 'account', fingerprint: null };

  const parsed = parseJsonError(body);
  const message = String(parsed?.message || '').toLowerCase();
  const type = String(parsed?.type || '').toLowerCase();
  const unifiedStatus = String(headers['anthropic-ratelimit-unified-status'] || '').toLowerCase();
  const fiveHour = Number(headers['anthropic-ratelimit-unified-5h-utilization']);
  const weekly = Number(headers['anthropic-ratelimit-unified-7d-utilization']);
  const tokensRemaining = Number(headers['anthropic-ratelimit-tokens-remaining']);
  const requestsRemaining = Number(headers['anthropic-ratelimit-requests-remaining']);

  // A PER-MODEL weekly sub-limit (e.g. Fable) rejects while the account's UNIFIED
  // quota is healthy. We can't rely on a captured Fable-429 body shape, so detect
  // by the CONTRADICTION: a weekly-class (long) reset AND both unified buckets NOT
  // exhausted AND the request carries a known model family. Tagging modelScope
  // makes the failover bench only (account, model) — not the whole account (which
  // still has headroom for its other models). retryAfter is in SECONDS.
  const fam = modelFamily(opts.model);
  const retryAfter = Number(opts.retryAfter);
  // Model-scope requires POSITIVE evidence the unified quota has headroom: at least
  // one unified utilization header present AND both present ones below the floor. A
  // rejection with NO utilization headers is treated as account-wide (safer — a
  // genuine account cap with stripped headers must bench the whole account, not one
  // model). Neither bucket may be at/above the exhaustion floor.
  const haveUnifiedEvidence = Number.isFinite(weekly) || Number.isFinite(fiveHour);
  // Exhaustion floor for 429-SCOPE classification — kept in sync with the scheduler's
  // weeklyExhaustedThreshold (0.999, use-it-or-lose-it). A 429 whose unified buckets are
  // still below the floor isn't weekly-exhaustion, so a model-family + long-retry-after
  // 429 benches only that model, not the whole (still-usable) account — matching routing,
  // which now treats 0.95-0.999 as usable (critical), not benched.
  const EXHAUSTION_FLOOR = 0.999;
  const unifiedNotExhausted =
    (!Number.isFinite(weekly) || weekly < EXHAUSTION_FLOOR) && (!Number.isFinite(fiveHour) || fiveHour < EXHAUSTION_FLOOR);
  const modelScope =
    (fam && haveUnifiedEvidence && unifiedNotExhausted && Number.isFinite(retryAfter) && retryAfter >= 30 * 60)
      ? fam : null;

  const quotaHeaderExhaustion =
    unifiedStatus === 'rejected'
    || (Number.isFinite(fiveHour) && fiveHour >= EXHAUSTION_FLOOR)
    || (Number.isFinite(weekly) && weekly >= EXHAUSTION_FLOOR)
    || (headers['anthropic-ratelimit-tokens-remaining'] != null && tokensRemaining <= 0)
    || (headers['anthropic-ratelimit-requests-remaining'] != null && requestsRemaining <= 0);
  if (quotaHeaderExhaustion) return { scope: 'account', fingerprint: null, modelScope };

  const quotaBodyExhaustion =
    /\b(account|plan|session|weekly|quota)\b.{0,40}\b(exhausted|limit|exceeded|reached)\b/i.test(message)
    || /\busage\b.{0,40}\b(exhausted|exceeded|reached)\b/i.test(message);
  if (quotaBodyExhaustion) return { scope: 'account', fingerprint: null, modelScope };

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

// Provider thinking signatures CANNOT be told apart from Anthropic's by shape — measured
// against the live APIs 2026-07-25: Anthropic ~200-400 char base64, GLM a 24-char hex
// digest, Kimi(K3) a 12,946-char base64 blob. A shape heuristic tuned to GLM silently
// missed Kimi entirely. So the repair below does NOT guess: it strips EVERY `thinking`
// block. That is safe precisely because it only ever runs in response to Anthropic's own
// signature-rejection 400 — a healthy Claude-only session never reaches it — and a history
// with thinking removed is accepted (200 OK, verified, incl. tool_use → tool_result).
// `redacted_thinking` is never touched: it legitimately carries `data` and no signature.
function isStrippableThinkingBlock(block) {
  return block?.type === 'thinking';
}

/**
 * Recovery for a provider-contaminated transcript: drop the assistant `thinking` /
 * `redacted_thinking` blocks whose signature Anthropic can't validate, so the session
 * can CONTINUE ON CLAUDE instead of being pinned to a provider forever.
 *
 * Empirically verified 2026-07-25 against the real API: replaying a GLM-authored
 * thinking block to Anthropic returns 400; the SAME history with those blocks removed
 * returns 200 — including an assistant turn carrying `tool_use` followed by a
 * `tool_result` (thinking blocks are not required on replay for a new turn). Text and
 * tool_use blocks are preserved, so no conversation content or tool wiring is lost.
 *
 * Returns { body, removed } — `body` is null when nothing needed stripping.
 */
// A provider's web search leaves a `server_tool_use` id Anthropic rejects (it demands
// ^srvtoolu_). Verified 2026-07-26 against the live API: renaming the id is NOT enough —
// a second gate rejects the result's `encrypted_content`, which only Anthropic can mint.
// But converting the pair into plain TEXT is accepted (200 OK) and keeps what the search
// actually found, so the session survives with its information intact. This is what made
// the web-search case look permanently unrepairable.
// Claude Code can send an `output_config.effort` the target model won't take — usually
// after the session's model changes (a resume/fallback) while the effort setting stays.
// It is a HARD error: the tool call just fails, which is what killed the user's web
// searches. Three shapes seen live 2026-07-26, all repairable:
//   "does not support effort level 'xhigh'. Supported levels: high, low, medium" -> downgrade
//   "'xhigh' is not supported when thinking is disabled … Use effort 'high' or below" -> downgrade
//   "does not support the effort parameter."                                       -> drop it
function classifyEffortRejection(errorBody) {
  if (!/effort/i.test(errorBody)) return null;
  if (/does not support the effort parameter/i.test(errorBody)) return 'drop';
  if (/does not support effort level|is not supported when thinking is disabled/i.test(errorBody)
    || /output_config\.effort: Input should be/i.test(errorBody)) {   // invalid value from the client
    return 'downgrade';
  }
  return null;
}

/** Rewrite the request's effort so the model accepts it. 'downgrade' picks the best level
 *  the error itself advertises (falling back to 'high'); 'drop' removes the field. */
function repairEffort(body, mode, errorBody = '') {
  try {
    const json = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    const cur = json?.output_config?.effort;
    if (!cur) return { body: null, effort: null };
    if (mode === 'drop') {
      delete json.output_config.effort;
      if (Object.keys(json.output_config).length === 0) delete json.output_config;
      return { body: Buffer.from(JSON.stringify(json)), effort: null };
    }
    // Prefer a level the error explicitly lists, else 'high' (what the message recommends).
    const rank = ['max', 'xhigh', 'high', 'medium', 'low'];
    const listed = /supported levels:\s*([a-z, ']+)/i.exec(errorBody)?.[1];
    let allowed = listed ? listed.split(',').map(x => x.trim().replace(/'/g, '').toLowerCase()).filter(Boolean) : [];
    // The other real shape names a ceiling instead of a list: "Use effort 'high' or below".
    const ceiling = /use effort '([a-z]+)' or below/i.exec(errorBody)?.[1]?.toLowerCase();
    if (!allowed.length && ceiling) allowed = rank.slice(rank.indexOf(ceiling)).filter(Boolean);
    let next = rank.find(r => allowed.includes(r));
    // Nothing usable advertised (or it names the level we already sent) — step strictly
    // BELOW the current level rather than giving up, so we never retry the same value.
    if (!next || next === cur) {
      const below = rank.slice(rank.indexOf(cur) + 1);
      next = below.find(r => !allowed.length || allowed.includes(r)) || below[0];
    }
    if (!next || next === cur) return { body: null, effort: null };
    json.output_config.effort = next;
    return { body: Buffer.from(JSON.stringify(json)), effort: next };
  } catch {
    return { body: null, effort: null };
  }
}

/** Collect foreign server-tool ids across the WHOLE transcript first — a call sits on the
 *  assistant turn but its result is often carried on the FOLLOWING user turn, so a
 *  per-message scan would leave that result behind (and it alone still 400s). */
function collectForeignServerToolIds(messages) {
  const ids = new Set();
  const clientIds = new Set();
  const walk = (blocks) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b?.type === 'tool_use' && b.id) clientIds.add(b.id);
      if (b?.type === 'server_tool_use' && !ANTHROPIC_TOOL_ID.test(String(b.id || ''))) ids.add(b.id);
      if (Array.isArray(b?.content)) walk(b.content);   // nested, mirrors detectTranscriptOrigin
    }
  };
  for (const msg of messages) walk(msg?.content);
  // NEVER treat an id that a real client tool_use also owns as foreign: converting its
  // tool_result would orphan that tool_use and Anthropic 400s ("tool_use ids without
  // tool_result"), which the sticky pre-strip would then re-inflict every turn — a
  // permanent loop. Providers with per-turn counters (call_0, call_1) make the collision
  // likely, not theoretical.
  for (const id of clientIds) ids.delete(id);
  return ids;
}

function convertForeignServerTools(content, foreignIds) {
  if (!foreignIds || foreignIds.size === 0) return { content, converted: 0 };
  let converted = 0;
  const out = [];
  for (const b of content) {
    if (b?.type === 'server_tool_use' && foreignIds.has(b.id)) {
      const q = b.input?.query;
      out.push({ type: 'text', text: q ? `[searched the web for: ${q}]` : `[used ${b.name || 'a tool'}]` });
      converted++;
      continue;
    }
    // Any result block referring to a foreign call — web_search_tool_result and friends.
    if (b?.tool_use_id && foreignIds.has(b.tool_use_id)) {
      const rows = Array.isArray(b.content) ? b.content : [];
      // Fall back through the shapes a PROVIDER may use — the point of converting rather
      // than dropping is to keep what the search found; assuming Anthropic's {title,url}
      // would silently discard a GLM row that carries text instead.
      const found = rows
        .map(r => [r?.title, r?.url].filter(Boolean).join(' — ')
          || (typeof r === 'string' ? r : (r?.text ?? r?.content ?? r?.snippet ?? '')))
        .map(t => (typeof t === 'string' ? t.slice(0, 300) : ''))
        .filter(Boolean).slice(0, 10);
      out.push({ type: 'text', text: found.length ? `[search results: ${found.join(' | ')}]` : '[search returned no usable results]' });
      converted++;
      continue;
    }
    out.push(b);
  }
  return { content: out, converted };
}

function stripForeignThinkingBlocks(body) {
  try {
    const json = JSON.parse(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
    if (!Array.isArray(json?.messages)) return { body: null, removed: 0 };
    let removed = 0;
    let converted = 0;
    const foreignToolIds = collectForeignServerToolIds(json.messages);
    const messages = [];
    for (const msg of json.messages) {
      if (!Array.isArray(msg?.content)) { messages.push(msg); continue; }
      // Foreign server-tool pairs are converted on EVERY role: the call sits on the
      // assistant turn but its result can be carried on the following user turn.
      const tools = convertForeignServerTools(msg.content, foreignToolIds);
      converted += tools.converted;
      if (msg.role !== 'assistant') {
        messages.push(tools.converted ? { ...msg, content: tools.content } : msg);
        continue;
      }
      let localRemoved = 0;
      const kept = tools.content.filter(block => {
        if (!isStrippableThinkingBlock(block)) return true;
        localRemoved++;
        return false;
      });
      removed += localRemoved;
      if (!localRemoved) {
        messages.push(tools.converted ? { ...msg, content: tools.content } : msg);
        continue;
      }
      // A turn that stripping empties is DROPPED, not left with its poisoned block:
      // leaving it would resend the exact body that just 400'd while reporting success
      // and burning the single recovery attempt. Verified against the live API — the
      // resulting consecutive user messages are accepted (200 OK).
      if (kept.length === 0) continue;
      messages.push({ ...msg, content: kept });
    }
    if (!removed && !converted) return { body: null, removed: 0, converted: 0 };
    json.messages = messages;
    return { body: Buffer.from(JSON.stringify(json)), removed, converted };
  } catch {
    return { body: null, removed: 0, converted: 0 };   // non-JSON / unparseable → no rewrite
  }
}

/**
 * Is this status a CAPACITY signal (i.e. evidence the upstream can't serve us right
 * now), as opposed to a per-request verdict? Only these may keep the shared Anthropic
 * throttle armed. 403 is included deliberately: on these plans a 403 is almost always
 * quota/plan exhaustion, NOT bad credentials (see the provider-auth handler). 408 is a
 * latency/capacity signal. Everything else in 4xx (400/401/404/413/422…) means Anthropic
 * answered a specific request — the upstream is alive.
 */
function isCapacitySignalStatus(status) {
  return status === 429 || status === 403 || status === 408 || status >= 500;
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
      // Guarded: a write onto a half-dead socket throws, and there is no res.on('error')
      // anywhere here — an uncaught one reaches the worker's uncaughtException handler,
      // which process.exit()s and bounces EVERY other in-flight stream. ensureQueueHeartbeat
      // already guards its identical write; this one did not.
      try {
        res.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
      } catch { /* peer vanished mid-write — nothing to deliver, fall through to end() */ }
      try { res.end(); } catch { /* already torn down */ }
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
  // A 'proxy' (non-transient upstream) error fails fast. A 'network' error (the
  // upstream fetch threw — ECONNRESET / ETIMEDOUT / a VPN or internet blip) is the
  // MOST transient failure there is, and must NOT kill a live session: when the
  // request is a STREAMING, replayable one (heartbeat keeps it alive, buffered body
  // can be re-sent) and ≥1 account will recover on a finite schedule, hold it and
  // resume when connectivity returns — exactly the "a network drop shouldn't break
  // my session" goal (2026-06-27). The hold-vs-error gate below still error-fasts if
  // nextRetryForRequest reports no finite recovery (all accounts genuinely gone), so
  // a real outage doesn't spin. A non-streaming network failure (no keepalive) still
  // fails fast — it would die on the client's own timeout anyway.
  if (cause === 'proxy') return false;
  if (cause === 'network' && (!requestInfo.stream || !canQueueBufferedBody)) return false;

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
  const countTokensMaxWaitMs = queueConfig.countTokensMaxWaitMs == null
    ? 8000
    : Math.max(0, Number(queueConfig.countTokensMaxWaitMs) || 0);
  const retryPlan = accountManager.nextRetryForRequest?.(requestInfo, new Set()) || {
    retryAfterMs: Infinity,
    cause: 'unavailable',
  };

  // Honest, cause-/thinking-aware message used for every give-up path below.
  // A 'network'-cause hold that ultimately gives up means connectivity never came
  // back within the window — say THAT (check your internet), not the misleading
  // "all accounts at their quota limit" (the accounts are fine; the network isn't).
  const honestMessage = cause === 'network'
    ? 'Could not connect to Claude (network error) and connectivity did not return in time. Check your internet connection and try again. This is not an account quota issue.'
    : unavailableMessage(
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
  const streamClientToleranceMs = queueConfig.streamClientToleranceMs == null
    ? 3 * 60 * 60 * 1000
    : Math.max(0, Number(queueConfig.streamClientToleranceMs) || 0);
  const queueWindowMs = computeQueueWindowMs({
    cause,
    stream: Boolean(requestInfo.stream),
    retryPlanCause: retryPlan.cause,
    maxWaitMs,
    capacityMaxWaitMs,
    nonStreamMaxWaitMs,
    streamHoldMaxMs,
    streamClientToleranceMs,
    isCountTokens: Boolean(requestInfo.isCountTokens),
    countTokensMaxWaitMs,
  });

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

  // NOTE: the heartbeat is deliberately NOT cleared here. It must stay alive
  // through the resumed forward's CONNECTION + failover attempts: if the freed
  // account 529s/throttles on the first resumed request (before any upstream
  // bytes), forwardRequest re-enters queueAndRetry — whose guard at the top
  // (`res.headersSent && !queueHeartbeatActive`) would otherwise BAIL on the
  // committed stream and DROP the held session. Keeping the heartbeat active lets
  // it re-hold. The heartbeat is instead stopped the instant real upstream bytes
  // start flowing, inside streamResponse — that prevents the Bug A interleave
  // (queue keepalive pings injected between real SSE events) without losing
  // re-holdability on a post-resume failover.
  return forwardRequest(
    req, res, body, accountManager, upstream, 0, hooks, reqId, ctx, logDir,
    retryConfig, queueConfig, requestInfo, canRetryBufferedBody, canQueueBufferedBody, new Set(),
  ).then(() => true);
}

// The stream-forward grace-timer callback (extracted so its logic is unit-testable
// in isolation). Fires when a STREAMING request's upstream is slow to first byte:
// commits the SSE stream + heartbeat so the client never idle-times-out. Client-
// abort-safe — an async timer has NO synchronous liveness precondition (unlike the
// queue caller), so if the client vanished during the forward window (or the stream
// is already committed) it reaps the queue slot and bails WITHOUT touching the dead
// socket. ensureQueueHeartbeat is itself hardened against a throwing write, but this
// guard is the cheaper first line of defense against the worker-bounce race.
function commitStreamGraceHeartbeat(res, requestInfo, queueConfig, accountManager) {
  if (res.destroyed || res.writableEnded || res.headersSent) {
    clearQueueHeartbeat(requestInfo);
    accountManager.removeQueuedRequest?.(requestInfo);
    return;
  }
  ensureQueueHeartbeat(res, requestInfo, queueConfig, accountManager);
}

function ensureQueueHeartbeat(res, requestInfo, queueConfig, accountManager) {
  if (!requestInfo.stream || requestInfo.queueHeartbeatActive || res.headersSent) return;
  const heartbeatMs = Math.max(1000, Number(queueConfig.heartbeatMs) || 10_000);
  // The heartbeat is the liveness probe: if the client is gone (socket
  // destroyed/ended, or a write throws EPIPE/ERR_STREAM_DESTROYED), release
  // the queue slot + bytes IMMEDIATELY rather than letting a dead ticket occupy
  // the queue until its (up to 7d) deadline — the ghost-leak guard.
  const reapDead = () => {
    clearQueueHeartbeat(requestInfo);
    accountManager?.removeQueuedRequest?.(requestInfo);
  };
  // The INITIAL commit can throw if the socket died between the caller's last
  // liveness check and here. The synchronous queue caller (queueAndRetry) bails
  // on res.destroyed right before calling, but the ASYNC stream-forward grace
  // timer has no such precondition — the client can vanish mid-window. An
  // unguarded throw here has NO 'error' listener → uncaughtException → the worker
  // process.exits and bounces EVERY in-flight stream. Guard the initial write
  // exactly like the interval callback below so ensureQueueHeartbeat is safe from
  // ANY caller, sync or async.
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(QUEUE_KEEPALIVE);
  } catch {
    reapDead();
    return;
  }
  requestInfo.queueHeartbeatActive = true;
  requestInfo.queueHeartbeatTimer = setInterval(() => {
    if (res.destroyed || res.writableEnded) { reapDead(); return; }
    try {
      res.write(QUEUE_KEEPALIVE);
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
    // count_tokens is cheap non-streaming metadata with NO SSE heartbeat, so a long
    // queue-hold just dies on the client's idle window ("Stream idle timeout - no
    // chunks received"). Flag it (URL-based, so it's set regardless of body parse) to
    // cap its queue wait short and fast-fail with a retryable 429 instead of hanging.
    isCountTokens: /\/v1\/messages\/count_tokens\b/.test(req.url),
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
    // We fully scanned this body for signed-thinking content. Only a successfully
    // scanned, thinking-free body is safe to migrate to another account (session
    // rebalancing); an unparsed body leaves this false → treated as NOT safe
    // (fail-closed) so we never replay a signed thinking block to a new account.
    info.bodyThinkingScanned = true;
    // Whether the resumed transcript can replay to a Claude account. A session with
    // a foreign server_tool_use id CANNOT (Anthropic 400s) → routing pins it to
    // providers. Everything else stays Claude-eligible (Kimi/GLM without server-tools
    // replay fine); a rare rejected-thinking 400 self-heals via react-and-heal.
    const origin = detectTranscriptOrigin(json);
    if (origin.anthropicIncompatible) info.anthropicIncompatible = true;
    if (origin.homeProvider) info.homeProvider = origin.homeProvider;
    // Image content (incl. tool_result-nested screenshots) keeps a request off Kimi
    // (Moonshot 400s on some images GLM/Anthropic accept, and a 400 is terminal).
    if (containsImageBlock(json.messages)) info.hasImage = true;
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

// Anthropic tool-use ids: client tool_use is 'toolu_…', server_tool_use is 'srvtoolu_…'
// (the latter is REQUIRED — Anthropic 400s on replay of any other shape). GLM (z.ai)
// emits OpenAI-style 'call_…'; Kimi (moonshot) emits 'tool_…'. Allowlist, not denylist:
// anything NOT matching this is treated as foreign (fail-closed classification).
const ANTHROPIC_TOOL_ID = /^(toolu|srvtoolu)_/;

// Decide whether a resumed transcript can replay to an Anthropic (Claude) account,
// from the tool-use id shapes in its `messages`. Returns { anthropicIncompatible,
// homeProvider }.
//   anthropicIncompatible = the transcript has a `server_tool_use` id NOT matching
//     ^srvtoolu_ — the ONE DETERMINISTIC incompatibility (Anthropic 400s on replay,
//     the reported bug). Anthropic validates a client `tool_use.id` LOOSELY
//     (^[a-zA-Z0-9_-]+$), so GLM `call_…` / Kimi `tool_…` client ids PASS and a
//     Kimi/GLM session without server-tools is FINE on Claude — we do NOT predict
//     those (a rejected thinking signature, if it ever happens, self-heals via the
//     4xx react-and-heal in forwardRequest). server_tool_use is rare (GLM ~15%,
//     Kimi 0%), so most sessions are compatible.
//   homeProvider = the first foreign tool-use id shape (call_→zai, tool_→kimi), a
//     SOFT hint for the 'never' same-family preference only; ambiguous/none → null.
// The request MODEL is not used — Claude Code rewrites it to opus on resume.
function detectTranscriptOrigin(json) {
  if (!json || typeof json !== 'object') return { anthropicIncompatible: false, homeProvider: null };
  let incompatible = false;
  let homeProvider = null;
  const fam = id => id.startsWith('call_') ? 'zai' : id.startsWith('tool_') ? 'kimi' : null;
  const noteForeign = id => { if (!homeProvider) homeProvider = fam(id); };
  const visit = value => {
    if (incompatible) return; // server_tool_use is decisive — stop
    if (Array.isArray(value)) { for (const v of value) { visit(v); if (incompatible) return; } return; }
    if (!value || typeof value !== 'object') return;
    const t = value.type;
    if (t === 'server_tool_use' && typeof value.id === 'string' && !ANTHROPIC_TOOL_ID.test(value.id)) {
      incompatible = true; noteForeign(value.id); return;
    }
    if (t === 'tool_use' && typeof value.id === 'string' && !ANTHROPIC_TOOL_ID.test(value.id)) noteForeign(value.id);
    if (t === 'tool_result' && typeof value.tool_use_id === 'string' && !ANTHROPIC_TOOL_ID.test(value.tool_use_id)) noteForeign(value.tool_use_id);
    if (value.content) visit(value.content);
    if (value.messages) visit(value.messages);
  };
  visit(json.messages);
  return { anthropicIncompatible: incompatible, homeProvider };
}

// Does this upstream 4xx error body indicate the transcript is un-replayable to
// Anthropic (a lenient GLM/Kimi provider produced content Anthropic rejects on
// replay)? Matches the three known shapes: a non-srvtoolu_ server_tool_use id, or a
// thinking-block signature Anthropic can't validate (invalid OR missing). Used to
// self-heal onto a provider instead of surfacing the 400.
function isAnthropicIncompatBody(body) {
  if (!body) return false;
  // The deterministic server-tool-id 400, the known invalid-signature error, or a
  // thinking-block signature VALIDATION error (missing/invalid) — the last gated on
  // a validation verb so a user message merely echoing "thinking"/"signature" can't
  // false-latch the session provider-pinned for life.
  return /srvtoolu_|server_tool_use/.test(body)
    || /invalid `signature` in `thinking`/i.test(body)
    || (/thinking/.test(body) && /signature/.test(body) && /(should match|required|invalid|expected|must )/i.test(body));
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

// True if any message carries an `{type:'image'}` content block at ANY nesting
// depth — including images nested inside a `tool_result` block (the primary
// Claude Code image path: a browser/Playwright tool returning a screenshot). A
// shallow 2-level scan misses those. Used to keep image requests off Kimi, whose
// decoder 400s on images Anthropic/GLM accept.
function containsImageBlock(value) {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(containsImageBlock);
  if (typeof value !== 'object') return false;
  if (value.type === 'image') return true;
  if (value.content && containsImageBlock(value.content)) return true;
  if (value.messages && containsImageBlock(value.messages)) return true;
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
/**
 * Backstop reaper for a single request: force-abort it if it makes ZERO client-write
 * progress for idleMs. IDLE-keyed via res.socket.bytesWritten (a legit streaming HOLD
 * heartbeats → bytesWritten advances → never trips; only a genuinely stuck request
 * with no writes is reaped). res.destroy() routes into the normal onClose→finally
 * cleanup so the account lease + onRequestEnd release — never a direct releaseAccount
 * (which has no idempotency guard). Clock/timer injectable for tests. Returns the
 * interval handle (caller clearInterval()s it in the request's finally).
 */
function startIdleRequestReaper(res, reqId, idleMs, { now = Date.now, setIntervalFn = setInterval } = {}) {
  let lastBytes = res.socket?.bytesWritten ?? 0;
  let lastProgressAt = now();
  const timer = setIntervalFn(() => {
    const bytes = res.socket?.bytesWritten ?? lastBytes;
    if (bytes !== lastBytes) { lastBytes = bytes; lastProgressAt = now(); return; }
    if (now() - lastProgressAt >= idleMs && !res.writableEnded && !res.destroyed) {
      console.error(`[Maxpool] Request ${reqId} — no write progress for ${Math.round(idleMs / 1000)}s (backstop reaper); force-aborting a stuck request to free its account slot`);
      res.destroy();
    }
  }, Math.min(60_000, idleMs));
  timer.unref?.();
  return timer;
}

async function streamResponse(webStream, res, status, responseHeaders, accountIndex, accountManager, streamLog, requestInfo = {}, idleMs = STREAM_IDLE_MS) {
  const reader = webStream.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let committed = res.headersSent;
  let readFailed = false;

  // We're now committed to streaming a real upstream response body onto this
  // response — there is no more failover for this forward. Stop the queue
  // heartbeat (if this was a resumed held stream) BEFORE the first real byte, so
  // the setInterval can't inject queue keepalive pings between live SSE
  // events (Bug A). It is deliberately NOT cleared earlier (on resume), so a
  // pre-byte failover can still re-hold the session via queueAndRetry.
  clearQueueHeartbeat(requestInfo);

  // Client left mid-stream: the caller drops its disconnect-abort once headers
  // arrive, and the loop below only checks res.destroyed AFTER a read resolves — so
  // a BLOCKED read() would never notice. Cancel the reader on 'close' to unblock it
  // (resolves the pending read as done) → the loop breaks → the lease frees instead
  // of leaking until the (maybe never) upstream close.
  const onClose = () => { reader.cancel().catch(() => {}); };
  res.once('close', onClose);

  try {
    while (true) {
      // Idle guard: a half-open upstream (headers, then silence, never closes) would
      // block reader.read() forever → the whole request handler hangs → neither the
      // lease nor onRequestEnd is released (the "106 phantom active" leak). Bound each
      // read by a per-chunk idle timeout, RESET every chunk so a healthy slow stream
      // is never cut; on a real stall, UPSTREAM_IDLE → the caller frees the lease and
      // ends the client SSE cleanly (isTransient → sendErrorResponse).
      const readP = reader.read();
      readP.catch(() => {});  // race-loser must not surface as an unhandled rejection
      let idleTimer;
      const idle = new Promise((_, reject) => {
        idleTimer = setTimeout(
          () => reject(Object.assign(new Error('upstream idle timeout'), { code: 'UPSTREAM_IDLE' })),
          idleMs,
        );
        idleTimer.unref?.();
      });
      let result;
      try {
        result = await Promise.race([readP, idle]);
      } finally {
        clearTimeout(idleTimer);  // single live timer at a time — no per-chunk timer accumulation
      }
      const { done, value } = result;
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

      // Handle backpressure — bail out if the client disconnects OR goes silently
      // half-open. A vanished peer (laptop sleep / Wi-Fi drop / lost TCP FIN) leaves
      // the send buffer full so this branch is entered, but sends no FIN ('close'
      // never fires) and never ACKs ('drain' never fires) — so a bare await here
      // hangs FOREVER, pinning the account lease and never firing onRequestEnd (the
      // phantom-"N active" leak). Bound it: if the client can't drain a small SSE
      // chunk within CLIENT_DRAIN_MS it's gone → break (same disposition as a
      // destroyed socket: the finally runs reader.cancel()+res.end(), the lease
      // frees with success:true, onRequestEnd fires). A legit slow client drains
      // each episode well within this window; the timer is per-episode, never summed.
      if (!ok) {
        let drainTimer, onDrain, onClose2;
        const settled = new Promise(resolve => {
          onDrain = () => resolve(true);
          onClose2 = () => resolve(true);
          res.once('drain', onDrain);
          res.once('close', onClose2);
          // Bound the wait by the drain cap, but never longer than this stream's
          // idle bound (keeps it injectable for tests; prod = min(300s, 60s) = 60s).
          drainTimer = setTimeout(() => resolve(false), Math.min(idleMs, CLIENT_DRAIN_MS));
          drainTimer.unref?.();
        });
        let drained;
        try {
          drained = await settled;
        } finally {
          clearTimeout(drainTimer);
          res.off('drain', onDrain);
          res.off('close', onClose2);
        }
        if (!drained || res.destroyed) break; // client gone/stalled → stop, clean up in finally
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
    res.off('close', onClose);
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
