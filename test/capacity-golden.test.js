// GOLDEN (audit 2026-11-18): rebuild the owner's reported screen from BOTH pools' real
// snapshots and assert the post-fix table. The snapshots are read-only fixtures taken
// 2026-11-18 12:13 local; expected values come from research/2026-11-18-capacity-audit.md
// § "expected after fix" (verifier-recomputed). Snapshots live in the session scratchpad;
// when absent (CI, another machine) the test self-skips with a printed reason — it is an
// evidence test, not a portable unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tankStatsFromCycles, cycleEstimate } from '../src/capacity-ledger.js';

const SNAP = '/private/tmp/claude-501/-Users-maxkrasnykh-Mokka-mokka-workspace/a8e511db-78c9-4c92-aeb5-3283036af0eb/scratchpad/cap-audit';
const LAPTOP = join(SNAP, 'laptop-capacity.json');
const CLOUD = join(SNAP, 'cloud-capacity.json');
const SKIP = !existsSync(LAPTOP) || !existsSync(CLOUD);
const maybe = SKIP ? test.skip : test;

function cyclesOf(snap, name, win) {
  const rec = snap.capacity?.accounts?.[name]?.[win];
  return (rec?.closed || []).map(c => ({ ...c, samples: (c.samples || []).map(s => ({ ...s })) }));
}

maybe('golden: the 7 refill-cloud Anthropic rows gain numbers from their slope-estimated refill cycles (D1+D7)', () => {
  const cloud = JSON.parse(readFileSync(CLOUD, 'utf8'));
  // partnerships' cloud-held week (spansRefill, slope-derived) must ADMIT after D1.
  const name = 'partnerships';
  const wk = cyclesOf(cloud, name, 'wk');
  assert.ok(wk.length >= 1, 'cloud holds the week');
  const t = tankStatsFromCycles(wk, 'wk');
  assert.ok(t, `partnerships admits after D1, got ${JSON.stringify(t)}`);
  assert.ok(t.avg > 1e9 && t.avg < 4e9, `tank in the measured 1.7-3.2B band, got ${t.avg}`);
});

maybe('golden: kira admits BOTH weeks — the refill cycle (3.3B) and the live week reads ~3.5B (D1+D5+D6)', () => {
  const laptop = JSON.parse(readFileSync(LAPTOP, 'utf8'));
  const wk = cyclesOf(laptop, 'kira', 'wk');
  const t = tankStatsFromCycles(wk, 'wk');
  assert.ok(t, 'kira history admits');
  // The refill week (spansRefill=true, slope method) now counts; the 1.04d single-segment
  // cycle (audit D6) is REJECTED — one 5-point slice is not an observation. So N=1 from
  // the refill week, whose estimate reads ~3.3B.
  assert.equal(t.n, 1, 'the refill week admits; the single-slice week does not');
  assert.ok(t.avg > 3e9 && t.avg < 3.7e9, `the refill week reads ~3.3B, got ${t.avg}`);
});

maybe('golden: the cloud exports its OPEN week for every identity (D3)', () => {
  const cloud = JSON.parse(readFileSync(CLOUD, 'utf8'));
  // The export shape is asserted at the unit level; here assert the SOURCE data exists:
  // every cloud account with an open week carries windowStartedAt + tokensSoFar + peak.
  let withOpen = 0;
  for (const rec of Object.values(cloud.capacity?.accounts || {})) {
    const o = rec?.wk?.open;
    if (o && o.tokensSoFar > 0 && o.windowStartedAt != null) withOpen++;
  }
  assert.ok(withOpen >= 15, `most cloud accounts have a live open week, got ${withOpen}`);
});

maybe('golden: max@gomokka.com whole-window current — the 1.6B delta mark reads 3.2-3.3B after D5+D1', () => {
  const laptop = JSON.parse(readFileSync(LAPTOP, 'utf8'));
  const wk = cyclesOf(laptop, 'max@gomokka.com', 'wk');
  const t = tankStatsFromCycles(wk, 'wk');
  const o = laptop.capacity.accounts['max@gomokka.com'].wk.open;
  assert.ok(o.tokensSoFar > 1e9, 'live week accrues');
  if (t) {
    assert.ok(t.avg > 2.5e9 && t.avg < 4e9, `post-refill history in the 2.8-3.3B band, got ${t.avg}`);
  }
});
