import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readCapacityDrains, acknowledgeCapacityDrains } from '../src/config.js';
import { CapacityLedger } from '../src/capacity-ledger.js';

test('unchanged malformed drains stay quiet; replacing them retries the same IDs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-bad-drains-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state'), queue = path + '.drains';
  await mkdir(queue);
  const badJSON = 'a'.repeat(24), badData = 'b'.repeat(24);
  const day = new Date().toISOString().slice(0, 10);
  const payload = tokens => JSON.stringify({ accounts: { local: { days: { [day]: tokens } } } });
  await writeFile(join(queue, badJSON), '{broken');
  await writeFile(join(queue, badData), payload(-2));
  const ledger = new CapacityLedger();
  const invalidLogs = t.mock.method(console, 'error', () => {});
  const apply = t.mock.method(ledger, 'applyDrain');
  assert.deepEqual(await readCapacityDrains(ledger, path), []);
  assert.deepEqual(await readCapacityDrains(ledger, path), []);
  assert.equal(apply.mock.callCount(), 1, 'invalid schema is validated once');
  assert.equal(invalidLogs.mock.callCount(), 2, 'one diagnostic per unchanged file');
  assert.deepEqual((await readdir(queue)).sort(), [badJSON, badData]);

  await writeFile(join(queue, badJSON), payload(5));
  // Same-size repair via rename changes file identity, even on a coarse clock.
  const fixed = payload(12);
  assert.equal(fixed.length, payload(-2).length);
  await writeFile(join(queue, 'repair'), fixed);
  await rename(join(queue, 'repair'), join(queue, badData));
  const ready = await readCapacityDrains(ledger, path);
  assert.deepEqual(ready.sort(), [badJSON, badData]);
  await readCapacityDrains(ledger, path);
  assert.equal(ledger.rollingThroughput('local').tokens, 17);
  await acknowledgeCapacityDrains(ledger, ready, path);
  assert.deepEqual(await readdir(queue), []);
});

test('a transient store error retries without a file modification', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-transient-drain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state'), id = 'a'.repeat(24);
  await mkdir(path + '.drains');
  await writeFile(join(path + '.drains', id), JSON.stringify({ accounts: {}, owners: {} }));
  const ledger = new CapacityLedger();
  const apply = t.mock.method(ledger, 'applyDrain', () => { throw Error('state temporarily unavailable'); });
  t.mock.method(console, 'error', () => {});
  assert.deepEqual(await readCapacityDrains(ledger, path), []);
  apply.mock.restore();
  assert.deepEqual(await readCapacityDrains(ledger, path), [id]);
});
