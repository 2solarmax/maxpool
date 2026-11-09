// LINK path after red-team r1 #2: the link first-byte wait is the FLAT floor — no size
// scaling, no retry-same (the linked pool commits its own keep-alive headers ~1s in,
// so a scaled wait only ever stretched dead-tunnel detection). What stays: the flat
// floor itself, and the P2 pre-headers keep-alive.
process.env.MAXPOOL_LINK_TTFB_MS = '15000';
// Guard by test: if scaling ever comes back on the link path, this knob must stay dead.
process.env.MAXPOOL_LINK_TTFB_MS_PER_BYTE = String(30_000 / 300_000);

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Dynamic import: a static one is hoisted ABOVE the env lines, so server.js would read
// its module constants before the knobs are set.
const { remotePool, bootLink, bigBody, captureLog, attempts } = await import('./link-fixture.js');

test('#2: a 300KB streaming turn on the link aborts at the FLAT 15s floor (the scaling knob is dead)', async () => {
  // 300KB × the env knob would be a 30s wait; the flat floor is 15s. Row 1 answers at
  // 22s: a scaled link would wait for it (one hit). The flat floor aborts it at ~15s
  // and moves to row 2, which answers at once.
  const remote = remotePool(pin => (pin === 'reports@gomokka.com' ? { delay: 22_000, sse: true } : 'sse'));
  const { port, cleanup } = await bootLink(remote, { enabled: true, streamForwardGraceMs: 1000 });
  try {
    let status = 0; let text = '';
    const t0 = Date.now();
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: bigBody(300_000, true),
      });
      status = r.status; text = await r.text();
    });
    const took = Date.now() - t0;
    assert.equal(status, 200);
    assert.ok(text.includes('msg_link_ok'), `row 2 answered:\n${text.slice(0, 200)}`);
    assert.deepEqual(remote.hits, ['reports@gomokka.com', 'personal'], 'aborted at the floor, then moved');
    assert.ok(took >= 14_000 && took < 20_000, `abort at the 15s floor, not a scaled wait (took ${took}ms)`);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /\(link_ttfb\) on "reports@gomokka\.com ☁" — .* → moved$/);
    assert.ok(!lines.some(l => l.includes('first-byte wait')), `no scaled wait on the link:\n${lines.join('\n')}`);
  } finally { await cleanup(); }
});

test('#2: a big-prompt link TTFB MOVES — retry-same is direct-only', async () => {
  const remote = remotePool((pin, n) => (pin === 'reports@gomokka.com' && n === 1 ? 'hang' : 'sse'));
  const { port, cleanup } = await bootLink(remote);
  try {
    let status = 0;
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: bigBody(300_000),
      });
      status = r.status; await r.text();
    });
    assert.equal(status, 200);
    assert.deepEqual(remote.hits, ['reports@gomokka.com', 'personal'], `moved at once: ${remote.hits}`);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /\(link_ttfb\) on "reports@gomokka\.com ☁" — .* → moved$/);
  } finally { await cleanup(); }
});

test('#2 unit: the link knob has no per-byte companion', async () => {
  const { __serverTest } = await import('../src/server.js');
  assert.ok(!('LINK_TTFB_MS_PER_BYTE' in __serverTest.ttfbKnobs()), 'no link scaling knob exists');
});

test('P2: pre-headers keep-alive on the link path — the client survives a silent 12s wait', async () => {
  // Before P2 the link path had NO pre-headers keepalive: a streaming client sat
  // silent for the whole link wait. With streamForwardGraceMs=1s and a stub that
  // answers at 12s, the client must still be ALIVE (the keep-alive committed the SSE
  // stream) and receive the full answer.
  const remote = remotePool(() => ({ delay: 12_000, sse: true }));
  const { port, cleanup } = await bootLink(remote, { enabled: true, streamForwardGraceMs: 1000 });
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: bigBody(200_000, true),
    });
    const text = await r.text();
    assert.equal(r.status, 200);
    assert.ok(text.includes('event: ping'), 'the keep-alive committed the SSE stream pre-headers');
    assert.ok(text.includes('msg_link_ok'), 'the real answer followed the keep-alive');
  } finally { await cleanup(); }
});
