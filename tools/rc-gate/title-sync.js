// title-sync — push the session's LOCAL /rename name up as its Remote Control title.
//
// WHY (2026-09-08). Claude Code sets a remote session's title exactly ONCE, in the
// body of the POST that creates it, and never updates it again. When Remote Control
// auto-attaches to an already-running CLI session (`tags: ["remote-control-auto"]`,
// 21 of 26 creates observed) that happens at startup, before the session has any
// name — so the title is the generated placeholder `macbook-pro-local-<slug>`, which
// is what shows in the Claude app forever. `/rename` writes only the local registry
// (`~/.claude/sessions/<pid>.json`, `nameSource: "user"`); it has no push path. And
// the CLI's own auto-titler (the sole caller of updateSessionTitle) is explicitly
// skipped when `isAttachToExisting` is set — i.e. exactly the attach case. Measured:
// zero PUT /v1/code/sessions/* in the whole gate log.
//
// HOW: the gate already proxies the CLI's own authenticated calls to
// /v1/code/sessions, so it can borrow a live header set from one (no new credential,
// no token refresh, nothing on disk) and issue the PUT the CLI never makes. Runs
// entirely off the request path on a timer — it can never delay or alter a
// forwarded request.
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

// Test seam, same pattern as the gate's DIRECT_HOST/DIRECT_PORT overrides.
const SESSIONS_DIR = process.env.RC_GATE_SESSIONS_DIR || path.join(os.homedir(), '.claude', 'sessions');

// Own agent, keep-alive OFF. One PUT every 30s does not need pooling, and this
// process has a history of holding fds after close (7,568 CLOSED sockets, 09-04) —
// so the sync must not add a long-lived socket of its own. Node's globalAgent
// keeps connections alive by default, which is exactly what we are avoiding.
const syncAgent = new https.Agent({ keepAlive: false, maxSockets: 2 });
const MAX_TITLE = 200;
const PER_CYCLE = 20;          // bound the work per tick
const MAX_FAILURES = 3;        // give up on a session after this many non-401 failures

// Headers that must NOT be inherited from the observed request.
const DROP = new Set([
  'host', 'content-length', 'content-type', 'transfer-encoding',
  'connection', 'proxy-connection', 'accept-encoding', 'expect',
]);

let authTemplate = null;       // in-memory only; never logged, never written to disk
let authSeen = null;           // last credential string, to skip redundant rebuilds

// Capture a usable header set from a real, authenticated CLI request. Reusing the
// CLI's own headers (rather than hand-building them) carries whatever the server
// requires — anthropic-version, betas, X-Trusted-Device-Token — without guessing.
export function noteAuthHeaders(url, headers) {
  try {
    if (!headers || typeof url !== 'string') return;
    const p0 = url.split('?')[0];
    const userAuthPath =
      p0 === '/v1/code/sessions' ||                      // list / create
      /^\/v1\/code\/sessions\/[^/]+$/.test(p0) ||       // fetch one
      p0.startsWith('/api/');                            // profile, settings, flags
    if (!userAuthPath) return;
    const auth = headers.authorization || headers.Authorization;
    if (typeof auth !== 'string' || !/^Bearer\s+sk-ant-/.test(auth)) return;
    if (auth === authSeen && authTemplate) return;   // unchanged credential: nothing to rebuild
    const t = {};
    for (const [k, v] of Object.entries(headers)) {
      const lk = k.toLowerCase();
      if (DROP.has(lk)) continue;
      if (typeof v === 'string') t[lk] = v;
    }
    t['content-type'] = 'application/json';
    t['accept-encoding'] = 'identity';
    t['anthropic-version'] = t['anthropic-version'] || '2023-06-01';
    authTemplate = t;
    authSeen = auth;
  } catch {}
}

