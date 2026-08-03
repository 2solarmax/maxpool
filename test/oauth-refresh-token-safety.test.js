import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/oauth.js', import.meta.url), 'utf8');

test('an AMBIGUOUS refresh failure never re-sends the single-use token', () => {
  // ROOT CAUSE 2026-08-03. A degraded network aborted refreshes at the 10s timeout; the
  // retry loop then re-sent the SAME refresh token up to 3 times within seconds. Anthropic
  // rotates on first use, so if it had processed the first attempt the retries were
  // guaranteed invalid_grant — 4 accounts were destroyed and each needed a manual re-login.
  // Only a failure that provably happened BEFORE the server saw the request is safe to retry.
  assert.match(SRC, /const sentToServer = /, 'ambiguity is classified');
  const m = /const sentToServer = !\(([^)]*)\)/.exec(SRC);
  assert.ok(m, 'the safe-to-retry set is explicit');
  for (const safe of ['ECONNREFUSED', 'ENOTFOUND']) {
    assert.match(m[1], new RegExp(safe), `${safe} never reached the server — safe to retry`);
  }
  // A timeout/abort/reset may have been processed upstream: must NOT be in the safe set.
  for (const unsafe of ['TimeoutError', 'AbortError', 'ECONNRESET']) {
    assert.doesNotMatch(m[1], new RegExp(unsafe), `${unsafe} is ambiguous — must not be retried`);
  }
  assert.match(SRC, /if \(attempt < maxRetries && isNetworkError && !sentToServer\)/,
    'the retry is gated on the request never having reached the server');
});

test('the refresh timeout is generous enough that a slow network does not abort it', () => {
  // Our OWN abort is what creates the ambiguity, so the timeout must not fire on latency.
  const m = /const perAttemptTimeoutMs = Math\.max\(10_000, Number\(process\.env\.MAXPOOL_TOKEN_REFRESH_TIMEOUT_MS\) \|\| ([0-9_]+)\)/.exec(SRC);
  assert.ok(m, 'the refresh timeout is where the test expects it');
  assert.ok(Number(m[1].replace(/_/g, '')) >= 30_000, `too tight: ${m[1]}`);
});

test('an ambiguous failure is flagged so the caller does not treat it as clean', () => {
  assert.match(SRC, /err\.ambiguousRefresh = sentToServer/,
    'the caller can distinguish "token fate unknown" from "token definitely fine"');
});

test('the browser login allows 5 minutes, env-overridable with a floor', () => {
  // Reported: a real login (password + 2FA, several accounts back to back) repeatedly
  // overran the old 2-minute limit and had to be restarted from scratch.
  const m = /const LOGIN_TIMEOUT_MS = Math\.max\(60_000, Number\(process\.env\.MAXPOOL_LOGIN_TIMEOUT_MS\) \|\| ([0-9_]+)\)/.exec(SRC);
  assert.ok(m, 'the login timeout is a named constant');
  assert.equal(Number(m[1].replace(/_/g, '')), 300_000, 'defaults to 5 minutes');
  assert.doesNotMatch(SRC, /Login timed out after 2 minutes/, 'the hardcoded 2-minute text is gone');
});
