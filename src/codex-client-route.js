// Native Codex client traffic shares MaxPool's scheduler and account leases.
// Keep its Responses wire format separate from the Claude Messages adapter.
import { createHash, timingSafeEqual } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nativeCodexHeaders, nativeCodexOwnerIdentity, normalizeNativeCodexModel, NATIVE_CODEX_RESPONSES_URL } from './codex-native.js';
import { codexRateLimit, codexWeeklyRefusal } from './codex-quota.js';
import { HOP_HEADER } from './pool-link.js';
import { finishInference, capacityDenial, noteRoutingUsage } from './routing-service-analytics.js';

export const CODEX_CLIENT_BASE_PATH = '/maxpool/codex/v1';
const NATIVE_MODELS_URL = new URL('models', NATIVE_CODEX_RESPONSES_URL);
const SEARCH_PATH = '/alpha/search';
const NATIVE_POST_URLS = new Map([
  ['/responses', NATIVE_CODEX_RESPONSES_URL],
  ['/responses/compact', NATIVE_CODEX_RESPONSES_URL + '/compact'],
  [SEARCH_PATH, new URL('alpha/search', NATIVE_CODEX_RESPONSES_URL).href],
]);
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_SSE_LINE_BYTES = 16 * 1024 * 1024;
const HEAD_TIMEOUT_MS = 120_000;
const STREAM_IDLE_MS = 180_000;
const LOCAL_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LISTEN_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{0,100}$/i;
const THREAD_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const REQUEST_HEADERS = ['thread-id', 'x-client-request-id', 'session_id', 'session-id', 'x-codex-turn-state',
  'x-codex-turn-metadata', 'x-openai-subagent', 'x-codex-beta-features'];
const RESPONSE_HEADERS = new Set(['content-type', 'retry-after', 'openai-model', 'x-request-id', 'request-id',
  'x-oai-request-id', 'x-codex-turn-state', 'x-codex-plan-type', 'x-codex-active-limit']);

export function isCodexClientPath(url) {
  return typeof url === 'string' && /^\/maxpool\/codex(?:[/?]|$)/.test(url);
}

function routeError(res, status, code, message, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify({ error: { message, type: code, code } }));
  return status;
}

function handoff(res) {
  return routeError(res, 503, 'restart_in_progress', 'MaxPool is handing off native Codex requests.',
    { 'retry-after': '1', connection: 'close' });
}

function isLocalRequest(req) {
  const host = req.headers.host || '';
  return LOCAL_ADDRESSES.has(req.socket.remoteAddress) && LOCAL_ADDRESSES.has(req.socket.localAddress)
    && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)
    && !['origin', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'via', HOP_HEADER]
      .some(header => req.headers[header] != null);
}

