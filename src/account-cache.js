import { randomUUID } from 'node:crypto';

// Account-owner input/output observations. The four counters are always in this
// order: uncached input, cache reads, cache writes, generated output.
const FIELDS = ['input', 'cacheRead', 'cacheWrite', 'output'];
const MINUTE = 60_000;
const WEEK = 7 * 24 * 60;
const WINDOWS = { '1h': 60, '3h': 180, '24h': 1440, '7d': WEEK, all: Infinity };
const zero = () => [0, 0, 0, 0];
const valid = v => Array.isArray(v) && v.length === 4 && v.every(n => Number.isFinite(n) && n >= 0);
const add = (a, b) => { for (let i = 0; i < 4; i++) a[i] += b[i]; };
const memo = new WeakMap();
const pruned = new WeakMap();

export const validCacheSource = id => typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);

export function emptyCacheHistory(since, source = randomUUID()) {
  return { source, since, total: zero(), minutes: {}, legacyHours: {} };
}

function prune(history, minute) {
  // Sweep at most once per hour per active account. Queries independently age
  // the windows, including idle accounts. Lifetime totals never expire.
  const hour = Math.floor(minute / 60);
  const last = pruned.get(history);
  if (last != null && hour <= last) return minute > last * 60 - WEEK;
  for (const k of Object.keys(history.minutes)) if (+k <= minute - WEEK) delete history.minutes[k];
  for (const k of Object.keys(history.legacyHours)) if (+k + 60 <= minute - WEEK) delete history.legacyHours[k];
  pruned.set(history, hour);
  return true;
}

export function addCacheUsage(history, at, counts) {
  if (!valid(counts) || !counts.some(Boolean)) return;
  const minute = Math.floor(at / MINUTE);
  history.since = Math.min(history.since, at);
  add(history.total, counts);
  if (!prune(history, minute)) return;
  add(history.minutes[minute] ||= zero(), counts);
  if (memo.get(history)?.minute !== minute) memo.delete(history);
}

// Before per-minute tracking the serving worker persisted up to ~24 hours of
// classified usage. Keep those hours whole: an hour straddling a cutoff cannot
// be apportioned honestly. Old day/cycle totals do not separate uncached input.
export function cacheHistoryFromHours(hours, now) {
  const history = emptyCacheHistory(now);
  for (const [key, v] of Object.entries(hours || {})) {
    const at = Date.parse(key + ':00:00Z');
    if (!Number.isFinite(at) || at > now || at < now - 25 * 3600_000 || !v) continue;
    const counts = [v.in, v.cr, v.cc, v.out];
    if (!valid(counts) || !counts.some(Boolean)) continue;
    history.legacyHours[at / MINUTE] = counts;
    history.since = Math.min(history.since, at);
    add(history.total, counts);
  }
  return history;
}

export function restoreCacheHistory(raw, now) {
  if (!raw || !Number.isFinite(raw.since) || !valid(raw.total)) return null;
  const history = emptyCacheHistory(raw.since, validCacheSource(raw.source) ? raw.source : undefined);
  if (typeof raw.assignedOwner === 'string') history.assignedOwner = raw.assignedOwner;
  history.total = [...raw.total];
  for (const key of ['minutes', 'legacyHours']) {
    for (const [minute, counts] of Object.entries(raw[key] || {})) {
      if (/^\d+$/.test(minute) && valid(counts)) history[key][minute] = [...counts];
    }
  }
  prune(history, Math.floor(now / MINUTE));
  return history;
}

function describe(values, partial) {
  const [input, cacheRead, cacheWrite, output] = values;
  const prompt = input + cacheRead + cacheWrite;
  return { input, cacheRead, cacheWrite, output, hit: prompt > 0 ? cacheRead / prompt : null, partial };
}

