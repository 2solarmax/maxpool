import { randomBytes, createHash } from 'node:crypto';
import { exec } from 'node:child_process';
import { createInterface } from 'node:readline';
import http from 'node:http';

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
// Token endpoint is overridable via env so a stub OAuth server can be pointed at
// for integration tests (e.g. the single-use-rotating-token reload torture test).
const DEFAULT_TOKEN_ENDPOINT = process.env.MAXPOOL_OAUTH_TOKEN_ENDPOINT
  || 'https://platform.claude.com/v1/oauth/token';
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/**
 * A short, NON-REVERSIBLE fingerprint of a refresh token, for audit logging of
 * the single-use-token rotation lifecycle. NEVER log the token itself — an
 * 8-char sha256 prefix is irreversible yet enough to correlate a rotation
 * ("rotated → fp / Persisted fp") with the token later rejected on boot
 * ("REJECTED sent fp"), which is what distinguishes a lost-rotation double-spend
 * from an upstream revocation. Returns 'none' for a falsy token.
 */
export function tokenFingerprint(token) {
  if (!token) return 'none';
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 8);
}

/**
 * Refresh an expired OAuth access token using the refresh token.
 * Retries on 5xx and network errors with exponential backoff.
 */
// How long to wait for the user to finish the browser login. Env-overridable.
const LOGIN_TIMEOUT_MS = Math.max(60_000, Number(process.env.MAXPOOL_LOGIN_TIMEOUT_MS) || 300_000);

