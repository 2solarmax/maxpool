// D3 on the LINK path: a first-byte timeout on a big prompt retries the SAME remote row
// once (floor lowered to the 15s minimum; ~20s of test wall-clock).
process.env.MAXPOOL_LINK_TTFB_MS = '15000';
process.env.MAXPOOL_LINK_TTFB_MS_PER_BYTE = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Dynamic import: a static one is hoisted ABOVE the env lines, so server.js would read
// its module constants before the knobs are set (the first version of this file did).
const { remotePool, bootLink, bigBody, captureLog, attempts } = await import('./link-fixture.js');

const BIG = 300_000;
const SMALL = 5_000;

test('T6 (link): big prompt link-TTFB once → retry-same on the same remote row → answers', async () => {
  const remote = remotePool((pin, n) => (pin === 'reports@gomokka.com' && n === 1 ? 'hang' : 'sse'));
  const { port, cleanup } = await bootLink(remote);
  try {
    let status = 0;
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: bigBody(BIG),
      });
      status = r.status; await r.text();
    });
    assert.equal(status, 200);
    assert.deepEqual(remote.hits, ['reports@gomokka.com', 'reports@gomokka.com'], `same row retried; hits: ${remote.hits}`);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /^\[Maxpool\] attempt failed \(link_ttfb\) on "reports@gomokka.com ☁" — no first byte after .* on a 300KB prompt → retry-same$/);
  } finally { await cleanup(); }
});

test('T7 (link): small prompt link-TTFB moves immediately', async () => {
  const remote = remotePool(pin => (pin === 'reports@gomokka.com' ? 'hang' : 'sse'));
  const { port, cleanup } = await bootLink(remote);
  try {
    let status = 0;
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: bigBody(SMALL),
      });
      status = r.status; await r.text();
    });
    assert.equal(status, 200);
    assert.deepEqual(remote.hits, ['reports@gomokka.com', 'personal'], `moved at once: ${remote.hits}`);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.ok(a[0].endsWith('→ moved'), a[0]);
  } finally { await cleanup(); }
});

test('T7 (link): a link DROP (not a timeout) on a big prompt moves — no retry-same', async () => {
  const remote = remotePool((pin, n, req) => {
    if (pin === 'reports@gomokka.com') { req.socket.destroy(); return 'hang'; }
    return 'sse';
  });
  const { port, cleanup } = await bootLink(remote);
  try {
    let status = 0;
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: bigBody(BIG),
      });
      status = r.status; await r.text();
    });
    assert.equal(status, 200);
    assert.deepEqual(remote.hits, ['reports@gomokka.com', 'personal']);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /\(pool_link_unreachable\) on "reports@gomokka.com ☁" .* → moved$/);
  } finally { await cleanup(); }
});
