// Versioned read model shared by the terminal and /maxpool/status. Each source
// exports its own ingress and meters. A peer's status is never re-exported.
import { provisioningEvidence } from './routing-capacity-analytics.js';

const HOUR = 3600_000;
const METRICS = ['arrivals', 'requests', 'completed', 'timelyCompleted', 'failed', 'cancelled', 'incomplete',
  'capacityDenied', 'weeklyDenied', 'sessionDenied', 'concurrencyDenied', 'unclassifiedDenied', 'queuedRequests', 'waitP90Ms', 'waitP95Ms', 'queuedWaitP95Ms', 'waitTargetMs',
  'active', 'serving', 'peakServing', 'activeSessions', 'peakSessions',
  'inputTokens', 'cachedInputTokens', 'coverageSince', 'completeCoverage', 'from', 'to'];
const metrics = row => Object.fromEntries(METRICS.filter(k => Number.isFinite(row[k]) || typeof row[k] === 'boolean').map(k => [k, row[k]]));
const PERIODS = { '1h': HOUR, '24h': 24 * HOUR, '7d': 168 * HOUR };

export function buildRoutingReport(am, now) {
  const service = {};
  const daily = new Map();
  for (const [period, ms] of Object.entries(PERIODS)) {
    const sample = am.routingService.snapshot(ms, now);
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
  const owners = new Set();
  const quotas = [];
  for (const account of am.accounts) {
    if (account.remote || account.type === 'pool') continue;
    const owner = am._localCacheKeys(account)[0];
    if (owners.has(owner)) continue;
    owners.add(owner);
    const sample = am.routingCapacity.snapshot(owner, now);
    quotas.push({
      name: account.name, provider: account.provider || account.type,
      window: sample.window, measuredCycles: sample.measuredCycles,
      unknownCycles: sample.unknownCycles, meanUnusedFraction: sample.meanUnusedFraction,
      cycles: sample.cycles.slice(0, 12).map(c => ({
        startAt: c.startAt, resetAt: c.resetAt, observedAt: c.observedAt, window: c.window,
        unusedFraction: c.unusedFraction, reason: c.reason, attribution: c.attribution,
        alternativeTurns: c.alternativeTurns,
      })),
    });
  }
  return { version: 1, source: am.capacity.poolCacheSource, asOf: now,
    service, daily: [...daily.values()], quotas, placement: am.placementComparison?.() || null,
    provisioning: provisioningEvidence((start, end) => am.routingService.demandBetween(start, end), now,
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
      sources.push({ name: link.name, report, stale: Boolean(link.lastError) || !Number.isFinite(report.asOf) || now - report.asOf > 300_000 });
    } else {
      sources.push({ name: link.name, report: null, stale: true });
    }
  }
  return sources;
}