export function cacheWindows(history, now) {
  if (!history) return null;
  const minute = Math.floor(now / MINUTE);
  let base = memo.get(history);
  if (base?.minute !== minute) {
    const finished = {}, partial = {};
    for (const [key, span] of Object.entries(WINDOWS)) {
      if (key === 'all') continue;
      const first = minute - span + 1;
      finished[key] = zero();
      partial[key] = history.since > first * MINUTE;
      for (const [k, counts] of Object.entries(history.minutes)) {
        if (+k >= first && +k < minute) add(finished[key], counts);
      }
      for (const [k, counts] of Object.entries(history.legacyHours)) {
        if (+k >= first && +k <= minute) add(finished[key], counts);
        else if (+k < first && +k + 60 > first) partial[key] = true;
      }
    }
    base = { minute, finished, partial };
    memo.set(history, base);
  }
  const windows = {};
  for (const key of Object.keys(base.finished)) {
    const values = [...base.finished[key]];
    if (history.minutes[minute]) add(values, history.minutes[minute]);
    windows[key] = describe(values, base.partial[key]);
  }
  windows.all = describe(history.total, false);
  return { source: history.source, since: history.since, asOf: now, windows };
}

// Validate and whitelist the optional status extension at the link boundary.
// A missing or malformed snapshot must never become an apparent 0% result.
export function readCacheSnapshot(raw) {
  if (!raw || !Number.isFinite(raw.since) || !Number.isFinite(raw.asOf)) return null;
  const windows = {};
  for (const key of Object.keys(WINDOWS)) {
    const w = raw.windows?.[key];
    const values = FIELDS.map(f => w?.[f]);
    if (!valid(values)) return null;
    windows[key] = describe(values, w.partial === true);
  }
  return { ...(validCacheSource(raw.source) ? { source: raw.source } : {}), since: raw.since, asOf: raw.asOf, windows };
}

export function combineCacheWindows(snapshots) {
  // The same serving ledger can appear through two aliases of one team pool.
  // Pick its latest live observation once; distinct credential holders still sum.
  const sources = new Map();
  const lifetime = s => FIELDS.reduce((total, field) => total + s.windows.all[field], 0);
  for (const snapshot of snapshots) {
    if (!snapshot) continue;
    const key = snapshot.source || snapshot;
    const prior = sources.get(key);
    const newer = prior && (snapshot.asOf > prior.asOf ||
      (snapshot.asOf === prior.asOf && lifetime(snapshot) > lifetime(prior)));
    if (!prior || (prior.offline && !snapshot.offline) ||
        (Boolean(prior.offline) === Boolean(snapshot.offline) && newer)) sources.set(key, snapshot);
  }
  const known = [...sources.values()];
  if (!known.length) return null;
  const windows = {};
  for (const key of Object.keys(WINDOWS)) {
    const sums = zero();
    for (const snap of known) {
      if (key === 'all' || !snap.offline) add(sums, FIELDS.map(f => snap.windows[key][f]));
    }
    windows[key] = describe(sums, snapshots.some(s => !s) || known.some(s => s.offline || s.windows[key].partial));
  }
  return { since: Math.min(...known.map(s => s.since)), asOf: Math.min(...known.map(s => s.asOf)), windows };
}

// A released worker can still finish requests while the new owner is serving.
// Add only positive increments since its handoff snapshot to the new owner's
// persisted ledger, alongside the capacity ledger's existing drain merge.
export function mergeCacheDelta(target, before, after) {
  if (!after) return target;
  const delta = after.total.map((n, i) => Math.max(0, n - (before?.total?.[i] || 0)));
  if (!delta.some(Boolean)) return target;
  target ||= emptyCacheHistory(after.since, after.source);
  memo.delete(target);
  add(target.total, delta);
  target.since = Math.min(target.since, after.since);
  for (const [minute, values] of Object.entries(after.minutes)) {
    const increments = values.map((n, i) => Math.max(0, n - (before?.minutes?.[minute]?.[i] || 0)));
    if (increments.some(Boolean)) add(target.minutes[minute] ||= zero(), increments);
  }
  return target;
}