function loadState(stateFile) {
  try { return JSON.parse(readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function saveState(stateFile, s) {
  try { writeFileSync(stateFile, JSON.stringify(s, null, 0)); } catch {}
}

// One PUT. Resolves {status} — never rejects, so a transport error can't reach the
// timer as an unhandled rejection and take the gate down.
function putTitle(host, port, id, title, headers) {
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    try {
      const body = Buffer.from(JSON.stringify({ title }), 'utf8');
      const req = https.request({
        host, port, servername: 'api.anthropic.com',
        method: 'PUT', path: `/v1/code/sessions/${encodeURIComponent(id)}`,
        headers: { ...headers, 'content-length': String(body.length) },
        timeout: 15_000,
        agent: syncAgent,
      }, res => {
        const chunks = [];
        res.on('data', c => { if (chunks.length < 8) chunks.push(c); });
        res.on('end', () => finish({
          status: res.statusCode,
          body: res.statusCode >= 300 ? Buffer.concat(chunks).toString('utf8').slice(0, 300) : '',
        }));
        res.on('error', () => finish({ status: 0, error: 'response' }));
      });
      req.on('timeout', () => { try { req.destroy(); } catch {} finish({ status: 0, error: 'timeout' }); });
      req.on('error', e => finish({ status: 0, error: e?.code || e?.message || 'error' }));
      req.end(body);
    } catch (e) { finish({ status: 0, error: String(e?.message || e) }); }
  });
}

// Local sessions that carry BOTH a user-chosen name and a bridge session id. A
// `derived` name (`team-workspace-5e`) is no better than the placeholder, so only
// `user` names are pushed — this never overwrites a real title with a worse one.
function pendingRenames(state) {
  const out = [];
  let files = [];
  try { files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json')); } catch { return out; }
  for (const f of files) {
    let d;
    try { d = JSON.parse(readFileSync(path.join(SESSIONS_DIR, f), 'utf8')); } catch { continue; }
    const id = d?.bridgeSessionId, name = d?.name;
    if (!id || typeof id !== 'string') continue;
    if (!name || typeof name !== 'string' || d.nameSource !== 'user') continue;
    const title = name.slice(0, MAX_TITLE);
    const st = state[id];
    if (st && st.title === title) continue;            // already pushed this exact name
    if (st && st.failures >= MAX_FAILURES && st.failedTitle === title) continue;  // archived/gone
    out.push({ id, title });
  }
  return out;
}

export function startTitleSync({ host, port, stateFile, intervalMs = 30_000, log = console.log }) {
  let running = false;

  async function cycle() {
    if (running) return;
    running = true;
    try {
      // Nothing observed yet. This early return is an optimization (it skips the
      // directory scan); the `if (!authTemplate) break` below is what makes the
      // no-credential case CORRECT, which is why mutating this line alone survives.
      if (!authTemplate) return;
      const state = loadState(stateFile);
      const todo = pendingRenames(state).slice(0, PER_CYCLE);
      if (!todo.length) return;
      let dirty = false;
      const credType = String(authSeen || '').slice(7, 20);   // "sk-ant-oat01" — a type marker, not secret material
      for (const { id, title } of todo) {
        if (!authTemplate) break;
        const r = await putTitle(host, port, id, title, authTemplate);
        if (r.status === 200 || r.status === 201) {
          state[id] = { title, at: Date.now() };
          dirty = true;
          log(`[title-sync] ${id.slice(0, 12)} -> ${JSON.stringify(title)}`);
        } else if (r.status === 401 || r.status === 403) {
          // Borrowed credential went stale; drop it and wait for the next observed
          // request to supply a fresh one. Never refresh a token ourselves —
          // rotating the CLI's refresh chain could sign every session out.
          authTemplate = null; authSeen = null;
          log(`[title-sync] borrowed credential rejected (${r.status}, type ${credType}) — waiting for a fresh one`);
          break;
        } else {
          const prev = state[id] || {};
          const streak = prev.failedTitle === title ? (prev.failures || 0) : 0;
          state[id] = { ...prev, failures: streak + 1, failedTitle: title, lastError: r.status || r.error };
          dirty = true;
          log(`[title-sync] ${id.slice(0, 12)} failed: ${r.status || r.error} ${r.body || ''}`.trimEnd());
        }
      }
      if (dirty) saveState(stateFile, state);
    } catch (e) {
      log(`[title-sync] cycle error: ${e?.message || e}`);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => { cycle(); }, intervalMs);
  timer.unref?.();                                     // never hold the process open
  return () => clearInterval(timer);
}
