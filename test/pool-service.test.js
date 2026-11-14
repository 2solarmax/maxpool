// Shell harness for the pool service (tools/pool-service/*): install.sh,
// tmux.conf, pane.sh and the maxpool.zsh wrapper function.
//
// SAFETY: every external command is stubbed — launchctl, tmux, maxpool and npm
// resolve to stubs on PATH or absolute env overrides. A run of this file must
// never call real launchctl, never start a real tmux server, never touch the
// live pool on :3456, and never run the installed maxpool. Sockets and plists
// land in a throwaway stage directory; HOME is overridden so a buggy install.sh
// cannot write to the real ~/Library/LaunchAgents.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, unlink } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const tools = join(repo, 'tools', 'pool-service');
const MIN_VERSION = '1.24.95';

// node:fs has no waitFor; poll by hand.
async function waitForFile(path, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return Date.now();
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}: ${path}`);
}

async function makeStage() {
  const stage = await mkdtemp(join(tmpdir(), 'pool-service-'));
  const home = join(stage, 'home');
  const dir = join(stage, 'dir');
  const bin = join(stage, 'bin');
  await mkdir(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  await mkdir(dir, { recursive: true });
  await mkdir(bin, { recursive: true });
  return { stage, home, dir, bin };
}

async function writeStub(path, body) {
  await writeFile(path, `#!/bin/bash\n${body}\n`);
  await chmod(path, 0o755);
}

function run(cmd, args, env, timeoutMs = 60000) {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: timeoutMs });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function envFor(stage, extra = {}) {
  return {
    ...process.env,
    HOME: stage.home,
    PATH: `${stage.bin}:${process.env.PATH}`,
    ...extra,
  };
}

async function stubNpmRoot(stage, version) {
  const root = join(stage.stage, 'npmroot', 'maxpool');
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'maxpool', version }));
  return dirname(root);
}

// A stub node bin dir: an executable `node` and a stub `tmux` that records its
// args (pane.sh puts the node dir FIRST in PATH, so stubs there win), plus a
// stub `maxpool` pane.sh runs once the port is free.
async function stubNodeDir(stage, name, maxpoolBody = 'exit 0') {
  const dir = join(stage.stage, name);
  await mkdir(dir, { recursive: true });
  await writeStub(join(dir, 'node'), 'exit 0');
  await writeStub(join(dir, 'tmux'), `echo "tmux $*" >> "${join(stage.stage, 'tmux-calls.txt')}"`);
  await writeStub(join(dir, 'maxpool'), maxpoolBody);
  return dir;
}

// ── install.sh: version gate ────────────────────────────────────────────────

test('install.sh refuses a version below MIN_VERSION and writes no plist', async () => {
  const stage = await makeStage();
  await writeStub(join(stage.bin, 'launchctl'), `echo "launchctl $*" >> "${join(stage.stage, 'launchctl-calls.txt')}"`);
  const npmRoot = await stubNpmRoot(stage, '1.24.93');   // current release — too old

  const r = run('bash', [join(tools, 'install.sh'), '--no-load', '--dir', stage.dir,
    '--port', '39401', '--label', 'com.maxpool.test'], envFor(stage, { MAXPOOL_NPM_ROOT: npmRoot }));

  assert.notEqual(r.status, 0, `install must fail on ${'1.24.93'} < ${MIN_VERSION}, got exit 0`);
  assert.match(r.stderr + r.stdout, new RegExp(MIN_VERSION));
  assert.equal(existsSync(join(stage.home, 'Library/LaunchAgents/com.maxpool.test.plist')), false,
    'no plist may be written when the installed version is too old');
  assert.equal(existsSync(join(stage.stage, 'launchctl-calls.txt')), false,
    'install must not call launchctl at all before the version gate passes');
});

