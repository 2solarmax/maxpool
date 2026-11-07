// Capacity v5 seams (red-team 2026-11-06): the SSE -> accrual plumbing, the state-file
// rollback protection, and the merged-cycle marker in the TUI.
//
// S*: the all-token axis (input + cache_read + cache_creation + output) is only real if the
//     cache counters survive parseSSEEvent -> requestInfo -> accrueCapacity. Unit tests of the
//     ledger cannot see that plumbing; deleting the noteCapacityCache calls used to pass.
// R*: an older build boots a newer ledger EMPTY and its flush would overwrite the history.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { saveState, flushStateWrites } from '../src/config.js';
import { SCHEMA_VERSION } from '../src/capacity-ledger.js';
import { TUI } from '../src/tui.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => s.close(r));
const oauth = (name = 'a1') => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 });

const sse = (...events) => events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

async function streamThrough(body) {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(body);
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([oauth()], 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    queue: { enabled: false },
  });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-4-8', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
    });
    await r.text();
    return { open: am.capacity.openCycle('a1', 'ses'), wk: am.capacity.openCycle('a1', 'wk') };
  } finally {
    await close(proxy);
    await close(upstream);
  }
}

// ── S: SSE -> accrual seam ───────────────────────────────────────────────────

test('S1: Anthropic shape (input + cache_read + cache_creation on message_start, output on message_delta) accrues the ALL-token total', async () => {
  const { open, wk } = await streamThrough(sse(
    { type: 'message_start', message: { usage: { input_tokens: 100, cache_read_input_tokens: 5000, cache_creation_input_tokens: 700, output_tokens: 1 } } },
    { type: 'message_delta', usage: { output_tokens: 20 } },
    { type: 'message_delta', usage: { output_tokens: 90 } },
    { type: 'message_stop' },
  ));
  assert.equal(open.tokensSoFar, 100 + 5000 + 700 + 90, 'input + cache_read + cache_creation + MAX output');
  assert.equal(open.cacheRead, 5000);
  assert.equal(open.cacheCreation, 700);
  assert.equal(wk.tokensSoFar, 5890, 'weekly cycle accrues the same request');
});

test('S2: z.ai shape (everything on message_delta, message_start zeros) accrues the ALL-token total', async () => {
  const { open } = await streamThrough(sse(
    { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'message_delta', usage: { input_tokens: 32, output_tokens: 3, cache_read_input_tokens: 6592, cache_creation_input_tokens: 40 } },
    { type: 'message_stop' },
  ));
  assert.equal(open.tokensSoFar, 32 + 3 + 6592 + 40);
  assert.equal(open.cacheRead, 6592);
});

test('S3: cache counters repeated on BOTH events are a running max, never summed', async () => {
  const { open } = await streamThrough(sse(
    { type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 0 } } },
    { type: 'message_delta', usage: { input_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10, output_tokens: 25 } },
    { type: 'message_stop' },
  ));
  assert.equal(open.tokensSoFar, 50 + 1000 + 10 + 25);
});

// Real captured z.ai (GLM via maxpool) responses — the field names are pinned from the wire,
// not from documentation. Fixture: test/fixtures/zai-sse-usage.txt.
const ZAI = readFileSync(join(HERE, 'fixtures', 'zai-sse-usage.txt'), 'utf8')
  .split(/^=== /m).slice(1)
  .map(block => { const nl = block.indexOf('\n'); return { name: block.slice(0, nl), body: block.slice(nl + 1) }; });

test('S4: real captured z.ai streams — field names are the Anthropic names, usage rides message_delta', async () => {
  assert.equal(ZAI.length, 2, 'cold + warm captures');
  for (const { name, body } of ZAI) {
    const events = body.split('\n\n').map(b => b.split('\n').find(l => l.startsWith('data: '))).filter(Boolean).map(l => JSON.parse(l.slice(6)));
    const start = events.find(e => e.type === 'message_start');
    const delta = events.find(e => e.type === 'message_delta');
    assert.deepEqual(start.message.usage, { input_tokens: 0, output_tokens: 0 }, `${name}: message_start usage is zeros`);
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens']) {
      assert.ok(Number.isInteger(delta.usage[k]), `${name}: message_delta.usage.${k} present`);
    }
    assert.equal('cache_creation_input_tokens' in delta.usage, false, `${name}: z.ai sends no cache_creation field`);
  }
  // and the REAL bytes accrue the all-token total through the real server path
  const warm = ZAI.find(z => z.name.startsWith('call-warm'));
  const { open } = await streamThrough(warm.body);
  assert.equal(open.tokensSoFar, 32 + 3 + 6592);
  assert.equal(open.cacheRead, 6592);
  const cold = ZAI.find(z => z.name.startsWith('call-cold'));
  assert.equal((await streamThrough(cold.body)).open.tokensSoFar, 17 + 33);
});

// ── R: rollback protection in saveState ──────────────────────────────────────

