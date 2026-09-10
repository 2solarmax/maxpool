// A provider rejecting the request SHAPE (z.ai 1210) must route to Claude, not surface.
//
// Driver 2026-09-09: two `[1210][Invalid API parameter, please check the documentation.]`
// replies from z.ai reached a live session as a hard API error. A 4xx is non-retriable in
// maxpool, so it was terminal — even though nine Claude accounts sat idle and z.ai's
// message names no field, leaving the user nothing to act on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';

const { isProviderParamRejection, describeBodyShape } = __serverTest;

// The two real bodies, captured from the live log and from a direct probe of z.ai.
const GENERIC_1210 = '{"type":"error","error":{"type":"invalid_request_error","code":"1210","message":"[1210][Invalid API parameter, please check the documentation.][20260909190626ca91516b53ea4e5c]"}}';
const MAXTOK_1210  = '{"type":"error","error":{"type":"invalid_request_error","code":"1210","message":"[1210][The max_tokens parameter is illegal]"}}';

test('matches the z.ai parameter-rejection code family, in both message shapes', () => {
  assert.equal(isProviderParamRejection(GENERIC_1210), true);
  assert.equal(isProviderParamRejection(MAXTOK_1210), true);
  assert.equal(isProviderParamRejection('[1210][Invalid API parameter]'), true);
});

test('does NOT fire on errors that already name their field — those keep their own message', () => {
  // Anthropic 400s are self-describing; re-routing them would hide a real client fault.
  assert.equal(isProviderParamRejection('{"error":{"type":"invalid_request_error","message":"messages.4.content.0.thinking.signature: Field required"}}'), false);
  assert.equal(isProviderParamRejection('{"error":{"message":"max_tokens: must be <= 64000"}}'), false);
  // z.ai's OTHER codes are separate faults and must not be swept in by a loose regex.
  assert.equal(isProviderParamRejection('{"error":{"code":"1213","message":"[1213][The prompt parameter was not recorded]"}}'), false);
  assert.equal(isProviderParamRejection('{"error":{"code":"1113","message":"[1113][quota]"}}'), false);
  assert.equal(isProviderParamRejection('rate limit exceeded'), false);
  assert.equal(isProviderParamRejection(''), false);
  assert.equal(isProviderParamRejection(null), false);
});

test('a bare 1210 inside unrelated prose does not match by accident', () => {
  // The code must look like a code, not a number that happens to appear.
  assert.equal(isProviderParamRejection('processed 1210 tokens'), false);
  assert.equal(isProviderParamRejection('request_id 4412108'), false);
});

// ── the diagnostic that makes the NEXT one solvable ───────────────────────────

test('the shape log records the fields a 1210 could be about, and no content', () => {
  const secret = 'CONFIDENTIALPROMPTTEXT';
  const out = describeBodyShape(Buffer.from(JSON.stringify({
    model: 'glm-5.3', max_tokens: 64000, stream: true,
    system: [{ type: 'text', text: secret }],
    tools: [{ name: 't', description: secret }],
    messages: [{ role: 'user', content: [{ type: 'text', text: secret }] }],
  })));
  assert.ok(!out.includes(secret), `leaked transcript content: ${out}`);
  assert.match(out, /max_tokens=64000/);
  assert.match(out, /model=glm-5\.3/);
  assert.match(out, /tools=1/);
});
