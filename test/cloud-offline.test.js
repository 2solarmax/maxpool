// Flaky Wi-Fi (2026-11-07): one timed-out status check flipped every cloud row to a
// red "cloud ✕" with no cause shown, while requests were still getting through.
// The link now goes down only after repeated failures, and the screen names the
// cause once in a "Cloud" line instead of on every row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { PoolLink, remoteIdentities, describeLinkError, FAILS_BEFORE_DOWN } from '../src/pool-link.js';
import { controllingTerminalAlive } from '../src/terminal-alive.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const okStatus = { accounts: [{ name: 'glm a', type: 'provider', provider: 'zai', enabled: true, status: 'active', inFlight: 0, quota: {} }] };

function scriptedLink(results) {
  let i = 0, t = 1_000;
  return new PoolLink({ name: 'team', url: 'http://x', key: 'k' }, {
    now: () => t,
    fetchRemoteStatus: async () => {
      const r = results[Math.min(i++, results.length - 1)];
      t += 30_000;
      return r === 'ok' ? { ok: true, status: 200, json: structuredClone(okStatus), error: null, at: t } : { ok: false, status: null, json: null, error: r, at: t };
    },
  });
}

test('one missed check is not an outage; the second in a row is', async () => {
  assert.equal(FAILS_BEFORE_DOWN, 2);
  const link = scriptedLink(['ok', 'timeout', 'ok', 'timeout', 'timeout', 'ok']);
  await link.poll();
  assert.equal(link.lastError, null);
  await link.poll();                                   // single blip
  assert.equal(link.lastError, null, 'one timeout must not take the cloud down');
  assert.equal(link.lastPollError, 'timeout', 'the blip is still recorded');
  await link.poll();                                   // recovered → streak reset
  await link.poll();
  assert.equal(link.lastError, null, 'streak restarts after a success');
  await link.poll();                                   // second in a row
  assert.equal(link.lastError, 'timeout');
  const downAt = link.downSince;
  assert.ok(downAt, 'outage start recorded');
  await link.poll();
  assert.equal(link.lastError, null, 'first success brings it back');
  assert.equal(link.downSince, null);
});

test('a rejected key and a never-connected link are down at once', async () => {
  const rejected = scriptedLink(['ok', 'key rejected']);
  await rejected.poll(); await rejected.poll();
  assert.equal(rejected.lastError, 'key rejected');
  const fresh = scriptedLink(['timeout']);
  await fresh.poll();
  assert.equal(fresh.lastError, 'timeout', 'no good check yet → nothing to keep showing');
});

test('outage start stays at the FIRST down check, not the latest', async () => {
  const link = scriptedLink(['ok', 'timeout', 'timeout', 'timeout']);
  for (let i = 0; i < 3; i++) await link.poll();
  const first = link.downSince;
  await link.poll();
  assert.equal(link.downSince, first);
});

test('cause in plain English', () => {
  assert.match(describeLinkError('timeout'), /^no connection — check your internet/);
  assert.match(describeLinkError('fetch failed'), /^no connection/);
  assert.match(describeLinkError('key rejected'), /rejected this laptop's key/);
  assert.match(describeLinkError('HTTP 502'), /answered with an error \(HTTP 502\)/);
});

test('screen: one Cloud line names the cause; rows say "offline", not a red ✕', async () => {
  const am = new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'k1' }], 0.9, { routingMode: 'balance' });
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = Date.now() - 5 * 60_000; link.lastError = null;
  link.status = structuredClone(okStatus);
  link.identities = remoteIdentities(link.status);
  am.setPoolLinks([link]);
  const { TUI } = await import('../src/tui.js');
  const tui = new TUI({ accountManager: am });
  assert.deepEqual(tui._cloudLinkLines(200), [], 'healthy link → no Cloud line');

  link.lastError = 'timeout'; link.downSince = Date.now() - 3 * 60_000;
  am.syncRemoteMirrors(link);
  const [line, ...rest] = tui._cloudLinkLines(400).map(strip);
  assert.equal(rest.length, 0);
  assert.match(line, /Cloud\s+⟐ team unreachable for 3m — no connection — check your internet/);
  assert.match(line, /local accounts still serving · last synced/);
  const row = strip(tui._renderAcct(am.accounts.find(x => x.remote).index, 11, true));
  assert.match(row, /⟐ offline/);
  assert.doesNotMatch(row, /✕/);
  am.setPoolLinks([]);
});

test('terminal check: open terminal → alive; revoked terminal or a pipe → treat as hangup', () => {
  const ok = { isTTY: true, fd: 1, open: () => 9, close: () => {}, write: () => 0 };
  assert.equal(controllingTerminalAlive(ok), true);
  assert.equal(controllingTerminalAlive({ ...ok, open: () => { throw Object.assign(new Error('ENXIO'), { code: 'ENXIO' }); } }), false);
  assert.equal(controllingTerminalAlive({ ...ok, write: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } }), false);
  assert.equal(controllingTerminalAlive({ ...ok, isTTY: false }), false, 'pipe/test mode keeps the old hangup answer');
});
