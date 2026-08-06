import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const mgr = () => new AccountManager(
  [{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 }], 0.90,
);
function capture(fn) {
  const out = []; const orig = console.error;
  console.error = (...a) => out.push(a.join(' '));
  try { fn(); } finally { console.error = orig; }
  return out;
}

test('a systemically failing quota probe SAYS SO instead of failing silently', () => {
  // Measured 2026-08-06: both quota endpoints return 404, so the probe had been failing on
  // every call since forever — writing a field nothing read. Weekly quota was therefore only
  // learned from upstream 429 headers, and an account that had not hit a 429 showed a blank
  // weekly with no explanation. A fail-open probe that never reports failing is a log line,
  // not a detector.
  const am = mgr();
  const lines = capture(() => {
    for (let i = 0; i < 25; i++) am.recordProbeError(0, 'Not found', 404);
  });
  assert.ok(lines.length >= 1, 'it escalates rather than staying silent');
  assert.match(lines[0], /Quota probe has failed \d+x in a row/);
  assert.match(lines[0], /HTTP 404/, 'carries the status so it is diagnosable');
  assert.match(lines[0], /blank weekly/, 'explains the user-visible symptom it causes');
});

test('a blip does NOT escalate — only a sustained streak', () => {
  const am = mgr();
  const lines = capture(() => {
    for (let i = 0; i < 5; i++) am.recordProbeError(0, 'fetch failed', null);
  });
  assert.equal(lines.length, 0, 'a handful of failures is noise, not a finding');
});

test('a successful probe clears the streak', () => {
  const am = mgr();
  for (let i = 0; i < 19; i++) am.recordProbeError(0, 'fetch failed', null);
  am.applyUsageData(0, {});                       // one success
  const lines = capture(() => {
    for (let i = 0; i < 5; i++) am.recordProbeError(0, 'fetch failed', null);
  });
  assert.equal(lines.length, 0, 'recovery resets the counter, so it cannot false-alarm later');
});

test('it does not wall the log once escalated', () => {
  const am = mgr();
  const lines = capture(() => {
    for (let i = 0; i < 250; i++) am.recordProbeError(0, 'Not found', 404);
  });
  assert.ok(lines.length <= 4, `stays visible without flooding (got ${lines.length})`);
});
