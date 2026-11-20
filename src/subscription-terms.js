// Operator-only display data. Neither the registry nor the probe terms live in
// account status, link snapshots or the persisted usage ledger.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { credentialFp } from './pool-link.js';

const observed = new WeakMap();
const files = new Map();
const MAX_BYTES = 2 * 1024 * 1024;
const REFRESH_MS = 30_000;
const cadences = new Map([
  ['monthly', 'monthly'], ['quarterly', 'quarterly'],
  ['annual', 'annual'], ['annually', 'annual'], ['yearly', 'annual'],
]);

function vendor(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (key === 'z.ai' || key === 'glm') return 'zai';
  if (key === 'claude') return 'anthropic';
  return key || null;
}

function amount(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function renewalDate(value) {
  if (typeof value !== 'string') return null;
  const date = /^(\d{4}-\d\d-\d\d)(?:$|[ T]\d{2}:\d{2})/.exec(value)?.[1];
  const ms = date && Date.parse(date + 'T00:00:00Z');
  return date && Number.isFinite(ms) && new Date(ms).toISOString().startsWith(date + 'T') ? date : null;
}

function terms(sub) {
  if (!sub || typeof sub !== 'object' || (sub.status && String(sub.status).toUpperCase() !== 'VALID')) return null;
  const stopped = [false, 0, '0', 'false'].includes(sub.auto_renew);
  const price = (!stopped ? amount(sub.renew_price) : null) ?? amount(sub.price);
  const currency = typeof sub.currency === 'string' && /^[a-z]{3}$/i.test(sub.currency)
    ? sub.currency.toUpperCase() : null;
  const cadence = cadences.get(String(sub.cycle ?? '').toLowerCase()) ?? null;
  const nextRenewal = stopped ? null : renewalDate(sub.next_renew);
  return price !== null || cadence || nextRenewal ? { price, currency, cadence, nextRenewal } : null;
}

function readRegistry(file) {
  let fd;
  const byAccount = new Map();
  try {
    // Check the *opened* file before reading. Never open a FIFO in blocking
    // mode or follow a substituted symlink. Only the owning OS user may read it.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (typeof process.getuid !== 'function' || !stat.isFile() || stat.uid !== process.getuid()
        || (stat.mode & 0o077) || stat.size > MAX_BYTES) return byAccount;
    const data = Buffer.alloc(stat.size);
    let bytes = 0;
    while (bytes < data.length) {
      const n = readSync(fd, data, bytes, data.length - bytes, bytes);
      if (!n) return byAccount;
      bytes += n;
    }
    const rows = JSON.parse(data.toString('utf8'));
    if (!Array.isArray(rows)) return byAccount;
    for (const row of rows) {
      const provider = vendor(row?.vendor);
      const name = row?.maxpool_account ?? row?.account;
      if (!provider || typeof name !== 'string' || !name || !Array.isArray(row.subscriptions)) continue;
      const entries = row.subscriptions.map(terms).filter(Boolean);
      if (!entries.length) continue;
      const key = JSON.stringify([provider, name]);
      const previous = byAccount.get(key) || [];
      byAccount.set(key, previous.concat(entries));
    }
  } catch {
    // Missing, unreadable or malformed private settings never interrupt the TUI.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return byAccount;
}

function registry(file) {
  const now = Date.now();
  const cached = files.get(file);
  if (cached && now - cached.time < REFRESH_MS) return cached.rows;
  const rows = readRegistry(file);
  files.set(file, { time: now, rows });
  return rows;
}

/** Reuse the existing z.ai probe. Keep only display fields, without adding
 * billing data to the runtime account that status/link serializers receive. */
export function rememberZaiTerms(account, subscriptions) {
  if (!account?.credential || account.remote || account.provider !== 'zai' || !Array.isArray(subscriptions)) return;
  const rows = subscriptions.map(s => terms({
    status: s.status, price: s.actualPrice, renew_price: s.renewPrice, currency: s.currency,
    cycle: s.billingCycle, auto_renew: s.autoRenew, next_renew: s.nextRenewal,
  })).filter(Boolean);
  observed.set(account, { fingerprint: credentialFp(account.credential), rows });
}

/** One row per active subscription. Link-scoped registry entries are explicitly
 * configured on the viewing machine. A remote's self-reported plan is never read. */
export function subscriptionTermsFor(config, account) {
  if (!account) return [];
  const pool = account.remote ? account.remote.linkName : null;
  if (account.remote && !pool) return [];
  const provider = vendor(account.provider || (account.type === 'oauth' ? 'anthropic' : null));
  const name = account.remote ? account.remote.remoteName : account.name;
  if (!provider || !name) return [];
  const sources = config?.ui?.subscriptionRegistries;
  if (Array.isArray(sources)) {
    const key = JSON.stringify([provider, name]);
    for (const source of sources) {
      if ((source?.pool ?? null) !== pool || typeof source?.file !== 'string' || !isAbsolute(source.file)) continue;
      const rows = registry(source.file).get(key);
      if (rows?.length) return rows;
    }
  }
  if (account.remote) return [];
  const live = observed.get(account);
  if (live && live.fingerprint === credentialFp(account.credential)) return live.rows;
  // This is a plan explicitly entered for the local account. Never turn a
  // provider default or a monthly-normalized capacity estimate into invoice facts.
  const plan = account.plan;
  if (!plan) return [];
  const row = terms({ price: plan.priceUsd, currency: 'USD', cycle: plan.cadence });
  return row ? [row] : [];
}
