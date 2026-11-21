// install-launchagent.sh decides "did ProcessType apply?" from `launchctl print` text. The parse
// lives in tools/rc-gate/launchd-spawn-type.sh so it can be tested on canned text (no launchctl,
// runs on Linux CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../tools/rc-gate/launchd-spawn-type.sh', import.meta.url));
const parse = text => {
  const r = spawnSync('bash', ['-c', `. "${LIB}"; rc_gate_spawn_type`], { input: text, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
const fixture = line => `gui/501/com.mokka.rc-gate = {\n\tactive count = 1\n\tpath = /Users/x/Library/LaunchAgents/com.mokka.rc-gate.plist\n\tstate = running\n${line}\n\tjob state = running\n}\n`;

test('rc-gate install: spawn type "interactive (4)" is read as interactive', () => {
  assert.equal(parse(fixture('\tspawn type = interactive (4)')), 'interactive');
});
test('rc-gate install: spawn type "daemon (3)" (no ProcessType) is read as daemon, not interactive', () => {
  assert.equal(parse(fixture('\tspawn type = daemon (3)')), 'daemon');
});
test('rc-gate install: a missing spawn-type line parses to nothing (the script then warns and exits 2)', () => {
  assert.equal(parse(fixture('\tprograms = ...')), '');
});
test('rc-gate install: the script verifies spawn type, warns loudly and exits 2 when it is not interactive', () => {
  const sh = readFileSync(new URL('../tools/rc-gate/install-launchagent.sh', import.meta.url), 'utf8');
  assert.match(sh, /rc_gate_spawn_type/);
  assert.match(sh, /WARN: rc-gate is not running as an Interactive job/);
  assert.match(sh, /exit 2/);
  assert.ok(sh.indexOf('lsof -ti :3457') < sh.indexOf('rc_gate_spawn_type'), 'the listen check runs first');
});
