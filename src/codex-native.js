// Native OAuth protocol adapted from TeamClaude v1.1.30 (KarpelesLab).
// License in codex-quota.js.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { sameAccountIdentity } from './oauth.js';

const AUTHORIZATION_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const AUTH_CLAIM = 'https://api.openai.com/auth';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CALLBACK_PORT = 1455;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/auth/callback`;
const TERMINAL_REFRESH_ERRORS = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired',
  'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const NATIVE_BACKEND = 'https://chatgpt.com/backend-api/codex';
export const NATIVE_CODEX_RESPONSES_URL = `${NATIVE_BACKEND}/responses`;

// The upstream catalog is versioned by Codex client, even when no Codex binary is
// used to send inference requests. This revision was verified with the models
// published on 2026-11-19. Keep it real so subsequent responses are comparable.
const VERIFIED_CODEX_VERSION = '0.169.1';

function jwtClaims(token) {
  if (typeof token !== 'string' || token.split('.').length !== 3) return {};
  try {
    const value = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function field(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function nativeCodexHeaders(account) {
  const credential = field(account?.credential) || field(account?.accessToken);
  const workspace = field(account?.codexAccountId) || field(account?.accountId)
    || (account?.codexAuth === 'native' ? field(account.organizationUuid) : null);
  if (!credential || !workspace || /[\u0000-\u0020\u007f]/.test(credential + workspace)) return null;
  return { authorization: `Bearer ${credential}`, 'chatgpt-account-id': workspace };
}

function identityFromTokens(data) {
  // Claims from the just-completed HTTPS OAuth exchange are used to bind the
  // grant to a local user/workspace. They never authorize a callback by itself.
  const idClaims = jwtClaims(data.id_token);
  const accessClaims = jwtClaims(data.access_token);
  const auth = idClaims[AUTH_CLAIM] || {};
  const accessAuth = accessClaims[AUTH_CLAIM] || {};
  const workspace = field(auth.chatgpt_account_id) || field(accessAuth.chatgpt_account_id);
  const user = field(auth.chatgpt_user_id) || field(auth.user_id)
    || field(accessAuth.chatgpt_user_id) || field(accessAuth.user_id) || field(idClaims.sub);
  if (!workspace || !user
    || (field(accessAuth.chatgpt_account_id) && accessAuth.chatgpt_account_id !== workspace)) {
    throw new Error('Codex did not return a matching ChatGPT account identity');
  }
  return {
    provider: 'codex', accountUuid: user, organizationUuid: workspace,
    email: idClaims.email_verified !== false ? field(idClaims.email) : null,
  };
}

function tokenFields(data, previousRefreshToken) {
  const accessToken = field(data.access_token);
  const refreshToken = field(data.refresh_token) || previousRefreshToken;
  const relative = Number(data.expires_in);
  const expiration = Number(jwtClaims(accessToken).exp) * 1000;
  const expiryCandidates = [];
  if (relative > 0 && Number.isFinite(relative)) expiryCandidates.push(Date.now() + relative * 1000);
  if (expiration > 0 && Number.isFinite(expiration)) expiryCandidates.push(expiration);
  const expiresAt = expiryCandidates.length ? Math.min(...expiryCandidates) : 0;
  if (!accessToken || !refreshToken || expiresAt <= Date.now()) {
    throw Object.assign(new Error('Codex token endpoint returned incomplete credentials'), { retryable: true });
  }
  return { accessToken, refreshToken, expiresAt };
}

async function requestToken(fields, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    const timeout = AbortSignal.timeout(30_000);
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...fields, client_id: CLIENT_ID }),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw Object.assign(new Error('Could not reach the Codex token endpoint', { cause: error }), { retryable: true });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const upstreamCode = typeof data.error === 'string' ? data.error : data.error?.code;
    throw Object.assign(new Error(`Codex authorization returned HTTP ${response.status}`), {
      status: response.status,
      retryable: !TERMINAL_REFRESH_ERRORS.has(upstreamCode) && response.status !== 401,
    });
  }
  return data;
}

export async function refreshNativeCodexToken(account, options = {}) {
  const previous = field(account?.refreshToken);
  if (!previous) throw new Error('Codex refresh token is missing');
  const data = await requestToken({ grant_type: 'refresh_token', refresh_token: previous }, options);
  const workspace = field(account.codexAccountId) || field(account.accountId) || field(account.organizationUuid);
  const returnedWorkspace = field(jwtClaims(data.access_token)[AUTH_CLAIM]?.chatgpt_account_id);
  if (workspace && returnedWorkspace && returnedWorkspace !== workspace) {
    throw new Error('Codex renewed a different ChatGPT workspace');
  }
  return tokenFields(data, previous);
}

function browser(url) {
  if (process.platform === 'win32' || process.env.SSH_CONNECTION) return;
  const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  child.on('error', () => {});
}

function authorizationUrl(state, verifier) {
  const url = new URL(AUTHORIZATION_URL);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: CALLBACK_URL,
    scope: 'openid profile email offline_access',
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'codex_cli_rs',
  });
  return url.href;
}

export function parseNativeCodexCallback(input, expectedState) {
  const text = String(input || '').trim();
  const url = new URL(text.startsWith('localhost:') ? `http://${text}` : text, CALLBACK_URL);
  if (url.origin !== `http://localhost:${CALLBACK_PORT}` || url.pathname !== '/auth/callback'
    || url.searchParams.get('state') !== expectedState) {
    throw new Error('This callback belongs to a different Codex sign-in. Paste the complete address from this attempt.');
  }
  if (url.searchParams.has('error')) return { declined: true };
  const code = field(url.searchParams.get('code'));
  if (!code) throw new Error('The Codex sign-in callback is missing its authorization code');
  return { code };
}