export async function refreshAccessToken(refreshToken, endpoint = DEFAULT_TOKEN_ENDPOINT) {
  const maxRetries = 2;
  const baseDelayMs = 500;
  // 30s, not 10s. A refresh aborted by OUR timeout is the dangerous case (see below), so
  // the timeout must be generous enough that a merely slow network never triggers it.
  // Measured 2026-08-03: refreshes aborted at 10s during a degraded-network window, and
  // the retries that followed destroyed 4 accounts.
  const perAttemptTimeoutMs = Math.max(10_000, Number(process.env.MAXPOOL_TOKEN_REFRESH_TIMEOUT_MS) || 30_000);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = baseDelayMs * 2 ** (attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/plain, */*',
          'User-Agent': 'axios/1.13.6',
        },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: DEFAULT_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(perAttemptTimeoutMs),
      });

      if (!res.ok) {
        if (res.status >= 500 && attempt < maxRetries) {
          await res.body?.cancel();
          continue;
        }
        const text = await res.text();
        const error = new Error(`Token refresh failed (${res.status}): ${text}`);
        error.status = res.status;
        error.retryable = res.status === 429 || res.status >= 500;
        throw error;
      }

      const data = await res.json();
      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || refreshToken,
        expiresAt: normalizeExpiresAt(data.expires_at) || (Date.now() + (data.expires_in || 3600) * 1000),
      };
    } catch (err) {
      const isNetworkError = err instanceof Error &&
        (err.message.includes('fetch failed') ||
          err.name === 'TimeoutError' || err.name === 'AbortError' ||
          (err.code === 'ECONNRESET' || err.code === 'ECONNREFUSED' ||
           err.code === 'ETIMEDOUT' || err.code === 'UND_ERR_CONNECT_TIMEOUT'));

      // NEVER re-send a single-use refresh token after an AMBIGUOUS failure. A timeout,
      // an abort, or a reset AFTER the request left us means the server may have processed
      // it and rotated the token — retrying then spends a token that is already dead and
      // the account is destroyed with invalid_grant. Only a failure that provably happened
      // BEFORE the server saw the request (connection refused, DNS) is safe to retry.
      //
      // Measured 2026-08-03: a degraded network aborted refreshes at 10s; the retry loop
      // re-sent each token up to 3 times within seconds, and 4 accounts died with
      // "Refresh token not found or invalid" — requiring a manual re-login each.
      const sentToServer = !(err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND'
        || err.code === 'EAI_AGAIN' || err.code === 'UND_ERR_CONNECT_TIMEOUT');
      if (attempt < maxRetries && isNetworkError && !sentToServer) {
        continue;
      }
      if (isNetworkError) {
        err.retryable = true;
        // Tell the caller the token's fate is UNKNOWN, so it cools the account and tries
        // once later instead of treating this as a clean failure.
        err.ambiguousRefresh = sentToServer;
      }
      throw err;
    }
  }
}

/**
 * Normalize an expires_at value to milliseconds.
 * OAuth endpoints may return seconds; Claude Code credentials use milliseconds.
 */
export function normalizeExpiresAt(expiresAt) {
  if (!expiresAt) return expiresAt;
  // If the value is plausibly in seconds (< 10^12 ≈ year 2001 in ms, year 33658 in s),
  // convert to milliseconds
  return expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
}

/**
 * Check if an OAuth token is expiring within the given threshold.
 */
export function isTokenExpiringSoon(expiresAt, thresholdMs = 5 * 60 * 1000) {
  if (!expiresAt) return false;
  return Date.now() + thresholdMs >= normalizeExpiresAt(expiresAt);
}

/**
 * Fetch account profile for an OAuth token.
 * Returns { email, name, orgName, orgType, ... } on success,
 * or { error: 'reason' } on failure.
 */
export async function fetchProfile(accessToken) {
  try {
    const res = await fetch(PROFILE_URL, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message || JSON.stringify(body).slice(0, 200);
      } catch {
        detail = await res.text().catch(() => '');
      }
      return { error: `HTTP ${res.status}${detail ? ': ' + detail : ''}` };
    }
    const data = await res.json();
    return {
      accountUuid: data.account?.uuid,
      email: data.account?.email,
      name: data.account?.display_name,
      orgName: data.organization?.name,
      orgType: data.organization?.organization_type,
      hasClaudeMax: data.account?.has_claude_max,
      hasClaudePro: data.account?.has_claude_pro,
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_USAGE_BETA = 'oauth-2025-04-20';

/** Parse a reset timestamp (epoch-seconds, epoch-ms, or ISO string) to ms, or null. */
export function parseResetTimestamp(rawReset) {
  if (typeof rawReset === 'number') return rawReset < 1e12 ? rawReset * 1000 : rawReset;
  if (typeof rawReset === 'string') {
    const asNum = Number(rawReset);
    if (Number.isFinite(asNum) && rawReset.trim() !== '') return asNum < 1e12 ? asNum * 1000 : asNum;
    const parsed = Date.parse(rawReset);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Map a model id or usage display name to a coarse family key, or null. Matches
 *  BOTH request models (`claude-fable-5`) and usage `scope.model.display_name`
 *  (`Fable`). Unmatched → null (caller treats as never model-scoped). */
export function modelFamily(model) {
  const s = String(model || '').toLowerCase();
  if (s.includes('fable') || s.includes('mythos')) return 'fable';
  if (s.includes('opus')) return 'opus';
  if (s.includes('sonnet')) return 'sonnet';
  if (s.includes('haiku')) return 'haiku';
  return null;
}

/** Normalize one usage bucket from the /api/oauth/usage response to
 *  { utilization: 0..1, resetAt: ms-timestamp } (tolerant of field-name and
 *  percentage/epoch-vs-iso variations). Legacy top-level buckets only — the
 *  `limits[]` path uses parseLimitEntry (clean 0-100 percent, no ambiguity). */
export function normalizeUsageBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;

  const rawPct = bucket.used_percentage ?? bucket.utilization ?? bucket.usedPercentage;
  const parsedPct = typeof rawPct === 'number' ? rawPct : parseFloat(rawPct);
  const utilization = Number.isFinite(parsedPct)
    ? (parsedPct > 1 ? parsedPct / 100 : parsedPct)
    : null;

  return { utilization, resetAt: parseResetTimestamp(bucket.resets_at ?? bucket.resetsAt ?? bucket.reset_at ?? bucket.resetAt) };
}

/** Normalize one `limits[]` entry. `percent` is a clean 0-100 integer (unlike the
 *  ambiguous top-level buckets), so utilization = percent/100 always. */
export function parseLimitEntry(l) {
  if (!l || typeof l !== 'object') return null;
  const pct = typeof l.percent === 'number' ? l.percent : parseFloat(l.percent);
  return {
    utilization: Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : null,
    resetAt: parseResetTimestamp(l.resets_at ?? l.resetsAt),
    severity: typeof l.severity === 'string' ? l.severity : null,
    isActive: l.is_active !== false,
  };
}

/** Read an account's quota from the zero-spend /api/oauth/usage endpoint.
 *  Returns { fiveHour, sevenDay, scopedWeekly } buckets, or { error, status }.
 *  Per-model + unified limits now live in the `limits[]` array (the top-level
 *  seven_day_opus / seven_day_sonnet keys are deprecated → always null). */
export async function fetchUsage(accessToken) {
  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_USAGE_BETA,
        'Accept': 'application/json',
      },
    });

    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.error?.message || JSON.stringify(body).slice(0, 200);
      } catch {
        detail = await res.text().catch(() => '');
      }
      return { error: `HTTP ${res.status}${detail ? ': ' + detail : ''}`, status: res.status };
    }

    const data = await res.json();

    // The `limits[]` array is the authoritative source: `session` (5h), unscoped
    // `weekly_all` (unified 7d), and `weekly_scoped` entries carrying a
    // `scope.model` — the PER-MODEL weekly sub-limits (e.g. Fable) Anthropic
    // enforces separately from the unified weekly. Prefer it over the legacy
    // top-level buckets (whose 0-100 percent misreads a genuine 1% as 100%).
    const scopedWeekly = {};
    let limitsSession = null;
    let limitsWeeklyAll = null;
    for (const l of (Array.isArray(data?.limits) ? data.limits : [])) {
      if (l?.kind === 'weekly_scoped') {
        const fam = l?.scope?.model?.display_name ? modelFamily(l.scope.model.display_name) : null;
        if (fam) scopedWeekly[fam] = parseLimitEntry(l);
      } else if (l?.kind === 'session') {
        limitsSession = parseLimitEntry(l);
      } else if (l?.kind === 'weekly_all') {
        limitsWeeklyAll = parseLimitEntry(l);
      }
    }

    return {
      fiveHour: limitsSession || normalizeUsageBucket(data?.five_hour),
      sevenDay: limitsWeeklyAll || normalizeUsageBucket(data?.seven_day),
      scopedWeekly,
    };
  } catch (err) {
    return { error: err.message || String(err), status: null };
  }
}

