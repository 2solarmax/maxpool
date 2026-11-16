// The pool runs for days; its launch directory can be deleted and restored under it
// (2026-11-16: a workspace wipe+restore left the supervisor's cwd a dead inode). A
// child `npm install -g` inherits that dead cwd and dies at startup with
// ENOENT uv_cwd before installing anything, so self-update failed every check until
// a human installed by hand. selfUpdate must run npm from a directory that exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const updater = join(dirname(dirname(fileURLToPath(import.meta.url))), 'src', 'updater.js');

test('selfUpdate still runs npm when the process cwd has been deleted', { skip: process.platform === 'win32' }, () => {
  const stage = mkdtempSync(join(tmpdir(), 'updater-cwd-'));
  const bin = join(stage, 'bin');
  mkdirSync(bin);
  // Stub npm: like real npm, it reads process.cwd() at startup (throws ENOENT when the
  // inherited cwd is gone), then reports where it ran.
  const stub = join(bin, 'npm');
  writeFileSync(stub, `#!${process.execPath}\nprocess.stdout.write('ran-in:' + process.cwd());\n`);
  chmodSync(stub, 0o755);
  const doomed = join(stage, 'launch-dir');
  mkdirSync(doomed);
  // The child: enter the launch dir, delete it from under itself, then self-update.
  const script = `
    const { rmSync } = await import('node:fs');
    process.chdir(${JSON.stringify(doomed)});
    rmSync(${JSON.stringify(doomed)}, { recursive: true });
    const { selfUpdate } = await import(${JSON.stringify(updater)});
    const r = await selfUpdate({ timeoutMs: 20_000 });
    process.stdout.write(JSON.stringify(r));
  `;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    encoding: 'utf8',
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `child failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true, `selfUpdate failed: ${out.error}`);
  assert.match(out.output, /^ran-in:\//, 'npm must start in an existing directory');
});
