// LAST-ROUTE ACROSS A POOL LINK (2026-11-26): Claude Code's status line asks the pool
// that answered it which model served a reply (GET /maxpool/last-route?messageId=<id>).
// A laptop pool forwards a turn to a linked pool, which serves it on a z.ai row and
// normalizes the model echo back to the client's requested Claude name. The forwarding
// pool relayed the bytes but never recorded the route, so every link-served GLM turn
// answered 404 and the status line showed the requested Claude name ("Opus 5.5").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';
import { listen, close, postTurn } from './link-fixture.js';

const START = id => `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id, model: 'glm-5.4', usage: { input_tokens: 10, output_tokens: 1 } } })}\n\n`;
const STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const sse = (id) => START(id) + STOP;
const nonStream = id => JSON.stringify({ id, type: 'message', model: 'glm-5.4', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 1 } });

/** laptop proxy → linked pool → z.ai stub. The linked pool is a real maxpool proxy with one
 *  z.ai provider row (modelMap opus → glm-5.4), the same shape as the cloud pool. */
async function rig(t, { local = false, stream = true } = {}) {
  let served = 0;
  const ids = [];
  const zai = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      served++;
      const id = 'msg_20261126fixture' + served;
      ids.push(id);
      res.writeHead(200, { 'content-type': stream ? 'text/event-stream' : 'application/json' });
      res.end(stream ? sse(id) : nonStream(id));
    });
  });
  const zaiPort = await listen(zai);
  const glmRow = () => ({ name: 'glm row', type: 'provider', provider: 'zai', authToken: 'z', upstream: `http://127.0.0.1:${zaiPort}`,
    authHeader: 'authorization', profiles: ['all'], priority: 0, modelMap: { opus: 'glm-5.4', sonnet: 'glm-5.4', haiku: 'glm-5.3-flash', default: 'glm-5.4' }, stripBetaHeaders: true });
  const cloudAm = new AccountManager([glmRow()], 0.9, { crossProviderFallbackPolicy: 'when-exhausted' });
  // The link authenticates with the linked pool's key, exactly as the laptop does.
  const cloud = createProxyServer(cloudAm, { proxy: { apiKey: 'mp-max' }, queue: { enabled: false } });
  const cloudPort = await listen(cloud);
  // local: the row lives on THIS pool and no link exists (a linked twin would be benched
  // by the duplicate guard). Otherwise this pool has no rows of its own, only the link.
  const link = local ? null : new PoolLink({ name: 'team', url: `http://127.0.0.1:${cloudPort}`, key: 'mp-max' });
  if (link) await link.poll();
  // The laptop's setting: once the Claude rows have no room, a Claude-named turn may
  // be served by GLM (a fresh AccountManager ships with that fallback off).
  const am = new AccountManager(local ? [glmRow()] : [], 0.9, { crossProviderFallbackPolicy: 'when-exhausted' });
  if (link) { am.setPoolLinks([link]); link.stop(); }
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1', queue: { enabled: false } });
  const port = await listen(proxy);
  t.after(async () => { am.setPoolLinks([]); await close(proxy); await close(cloud); await close(zai); });
  return { am, port, ids, served: () => served };
}

const route = async (port, id) => fetch(`http://127.0.0.1:${port}/maxpool/last-route?messageId=${encodeURIComponent(id)}`, { headers: { 'x-api-key': 'tc-test' } });
const turn = (port, stream, session) => postTurn(port, JSON.stringify({ model: 'claude-opus-5-5', stream, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }), { session, headers: { 'x-maxpool-profile': 'all' } });

test('a GLM turn forwarded to a linked pool is remembered with the real model, and the client still sees its requested name', { timeout: 20_000 }, async t => {
  const r = await rig(t);
  const res = await turn(r.port, true, 'link-stream');
  assert.equal(res.status, 200);
  assert.match(res.text, /"model":"claude-opus-5-5"/, 'the model echo stays normalized for the client');
  assert.equal(r.served(), 1);
  const got = await (await route(r.port, r.ids[0])).json();
  assert.deepEqual(got, { provider: 'zai', model: 'glm-5.4' });
});

test('a non-streaming GLM turn forwarded to a linked pool is remembered too', { timeout: 20_000 }, async t => {
  const r = await rig(t, { stream: false });
  const res = await turn(r.port, false, 'link-json');
  assert.equal(res.status, 200);
  assert.match(res.text, /"model":"claude-opus-5-5"/);
  const got = await (await route(r.port, r.ids[0])).json();
  assert.deepEqual(got, { provider: 'zai', model: 'glm-5.4' });
});

test('a GLM turn served by a LOCAL provider row is remembered (scope check: the defect is the link path only)', { timeout: 20_000 }, async t => {
  const r = await rig(t, { local: true });
  const res = await turn(r.port, true, 'local-stream');
  assert.equal(res.status, 200);
  assert.ok(r.am.accounts.some(a => !a.remote), 'a local row exists');
  const got = await (await route(r.port, r.ids[0])).json();
  assert.deepEqual(got, { provider: 'zai', model: 'glm-5.4' });
});
