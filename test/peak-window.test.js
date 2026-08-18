import { test } from 'node:test';
import assert from 'node:assert/strict';
import { peakWindowState, normalizePeakWindow, mergePeakDefaults, DEFAULT_PEAK_PROVIDERS, MINUTES_PER_DAY } from '../src/peak-window.js';

// Explicit UTC timestamps — never the ambient clock (TEST PLAN T3).
const U = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi, 0, 0);
// The shipped default is expressed in the VENDOR's zone (Mon-Fri 14:00-18:00 SGT).
// The A-lane pins the evaluator's semantics, so it uses an explicit UTC-equivalent
// window + 'UTC' — keeping the numbers in the assertions literal. A dedicated TZ lane
// below pins the zone behaviour itself.
const ZAI = [{ days: [1, 2, 3, 4, 5], startMin: 360, endMin: 600 }];   // 06:00-10:00 UTC
const TZ = 'UTC';

test('A1 exact start is IN, exact end is OUT (inclusive start, exclusive end)', () => {
  // 2026-08-18 is a Tuesday
  assert.equal(peakWindowState(ZAI, U(2026, 7, 18, 6, 0), TZ).inPeak, true, '06:00:00.000 in');
  assert.equal(peakWindowState(ZAI, U(2026, 7, 18, 10, 0), TZ).inPeak, false, '10:00:00.000 out');
});

test('A2 minute before start out; minute before end in; endsAt = 10:00 that day', () => {
  assert.equal(peakWindowState(ZAI, U(2026, 7, 18, 5, 59), TZ).inPeak, false);
  const s = peakWindowState(ZAI, U(2026, 7, 18, 9, 59), TZ);
  assert.equal(s.inPeak, true);
  assert.equal(s.endsAt, U(2026, 7, 18, 10, 0));
});

test('A3 Saturday and Sunday are never peak', () => {
  assert.equal(peakWindowState(ZAI, U(2026, 7, 22, 7, 0), TZ).inPeak, false, 'Sat');
  assert.equal(peakWindowState(ZAI, U(2026, 7, 23, 7, 0), TZ).inPeak, false, 'Sun');
});

test('A4 midnight-wrap keyed on the START day: Fri 22-02 peaks early Sat, never early Sun', () => {
  const wrap = [{ days: [5], startUtcMin: 22 * 60, endUtcMin: 2 * 60 }];
  assert.equal(peakWindowState(wrap, U(2026, 7, 21, 23, 59), TZ).inPeak, true, 'Fri 23:59');
  assert.equal(peakWindowState(wrap, U(2026, 7, 22, 1, 59), TZ).inPeak, true, 'Sat 01:59');
  assert.equal(peakWindowState(wrap, U(2026, 7, 22, 2, 0), TZ).inPeak, false, 'Sat 02:00 out');
  assert.equal(peakWindowState(wrap, U(2026, 7, 23, 23, 59), TZ).inPeak, false, 'Sun 23:59 NOT peak (no Sun-started window)');
});

test('A5 malformed windows never match (a typo must not bench GLM)', () => {
  for (const bad of [
    [{ days: [1], startUtcMin: NaN, endUtcMin: 600 }],
    [{ days: [1], startUtcMin: 360, endUtcMin: 'x' }],
    [{ days: [], startUtcMin: 360, endUtcMin: 600 }],
    [{ startUtcMin: 360, endUtcMin: 600 }],                            // no days
    [{ days: [1], startUtcMin: 360, endUtcMin: 360 }],                 // zero-length
    [{ days: [1], startUtcMin: -5, endUtcMin: 600 }],
    [{ days: [1], startUtcMin: 360, endUtcMin: MINUTES_PER_DAY + 1 }],
    null, 'garbage',
  ]) {
    assert.equal(peakWindowState(bad, U(2026, 7, 18, 7, 0), TZ).inPeak, false, JSON.stringify(bad));
    assert.equal(normalizePeakWindow(bad?.[0]), null);
  }
});

test('A6 abutting windows merge endsAt to the LATEST end', () => {
  const two = [
    { days: [2], startUtcMin: 360, endUtcMin: 480 },   // 06:00-08:00 (Tue)
    { days: [2], startUtcMin: 480, endUtcMin: 600 },   // 08:00-10:00 (Tue)
  ];
  const s = peakWindowState(two, U(2026, 7, 18, 7, 0), TZ);
  assert.equal(s.inPeak, true);
  assert.equal(s.endsAt, U(2026, 7, 18, 10, 0), 'wake never lands inside the second window');
});

