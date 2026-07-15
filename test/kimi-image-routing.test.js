import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';

const { describeRequest } = __serverTest;
const body = obj => Buffer.from(JSON.stringify(obj));
const req = { method: 'POST', url: '/v1/messages?beta=true' };
const IMG = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0=' } };

function fleet() {
  // 'all' profile so providers are eligible; default cross-provider policy = when-exhausted.
  return new AccountManager([
    { name: 'oauth1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://api.z.ai/api/anthropic' },
    { name: 'kimi', type: 'provider', provider: 'kimi', authToken: 'k', upstream: 'https://api.kimi.com/coding' },
  ], 0.90);
}

// ── describeRequest: detect images at ANY nesting depth ───────────────────────

test('describeRequest.hasImage — top-level image block', () => {
  const info = describeRequest(req, body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, IMG] }] }));
  assert.equal(info.hasImage, true);
});

test('describeRequest.hasImage — image NESTED in a tool_result (the Playwright/browser screenshot path)', () => {
  const info = describeRequest(req, body({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'screenshot:' }, IMG] }] }],
  }));
  assert.equal(info.hasImage, true, 'must recurse into tool_result.content — a shallow scan would miss this (the dominant CC image path)');
});

test('describeRequest — a text-only body sets no hasImage', () => {
  assert.equal(describeRequest(req, body({ messages: [{ role: 'user', content: 'plain text' }] })).hasImage, undefined);
  assert.equal(describeRequest(req, body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })).hasImage, undefined);
});

// ── the routing invariant: an image request NEVER matches Kimi ────────────────

test('an image request is incompatible with Kimi but eligible on GLM + OAuth', () => {
  const m = fleet();
  const [oauth, glm, kimi] = m.accounts;
  const imgReq = { profile: 'all', hasImage: true };

  assert.equal(m._isRequestCompatible(kimi, 'all', imgReq), false, 'Kimi excluded for images (Moonshot 400s on them)');
  assert.equal(m._isRequestCompatible(glm, 'all', imgReq), true, 'GLM handles images — still eligible');
  assert.equal(m._isRequestCompatible(oauth, 'all', imgReq), true, 'OAuth still eligible');
  // The higher-level matcher every selection path funnels through must agree.
  assert.equal(m._matchesRequest(kimi, 'all', imgReq), false, '_matchesRequest (the chokepoint) also excludes Kimi');
  assert.equal(m._matchesRequest(glm, 'all', imgReq), true);
});

test('a NON-image request is still eligible on Kimi (fix is scoped to images)', () => {
  const m = fleet();
  const kimi = m.accounts[2];
  assert.equal(m._isRequestCompatible(kimi, 'all', { profile: 'all' }), true);
  assert.equal(m._matchesRequest(kimi, 'all', { profile: 'all' }), true);
});

test('even an anthropic-incompatible (provider-pinned) image session skips Kimi, keeping GLM', () => {
  // A foreign transcript pins to providers only; with an image it must still avoid Kimi.
  const m = fleet();
  const [, glm, kimi] = m.accounts;
  const imgReq = { profile: 'all', hasImage: true, anthropicIncompatible: true };
  assert.equal(m._isRequestCompatible(kimi, 'all', imgReq), false, 'provider-pinned + image → not Kimi');
  assert.equal(m._isRequestCompatible(glm, 'all', imgReq), true, '→ GLM (the recoverable provider for images)');
});