test('install.sh at MIN_VERSION writes plist, tmux.conf and canary config', async () => {
  const stage = await makeStage();
  await writeStub(join(stage.bin, 'launchctl'), `echo "launchctl $*" >> "${join(stage.stage, 'launchctl-calls.txt')}"`);
  const npmRoot = await stubNpmRoot(stage, MIN_VERSION);
  const nodeDir = await stubNodeDir(stage, 'nodebin');

  const r = run('bash', [join(tools, 'install.sh'), '--no-load', '--dir', stage.dir,
    '--port', '39402', '--label', 'com.maxpool.canary'],
    envFor(stage, { MAXPOOL_NPM_ROOT: npmRoot, PATH: `${nodeDir}:${stage.bin}:${process.env.PATH}` }));
  assert.equal(r.status, 0, `install failed:\n${r.stdout}\n${r.stderr}`);

  // --no-load wrote the plist but never touched launchctl.
  assert.equal(existsSync(join(stage.stage, 'launchctl-calls.txt')), false, '--no-load must not call launchctl');

  const plist = join(stage.home, 'Library/LaunchAgents/com.maxpool.canary.plist');
  assert.ok(existsSync(plist), 'plist written');
  assert.equal(run('/usr/bin/plutil', ['-lint', plist], process.env).status, 0, 'plist must be valid');
  const xml = readFileSync(plist, 'utf8');
  assert.match(xml, /<string>com\.maxpool\.canary<\/string>/);
  assert.match(xml, new RegExp(`MAXPOOL_PORT</key>\\s*<string>39402</string>`));
  assert.match(xml, /MAXPOOL_SERVICE<\/key>\s*<string>1<\/string>/);
  assert.match(xml, /MAXPOOL_CONFIG<\/key>\s*<string>[^<]*config\.json<\/string>/);
  assert.match(xml, /MAXPOOL_TMUX_SOCK<\/key>\s*<string>[^<]*tmux\.sock<\/string>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /ThrottleInterval<\/key>\s*<integer>10<\/integer>/);
  assert.match(xml, /ProcessType<\/key>\s*<string>Interactive<\/string>/);
  assert.match(xml, new RegExp(`StandardOutPath</key>\\s*<string>${stage.dir.replace(/\//g, '\\/')}\/tmux\.log<\/string>`));
  assert.match(xml, /\/opt\/homebrew\/bin\/tmux<\/string>/);
  assert.match(xml, /<string>-D<\/string>/);

  // The generated tmux.conf: the committed settings plus the pool session with
  // an absolute pane.sh path (tmux refuses a command with -D at the CLI, and
  // conf commands get no env expansion — install.sh must bake the path in).
  const conf = readFileSync(join(stage.dir, 'tmux.conf'), 'utf8');
  assert.match(conf, /set -s escape-time 10/);
  assert.match(conf, /status off/);
  assert.match(conf, /bind -n C-c detach-client/);
  assert.match(conf, new RegExp(`new-session -d -s pool ${tools.replace(/\//g, '\\/')}\/pane\\.sh`));

  // Canary config pre-written (non-default label): own port, no accounts or
  // providers, sleep + all update machinery off, own API key.
  const canary = JSON.parse(readFileSync(join(stage.dir, 'config.json'), 'utf8'));
  assert.equal(canary.proxy.port, 39402);
  assert.match(canary.proxy.apiKey, /^mp-/);
  assert.deepEqual(canary.accounts, []);
  assert.deepEqual(canary.providers ?? [], []);
  assert.equal(canary.preventSleep, false);
  assert.equal(canary.updateCheck, false);
  assert.equal(canary.autoUpdate, false);
  assert.equal(canary.autoApply, false);
});

test('install.sh with the default label writes no canary config and points at the real config', async () => {
  const stage = await makeStage();
  const npmRoot = await stubNpmRoot(stage, MIN_VERSION);
  const nodeDir = await stubNodeDir(stage, 'nodebin');
  // Like this Mac: only the legacy config file exists.
  await mkdir(join(stage.home, '.config'), { recursive: true });
  await writeFile(join(stage.home, '.config', 'teamclaude.json'), '{}');

  const r = run('bash', [join(tools, 'install.sh'), '--no-load', '--dir', stage.dir],
    envFor(stage, { MAXPOOL_NPM_ROOT: npmRoot, PATH: `${nodeDir}:${stage.bin}:${process.env.PATH}` }));
  assert.equal(r.status, 0, `install failed:\n${r.stdout}\n${r.stderr}`);

  assert.equal(existsSync(join(stage.dir, 'config.json')), false,
    'the live label must NOT get a canary config — it would boot an empty pool');
  const xml = readFileSync(join(stage.home, 'Library/LaunchAgents/com.maxpool.pool.plist'), 'utf8');
  // Live config resolution mirrors config.js: teamclaude.json when maxpool.json is absent.
  assert.match(xml, /MAXPOOL_CONFIG<\/key>\s*<string>[^<]*teamclaude\.json<\/string>/);
});