async function withState(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-state-'));
  const prev = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = join(dir, 'maxpool.json');
  const statePath = join(dir, 'maxpool.state.json');
  try { return await fn(dir, statePath); } finally {
    await flushStateWrites().catch(() => {});
    if (prev === undefined) delete process.env.MAXPOOL_CONFIG; else process.env.MAXPOOL_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
}
const baks = async dir => (await readdir(dir)).filter(f => f.includes('.bak-'));

test('R1: the FIRST v5 write over a v4 state file keeps a timestamped .v4.bak copy; later writes add none', async () => {
  await withState(async (dir, statePath) => {
    const v4 = { quota: { q: 1 }, capacity: { schemaVersion: 4, accounts: { a: { marker: 'old-history' } } }, _generation: 3 };
    await writeFile(statePath, JSON.stringify(v4));
    await saveState({ quota: {}, capacity: { schemaVersion: SCHEMA_VERSION, accounts: {} } });
    const files = await baks(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^maxpool\.state\.json\.v4\.bak-\d{8}T\d{6}Z$/);
    assert.deepEqual(JSON.parse(await readFile(join(dir, files[0]), 'utf8')), v4, 'backup is the untouched v4 file');
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).capacity.schemaVersion, SCHEMA_VERSION);
    await saveState({ quota: {}, capacity: { schemaVersion: SCHEMA_VERSION, accounts: {} } });
    assert.equal((await baks(dir)).length, 1, 'v5-over-v5 does not back up again');
  });
});

test('R2: a state file whose capacity schema is NEWER than this build is never overwritten', async () => {
  await withState(async (dir, statePath) => {
    const newer = { quota: {}, capacity: { schemaVersion: SCHEMA_VERSION + 1, accounts: { a: { marker: 'future' } } }, _generation: 9 };
    await writeFile(statePath, JSON.stringify(newer));
    const origError = console.error; const logged = [];
    console.error = (...a) => logged.push(a.join(' '));
    try {
      await assert.rejects(saveState({ quota: {}, capacity: { schemaVersion: SCHEMA_VERSION, accounts: {} } }), { code: 'STATE_SCHEMA_NEWER' });
    } finally { console.error = origError; }
    assert.ok(logged.some(l => /refusing to write/.test(l)), 'logged loudly');
    assert.deepEqual(JSON.parse(await readFile(statePath, 'utf8')), newer, 'file untouched');
    assert.equal((await baks(dir)).length, 0);
  });
});

test('R3: a file with no capacity block (fresh / quota-only) writes normally with no backup', async () => {
  await withState(async (dir, _statePath) => {
    await saveState({ quota: {}, capacity: { schemaVersion: SCHEMA_VERSION, accounts: {} } });
    await saveState({ quota: { a: 1 }, capacity: null });
    assert.equal((await baks(dir)).length, 0);
  });
});

// ── M: merged-cycle marker ───────────────────────────────────────────────────

test('M1: tankStatsFromCycles exposes mergedCount and the TUI marks N with * when a merged cycle contributes', async () => {
  const { tankStatsFromCycles } = await import('../src/capacity-ledger.js');
  const SEVEN_D = 7 * 86400_000, end = Date.now();
  const cyc = (i, extra = {}) => ({ startedAt: end - (i + 1) * SEVEN_D, endedAt: end - i * SEVEN_D, resetAt: end - i * SEVEN_D,
    tokens: 5e6, finalUtilization: 1, complete: true, disabledDuring: false, axis: 'all', ...extra });
  assert.equal(tankStatsFromCycles([cyc(1), cyc(2)], 'wk').mergedCount, 0);
  assert.equal(tankStatsFromCycles([cyc(1, { merged: true, sources: 2 }), cyc(2)], 'wk').mergedCount, 1);

  const am = new AccountManager([oauth('kira')], 0.90);
  am.capacity._readFloorOverride = { ses: 0, wk: 0 };
  const closeWk = (i, merged) => {
    am.capacity.accrue('kira', { input: 5e6, output: 0 }, end - (i + 1) * SEVEN_D + 1);
    am.capacity.closeCycle('kira', 'wk', end - i * SEVEN_D, { resetAt: end - i * SEVEN_D, finalUtilization: 1 });
    if (merged) { const c = am.capacity._accounts.get('kira').wk.closed.at(-1); c.merged = true; c.sources = 2; delete c.samples; }
  };
  const row = () => {
    const tui = new TUI({ accountManager: am, config: {} }); tui.capacityWindow = 'wk';
    const text = tui._renderCapacityPage(160).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
    assert.ok(text.includes('Med-all') && text.includes('Med-3'), 'header says Med-3/Med-all, not Avg');
    return text.split('\n').find(l => l.includes('kira'));
  };
  closeWk(2, false); closeWk(1, false);
  assert.match(row(), /\s2(\s|$)/, 'two plain cycles: N = 2, no marker');
  assert.doesNotMatch(row(), /2\*/);
  closeWk(0, true);
  assert.match(row(), /3\*/, 'a merged cycle contributes: N shows 3*');
});