test('A7 empty windows never peak; empty days never peak', () => {
  assert.deepEqual(peakWindowState([], U(2026, 7, 18, 7, 0, TZ)), { inPeak: false, endsAt: null });
  assert.equal(peakWindowState(undefined, U(2026, 7, 18, 7, 0), TZ).inPeak, false);
});

test('F-suite: mergePeakDefaults is presence-based, clone-safe, version-gated', () => {
  const live = { zai: { claudeFallback: 'always' }, kimi: { claudeFallback: 'always' } };
  const merged = mergePeakDefaults(live, undefined);
  assert.equal(merged.zai.claudeFallback, 'always', 'existing key survives');
  assert.equal(merged.zai.peakWindows.length, 1, 'absent key inherits');
  assert.equal(merged.zai.peakCap, 0.5);
  assert.equal(merged.kimi.peakWindows.length, 0, 'kimi stays never-peak');
  assert.notEqual(merged.zai, live.zai, 'CLONES, never mutates');
  assert.deepEqual(live.zai, { claudeFallback: 'always' }, 'input untouched');

  const emptied = { zai: { peakWindows: [], peakCap: 0.5, peakDepreference: true } };
  const again = mergePeakDefaults(emptied, 1);
  assert.equal(again.zai.peakWindows.length, 0, 'version stamp prevents re-seeding');
  assert.equal(again, emptied, 'stamped config passes through untouched');
});

// ── TZ lane: the window is user-adjustable in HOURS and in ZONE (2026-08-18) ──────
// Requirement: peak hours must be adjustable; they must be computed from the user's
// real local time by default; and because a laptop's clock is often set to somewhere
// the user isn't, the zone must be overridable explicitly.

test('TZ1 the shipped default tracks the VENDOR zone, not the machine zone', () => {
  const z = DEFAULT_PEAK_PROVIDERS.zai;
  assert.equal(z.peakTimezone, 'Asia/Singapore', 'pinned to where z.ai defines its window');
  // 15:00 SGT is mid-window regardless of what the laptop clock says.
  assert.equal(peakWindowState(z.peakWindows, U(2026, 7, 18, 7, 0), z.peakTimezone).inPeak, true);
  // ...and the same instant is NOT peak if you (wrongly) read the numbers as UTC.
  assert.equal(peakWindowState(z.peakWindows, U(2026, 7, 18, 7, 0), 'UTC').inPeak, false);
});

test('TZ2 the same wall-clock window means different instants in different zones', () => {
  const w = [{ days: [2], startMin: 9 * 60, endMin: 17 * 60 }];   // 09:00-17:00 local
  // 14:00 UTC is 09:00 in New York (in peak) but 22:00 in Singapore (out).
  assert.equal(peakWindowState(w, U(2026, 7, 18, 14, 0), 'America/New_York').inPeak, true);
  assert.equal(peakWindowState(w, U(2026, 7, 18, 14, 0), 'Asia/Singapore').inPeak, false);
});

test('TZ3 null timezone follows the MACHINE zone (the documented default)', () => {
  // An always-on window is in-peak in EVERY zone, so this asserts the null path
  // resolves and evaluates rather than silently returning false.
  const always = [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }];
  assert.equal(peakWindowState(always, U(2026, 7, 18, 7, 0), null).inPeak, true);
});

test('TZ4 an invalid zone falls back to the machine zone — never throws in the hot path', () => {
  const w = [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }];   // always-on window
  assert.doesNotThrow(() => peakWindowState(w, U(2026, 7, 18, 7, 0), 'Not/AZone'));
  assert.equal(peakWindowState(w, U(2026, 7, 18, 7, 0), 'Not/AZone').inPeak, true, 'still evaluates');
});

test('TZ5 hours are adjustable: a custom window is honoured verbatim', () => {
  const custom = [{ days: [1, 2, 3, 4, 5], startMin: 8 * 60 + 30, endMin: 9 * 60 + 15 }];
  assert.equal(peakWindowState(custom, U(2026, 7, 18, 8, 29), 'UTC').inPeak, false, '08:29 out');
  assert.equal(peakWindowState(custom, U(2026, 7, 18, 8, 30), 'UTC').inPeak, true, '08:30 in (inclusive)');
  assert.equal(peakWindowState(custom, U(2026, 7, 18, 9, 14), 'UTC').inPeak, true, '09:14 in');
  assert.equal(peakWindowState(custom, U(2026, 7, 18, 9, 15), 'UTC').inPeak, false, '09:15 out (exclusive)');
});

test('TZ6 legacy startUtcMin/endUtcMin configs keep working', () => {
  const legacy = [{ days: [2], startUtcMin: 360, endUtcMin: 600 }];
  assert.equal(peakWindowState(legacy, U(2026, 7, 18, 7, 0), 'UTC').inPeak, true);
});
