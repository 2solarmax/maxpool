import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 60 * 60 * 1000;

function manager(count) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`, type: 'oauth',
      accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

function setWeekly(am, idx, util, resetInHours) {
  am.applyUsageData(idx, {
    fiveHour: { utilization: 0.10, resetAt: Date.now() + HOUR },
    sevenDay: { utilization: util, resetAt: Date.now() + resetInHours * HOUR },
  });
}

// A signed-thinking-free, fully-scanned request (migration-safe).
function req(extra = {}) {
  return { profile: 'claude', model: 'claude-sonnet-5', weight: 1, bodyThinkingScanned: true, ...extra };
}

// ── the reported bug, minimal form ───────────────────────────────────────────

test('an IDLE bound session on a 90%-weekly account rebalances to a 17% account', () => {
  const am = manager(2);
  setWeekly(am, 0, 0.90, 39);   // a1: reserve, pace-critical, resets in 39h (NOT near reset)
  setWeekly(am, 1, 0.17, 152);  // a2: normal, tons of headroom

  am._bindSession('sess1', am.accounts[0], 'claude-sonnet-5');
  // Pre-fix: _shouldRebalanceBoundSession's bestScore<=boundScore*0.5 is unsatisfiable
  // for an idle bound account (boundScore~2.2 → threshold~1.1 < the ~2 concurrency floor),
  // so the session stays pinned to the 90% account. This asserts it moves.
  const lease = am.acquireAccount(req({ sessionKey: 'sess1' }));
  assert.ok(lease, 'a request must always find an account');
  assert.equal(lease.account.name, 'a2', 'must rebalance OFF the near-exhausted weekly account');
});

test('the live scenario: bound to max@dubner (90%) with mk (17%) idle → moves off it', () => {
  const am = manager(5);
  // Mirrors the live pool the user reported.
  setWeekly(am, 0, 0.66, 121);  // partnerships (soft)
  setWeekly(am, 1, 0.79, 83);   // personal (soft raw / pace critical)
  setWeekly(am, 2, 0.17, 152);  // mk@gomokka (normal — the healthy sink)
  setWeekly(am, 3, 0.90, 39);   // max@dubner (reserve raw / pace critical)
  setWeekly(am, 4, 0.69, 111);  // 2solarmax (soft)

  am._bindSession('sessX', am.accounts[3], 'claude-sonnet-5');
  const lease = am.acquireAccount(req({ sessionKey: 'sessX' }));
  assert.ok(lease);
  assert.notEqual(lease.account.name, 'a4', 'must not stay pinned to the 90%-weekly account');
  // It re-homes to a genuinely-healthy (normal/soft raw) account — never a reserve+ one.
  assert.ok(['a1', 'a2', 'a3', 'a5'].includes(lease.account.name),
    'must re-home onto a healthy account (raw normal/soft)');
});

// ── the philosophy must be preserved: a fast-burner WITH headroom is NOT churned ─

test('a fast-burning account with real absolute headroom (69% raw) is NOT rebalanced off', () => {
  const am = manager(2);
  // a1: 69% used but resets in only 6h → pace looks reserve/critical, yet it has
  // genuine headroom (RAW soft, not reserve). The design intentionally keeps such
  // an account in the pool — moving off it would be needless churn.
  setWeekly(am, 0, 0.69, 6);
  setWeekly(am, 1, 0.20, 152);
  am._bindSession('sessP', am.accounts[0], 'claude-sonnet-5');

  const lease = am.acquireAccount(req({ sessionKey: 'sessP' }));
  assert.equal(lease.account.name, 'a1',
    'a RAW-healthy (soft) fast-burner keeps its bound session — only absolute reserve+ triggers the move');
});

// ── no stranding: if every alternative is also hot, keep the bound account ────

test('a bound session is NOT stranded when every alternative is also reserve+', () => {
  const am = manager(3);
  setWeekly(am, 0, 0.90, 39);   // bound, reserve
  setWeekly(am, 1, 0.92, 40);   // reserve
  setWeekly(am, 2, 0.88, 50);   // reserve
  am._bindSession('sessS', am.accounts[0], 'claude-sonnet-5');

  const lease = am.acquireAccount(req({ sessionKey: 'sessS' }));
  assert.ok(lease, 'must still get an account (no healthy option, but not stranded)');
  // All are reserve; it stays on its bound account rather than churning sideways.
  assert.equal(lease.account.name, 'a1');
});

// ── exhausted bound account with a healthy option still moves ─────────────────

test('a bound session on a critical-raw (96%) account moves to a healthy account', () => {
  const am = manager(2);
  setWeekly(am, 0, 0.96, 30);   // critical raw
  setWeekly(am, 1, 0.30, 120);  // normal
  am._bindSession('sessC', am.accounts[0], 'claude-sonnet-5');

  const lease = am.acquireAccount(req({ sessionKey: 'sessC' }));
  assert.equal(lease.account.name, 'a2', 'a 96% bound account must yield to a healthy one');
});
