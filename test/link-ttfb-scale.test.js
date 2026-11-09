// D2 on the LINK path: size-scaled first-byte wait (T4) + clamp (T5) + grace keep-alive.
// Per-byte is set so 300KB ⇒ 18s (floor 15s) and 800KB ⇒ 48s (clamped at a 20s ceiling).
process.env.MAXPOOL_LINK_TTFB_MS = '15000';
process.env.MAXPOOL_LINK_TTFB_MS_PER_BYTE = String(18_000 / 300_000);

import { test } from 'node:test';
import assert from 'node:assert/strict';
// Dynamic import: a static one is hoisted ABOVE the env lines, so server.js would read
// its module constants before the knobs are set (the first version of this file did).
const { remotePool, bootLink, bigBody, captureLog, attempts } = await import('./link-fixture.js');

test('T4 wiring: a 300KB streaming turn waits the scaled 18s on the link, not the 15s floor', async () => {
  // Answers at 17s: past the floor, inside the scaled wait (and inside the 20s clamp).
  // A link timer still on the flat 15s floor aborts and retries — two hits, not one.
  const remote = remotePool(() => ({ delay: 17_000, sse: true }));
  const { port, cleanup } = await bootLink(remote, { enabled: true, streamForwardGraceMs: 1000, streamClientToleranceMs: 20_000 });
  try {
    let status = 0, text = '';
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: bigBody(300_000, true),
      });
      status = r.status; text = await r.text();
    });
    assert.equal(status, 200);
    assert.ok(text.includes('msg_link_ok'), `the slow answer reached the client:\n${text.slice(0, 200)}`);
    assert.equal(remote.hits.length, 1, `one attempt; attempts:\n${attempts(lines).join('\n')}`);
    assert.ok(lines.some(l => /first-byte wait 18s for 300KB prompt on ".*" \(link; floor 15s\)$/.test(l)),
      `the scaled wait was logged:\n${lines.join('\n')}`);
  } finally { await cleanup(); }
});

test('T4 unit: link knob resolves independently, floor 15s, 0 disables, clamp binds', async () => {
  const { __serverTest } = await import('../src/server.js');
  const { scaledTtfbMs, clientWaitCeilingMs } = __serverTest;
  const cc = clientWaitCeilingMs({ stream: true }, { streamClientToleranceMs: 20_000 });
  assert.equal(scaledTtfbMs(15_000, 18_000 / 300_000, 300_000, cc), 18_000);
  assert.equal(scaledTtfbMs(15_000, 18_000 / 300_000, 800_000, cc), 20_000, '48s clamps at 20s');
  assert.equal(scaledTtfbMs(15_000, 18_000 / 300_000, 800_000, null), 15_000, 'non-stream: flat floor');
  assert.equal(scaledTtfbMs(15_000, 0, 800_000, cc), 15_000, 'per-byte 0 disables scaling');
  const { ttfbKnobs } = __serverTest;
  const knobs = ttfbKnobs();
  assert.equal(knobs.LINK_TTFB_MS_PER_BYTE, 18_000 / 300_000, 'env override honored (link)');
});

test('P2: pre-headers keep-alive on the link path — the client survives a silent 12s wait', async () => {
  // Before D2/P2 the link path had NO pre-headers keepalive: a streaming client sat
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
