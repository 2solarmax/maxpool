import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { sameAccountIdentity } from './oauth.js';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const planScope = 'chatgpt.tokens.use.direct';
export const DEFAULT_OPENAI_MODEL = 'gpt-6.2-sol';

function browser(url) {
  const platform = process.platform;
  if (platform === 'win32') {
    console.log('Open the link above in your browser.');
    return;
  }
  const processHandle = spawn(platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  processHandle.on('error', () => {});
}

async function tokenRequest(params, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(issuer + '/api/accounts/oauth/token', {
      method: 'POST', body: new URLSearchParams({ ...params, resource }), signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw Object.assign(new Error('Could not reach the ChatGPT token endpoint'), { retryable: true });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : data?.error?.code;
    throw Object.assign(new Error(`ChatGPT authorization returned HTTP ${response.status}`), {
      status: response.status, retryable: !['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired',
        'refresh_token_invalidated', 'refresh_token_reused'].includes(code),
    });
  }
  if (!data?.access_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
    throw Object.assign(new Error('The ChatGPT token response was incomplete'), { retryable: true });
  }
  if (data.scope != null && !String(data.scope).split(/\s+/).includes(planScope)) {
    throw new Error('Authorize ChatGPT plan usage before adding this account');
  }
  return data;
}

function tokenFields(data, oldRefreshToken) {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || oldRefreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

export async function refreshOpenAIToken(account) {
  const data = await tokenRequest({ grant_type: 'refresh_token',
    client_id: account.oauthClientId, refresh_token: account.refreshToken });
  return tokenFields(data, account.refreshToken);
}

async function verifyIdentity(token, clientId, nonce, fetchImpl) {
  if (typeof token !== 'string') throw new Error('ChatGPT did not return an identity token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('ChatGPT returned an invalid identity token');
  const [header, payload, signature] = parts;
  const { kid, alg } = JSON.parse(Buffer.from(header, 'base64url'));
  if (alg !== 'RS256' || !kid) throw new Error('Unexpected ChatGPT identity signature');
  const response = await fetchImpl(issuer + '/.well-known/jwks.json', { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('Could not load ChatGPT signing keys');
  const { keys } = await response.json();
  const key = keys.find(value => value.kid === kid && value.kty === 'RSA' && (!value.use || value.use === 'sig'));
  if (!key || !verify('RSA-SHA256', Buffer.from(header + '.' + payload),
    createPublicKey({ key, format: 'jwk' }), Buffer.from(signature, 'base64url'))) {
    throw new Error('Could not verify the ChatGPT identity token');
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== issuer || !audiences.includes(clientId)
    || (audiences.length > 1 && claims.azp !== clientId)
    || claims.nonce !== nonce || !Number.isFinite(claims.exp) || claims.exp <= Date.now() / 1000
    || typeof claims.sub !== 'string' || !claims.sub) throw new Error('ChatGPT identity did not match this sign-in');
  return claims;
}

export async function loginOpenAI({ hostId, prior, open = browser, report = console.log, fetchImpl = fetch }) {
  const pending = {
    state: randomBytes(32).toString('base64url'), nonce: randomBytes(32).toString('base64url'),
    verifier: randomBytes(32).toString('base64url'),
  };
  let resolveCallback;
  const callback = new Promise(resolve => { resolveCallback = resolve; });
  let handled = false;
  const listener = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/auth/callback' || handled) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== pending.state) {
      res.writeHead(400).end('This sign-in does not match the pending MaxPool request.');
      return;
    }
    handled = true;
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end('Return to MaxPool to finish connecting your ChatGPT account.');
    resolveCallback(url.searchParams);
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const { port } = listener.address();
  const redirect_uri = `http://127.0.0.1:${port}/auth/callback`;
  const url = new URL(issuer + '/api/accounts/authorize');
  url.search = new URLSearchParams({
    client_id: prior?.oauthClientId || 'dynamic_agent_client',
    ...(prior?.oauthClientId ? {} : { agent_name_hint: 'MaxPool' }),
    ext_agent_host_id: hostId, response_type: 'code', redirect_uri,
    scope: `openid profile email offline_access resource.invoke ${planScope}`,
    resource, state: pending.state, nonce: pending.nonce, code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(pending.verifier).digest('base64url'),
  });
  const timer = setTimeout(() => resolveCallback(null), 5 * 60_000);
  try {
    report(`Open this link to connect a ChatGPT account:\n${url}`);
    open(url.href);
    const params = await callback;
    if (!params) throw new Error('ChatGPT sign-in timed out');
    const code = params.get('code');
    if (params.has('error') || !code) throw new Error('ChatGPT sign-in was declined');
    const returnedId = params.get('client_id');
    const clientId = prior?.oauthClientId || returnedId;
    if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId || '') || (returnedId && returnedId !== clientId)) {
      throw new Error('ChatGPT did not return the expected app registration');
    }
    const data = await tokenRequest({ grant_type: 'authorization_code', client_id: clientId, code,
      code_verifier: pending.verifier, redirect_uri }, fetchImpl);
    if (!String(data.scope || '').split(/\s+/).includes(planScope) || !data.refresh_token) {
      throw new Error('Authorize ChatGPT plan usage before adding this account');
    }
    const claims = await verifyIdentity(data.id_token, clientId, pending.nonce, fetchImpl);
    const profile = { accountUuid: claims.sub, organizationUuid: clientId, provider: 'codex',
      email: claims.email_verified === true ? claims.email : null };
    if (prior && !sameAccountIdentity({ ...prior, organizationUuid: prior.oauthClientId, provider: 'codex' }, profile)) {
      throw new Error('Sign in with the ChatGPT account you are reconnecting');
    }
    return { profile, creds: { ...tokenFields(data), oauthClientId: clientId } };
  } finally {
    clearTimeout(timer);
    listener.close();
  }
}

export async function listOpenAIModels(accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(resource + '/models', {
    headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Could not read ChatGPT models (HTTP ${res.status})`);
  const json = await res.json();
  return (json.models || []).filter(model => model.visibility === 'list' && typeof model.slug === 'string')
    .map(model => model.slug);
}