// ── pane.sh: node fallback ──────────────────────────────────────────────────

test('pane.sh falls back to the nvm default alias when the pinned node is gone', async () => {
  const stage = await makeStage();
  const nvmBin = join(stage.home, '.nvm/versions/node/v20.9.9/bin');
  await mkdir(nvmBin, { recursive: true });
  await writeStub(join(nvmBin, 'node'), 'exit 0');
  await writeStub(join(nvmBin, 'tmux'), `echo "tmux $*" >> "${join(stage.stage, 'tmux-calls.txt')}"`);
  await mkdir(join(stage.home, '.nvm/alias'), { recursive: true });
  await writeFile(join(stage.home, '.nvm/alias/default'), '20\n');
  await writeStub(join(stage.bin, 'stub-maxpool'), 'exit 0');

  const r = run('bash', [join(tools, 'pane.sh')], envFor(stage, {
    MAXPOOL_DIR: stage.dir,
    MAXPOOL_PORT: '39403',
    MAXPOOL_TMUX_SOCK: join(stage.dir, 'tmux.sock'),
    MAXPOOL_NODE_BIN: join(stage.stage, 'pinned-gone'),   // missing → fallback
    MAXPOOL_CMD: join(stage.bin, 'stub-maxpool'),
  }));
  assert.equal(r.status, 0, `pane.sh failed:\n${r.stdout}\n${r.stderr}`);

  const log = readFileSync(join(stage.dir, 'pane.log'), 'utf8');
  assert.match(log, /FALLBACK node=.*v20\.[0-9.]+\/bin/);
  assert.match(log, /node=\S+/);       // tool-resolution line logged
  assert.match(log, /LANG=en_US\.UTF-8/);
});

// ── pane.sh: port wait ──────────────────────────────────────────────────────

