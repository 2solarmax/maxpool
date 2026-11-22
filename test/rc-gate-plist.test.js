// The shipped rc-gate LaunchAgent plist must keep the two keys the 2026-11-21 fixes rely on.
// Parsed as XML text (not plutil) so this runs on Linux CI too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = rel => readFileSync(new URL(rel, import.meta.url), 'utf8');

function topLevelValue(xml, key) {
  const body = xml.replace(/<!--[\s\S]*?-->/g, '');
  const m = new RegExp(`<key>${key}</key>\\s*<(string|integer)>([^<]*)</\\1>`).exec(body);
  return m ? { type: m[1], value: m[2].trim() } : null;
}

test('rc-gate plist: ProcessType is Interactive (no launchd light throttling)', () => {
  const v = topLevelValue(read('../tools/rc-gate/launchd/com.mokka.rc-gate.plist'), 'ProcessType');
  assert.deepEqual(v, { type: 'string', value: 'Interactive' });
});

test('rc-gate plist: ExitTimeOut is >= 25 so the 20s SIGTERM drain is not SIGKILLed', () => {
  const v = topLevelValue(read('../tools/rc-gate/launchd/com.mokka.rc-gate.plist'), 'ExitTimeOut');
  assert.ok(v && v.type === 'integer', 'ExitTimeOut is an integer key');
  assert.ok(Number(v.value) >= 25, `ExitTimeOut ${v.value} must be >= 25`);
});

test('rc-gate: the Maxbar README documents both keys for the hand-made second gate', () => {
  const readme = read('../tools/maxbar/README.md');
  assert.match(readme, /ProcessType/);
  assert.match(readme, /ExitTimeOut/);
});

test('rc-gate: the force-net-evac seam has no default path (armed only by RC_GATE_FORCE_EVAC_FLAG)', () => {
  const src = read('../tools/rc-gate/rc-gate.js');
  assert.doesNotMatch(src, /rc-gate-force-net-evac/, 'no hard-coded /tmp trigger file');
  assert.match(src, /const FORCE_EVAC_FLAG = process\.env\.RC_GATE_FORCE_EVAC_FLAG \|\| '';/);
  assert.match(src, /if \(FORCE_EVAC_FLAG\) setInterval\(/, 'no polling interval unless armed');
});

test('rc-gate: the loop-blocking test seam is inert unless its env var is set', () => {
  const src = read('../tools/rc-gate/rc-gate.js');
  assert.match(src, /const TEST_BLOCK_LOOP_MS = Number\(process\.env\.RC_GATE_TEST_BLOCK_LOOP_AFTER_SEND_MS \|\| 0\);/, 'defaults to 0');
  assert.match(src, /if \(isHeartbeat && TEST_BLOCK_LOOP_MS && !_testBlocked\)/, 'guarded by the env value and by a once flag');
});
