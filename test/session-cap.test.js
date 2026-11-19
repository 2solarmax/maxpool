import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { sessionCapCommand } from '../src/session-cap.js';

test('authenticated admission is bounded across overlapping workers, retries and worker replacement', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'maxpool-cap-test-'));
  const saved = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = join(directory, 'pool.json');
  t.after(async () => {
    if (saved === undefined) delete process.env.MAXPOOL_CONFIG;
    else process.env.MAXPOOL_CONFIG = saved;
    await rm(directory, { recursive: true, force: true });
  });

  async function listen(server) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }));
    return 'http://127.0.0.1:' + server.address().port;
  }
  const seen = [];
  const upstream = await listen(http.createServer((req, res) => {
    seen.push(req.url);
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
  }));
  const config = {
    upstream, proxy: { clients: [{ name: 'pilot', key: 'test-one' }, { name: 'peer', key: 'test-two' }] },
  };
  const worker = () => listen(createProxyServer(new AccountManager([{ name: 'fake', type: 'apikey', apiKey: 'fixture' }], 0.9), config));
  const first = await worker();
  const second = await worker();
  const pilot = randomUUID();
  const peerSession = randomUUID();
  async function call(base, session = pilot, key = 'test-one', path = '/v1/messages?beta=true', tag = 'x-maxpool-session') {
    const res = await fetch(base + path, {
      method: 'POST', headers: { 'x-api-key': key, [tag]: session, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [{ role: 'user', content: 'hello' }] }),
    });
    await res.text();
    if (res.status === 403) {
      assert.equal(res.headers.get('x-maxpool-session-cap'), 'blocked');
      assert.equal(res.headers.get('x-should-retry'), 'false');
    }
    return res.status;
  }
  const cap = (op, ...rest) => sessionCapCommand([op, pilot, ...rest, '--caller', 'pilot']);
  const ping = await fetch(first + '/maxpool/ping');
  assert.equal(ping.headers.get('x-maxpool-session-cap-version'), '1');
  assert.equal(await call(first), 200);
  assert.deepEqual(await cap('status'), { armed: false });
  await cap('arm', '3');
  await assert.rejects(cap('arm', '99'), /already armed/);
  assert.equal(await call(first, pilot, 'wrong'), 401);
  assert.equal(await call(first, pilot, 'test-one', '/v1/messages/count_tokens'), 200);
  assert.equal(await call(first, pilot, 'test-two'), 200);
  assert.equal(await call(first, peerSession), 200);
  const before = seen.length;
  const statuses = await Promise.all(Array.from({ length: 16 }, (_, i) => call(i % 2 ? first : second)));
  assert.equal(statuses.filter(code => code === 200).length, 3);
  assert.equal(statuses.filter(code => code === 403).length, 13);
  assert.equal(seen.length - before, 3, 'local rejections reached no upstream');
  assert.deepEqual(await cap('status'), { armed: true, limit: 3, admitted: 3, remaining: 0, blocked: true });
  const replacement = await worker();
  assert.equal(await call(replacement, pilot, 'test-one', '/v1/messages', 'x-teamclaude-session'), 403);
  assert.equal(seen.length - before, 3);
  await cap('disarm');
  assert.equal(await call(replacement), 200);
  await cap('arm', '0');
  assert.equal(await call(replacement), 403);
  assert.equal(await call(replacement, peerSession), 200);
  await cap('disarm');
  assert.deepEqual(await cap('disarm'), { armed: false });
});

test('a fresh process cannot replenish the shared cap', async t => {
  const root = await mkdtemp(join(tmpdir(), 'maxpool-cap-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = randomUUID();
  await sessionCapCommand(['arm', session, '5'], root);
  const moduleUrl = new URL('../src/session-cap.js', import.meta.url).href;
  const claimScript = `
    const [moduleUrl, root, session] = process.argv.slice(1);
    const { admitSessionRequest } = await import(moduleUrl);
    const results = await Promise.all(Array.from({ length: 8 }, () => admitSessionRequest(root, session, null)));
    console.log(results.filter(Boolean).length);
  `;
  const run = async () => {
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', claimScript, moduleUrl, root, session]);
    return Number(result.stdout.trim());
  };
  const winners = await Promise.all([run(), run(), run()]);
  assert.equal(winners.reduce((sum, n) => sum + n, 0), 5);
  assert.equal(await run(), 0);
  assert.deepEqual(await sessionCapCommand(['status', session], root), {
    armed: true, limit: 5, admitted: 5, remaining: 0, blocked: true,
  });
});