function authorized(header, key) {
  if (typeof header !== 'string' || typeof key !== 'string' || !key) return false;
  const received = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${key}`);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function threadKey(req, body, path, metadataThread) {
  // Responses sends thread-id. Codex standalone search instead sends the
  // thread in turn metadata and a session-scoped id in its body. Prefer the
  // operation's thread identity over shared session and transport request IDs.
  const ids = path === SEARCH_PATH ? [metadataThread, req.headers['thread-id']] : [req.headers['thread-id'], metadataThread];
  const value = [...ids, req.headers['x-client-request-id'], req.headers.session_id,
    req.headers['session-id'], path === SEARCH_PATH ? body.id : body.prompt_cache_key]
    .find(key => typeof key === 'string' && THREAD_ID.test(key));
  return value ? 'codex-wire:' + createHash('sha256').update(value).digest('hex') : null;
}

function accountBound(req, body) {
  return Boolean(body.previous_response_id || req.headers['x-codex-turn-state']
    || (Array.isArray(body.input) && body.input.some(item =>
      item && typeof item === 'object' && (item.encrypted_content || item.type === 'item_reference'))));
}

async function readBody(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Codex request or response too large'), { status: 413 });
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function outboundHeaders(req, account) {
  const headers = { ...nativeCodexHeaders(account), 'content-type': 'application/json', accept: 'text/event-stream, application/json' };
  for (const name of REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  return headers;
}

function codexResponseHeaders(upstream, streaming) {
  const headers = { 'cache-control': 'no-store' };
  for (const [key, value] of upstream.headers) {
    if (RESPONSE_HEADERS.has(key) || (key.startsWith('x-codex-')
      && /-(used-percent|reset-at|window-minutes|limit-name)$/.test(key))) headers[key] = value;
  }
  headers['content-type'] ||= streaming ? 'text/event-stream' : 'application/json';
  return headers;
}

function withJsonBody(buffer) {
  try { return JSON.parse(buffer.toString('utf8')); } catch { return null; }
}

function bookUsage(manager, account, info, value) {
  const usage = value?.usage;
  if (!usage || typeof usage !== 'object') return;
  const n = value => Number.isFinite(value) && value > 0 ? value : 0;
  const input = n(usage.input_tokens);
  const cacheRead = Math.min(input, n(usage.input_tokens_details?.cached_tokens));
  const cacheCreation = Math.min(input - cacheRead, n(usage.input_tokens_details?.cache_write_tokens));
  info._capacityInput = input - cacheRead - cacheCreation;
  info._capacityOutput = n(usage.output_tokens);
  info._capacityCacheRead = cacheRead;
  info._capacityCacheCreation = cacheCreation;
  manager.accrueCapacity(account.index, {
    input: info._capacityInput, output: info._capacityOutput, cacheRead, cacheCreation, model: info.model,
  });
}

function consumeStream(upstream, res, controller, onEvent) {
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), STREAM_IDLE_MS);
    timer.unref?.();
  };
  let remainder = '';
  const decoder = new TextDecoder();
  const inspect = new Transform({
    transform(chunk, _encoding, callback) {
      arm();
      remainder += decoder.decode(chunk, { stream: true });
      let nextLine = remainder.indexOf('\n');
      while (nextLine >= 0) {
        const line = remainder.slice(0, nextLine);
        remainder = remainder.slice(nextLine + 1);
        if (line.startsWith('data:')) {
          const event = withJsonBody(line.slice(5).trim());
          if (event) onEvent(event);
        }
        nextLine = remainder.indexOf('\n');
      }
      if (remainder.length > MAX_SSE_LINE_BYTES) remainder = '';
      callback(null, chunk);
    },
  });
  arm();
  return pipeline(Readable.fromWeb(upstream.body), inspect, res, { signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function boundedBody(upstream, controller) {
  if (!upstream.body) return Buffer.alloc(0);
  const timer = setTimeout(() => controller.abort(), STREAM_IDLE_MS);
  timer.unref?.();
  try { return await readBody(upstream.body); }
  finally { clearTimeout(timer); }
}

async function forwardNative(fetchImpl, url, options, controller) {
  const timer = setTimeout(() => controller.abort(), HEAD_TIMEOUT_MS);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...options, redirect: 'error', signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function retryAfter(upstream, resetSeconds) {
  const hint = upstream.headers.get('retry-after');
  const seconds = Number(hint);
  const retry = Number.isFinite(seconds) ? Math.ceil(seconds) : (Math.ceil((Date.parse(hint) - Date.now()) / 1000) || 0);
  return Math.max(retry, resetSeconds) || 5;
}

function shouldRetry(status, data) {
  return status === 401 || status === 429 || (
    [400, 404].includes(status) && ['model_not_found', 'model_not_supported', 'model_not_available'].includes(data?.error?.code)
  );
}

export function createCodexClientRoute(manager, config, hooks, redeemForRequest) {
  const fetchImpl = hooks.fetchNativeCodex || fetch;
  const catalogCache = new WeakMap();
  const pendingThreads = new Set();
  let draining = false;
  const listenerIsLocal = LISTEN_HOSTS.has(String(config.proxy?.host || '127.0.0.1').toLowerCase());
  const currentCatalog = account => {
    const entry = catalogCache.get(account);
    return entry && entry.identity === nativeCodexOwnerIdentity(account) && entry.credential === account.credential
      && entry.until > Date.now() ? entry : null;
  };

  async function models(req, res, requestedVersion) {
    const merged = new Map();
    const candidates = manager.accounts.filter(account => nativeCodexOwnerIdentity(account)
      && account.enabled !== false && !account.poolBenchedBy && !account.refreshDead && !account.subscriptionGone);
    // The raw catalog contains fields the Codex app needs beyond MaxPool's
    // normalized slug and reasoning controls. Cache each native account and
    // expose only its listed entitlements.
    const catalogs = await Promise.allSettled(candidates.map(async account => {
      const version = VERSION.test(requestedVersion) ? requestedVersion : (account.quota.codexCatalogVersion || '0.170.0');
      const cached = currentCatalog(account);
      if (cached?.version === version) return cached.models;
      if (!await manager.ensureTokenFresh(account.index) || manager.accounts[account.index] !== account
        || account.enabled === false || account.poolBenchedBy) return [];
      const credential = account.credential;
      const identity = nativeCodexOwnerIdentity(account);
      const headers = nativeCodexHeaders(account);
      if (!identity || !headers) return [];
      const url = new URL(NATIVE_MODELS_URL);
      url.searchParams.set('client_version', version);
      const response = await fetchImpl(url.href, {
        method: 'GET', headers: { ...headers, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) { await response.body?.cancel(); return []; }
      const body = withJsonBody(await readBody(response.body));
      const rows = [];
      const normalized = [];
      for (const row of Array.isArray(body?.models) ? body.models : []) {
        const model = normalizeNativeCodexModel(row);
        if (model) { rows.push(row); normalized.push(model); }
      }
      if (manager.accounts[account.index] !== account || account.enabled === false || account.poolBenchedBy
        || account.credential !== credential || nativeCodexOwnerIdentity(account) !== identity) return [];
      catalogCache.set(account, { version, credential, identity, until: Date.now() + 5 * 60_000, models: rows, normalized });
      return rows;
    }));
    if (req.destroyed && !req.complete) return;
    for (const result of catalogs) {
      if (result.status === 'fulfilled') for (const row of result.value) if (!merged.has(row.slug)) merged.set(row.slug, row);
    }
    if (!merged.size) return routeError(res, 503, 'model_catalog_unavailable', 'No local native Codex account reported a usable model catalog.');
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ models: [...merged.values()] }));
    return 200;
  }

  async function inference(req, res, path, reqId, ctx) {
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      return routeError(res, 415, 'unsupported_encoding', 'Send an uncompressed native Codex request.');
    }
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) {
      return routeError(res, 413, 'request_too_large', 'The Codex request exceeds the local size limit.', { connection: 'close' });
    }
    let body;
    try { body = await readBody(req.iterator({ destroyOnReturn: false })); }
    catch (error) {
      if (res.destroyed) return null;
      return routeError(res, error.status || 400, 'invalid_request_error', error.message, { connection: 'close' });
    }
    const data = withJsonBody(body);
    if (!data || typeof data.model !== 'string' || !MODEL_ID.test(data.model) || data.store === true || data.background === true) {
      return routeError(res, 400, 'invalid_request_error', 'Supply an entitled Codex model and a foreground request with store disabled.');
    }
    const metadata = req.headers['x-codex-turn-metadata'];
    const metadataThread = metadata && withJsonBody(metadata)?.thread_id;
    const key = threadKey(req, data, path, typeof metadata === 'string' ? metadataThread : null);
    let identifiedSession = false;
    if (path === SEARCH_PATH) ctx.endAuxiliary = manager.routingService?.auxiliary();
    else if (manager.routingService) {
      // x-client-request-id and prompt_cache_key can change per call. Neither
      // identifies a distinct active session for the parallelism KPI.
      const session = [req.headers['thread-id'], metadataThread,
        req.headers.session_id, req.headers['session-id']].find(value => typeof value === 'string' && THREAD_ID.test(value));
      identifiedSession = Boolean(session);
      ctx.service = manager.routingService.begin({ session });
    }
    const owner = key && manager.nativeCodexOwner(key);
    if (!owner && (path === SEARCH_PATH || accountBound(req, data))) {
      return routeError(res, 409, 'previous_response_not_found', 'This Codex state has no owner in MaxPool. Start a new conversation on this route.');
    }
    // Two initial requests with the same thread ID must not create two owners.
    if (key && pendingThreads.has(key)) {
      return routeError(res, 409, 'conversation_in_progress', 'A request is already starting this Codex conversation.', { 'retry-after': '1' });
    }
    if (key && !owner) pendingThreads.add(key);

    const streaming = path === '/responses' && data.stream === true;
    const info = { nativeCodexClient: true, onlyProvider: 'codex', profile: 'codex', codexCompatible: true,
      model: data.model, openAIModel: data.model, reasoningEffort: data.reasoning?.effort,
      path: CODEX_CLIENT_BASE_PATH + path, sessionKey: key, affinityKey: key, caller: 'local-codex',
      stream: streaming, _service: ctx.service, identifiedSession, nativeCodexOwner: owner, nativeCodexCatalog: account => currentCatalog(account)?.normalized,
      weight: Math.max(1, Math.ceil(body.length / 32768)) };
    const excluded = new Set();
    const controller = new AbortController();
    const clientClosed = new Error('Codex client closed the response');
    const abort = () => { if (!res.writableFinished) controller.abort(clientClosed); };
    res.once('close', abort);
    manager.countRequest?.(info.caller);
    try {
      for (;;) {
        if (draining) return handoff(res);
        const lease = manager.acquireAccount(info, excluded);
        if (!lease) {
          if (await redeemForRequest(req, res, info)) {
            if (controller.signal.aborted) return null;
            excluded.clear();
            continue;
          }
          const error = owner && !manager.accounts.some(account => nativeCodexOwnerIdentity(account) === owner)
            ? 'The owning local Codex account is no longer in the pool. Add it back to resume this conversation.'
            : 'No eligible local Codex account is available for this model or conversation.';
          if (ctx.service) ctx.service.denied ||= capacityDenial(manager.nextRetryForRequest?.(info, excluded));
          return routeError(res, 429, 'rate_limit_exceeded', error, { 'retry-after': '5' });
        }
        const { account } = lease;
        if (ctx.service) {
          ctx.service.route(account.name);
          ctx.service.denied = false;
          ctx.service.usage = null;
        }
        const identity = nativeCodexOwnerIdentity(account);
        const isCurrent = () => manager.accounts[account.index] === account && nativeCodexOwnerIdentity(account) === identity;
        const outcome = { neutral: true, scope: 'request' };
        let terminal;
        let upstream;
        ctx.account = account.name;
        hooks.onRequestRouted?.(reqId, { account: account.name });
        try {
          if (!identity || !await manager.ensureTokenFresh(account.index) || controller.signal.aborted
            || !isCurrent() || account.enabled === false || account.poolBenchedBy
            || !nativeCodexHeaders(account)) {
            excluded.add(account.index);
            if (controller.signal.aborted) return null;
            continue;
          }
          if (draining) return handoff(res);
          const url = NATIVE_POST_URLS.get(path);
          let sentAt;
          let sentCredential;
          const send = () => {
            sentAt = Date.now();
            sentCredential = account.credential;
            return forwardNative(fetchImpl, url, { method: 'POST', body, headers: outboundHeaders(req, account) }, controller);
          };
          const sameAttemptGrant = () => isCurrent() && account.credential === sentCredential;
          // Once bytes can go upstream, a missing response does not prove they
          // were rejected. Persist this prospective owner in the same snapshot
          // even if the old worker has yet to receive upstream headers.
          if (key) manager.rememberNativeCodexOwner(key, identity);
          upstream = await send();
          if (upstream.status === 401 && !draining && !controller.signal.aborted && isCurrent()) {
            if (sameAttemptGrant()) await manager.ensureTokenFresh(account.index, true);
            if (account.credential !== sentCredential && !draining && !controller.signal.aborted
              && isCurrent() && account.enabled !== false && !account.poolBenchedBy) {
              await upstream.body?.cancel();
              if (draining) return handoff(res);
              if (controller.signal.aborted) return null;
              if (!isCurrent() || account.enabled === false || account.poolBenchedBy) {
                return routeError(res, 409, 'conversation_owner_unavailable', 'The owning Codex account changed while retrying.');
              }
              upstream = await send();
            }
          }
          if (sameAttemptGrant()) manager.applyCodexQuotaHeaders(account.index, upstream.headers, sentAt, data.model);
          if (!upstream.ok) {
            const buffer = await boundedBody(upstream, controller);
            const error = withJsonBody(buffer);
            const limit = upstream.status === 429 ? codexRateLimit(upstream.headers, data.model, Date.now(), account.quota.codexLimitByModel?.[data.model]) : null;
            const retry = limit ? retryAfter(upstream, limit.retryAfter) : null;
            if (sameAttemptGrant() && limit) manager.markRateLimited(account.index, retry, { recordFailure: false, modelScope: limit.modelScope, modelWindow: limit.modelWindow });
            else if (sameAttemptGrant() && upstream.status === 401) manager.markAuthFailed(account.index, 401, 'native_codex_unauthorized');
            if (!draining && sameAttemptGrant() && limit) {
              const refused = codexWeeklyRefusal(upstream.headers, limit);
              if (refused) Promise.resolve(manager.onWeeklyRefusal?.(account, refused)).catch(() => {});
            }
            if (ctx.service && limit) {
              ctx.service.denied = limit.modelWindow === 'weekly' ? 'weeklyDenied'
                : limit.modelWindow === '5h' ? 'sessionDenied' : 'unclassifiedDenied';
            }
            outcome.status = upstream.status;
            if (!draining && !owner && shouldRetry(upstream.status, error)) {
              // No response was accepted on an explicit auth/quota/model
              // rejection. A first turn may establish a different owner until
              // the handoff begins and freezes reservations.
              if (key) manager.forgetNativeCodexOwner(key, identity);
              excluded.add(account.index);
              if (manager.hasAvailableRoute(info, excluded)) continue;
            }
            if (!draining && upstream.status === 429 && await redeemForRequest(req, res, info)) {
              if (controller.signal.aborted) return null;
              excluded.clear();
              continue;
            }
            if (upstream.status >= 400 && error?.error && typeof error.error === 'object') {
              const headers = codexResponseHeaders(upstream, false);
              if (retry) headers['retry-after'] ||= String(retry);
              res.writeHead(upstream.status, headers);
              res.end(buffer);
              return upstream.status;
            }
            return routeError(res, upstream.status >= 400 ? upstream.status : 502,
              'codex_upstream_error', 'Codex rejected the request.', retry ? { 'retry-after': String(retry) } : {});
          }

          if (key) manager.rememberNativeCodexOwner(key, identity);
          if (isCurrent()) {
            manager.markUpstreamAccepted(account.index);
            manager.noteConversationServed(info, account);
          }
          hooks.onRequestFirstByte?.(reqId);
          const headers = codexResponseHeaders(upstream, streaming);
          res.writeHead(upstream.status, { ...headers, 'x-maxpool-served-model': data.model });
          outcome.neutral = false;
          outcome.status = upstream.status;
          if (streaming && upstream.body) {
            await consumeStream(upstream, res, controller, event => {
              if (terminal) return;
              if (['response.completed', 'response.incomplete', 'response.failed', 'error'].includes(event.type)) {
                terminal = event.type;
                if (ctx.service) ctx.service.terminal = terminal === 'response.completed' ? 'completed'
                  : terminal === 'response.incomplete' ? 'incomplete' : 'failed';
                // Codex stops reading as soon as it sees its terminal event.
                // The result is final before the downstream pipeline reaches EOF.
                outcome.success = terminal === 'response.completed' || terminal === 'response.incomplete';
                if (!outcome.success) outcome.error = 'native_codex_stream_failed';
                if (isCurrent()) bookUsage(manager, account, info, event.response);
                noteRoutingUsage(ctx.service, info);
              }
            });
            if (!terminal) outcome.error = 'native_codex_stream_incomplete';
          } else {
            const buffer = await boundedBody(upstream, controller);
            const result = withJsonBody(buffer);
            if (ctx.service) {
              const compacted = path === '/responses/compact' && Array.isArray(result?.output)
                && result.output.some(item => item?.type === 'compaction');
              ctx.service.terminal = result?.error || result?.status === 'failed' ? 'failed'
                : result?.status === 'completed' || compacted ? 'completed' : 'incomplete';
            }
            if (isCurrent()) bookUsage(manager, account, info, result);
            noteRoutingUsage(ctx.service, info);
            res.end(buffer);
            outcome.success = true;
          }
          return upstream.status;
        } catch {
          if (ctx.service && !terminal) ctx.service.terminal = controller.signal.reason === clientClosed ? 'cancelled' : 'failed';
          if (res.headersSent) {
            if (!terminal && controller.signal.reason === clientClosed) outcome.neutral = true;
            if (!res.destroyed) res.destroy();
            return terminal ? outcome.status : null;
          }
          if (controller.signal.aborted) {
            return res.destroyed ? null : routeError(res, 504, 'gateway_timeout', 'Codex did not respond before the timeout.');
          }
          return routeError(res, 502, 'codex_upstream_error', 'The local pool could not complete the request to Codex.');
        } finally {
          // An account may be removed or re-provisioned while the stream drains.
          // The detached lease must not book against a new credential in that slot.
          if (!isCurrent()) outcome.neutral = true;
          manager.releaseAccount(lease, outcome);
        }
      }
    } finally {
      res.off('close', abort);
      if (key && !owner) pendingThreads.delete(key);
    }
  }

  const route = async (req, res, reqId) => {
    if (!listenerIsLocal) return routeError(res, 404, 'not_found', 'The native Codex route is available on a loopback-only MaxPool listener.');
    if (!isLocalRequest(req) || !authorized(req.headers.authorization, config.proxy?.apiKey)) {
      return routeError(res, 401, 'authentication_error', 'The native Codex route requires the local owner pool key.');
    }
    if (draining) return handoff(res);
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.slice(CODEX_CLIENT_BASE_PATH.length);
    if (!url.pathname.startsWith(CODEX_CLIENT_BASE_PATH + '/')
      || (path !== '/models' && !NATIVE_POST_URLS.has(path))) {
      return routeError(res, 404, 'not_found', 'Unknown native Codex operation.');
    }
    const method = path === '/models' ? 'GET' : 'POST';
    if (req.method !== method) return routeError(res, 405, 'method_not_allowed', 'This native Codex operation does not accept that method.', { allow: method });
    if (path === '/models') return models(req, res, url.searchParams.get('client_version'));
    const ctx = { account: null, status: null };
    const request = { method, path: req.url, sessionKey: null, caller: 'local-codex' };
    if (hooks.onRequestStart?.(reqId, request) === false) return handoff(res);
    try {
      ctx.status = await inference(req, res, path, reqId, ctx);
      return ctx.status;
    } finally {
      ctx.endAuxiliary?.();
      finishInference(ctx.service, ctx.status, res.destroyed && !res.writableFinished);
      hooks.onRequestEnd?.(reqId, { ...request, account: ctx.account, status: ctx.status });
    }
  };
  route.beginDrain = () => { draining = true; };
  return route;
}