test('pane.sh waits while the port is served and starts within seconds of it freeing', async () => {
  const stage = await makeStage();
  const nodeDir = await stubNodeDir(stage, 'nodebin');
  await writeStub(join(stage.bin, 'stub-maxpool'), `echo "ran $*" >> "${join(stage.stage, 'maxpool-ran.txt')}"`);

  const blocker = net.createServer();
  const port = await new Promise(resolve => blocker.listen(0, '127.0.0.1', () => resolve(blocker.address().port)));

  const child = spawn('bash', [join(tools, 'pane.sh')], {
    env: envFor(stage, {
      MAXPOOL_DIR: stage.dir,
      MAXPOOL_PORT: String(port),
      MAXPOOL_TMUX_SOCK: join(stage.dir, 'tmux.sock'),
      MAXPOOL_NODE_BIN: nodeDir,
      MAXPOOL_CMD: join(stage.bin, 'stub-maxpool'),
    }), stdio: 'ignore', detached: true,
  });
  child.unref();
  try {
    // Busy port: pane logs "waiting" and never runs the stub.
    await waitForFile(join(stage.dir, 'pane.log'), 15000, 'pane.log');
    await waitForFile(join(stage.dir, 'pane.log'), 8000, 'the waiting line');
    for (let i = 0; i < 20 && !/waiting for port/.test(readFileSync(join(stage.dir, 'pane.log'), 'utf8')); i++) {
      await new Promise(r => setTimeout(r, 200));
    }
    assert.match(readFileSync(join(stage.dir, 'pane.log'), 'utf8'), new RegExp(`waiting for port ${port}`));
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(existsSync(join(stage.stage, 'maxpool-ran.txt')), false,
      'pane.sh must NOT start maxpool while the port is already served');

    // Port freed: the stub runs promptly (1s poll).
    await new Promise(resolve => blocker.close(resolve));
    const t0 = Date.now();
    await waitForFile(join(stage.stage, 'maxpool-ran.txt'), 8000, 'stub maxpool run');
    const waitedMs = Date.now() - t0;
    assert.ok(waitedMs < 3000, `stub ran ${waitedMs}ms after the port freed — expected ~1s poll`);
  } finally {
    await new Promise(resolve => blocker.close(resolve)).catch(() => {});
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
});

// ── pane.sh: kill-server after exit ─────────────────────────────────────────

test('pane.sh kills the tmux server after maxpool exits and records a fast exit', async () => {
  const stage = await makeStage();
  const nodeDir = await stubNodeDir(stage, 'nodebin');
  await writeStub(join(stage.bin, 'stub-maxpool'), 'exit 0');

  const r = run('bash', [join(tools, 'pane.sh')], envFor(stage, {
    MAXPOOL_DIR: stage.dir,
    MAXPOOL_PORT: '39404',
    MAXPOOL_TMUX_SOCK: join(stage.dir, 'tmux.sock'),
    MAXPOOL_NODE_BIN: nodeDir,
    MAXPOOL_CMD: join(stage.bin, 'stub-maxpool'),
  }), 30000);
  assert.equal(r.status, 0, `pane.sh failed:\n${r.stdout}\n${r.stderr}`);

  const log = readFileSync(join(stage.dir, 'pane.log'), 'utf8');
  assert.match(log, /maxpool exited code=0/);
  assert.match(log, /FAST EXIT code 0/);      // the stub exits instantly → fast-exit breadcrumb
  const tmuxCalls = readFileSync(join(stage.stage, 'tmux-calls.txt'), 'utf8');
  assert.match(tmuxCalls, new RegExp(`-S ${stage.dir.replace(/\//g, '\\/')}\/tmux\.sock kill-server`),
    'pane.sh must run kill-server on its own socket so launchd sees the job exit');
});

// ── maxpool.zsh: the shell function ─────────────────────────────────────────

async function zshStage() {
  const stage = await makeStage();
  const calls = join(stage.stage, 'calls');
  const state = join(stage.stage, 'state');
  await writeStub(join(stage.bin, 'launchctl'), [
    `case "$1" in`,
    `  print-disabled) [ -f "${state}.disabled" ] && cat "${state}.disabled" || echo 'disabled services = {}' ;;`,
    `  enable) echo "enable $2" >> "${calls}.launchctl" ;;`,
    `  disable) echo "disable $2" >> "${calls}.launchctl" ;;`,
    `  bootstrap) echo "bootstrap $2 $3" >> "${calls}.launchctl"; exit 1 ;;`,   // simulates "already loaded"
    `  bootout) echo "bootout $2" >> "${calls}.launchctl" ;;`,
    `esac`,
  ].join('\n'));
  await writeStub(join(stage.bin, 'tmux'), `echo "tmux $*" >> "${calls}.tmux"; case " $* " in *" has-session "*) [ -f "${state}.alive" ] && exit 0 || exit 1 ;; esac`);
  await writeStub(join(stage.bin, 'maxpool'), [
    `echo "maxpool $*" >> "${calls}.maxpool"`,
    `if [ "$1" = status ]; then [ -f "${state}.statusok" ] && exit 0 || exit 1; fi`,
    `exit 0`,
  ].join('\n'));
  return { stage, calls, state };
}

function zshRun(stage, fnArgs, extraEnv = {}) {
  const script = `source "${join(tools, 'maxpool.zsh')}"; maxpool ${fnArgs}`;
  return run('/bin/zsh', ['-c', script], envFor(stage, {
    MAXPOOL_SERVICE_LABEL: 'com.maxpool.test',
    MAXPOOL_DIR: stage.dir,
    MAXPOOL_PORT: '39405',
    MAXPOOL_ON_WAIT_SECS: '2',
    MAXPOOL_OFF_WAIT_SECS: '2',
    ...extraEnv,
  }));
}

test('bare maxpool in each service state attaches, reports off, or reports starting — never starts a pool', async () => {
  const { stage, calls, state } = await zshStage();

  // State 1: running (socket session alive) → attach, no bare binary run.
  await writeFile(`${state}.alive`, '');
  let r = zshRun(stage, '');
  assert.equal(r.status, 0, `attach failed: ${r.stdout}${r.stderr}`);
  assert.match(readFileSync(`${calls}.tmux`, 'utf8'), /tmux -u -S \S*tmux\.sock attach -t pool/,
    'the running state attaches to the service socket (its message IS the dashboard)');
  assert.ok(!existsSync(`${calls}.maxpool`), 'bare maxpool must never run the real binary');

  // State 2: off (launchd job disabled, no session) → the off message.
  await unlink(`${state}.alive`);
  await writeFile(`${state}.disabled`, '"com.maxpool.test" => disabled\n');
  r = zshRun(stage, '');
  assert.match(r.stdout, /Maxpool is off\. Turn on: maxpool on/);
  assert.ok(!existsSync(`${calls}.maxpool`), 'the off state must not run the real binary either');

  // State 3: starting/restarting (enabled, no session yet) → says so, points at the log.
  await writeFile(`${state}.disabled`, '"com.maxpool.test" => enabled\n');
  r = zshRun(stage, '');
  assert.match(r.stdout, /start/i);
  assert.match(r.stdout, /pane\.log/);
  assert.ok(!existsSync(`${calls}.maxpool`), 'the starting state must not run the real binary');
});

test('maxpool off routes direct before disabling, and tolerates an unloaded job', async () => {
  const { stage, calls } = await zshStage();
  const r = zshRun(stage, 'off');
  assert.equal(r.status, 0, `off failed: ${r.stdout}${r.stderr}`);
  const launchctlCalls = readFileSync(`${calls}.launchctl`, 'utf8');
  const maxpoolCalls = readFileSync(`${calls}.maxpool`, 'utf8');
  // Cutover safety: sessions go direct BEFORE the pool is stopped.
  const firstRoute = maxpoolCalls.split('\n')[0];
  assert.match(firstRoute, /route direct/);
  assert.match(launchctlCalls, /disable gui\/\d+\/com\.maxpool\.test/);
  assert.match(launchctlCalls, /bootout gui\/\d+\/com\.maxpool\.test/);
  assert.match(r.stdout, /off/i);
});

test('maxpool on succeeds through a tolerated bootstrap and routes back to the pool', async () => {
  const { stage, calls, state } = await zshStage();
  await writeFile(`${state}.statusok`, '');   // status succeeds on the first poll
  const r = zshRun(stage, 'on');
  assert.equal(r.status, 0, `on failed: ${r.stdout}${r.stderr}`);
  const launchctlCalls = readFileSync(`${calls}.launchctl`, 'utf8');
  // enable BEFORE bootstrap, bootstrap failure tolerated (stub exits 1 = already loaded).
  const enableIdx = launchctlCalls.indexOf('enable ');
  const bootIdx = launchctlCalls.indexOf('bootstrap ');
  assert.ok(enableIdx !== -1 && bootIdx !== -1 && enableIdx < bootIdx, `enable must precede bootstrap: ${launchctlCalls}`);
  assert.ok(!/disable /.test(launchctlCalls), 'the on path must never disable the job');
  const maxpoolCalls = readFileSync(`${calls}.maxpool`, 'utf8');
  assert.match(maxpoolCalls, /status/);
  assert.match(maxpoolCalls.trim().split('\n').pop(), /route pool/);
});

test('maxpool on timeout leaves the job enabled, stays direct, and says so loudly', async () => {
  const { stage, calls } = await zshStage();
  // No ${state}.statusok → status never succeeds; MAXPOOL_ON_WAIT_SECS=2 keeps the test fast.
  const r = zshRun(stage, 'on');
  assert.notEqual(r.status, 0, `a start that never answered must not report success: ${r.stdout}${r.stderr}`);
  const out = r.stdout + r.stderr;
  assert.match(out, /did not start/i);
  assert.match(out, /going direct/i);
  assert.match(out, /pane\.log/);
  const launchctlCalls = readFileSync(`${calls}.launchctl`, 'utf8');
  assert.match(launchctlCalls, /enable /);
  assert.ok(!/disable /.test(launchctlCalls),
    'a failed start must leave the job ENABLED so the monitor keeps alerting');
  const maxpoolCalls = readFileSync(`${calls}.maxpool`, 'utf8');
  assert.ok(!/route pool/.test(maxpoolCalls), 'route stays direct when the start did not succeed');
});