// z.ai quota monitor — a DIFFERENT host/path than the message upstream
// (account.upstream is the Anthropic-compat endpoint). Zero-spend read.
const ZAI_QUOTA_URL = 'https://api.z.ai/api/monitor/usage/quota/limit';

/** Classify one z.ai `limits[]` entry into a Ses (5h) or Wk (weekly) TOKEN window.
 *  Only `TOKENS_LIMIT` maps to the quota bars; `TIME_LIMIT` is a tool-call cap
 *  (web-search/reader counts) and is intentionally ignored. `unit` is z.ai's
 *  window enum (3 = 5-hour session, 6 = weekly); we fall back to reset-distance
 *  when the code is unfamiliar so a new plan tier still classifies sanely. */
export function classifyZaiLimit(l, now = Date.now()) {
  if (!l || l.type !== 'TOKENS_LIMIT') return null;
  const reset = Number(l.nextResetTime);
  const resetAt = Number.isFinite(reset) && reset > 0 ? reset : null;
  const pct = typeof l.percentage === 'number' ? l.percentage : parseFloat(l.percentage);
  const utilization = Number.isFinite(pct) ? Math.max(0, Math.min(1, pct / 100)) : null;
  let bucket;
  if (l.unit === 3) bucket = 'ses';
  else if (l.unit === 6) bucket = 'wk';
  else if (resetAt) bucket = (resetAt - now) <= 12 * 60 * 60 * 1000 ? 'ses' : 'wk';
  else bucket = 'ses';
  return { bucket, utilization, resetAt };
}

// Kimi Coding Plan usage — the coding key (sk-kimi-…) reads its own quota at
// <base>/v1/usages (the community `kimi-code-usage` tool's endpoint). NOTE the
// User-Agent: the endpoint is served by the Kimi Code platform, not the Open
// Platform (whose /users/me/balance 401s a coding key). Best-effort, non-load-
// bearing UA — the failure path degrades to last-known + the staleness marker.
const KIMI_USAGE_UA = 'KimiCLI/1.6';

/** ms of one Kimi limit `window`, normalized from its timeUnit so the SHORTEST
 *  window (the 5h session) is picked regardless of unit. null when unknown. */
export function kimiWindowMs(window) {
  const dur = Number(window?.duration);
  if (!Number.isFinite(dur) || dur <= 0) return null;
  const unit = String(window?.timeUnit || window?.time_unit || '').toUpperCase();
  const mult = unit.includes('SECOND') ? 1e3
    : unit.includes('MINUTE') ? 60e3
    : unit.includes('HOUR') ? 3600e3
    : unit.includes('DAY') ? 86400e3
    : unit.includes('WEEK') ? 7 * 86400e3
    : unit.includes('MONTH') ? 30 * 86400e3
    : null;
  return mult == null ? null : dur * mult;
}

