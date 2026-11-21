// install-launchagent.sh decides "did ProcessType apply?" from `launchctl print` text. The parse
// lives in tools/rc-gate/launchd-spawn-type.sh so it can be tested on canned text (no launchctl,
// runs on Linux CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, chmodSync, existsSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

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
function runInstall(spawnTypeLine, { plistEdit = x => x } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rcgate-install-'));
  try {
    const home = join(root, 'home');
    const bin = join(root, 'bin');
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    mkdirSync(bin);
    // Run a COPY of the scripts so a test can feed the pre-check a wrong plist without touching the repo.
    const tools = join(root, 'tools', 'rc-gate');
    mkdirSync(join(tools, 'launchd'), { recursive: true });
    const srcDir = dirname(INSTALL);
    copyFileSync(INSTALL, join(tools, 'install-launchagent.sh'));
    copyFileSync(join(srcDir, 'launchd-spawn-type.sh'), join(tools, 'launchd-spawn-type.sh'));
    writeFileSync(join(tools, 'launchd', 'com.mokka.rc-gate.plist'),
      plistEdit(readFileSync(join(srcDir, 'launchd', 'com.mokka.rc-gate.plist'), 'utf8')));
    const log = join(root, 'launchctl.log');
    writeFileSync(join(root, 'print.txt'), `gui/501/com.mokka.rc-gate = {\n\tstate = running\n${spawnTypeLine}\n}\n`);
    const stub = (name, body) => { const f = join(bin, name); writeFileSync(f, `#!/bin/bash\n${body}\n`); chmodSync(f, 0o755); };
    stub('launchctl', `echo "launchctl $*" >> "${log}"\nif [ "$1" = print ]; then cat "${join(root, 'print.txt')}"; fi\nexit 0`);
    stub('lsof', 'echo 12345');
    stub('sleep', 'exit 0');
    const r = spawnSync('bash', [join(tools, 'install-launchagent.sh')], {
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
  assert.match(r.stderr, /FAILED: the relay is running and serving the new code, but macOS did not apply the new CPU priority \(spawn type = daemon\)\. Do NOT re-run or kickstart within the next hour/);
  assert.match(r.stderr, /Tell the agent\./);
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

test('rc-gate install (behavioural): a plist without ProcessType=Interactive stops with exit 3 BEFORE any launchctl call', () => {
  const r = runInstall('\tspawn type = interactive (4)', { plistEdit: x => x.replace(/<key>ProcessType<\/key>\s*<string>Interactive<\/string>/, '') });
  assert.equal(r.status, 3, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /does not have ProcessType=Interactive and ExitTimeOut>=25\. Nothing was reloaded/);
  assert.equal(r.calls, '', 'launchctl (stub) was never called: no unload, no load');
});

test('rc-gate install (behavioural): a plist with ExitTimeOut below 25 also stops with exit 3', () => {
  const r = runInstall('\tspawn type = interactive (4)', { plistEdit: x => x.replace(/(<key>ExitTimeOut<\/key>\s*<integer>)\d+/, (_m, head) => head + '5') });
  assert.equal(r.status, 3, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.equal(r.calls, '');
});
