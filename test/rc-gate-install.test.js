// install-launchagent.sh decides "did ProcessType apply?" from `launchctl print` text. The parse
// lives in tools/rc-gate/launchd-spawn-type.sh so it can be tested on canned text (no launchctl,
// runs on Linux CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('../tools/rc-gate/launchd-spawn-type.sh', import.meta.url));
const INSTALL = fileURLToPath(new URL('../tools/rc-gate/install-launchagent.sh', import.meta.url));
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
// BEHAVIOURAL: run the real install script with a temp HOME and stub launchctl/lsof/sleep first on
// PATH. Safety: the script's only filesystem write is `$HOME/Library/LaunchAgents/...` (HOME is the
// temp dir), `launchctl` resolves to the stub (it is not called by absolute path anywhere in the
// script or the sourced lib), and the stub only appends to a log inside the temp dir.
function runInstall(spawnTypeLine) {
  const root = mkdtempSync(join(tmpdir(), 'rcgate-install-'));
  try {
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(bin);
    const log = join(root, 'launchctl.log');
    writeFileSync(join(root, 'print.txt'), `gui/501/com.mokka.rc-gate = {\n\tstate = running\n${spawnTypeLine}\n}\n`);
    const stub = (name, body) => { const f = join(bin, name); writeFileSync(f, `#!/bin/bash\n${body}\n`); chmodSync(f, 0o755); };
    stub('launchctl', `echo "launchctl $*" >> "${log}"\nif [ "$1" = print ]; then cat "${join(root, 'print.txt')}"; fi\nexit 0`);
    stub('lsof', 'echo 12345');
    stub('sleep', 'exit 0');
    const r = spawnSync('bash', [INSTALL], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    const installed = existsSync(join(home, 'Library', 'LaunchAgents', 'com.mokka.rc-gate.plist'));
    return { ...r, calls, installed, home };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('rc-gate install (behavioural): spawn type daemon -> WARN on stderr and exit 2, gate left up', () => {
  const r = runInstall('\tspawn type = daemon (3)');
  assert.equal(r.status, 2, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /WARN: rc-gate is not running as an Interactive job \(spawn type = daemon\) — ProcessType did not apply/);
  assert.match(r.stdout, /rc-gate is listening on 127\.0\.0\.1:3457/, 'the listen check ran first');
  assert.ok(r.installed, 'the plist was written under the TEMP home');
  assert.match(r.calls, new RegExp(`launchctl load ${r.home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/Library/LaunchAgents/`), 'only the stub was called, with the temp-home path');
});

test('rc-gate install (behavioural): spawn type interactive -> exit 0, no WARN', () => {
  const r = runInstall('\tspawn type = interactive (4)');
  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /WARN/);
  assert.match(r.stdout, /launchd spawn type: interactive/);
});