export async function loginNativeCodex({
  prior, open = browser, report = console.log, fetchImpl = fetch,
  input = process.stdin, output = process.stderr, timeoutMs = 5 * 60_000, port = CALLBACK_PORT,
} = {}) {
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const canPaste = Boolean(input?.isTTY);
  let receive;
  const callback = new Promise(resolve => { receive = resolve; });
  const server = createServer((req, res) => {
    let result;
    try {
      if (req.method !== 'GET' || !req.url?.startsWith('/auth/callback?')) throw new Error('Invalid callback');
      result = parseNativeCodexCallback(req.url, state);
    } catch {
      res.writeHead(400, { 'cache-control': 'no-store' }).end('This Codex callback does not match the active login.');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(result.declined ? 'Codex sign-in was declined.' : 'Return to MaxPool to finish connecting Codex.');
    receive(result);
  });
  let listenerError;
  await new Promise(resolve => {
    server.once('error', error => { listenerError = error; resolve(); });
    server.listen(port, '127.0.0.1', resolve);
  });
  server.on('error', () => receive({ listenerLost: true }));
  if (listenerError && !canPaste) {
    throw new Error(`Codex's sign-in callback port ${CALLBACK_PORT} is unavailable`, { cause: listenerError });
  }
  const timer = setTimeout(() => receive(null), timeoutMs);
  let prompt;
  try {
    const url = authorizationUrl(state, verifier);
    report(`Open this link to connect Codex:\n${url}`);
    open(url, server.address()?.port);
    if (canPaste) {
      report('If the browser opens on another machine or the callback port is busy, paste the final localhost address here.');
      prompt = createInterface({ input, output, terminal: false });
      prompt.on('line', line => {
        try { receive(parseNativeCodexCallback(line, state)); }
        catch (error) { report(error.message); }
      });
      prompt.once('close', () => receive(null));
    }
    const result = await callback;
    if (!result) throw new Error('Codex sign-in timed out or was cancelled');
    if (result.declined) throw new Error('Codex sign-in was declined');
    if (result.listenerLost) throw new Error('Codex sign-in lost its callback listener');
    const data = await requestToken({
      grant_type: 'authorization_code', code: result.code, code_verifier: verifier, redirect_uri: CALLBACK_URL,
    }, { fetchImpl });
    const profile = identityFromTokens(data);
    if (prior?.codexAuth === 'native' && !sameAccountIdentity(prior, profile)) {
      throw new Error('Sign in with the same ChatGPT account and workspace you are reconnecting');
    }
    return {
      profile,
      creds: { ...tokenFields(data), codexAccountId: profile.organizationUuid, codexAuth: 'native' },
    };
  } finally {
    clearTimeout(timer);
    prompt?.close();
    server.close();
  }
}

function normalizeModel(model) {
  const slug = field(model?.slug);
  if (!slug || !/^[a-z0-9][a-z0-9._-]{0,100}$/i.test(slug) || model.visibility !== 'list') return null;
  const modalities = Array.isArray(model.input_modalities) ? model.input_modalities : [];
  const reasoning = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
  const contextWindow = Number(model.context_window);
  const priority = model.priority == null ? null : Number(model.priority);
  return {
    slug, displayName: field(model.display_name)?.replace(/\p{C}/gu, '').trim().slice(0, 120) || slug,
    priority: Number.isFinite(priority) ? priority : null,
    efforts: reasoning.map(value => field(value?.effort)).filter(Boolean),
    defaultEffort: field(model.default_reasoning_level),
    supportsTools: typeof model.supports_tools === 'boolean' ? model.supports_tools : null,
    supportsToolSearch: typeof model.supports_search_tool === 'boolean' ? model.supports_search_tool : null,
    supportsVision: modalities.length ? modalities.includes('image') : null,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null,
  };
}

export async function listNativeCodexModels(account, { etag, fetchImpl = fetch } = {}) {
  const identity = nativeCodexHeaders(account);
  if (!identity) throw new Error('Native Codex catalog requires account credentials');
  const url = `${NATIVE_BACKEND}/models?client_version=${VERIFIED_CODEX_VERSION}`;
  const headers = { ...identity, accept: 'application/json', ...(etag ? { 'if-none-match': etag } : {}) };
  const response = await fetchImpl(url, { headers, redirect: 'error', signal: AbortSignal.timeout(15_000) });
  if (response.status === 304 && etag) return { models: null, etag, notModified: true };
  if (!response.ok) {
    throw Object.assign(new Error(`Could not read the native Codex model catalog (HTTP ${response.status})`), { status: response.status });
  }
  const data = await response.json();
  if (!Array.isArray(data?.models)) throw new Error('Native Codex returned an invalid model catalog');
  return { models: data.models.map(normalizeModel).filter(Boolean), etag: response.headers.get('etag'), notModified: false };
}