/** Normalize a Kimi usage row {limit,used,remaining,resetTime} (values are STRINGS)
 *  to { utilization, resetAt }. CRITICAL: utilization is `null` — never a computed
 *  NaN — when the inputs are absent or limit<=0, because clamp01(NaN)=0 downstream
 *  would render a blind account as "0% used = fully available" and route real
 *  traffic onto quota we can't see. */
export function parseKimiRow(d) {
  if (!d || typeof d !== 'object') return null;
  const limit = Number(d.limit ?? d.limit_amount);
  let used = d.used != null ? Number(d.used ?? d.used_amount) : null;
  const remaining = d.remaining != null ? Number(d.remaining) : null;
  if (used == null && remaining != null && Number.isFinite(limit)) used = limit - remaining;
  const utilization = (Number.isFinite(limit) && limit > 0 && used != null && Number.isFinite(used))
    ? Math.max(0, Math.min(1, used / limit))
    : null;
  const resetRaw = d.resetTime || d.reset_at || d.reset_time;
  const parsed = resetRaw ? Date.parse(resetRaw) : NaN;
  return { utilization, resetAt: Number.isFinite(parsed) ? parsed : null };
}

/** Read the Kimi Coding Plan quota → { ses, wk, source:'kimi' } | { error, status? }.
 *  Weekly = the top-level `usage` rolling window; Ses (5h) = the shortest `limits[]`
 *  window. A transient/partial response returns {error} or null buckets so
 *  applyProviderUsage keeps the last-known values (never a phantom 0%). */
export async function fetchKimiUsage(account) {
  const token = account?.credential;
  if (!token) return { error: 'unsupported', source: null };
  const base = String(account.upstream || 'https://api.kimi.com/coding').replace(/\/+$/, '');
  const headers = { 'Authorization': `Bearer ${token}`, 'User-Agent': KIMI_USAGE_UA, 'Accept': 'application/json' };
  try {
    let res = await fetch(`${base}/v1/usages`, { headers, signal: AbortSignal.timeout(10_000) });
    if (res.status === 404) res = await fetch(`${base}/v1/usage`, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = await res.json();
    // Weekly = top-level `usage` (ALWAYS present in a valid coding-plan response).
    // If it's missing, the response is partial/malformed → return an error so
    // applyProviderUsage keeps the last-known weekly instead of the falsy-wk branch
    // BLANKING it (unlike z.ai, where a missing weekly genuinely means "no weekly").
    const wkRow = parseKimiRow(data?.usage);
    if (!wkRow || wkRow.utilization == null) return { error: 'partial_response', source: 'kimi' };
    const wk = wkRow;
    // Ses = the shortest limits[] window (the 5h). Fall back to first if durations unknown.
    let ses = null, sesMs = Infinity;
    for (const l of (Array.isArray(data?.limits) ? data.limits : [])) {
      const detail = l && typeof l.detail === 'object' ? l.detail : l;
      const row = parseKimiRow(detail);
      if (!row || row.utilization == null) continue;
      const ms = kimiWindowMs(l?.window);
      if (ms != null && ms < sesMs) { sesMs = ms; ses = row; }
      else if (ses == null && ms == null) ses = row;
    }
    return { ses, wk, source: 'kimi', level: data?.user?.membership?.level || null };
  } catch (err) {
    return { error: err.message || String(err), status: null };
  }
}

/** Read a provider account's quota. z.ai and Kimi both have a pollable coding-plan
 *  usage endpoint mapped to Ses/Wk windows. Returns { ses, wk, source } |
 *  { error, status?, source? }. */
export async function fetchProviderUsage(account) {
  const provider = account?.provider;
  const token = account?.credential;
  if (provider === 'kimi') return fetchKimiUsage(account);
  if (provider !== 'zai' || !token) return { error: 'unsupported', source: null };
  try {
    const res = await fetch(ZAI_QUOTA_URL, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
    });
    if (!res.ok) return { error: `HTTP ${res.status}`, status: res.status };
    const data = await res.json();
    if (data?.code !== 200 || !data?.data) {
      return { error: `bad_envelope${data?.code != null ? ' code=' + data.code : ''}` };
    }
    const now = Date.now();
    let ses = null, wk = null;
    for (const l of (Array.isArray(data.data.limits) ? data.data.limits : [])) {
      const c = classifyZaiLimit(l, now);
      if (!c) continue;
      if (c.bucket === 'ses') ses = { utilization: c.utilization, resetAt: c.resetAt };
      else if (c.bucket === 'wk') wk = { utilization: c.utilization, resetAt: c.resetAt };
    }
    return { ses, wk, level: data.data.level || null, source: 'zai' };
  } catch (err) {
    return { error: err.message || String(err), status: null };
  }
}

