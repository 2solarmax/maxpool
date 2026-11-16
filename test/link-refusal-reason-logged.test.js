// A refusal relayed from the linked (cloud) pool must leave its REASON in this pool's log.
// 2026-11-16: 13 requests on the Mac came back 400/404 within a fraction of a second, all on
// cloud (☁) rows. The direct path logs `[Maxpool] 400 from "<acct>": <message>`, but the link
// path relayed the body verbatim and wrote nothing — the cause was unknowable from the Mac.
// The client must still receive the cloud's answer byte-for-byte (status, body).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, captureLog, postTurn } from './link-fixture.js';

const BODY = JSON.stringify({ model: 'claude-opus-5-5', stream: false, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] });

for (const [status, message] of [
  [400, 'messages.3.content.0: unexpected tool_use_id found in tool_result blocks'],
  [404, 'model: not_a_real_model'],
]) {
  test(`a ${status} relayed from the cloud pool is logged with its reason and reaches the client unchanged`, async () => {
    const errorBody = { type: 'error', error: { type: status === 404 ? 'not_found_error' : 'invalid_request_error', message } };
    const remote = remotePool(() => ({ status, body: errorBody }));
    const { port, cleanup } = await bootLink(remote);
    try {
      let res;
      const lines = await captureLog(async () => { res = await postTurn(port, BODY); });
      assert.equal(res.status, status, 'the client gets the cloud status');
      assert.deepEqual(JSON.parse(res.text), errorBody, 'the client gets the cloud body unchanged');
      const reason = lines.find(l => l.startsWith(`[Maxpool] ${status} from "`) && l.includes(message));
      assert.ok(reason, `the reason is in the log: ${JSON.stringify(lines.slice(-6))}`);
      assert.match(reason, /☁/, 'it names the cloud row that refused');
    } finally {
      await cleanup();
    }
  });
}

test('a successful cloud answer logs no refusal line', async () => {
  const remote = remotePool(() => 'ok');
  const { port, cleanup } = await bootLink(remote);
  try {
    let res;
    const lines = await captureLog(async () => { res = await postTurn(port, BODY); });
    assert.equal(res.status, 200);
    assert.equal(lines.filter(l => /^\[Maxpool\] \d{3} from "/.test(l)).length, 0, 'no refusal line on a 200');
  } finally {
    await cleanup();
  }
});
