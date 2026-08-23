// The invariant checker is the instrument that watches PRODUCTION data. If it is
// wrong, nothing downstream is trustworthy — so it gets its own tests, built from
// the two real defect shapes it exists to catch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkInvariants } from '../scripts/capacity-invariants.mjs';

const NOW = Date.UTC(2026, 7, 23, 12, 0);
const cycle = (o = {}) => ({
  startedAt: NOW - 5 * 3600_000, endedAt: NOW, tokens: 1_000_000,
  complete: true, disabledDuring: false, resetAt: NOW, ...o,
});
const state = (closed, win = 'ses', extra = {}) => ({
  capacity: { schemaVersion: 3, accounts: { a1: {
    ses: { open: null, closed: win === 'ses' ? closed : [] },
    wk: { open: null, closed: win === 'wk' ? closed : [] },
    days: {}, ...extra } } },
});

test('a healthy ledger reports no violations', () => {
  const r = checkInvariants(state([cycle(), cycle({ tokens: 900_000 })]), NOW);
  assert.deepEqual(r.violations, []);
  assert.equal(r.cycles, 2);
});

test('catches the v1.8.0 shape: a sliver counted toward the averages', () => {
  // The real row: 0.2 min / 2228 tokens, complete:true, inside the averages.
  const r = checkInvariants(state([cycle({ startedAt: NOW - 12_000, tokens: 2_228 })]), NOW);
  assert.equal(r.violations.length, 1);
  assert.equal(r.violations[0].kind, 'partial-observation');
});

test('catches the v1.8.0 shape: a weekly cycle dated in the future', () => {
  const r = checkInvariants(state([cycle({ endedAt: NOW + 7 * 86400_000 })], 'wk'), NOW);
  assert.ok(r.violations.some(v => v.kind === 'future-cycle'));
});

test('catches the v1.8.1 shape: a 14.6-minute GLM sliver from a late probe', () => {
  const r = checkInvariants(state([cycle({ startedAt: NOW - 876_000, tokens: 21_192 })]), NOW);
  assert.equal(r.violations[0].kind, 'partial-observation');
  assert.match(r.violations[0].detail, /14\.6 min/);
});

test('does NOT flag a short cycle that is already excluded from the averages', () => {
  // A partial or disabled-during cycle is honest bookkeeping, not a defect — flagging
  // it would train the reader to ignore the alert.
  assert.deepEqual(checkInvariants(state([cycle({ startedAt: NOW - 12_000, complete: false })]), NOW).violations, []);
  assert.deepEqual(checkInvariants(state([cycle({ startedAt: NOW - 12_000, disabledDuring: true })]), NOW).violations, []);
});

test('catches a cycle that ends before it starts', () => {
  const r = checkInvariants(state([cycle({ startedAt: NOW, endedAt: NOW - 5_000 })]), NOW);
  assert.ok(r.violations.some(v => v.kind === 'backwards'));
});

test('catches a cycle stuck OPEN past its window — the silent failure mode', () => {
  // v1.8.0's other half: no closer fires, the page stays empty, and a closed-cycle-only
  // check reports "clean" forever.
  const s = { capacity: { schemaVersion: 2, accounts: { a1: {
    ses: { open: { startedAt: NOW - 3 * 86400_000, tokensSoFar: 5, lastAccrualAt: NOW, complete: true, disabledDuring: false }, closed: [] },
    wk: { open: null, closed: [] }, days: {} } } } };
  const r = checkInvariants(s, NOW);
  assert.ok(r.violations.some(v => v.kind === 'stuck-open'));
});

test('catches a stale schema — an older build writing the file', () => {
  const s = state([cycle()]);
  s.capacity.schemaVersion = 2;
  assert.ok(checkInvariants(s, NOW).violations.some(v => v.kind === 'schema'));
});

test('a fresh install with no capacity block is clean, not a violation', () => {
  assert.deepEqual(checkInvariants({}, NOW).violations, []);
});

test('the joined-mid-window first cycle (flagged partial) is NOT flagged', () => {
  // One-time per account after a history-dropping migration: short, but partial with a
  // reason — expected behavior, not a defect. If the monitor flagged it, the first
  // alert after every upgrade would be a false positive.
  const r = checkInvariants(state([cycle({ startedAt: NOW - 876_000, tokens: 21_192,
    complete: false, partialReason: 'joined-mid-window' })]), NOW);
  assert.deepEqual(r.violations, []);
});

test('catches the 64-minute variants a generous floor stayed silent on', () => {
  // Live 2026-08-23: three rows of 64.3/64.4/74.4 min for 5h windows were exactly as
  // wrong as the 14.6-min one, and the first floor (4h) flagged only the extreme case.
  for (const durMin of [64.3, 64.4, 74.4, 200]) {
    const r = checkInvariants(state([cycle({ startedAt: NOW - durMin * 60_000 })]), NOW);
    assert.equal(r.violations.length, 1, `${durMin} min must be flagged`);
    assert.equal(r.violations[0].kind, 'partial-observation');
  }
});

test('a cycle spanning its whole window is clean, and 80% is the boundary', () => {
  assert.deepEqual(checkInvariants(state([cycle({ startedAt: NOW - 5 * 3600_000 })]), NOW).violations, []);
  assert.deepEqual(checkInvariants(state([cycle({ startedAt: NOW - 4.1 * 3600_000 })]), NOW).violations, [],
    '82% of the window is a real observation (an account can go idle at the very end)');
  assert.equal(checkInvariants(state([cycle({ startedAt: NOW - 3.9 * 3600_000 })]), NOW).violations.length, 1,
    '78% is not');
});

test('the pre-v3 migrated rows are shown but never flagged', () => {
  const r = checkInvariants(state([cycle({ startedAt: NOW - 876_000, complete: false, partialReason: 'pre-v3-unverified' })]), NOW);
  assert.deepEqual(r.violations, []);
});