// OAuth config (extracted from Claude Code)
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_AUTHORIZE = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN = 'https://platform.claude.com/v1/oauth/token';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/**
 * Perform OAuth login via browser with PKCE flow.
 * Opens the user's browser, waits for the callback, exchanges the code for tokens.
 */
export async function loginOAuth() {
  // Generate PKCE
  const codeVerifier = randomBytes(32).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
  const state = randomBytes(32).toString('base64url');

  // Start local callback server on a random port
  const { port, codePromise, server } = await startCallbackServer(state);
  const redirectUri = `http://localhost:${port}/callback`;

  // Build authorization URL
  const authUrl = new URL(OAUTH_AUTHORIZE);
  authUrl.searchParams.set('code', 'true');
  authUrl.searchParams.set('client_id', OAUTH_CLIENT_ID);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', OAUTH_SCOPES);
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  // Open browser
  console.log('Opening browser for authentication...');
  console.log(`If it doesn't open, visit:\n  ${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());

  // Wait for either the callback server or manual paste from stdin
  let code;
  try {
    code = await raceWithStdinCode(codePromise, state);
  } finally {
    server.close();
  }

  // Exchange code for tokens
  console.log('Exchanging authorization code for tokens...');
  const tokenRes = await fetch(OAUTH_TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      state,
      grant_type: 'authorization_code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${text}`);
  }

  const tokens = await tokenRes.json();
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: normalizeExpiresAt(tokens.expires_at) || (Date.now() + (tokens.expires_in || 3600) * 1000),
  };
}

/**
 * Race the callback server promise against manual code entry from stdin.
 * The user can paste the full callback URL or just the authorization code.
 */
function raceWithStdinCode(callbackPromise, expectedState) {
  if (!process.stdin.isTTY) return callbackPromise;

  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;

    const settle = (fn, val) => {
      if (settled) return;
      settled = true;
      rl.close();
      fn(val);
    };

    rl.question('Paste authorization code here (or wait for browser callback): ', answer => {
      const trimmed = answer.trim();
      if (!trimmed) return; // empty input, keep waiting for callback

      // Try to parse as a URL with ?code= parameter
      try {
        const url = new URL(trimmed);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (code) {
          if (expectedState && state && state !== expectedState) {
            settle(reject, new Error('OAuth state mismatch'));
          } else {
            settle(resolve, code);
          }
          return;
        }
      } catch {}

      // Treat raw input as the authorization code
      settle(resolve, trimmed);
    });

    callbackPromise.then(
      code => settle(resolve, code),
      err => settle(reject, err),
    );
  });
}

function startCallbackServer(expectedState) {
  return new Promise((resolve, reject) => {
    let resolveCode, rejectCode;
    const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');
        const state = url.searchParams.get('state');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication failed</h2><p>You can close this tab.</p></body></html>');
          rejectCode(new Error(`OAuth error: ${error} - ${url.searchParams.get('error_description') || ''}`));
          return;
        }

        if (expectedState && state !== expectedState) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html><body><h2>Authentication failed</h2><p>State mismatch. You can close this tab.</p></body></html>');
          rejectCode(new Error('OAuth state mismatch'));
          return;
        }

        if (code) {
          res.writeHead(302, { 'Location': 'https://platform.claude.com/oauth/code/success?app=claude-code' });
          res.end();
          resolveCode(code);
          return;
        }
      }

      res.writeHead(404);
      res.end('Not found');
    });

    server.listen(0, 'localhost', () => {
      resolve({ port: server.address().port, codePromise, server });
    });
    server.on('error', reject);

    // Bounded so a forgotten browser tab can't pin the process. 5 minutes, not 2:
    // reported 2026-08-03 that a real login (password + 2FA, several accounts in a row)
    // repeatedly overran 2 minutes and had to be restarted from scratch.
    const timer = setTimeout(() => {
      rejectCode(new Error(`Login timed out after ${Math.round(LOGIN_TIMEOUT_MS / 60_000)} minutes`));
      server.close();
    }, LOGIN_TIMEOUT_MS);
    timer.unref();
  });
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open'
    : platform === 'win32' ? 'start'
    : 'xdg-open';
  exec(`${cmd} ${JSON.stringify(url)}`, () => {});
}
