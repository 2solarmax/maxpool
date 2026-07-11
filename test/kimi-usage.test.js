import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKimiRow, kimiWindowMs, fetchKimiUsage, fetchProviderUsage } from '../src/oauth.js';

// ── parsing (values are STRINGS; the NaN→0 "fully available" trap is the danger) ──

test('parseKimiRow computes utilization from string used/limit', () => {
  assert.deepEqual(parseKimiRow({ limit: '100', used: '10', remaining: '90', resetTime: '2026-07-17T08:18:08Z' }).utilization, 0.1);
  assert.equal(parseKimiRow({ limit: '100', remaining: '100' }).utilization, 0, 'derives used from remaining');
  assert.equal(parseKimiRow({ limit: '200', used: '50' }).utilization, 0.25);
});

test('parseKimiRow returns null utilization (NEVER a NaN) on missing/zero inputs', () => {
  assert.equal(parseKimiRow({}).utilization, null, 'no data → null, not 0 (0 would read as fully available)');
  assert.equal(parseKimiRow({ limit: '0', used: '5' }).utilization, null, 'limit 0 → null, not Infinity/NaN');
  assert.equal(parseKimiRow({ used: '5' }).utilization, null, 'no limit → null');
  assert.equal(parseKimiRow(null), null);
});

test('kimiWindowMs normalizes every time unit so the shortest window is comparable', () => {
  assert.equal(kimiWindowMs({ duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }), 300 * 60_000);
  assert.equal(kimiWindowMs({ duration: 5, timeUnit: 'TIME_UNIT_HOUR' }), 5 * 3600_000);
  assert.equal(kimiWindowMs({ duration: 7, timeUnit: 'TIME_UNIT_DAY' }), 7 * 86400_000);
  assert.equal(kimiWindowMs({ duration: 300, timeUnit: 'UNKNOWN' }), null);
});

// ── fetchKimiUsage against the live-confirmed response shape (mocked fetch) ──

const LIVE_SHAPE = {
  user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
  usage: { limit: '100', used: '10', remaining: '90', resetTime: '2026-07-17T08:18:08.214260Z' },
  limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '100', resetTime: '2026-07-11T13:18:08.214260Z' } }],
};

test('fetchKimiUsage maps usage→Wk and the shortest limits[] window→Ses', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(url, /\/coding\/v1\/usages$/, 'hits the coding-plan usages endpoint');
    return { ok: true, status: 200, json: async () => LIVE_SHAPE };
  };
  try {
    const u = await fetchKimiUsage({ provider: 'kimi', credential: 'sk-kimi-x', upstream: 'https://api.kimi.com/coding' });
    assert.equal(u.source, 'kimi');
    assert.equal(u.wk.utilization, 0.1, 'weekly 10%');
    assert.equal(u.ses.utilization, 0, '5h session 0%');
    assert.equal(u.level, 'LEVEL_INTERMEDIATE');
  } finally { globalThis.fetch = orig; }
});

test('picks the 5h window as Ses even when a longer window is also present', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({
    usage: { limit: '100', used: '20', resetTime: '2026-07-17T00:00:00Z' },
    limits: [
      { window: { duration: 7, timeUnit: 'TIME_UNIT_DAY' }, detail: { limit: '100', remaining: '80' } },   // weekly-ish
      { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '55' } }, // 5h
    ],
  }) });
  try {
    const u = await fetchKimiUsage({ provider: 'kimi', credential: 'k', upstream: 'https://api.kimi.com/coding' });
    assert.equal(u.ses.utilization, 0.45, 'Ses = the 300-min (5h) window: 1 - 55/100');
  } finally { globalThis.fetch = orig; }
});

test('a partial response (no usage) returns an error → applyProviderUsage keeps last-known (no blanked weekly)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ limits: [] }) });
  try {
    const u = await fetchKimiUsage({ provider: 'kimi', credential: 'k', upstream: 'https://api.kimi.com/coding' });
    assert.ok(u.error, 'missing usage → error (not {wk:null} which would clear the bar)');
  } finally { globalThis.fetch = orig; }
});

test('404 on /usages falls back to /usage', async () => {
  const orig = globalThis.fetch;
  let calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    if (/\/usages$/.test(url)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => LIVE_SHAPE };
  };
  try {
    const u = await fetchKimiUsage({ provider: 'kimi', credential: 'k', upstream: 'https://api.kimi.com/coding' });
    assert.equal(u.wk.utilization, 0.1);
    assert.ok(calls.some(u2 => /\/usage$/.test(u2)), 'fell back to /usage');
  } finally { globalThis.fetch = orig; }
});

test('an HTTP error surfaces transiently (no console-only fallback — it IS pollable now)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  try {
    const u = await fetchKimiUsage({ provider: 'kimi', credential: 'k', upstream: 'https://api.kimi.com/coding' });
    assert.equal(u.error, 'HTTP 429');
    assert.notEqual(u.source, 'console-only', 'Kimi is pollable — never fall back to the old console-only label');
  } finally { globalThis.fetch = orig; }
});

test('fetchProviderUsage dispatches kimi → fetchKimiUsage (no longer a console-only stub)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => LIVE_SHAPE });
  try {
    const u = await fetchProviderUsage({ provider: 'kimi', credential: 'sk-kimi-x', upstream: 'https://api.kimi.com/coding' });
    assert.equal(u.source, 'kimi');
    assert.equal(u.wk.utilization, 0.1);
  } finally { globalThis.fetch = orig; }
});
