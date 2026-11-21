// Versioned read model shared by the terminal and /maxpool/status. Each source
// exports its own ingress and meters. A peer's status is never re-exported.
import { provisioningEvidence } from './routing-capacity-analytics.js';

const HOUR = 3600_000;
const METRICS = ['arrivals', 'requests', 'completed', 'timelyCompleted', 'failed', 'cancelled', 'incomplete',
  'capacityDenied', 'weeklyDenied', 'sessionDenied', 'concurrencyDenied', 'unclassifiedDenied', 'queuedRequests', 'waitP90Ms', 'waitP95Ms', 'queuedWaitP95Ms', 'waitTargetMs',
  'active', 'serving', 'peakServing', 'activeSessions', 'peakSessions',
  'inputTokens', 'cachedInputTokens', 'coverageSince', 'completeCoverage', 'from', 'to'];
const metrics = row => Object.fromEntries(METRICS.filter(k => Number.isFinite(row[k]) || typeof row[k] === 'boolean').map(k => [k, row[k]]));
const RECENT_METRICS = ['requests', 'queuedRequests', 'notableWaits', 'capacityDenied', 'refusedAfterWait', 'waitP90Ms', 'waitP95Ms',
  'queuedWaitP95Ms', 'longestWaitMs', 'pending', 'oldestWaitMs', 'windowMs', 'observedMs'];
const RECENT_STATES = new Set(['quiet', 'ok', 'tight', 'short']);
const num = (v, min = 0) => Number.isFinite(v) && v >= min ? v : 0;

// A linked worker's recent block is remote input: re-derive every figure from coerced numbers so
// a malformed or older report can neither throw the render nor smuggle a value in as a string.
function sanitizeRecent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const recent = { state: RECENT_STATES.has(raw.state) ? raw.state : null };
  if (!recent.state) return null;
  for (const key of RECENT_METRICS) recent[key] = num(raw[key]);
  recent.windowMs = num(raw.windowMs, 1) || 900_000;
  if (recent.observedMs > recent.windowMs) recent.observedMs = recent.windowMs;
  return recent;
}
const dailyCounts = ({ requests, timelyCompleted, capacityDenied }) => ({ requests, timelyCompleted, capacityDenied });
const PERIODS = { '1h': HOUR, '24h': 24 * HOUR, '7d': 168 * HOUR };

export function buildRoutingReport(am, now) {
  const service = {};
  const daily = new Map();
  for (const [period, ms] of Object.entries(PERIODS)) {
    const sample = am.routingService.snapshot(ms, now, period === '7d' ? dailyCounts : null);
    // Hour buckets stay in the local store. A few fixed windows keep the regular
    // linked-worker poll small while still supporting period-to-period comparison.
    if (period === '7d') {
      for (const hour of sample.timeline) {
        const day = Math.floor(hour.hour / (24 * HOUR)) * 24 * HOUR;
        const row = daily.get(day) || { day, requests: 0, timelyCompleted: 0, capacityDenied: 0 };
        row.requests += hour.requests;
        row.timelyCompleted += hour.timelyCompleted;
        row.capacityDenied += hour.capacityDenied;
        daily.set(day, row);
      }
    }
    service[period] = { ...metrics(sample),
      accounts: (sample.accounts || []).map(a => ({ name: a.name, ...metrics(a) })) };
  }
  const live = am.routingService.recent(undefined, now);
  const recent = sanitizeRecent({ state: live.state, ...Object.fromEntries(RECENT_METRICS.filter(k => Number.isFinite(live[k])).map(k => [k, live[k]])) });
  const demandBetween = am.routingService.demandReader(now);
  const owners = new Set();
  const quotas = [];
  for (const account of am.accounts) {
    if (account.remote || account.type === 'pool') continue;
    const owner = am._localCacheKeys(account)[0];
    if (owners.has(owner)) continue;
    owners.add(owner);
    const sample = am.routingCapacity.snapshot(owner, now, demandBetween, 12);
    quotas.push({
      name: account.name, provider: account.provider || account.type,
      window: sample.window, measuredCycles: sample.measuredCycles,
      unknownCycles: sample.unknownCycles, meanUnusedFraction: sample.meanUnusedFraction,
      cycles: sample.cycles.map(c => ({
        startAt: c.startAt, resetAt: c.resetAt, observedAt: c.observedAt, window: c.window,
        unusedFraction: c.unusedFraction, reason: c.reason, attribution: c.attribution,
        alternativeTurns: c.alternativeTurns,
      })),
    });
  }
  return { version: 1, source: am.capacity.poolCacheSource, asOf: now,
    service, recent, daily: [...daily.values()], quotas, placement: am.placementComparison?.() || null,
    provisioning: provisioningEvidence(demandBetween, now,
      quotas.filter(q => q.window === 'wk').reduce((sum, q) => sum + q.measuredCycles, 0)),
  };
}

export function routingSources(am, now) {
  const local = am.routingReport(now);
  const sources = [{ name: 'This worker', report: local, stale: false }];
  const seen = new Set([local.source]);
  for (const link of am.poolLinks || []) {
    const report = link.status?.routingAnalytics;
    if (report?.version === 1 && typeof report.source === 'string') {
      if (seen.has(report.source)) continue;
      seen.add(report.source);
      // The recent block decides the overview headline: sanitize it at ingress so a malformed
      // or older remote cannot inject raw values (or string-coerced states) into the render.
      sources.push({ name: link.name, report: { ...report, recent: sanitizeRecent(report.recent) },
        stale: Boolean(link.lastError) || !Number.isFinite(report.asOf) || now - report.asOf > 300_000 });
    } else {
      sources.push({ name: link.name, report: null, stale: true });
    }
  }
  return sources;
}
