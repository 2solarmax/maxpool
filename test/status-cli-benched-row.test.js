// `maxpool status` must survive a benched duplicate row, which exports quota: null
// (its local numbers are stale by design — the cloud pool owns the live ones).
// Before this fix, `const q = acct.quota` + `q.unified5h` threw a TypeError and the
// command's catch printed "Cannot connect to proxy" and exited 1 on every linked Mac.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { listen, close } from './link-fixture.js';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

test('status prints every account and no connection error when a benched row has quota null', async () => {
  const am = new AccountManager([
    { name: 'healthy', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'benched', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 36e5 },
  ], 0.9);
  for (const a of am.accounts) a.quota = { unified5h: 0.42, unified7d: 0.77 };
  am.accounts[1].poolBenchedBy = 'cloud-team-row';
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-benched-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' }, accounts: [] }) + '\n');
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      const child = spawn(process.execPath, [cliPath, 'status'], { env: { ...process.env, MAXPOOL_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', d => { buf += d; });
      child.stderr.on('data', d => { buf += d; });
      child.on('error', reject);
      child.on('exit', code => resolve({ buf, code }));
    });
    assert.equal(out.code, 0, `status must exit 0, got ${out.code}\n${out.buf}`);
    assert.doesNotMatch(out.buf, /Cannot connect to proxy/, out.buf);
    assert.match(out.buf, /healthy \(oauth\)/, 'rows before the benched one print');
    assert.match(out.buf, /benched \(oauth\)/, 'the benched row itself prints');
    // A row printed AFTER the benched row proves the loop did not die mid-way.
    // The benched row is last in accounts, so use its own Total line as the tail check.
    assert.match(out.buf, /Quota:\s+from team pool/, 'the benched row names its quota source');
    assert.match(out.buf, /benched \(oauth\)\n(?:.*\n)*\s*Tokens:\s+- used\s+Requests: - used/, 'null quota renders as dashes, not a crash');
  } finally { await close(proxy); }
});
