// `maxpool status` prints the Efficiency block (2026-11-15): overall figures with this
// pool's rows and the linked pools' exported sums, per-account cache rows, and a cloud
// row showing the figure the SERVING pool exported.
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
const lease = a => { a.inFlight++; return { account: a, weight: 1, startedAt: Date.now() - 100, requestInfo: {} }; };

test('status prints the Efficiency block and per-account cache figures', async () => {
  const am = new AccountManager([
    { name: 'c1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, accountUuid: 'U1' },
    { name: 'g1', type: 'provider', provider: 'zai', authToken: 'k', accountUuid: 'U2' },
  ], 0.9);
  for (let i = 0; i < 5; i++) {
    am.releaseAccount(lease(am.accounts[0]), { success: true, status: 200, usage: { in: 1000, cr: 9000, cc: 0, out: 10 } });
  }
  am.releaseAccount(lease(am.accounts[0]), { success: true, status: 200, usage: { in: 1000, cr: 0, cc: 0 }, moved: true, moveCause: 'busy', busyWaitMs: 1200 });
  // A cloud mirror whose SERVING pool exported its own figures.
  am.addAccount({ name: 'cloud ☁', type: 'oauth', configSourced: true, runtime: false });
  const mirrorRow = am.accounts.find(a => a.name === 'cloud ☁');
  mirrorRow.remote = { linkName: 'team' };
  mirrorRow._remoteLoad = { last1h: { efficiency: { provider: 'claude', served: 20, cr: 18000, in: 2000, cc: 0, hit: 0.9, movedByCause: {} } } };
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:9' });
  const port = await listen(proxy);
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-eff-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({ proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' }, accounts: [] }) + '\n');
  try {
    const out = await new Promise((resolve, reject) => {
      let buf = '';
      const child = spawn(process.execPath, [cliPath, 'status'], { env: { ...process.env, MAXPOOL_CONFIG: configPath }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', d => { buf += d; });
      child.stderr.on('data', d => { buf += d; });
      child.on('error', reject);
      child.on('exit', () => resolve(buf));
    });
    assert.match(out, /Efficiency \(15m\):/, out);
    assert.match(out, /Claude 88% \(miss 0\.0M tok\)/, `local + cloud export combined: ${out}`);
    assert.match(out, /GLM —/, 'missing GLM figures read as a dash');
    assert.match(out, /Moves:\s+17\/100 served \(busy 1 · balance 0 · wall 0 · link 0 · other 0\)/, out);
    assert.match(out, /Waited:\s+1 \(avg 1\.2s\) · waited then moved 1/, 'a wait that still moved is counted as waste');
    assert.doesNotMatch(out, /g1 \(provider\)\n(?:.*\n){2}\s+Cache:/, 'an idle row prints no cache line');
    assert.match(out, /Cache:\s+88% over 1h, 6 served, 0 bounced/, `per-account row: ${out}`);
    assert.match(out, /Cache:\s+90% over 1h \(team\), 20 served/, `cloud row shows the serving pool's export: ${out}`);
  } finally { await close(proxy); }
});
