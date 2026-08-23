#!/usr/bin/env node
/**
 * Capacity-ledger LIVE invariant check (2026-08-23).
 *
 * WHY THIS EXISTS. The ledger shipped with 46 unit + integration tests, four
 * adversarial review rounds, and a real-component render — all green — and its
 * PRODUCTION DATA was wrong twice within 24 hours:
 *   v1.8.0  OAuth reset-stamp jitter recorded 9 cycles for one real 5h window and
 *           dated "weekly" cycles a week into the future.
 *   v1.8.1  A probe answering late delivered an already-expired stamp; the close
 *           honored it and wrote a 14.6-minute "complete cycle" of 21k tokens.
 * Neither was visible to a test, because every fixture used clean synthetic stamps.
 * Only reading the live ledger found them.
 *
 * So this asserts the invariants against the REAL state file the running proxy
 * writes. A test proves the code; this proves the data.
 *
 * Usage:
 *   node scripts/capacity-invariants.mjs            # human-readable, exit 1 on violation
 *   node scripts/capacity-invariants.mjs --json     # machine-readable for the monitor
 *
 * Exit: 0 clean · 1 violations found · 2 could not read (never conflated with clean).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const STATE = process.env.MAXPOOL_STATE_PATH
  || path.join(homedir(), '.config', 'teamclaude.state.json');

// A real 5h window is 5h; a real weekly is 7d. Anything under these floors is a
// sliver — the shape both live defects took. Generous floors (a genuinely short
// FIRST cycle after a fresh install is legitimate, so partial cycles are exempt).
const FLOOR_MIN = { ses: 4 * 60, wk: 5 * 24 * 60 };
const WINDOW_LABEL = { ses: '5h', wk: 'weekly' };
const EXPECTED_SCHEMA = 2;

export function checkInvariants(state, now = Date.now()) {
  const violations = [];
  const cap = state?.capacity;
  if (!cap) return { violations, cycles: 0, accounts: 0, note: 'no capacity block yet (fresh install)' };

  if (cap.schemaVersion !== EXPECTED_SCHEMA) {
    violations.push({
      kind: 'schema',
      detail: `state carries schemaVersion ${cap.schemaVersion}, expected ${EXPECTED_SCHEMA}` +
              ' — an older build is writing this file, or a migration did not run',
    });
  }

  let cycles = 0;
  const accounts = Object.entries(cap.accounts || {});
  for (const [name, rec] of accounts) {
    for (const win of ['ses', 'wk']) {
      for (const c of rec?.[win]?.closed || []) {
        cycles++;
        const durMin = (c.endedAt - c.startedAt) / 60_000;

        // 1. FUTURE-DATED. A cycle that has not ended cannot be a measurement.
        if (c.endedAt > now + 60_000) {
          violations.push({ kind: 'future-cycle', account: name, window: win,
            detail: `ends ${new Date(c.endedAt).toISOString()} — ${((c.endedAt - now) / 3_600_000).toFixed(1)}h in the future` });
        }

        // 2. SLIVER. Only complete, counted cycles matter: a partial one is already
        //    excluded from the averages, so a short one there is honest bookkeeping
        //    (explicitly including the flagged joined-mid-window first cycle after a
        //    history-dropping migration — expected once per account, never a defect).
        if (c.complete && !c.disabledDuring && durMin < FLOOR_MIN[win]) {
          violations.push({ kind: 'sliver', account: name, window: win,
            detail: `${durMin.toFixed(1)} min for a ${WINDOW_LABEL[win]} window, ${c.tokens} tokens — counted toward the averages` });
        }

        // 3. BACKWARDS. endedAt before startedAt is arithmetic nonsense.
        if (c.endedAt < c.startedAt) {
          violations.push({ kind: 'backwards', account: name, window: win,
            detail: `ends ${((c.startedAt - c.endedAt) / 1000).toFixed(1)}s before it starts` });
        }

        // 4. NEGATIVE / absurd token count.
        if (!(c.tokens >= 0)) {
          violations.push({ kind: 'tokens', account: name, window: win, detail: `tokens = ${c.tokens}` });
        }
      }

      // 5. OPEN CYCLE RUNNING PAST ITS WINDOW. A 5h cycle open for 3 days means no
      //    closer ever fired for it — the v1.8.0 failure mode in its silent form
      //    (the page stays empty rather than showing wrong numbers, which is why a
      //    "no violations" check that only looked at closed cycles would miss it).
      const open = rec?.[win]?.open;
      if (open) {
        const openMin = (now - open.startedAt) / 60_000;
        const ceiling = win === 'ses' ? 12 * 60 : 12 * 24 * 60;
        if (openMin > ceiling) {
          violations.push({ kind: 'stuck-open', account: name, window: win,
            detail: `open ${(openMin / 60).toFixed(1)}h for a ${WINDOW_LABEL[win]} window — no close has fired` });
        }
      }
    }
  }
  return { violations, cycles, accounts: accounts.length };
}

async function main() {
  const json = process.argv.includes('--json');
  let state;
  try {
    state = JSON.parse(await readFile(STATE, 'utf-8'));
  } catch (err) {
    // A read failure is NOT a clean result. Say so, distinctly.
    const out = { ok: false, unreadable: true, error: err.message, state: STATE };
    console.log(json ? JSON.stringify(out) : `UNREADABLE ${STATE}: ${err.message}`);
    process.exit(2);
  }

  const { violations, cycles, accounts, note } = checkInvariants(state);
  const out = { ok: violations.length === 0, violations, cycles, accounts, note, state: STATE };

  if (json) {
    console.log(JSON.stringify(out));
  } else if (violations.length === 0) {
    console.log(`capacity invariants OK — ${cycles} closed cycle(s) across ${accounts} account(s)${note ? ` (${note})` : ''}`);
  } else {
    console.log(`capacity invariants VIOLATED — ${violations.length} of ${cycles} closed cycle(s) across ${accounts} account(s):`);
    for (const v of violations) {
      console.log(`  ${v.kind}${v.account ? ` [${v.account} ${v.window}]` : ''}: ${v.detail}`);
    }
  }
  process.exit(violations.length ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
