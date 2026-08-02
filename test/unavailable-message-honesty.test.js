import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';
const { unavailableMessage } = __serverTest;

const claude = n => Array.from({ length: n }, (_, i) => ({
  name: `a${i}`, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5,
}));
const withProviders = (policy) => new AccountManager(
  [...claude(8),
    { name: 'glm-fallback', type: 'provider', provider: 'zai', apiKey: 'z' },
    { name: 'kimi-fallback', type: 'provider', provider: 'kimi', apiKey: 'k' }],
  0.90, { crossProviderFallbackPolicy: policy },
);

test('a 2282-second wait is not described as "momentarily", and not printed in raw seconds', () => {
  // Reported verbatim: "are momentarily at their limit. Retry in 2282s." That is 38
  // MINUTES — not momentary, and unreadable as a bare number while every other branch
  // in this same function already formats durations in human units.
  const m = unavailableMessage(withProviders('always'), {}, 2282, true);
  assert.doesNotMatch(m, /momentarily/, '38 minutes is not momentary');
  assert.doesNotMatch(m, /2282s/, 'raw seconds are unreadable');
  assert.match(m, /~38m/, 'rendered in human units');
});

test('a genuinely short wait keeps the softer wording', () => {
  const m = unavailableMessage(withProviders('always'), {}, 5, true);
  assert.match(m, /momentarily at their limit/);
  assert.match(m, /~5s/);
});

test('providers BARRED by policy are never described as "at their limit"', () => {
  // With crossProviderFallbackPolicy 'never' (the default) GLM/Kimi cannot serve a Claude
  // session at all. Claiming they are saturated is false AND hides the one-keypress fix.
  const m = unavailableMessage(withProviders('never'), {}, 30, true);
  assert.doesNotMatch(m, /and the GLM\/Kimi providers/, 'must not claim barred providers are saturated');
  assert.match(m, /switched off for Claude sessions/, 'says they are off');
  assert.match(m, /m then g/, 'names the actual fix');
});

test('providers that CAN serve are still named as saturated', () => {
  const m = unavailableMessage(withProviders('always'), {}, 30, true);
  assert.match(m, /and the GLM\/Kimi providers/);
  assert.doesNotMatch(m, /switched off/);
});

test('a Claude-only pool never mentions providers at all', () => {
  const m = unavailableMessage(new AccountManager(claude(8), 0.90), {}, 30, true);
  assert.doesNotMatch(m, /GLM|Kimi/);
});

test('the long-wait branch also carries the barred-provider hint', () => {
  const m = unavailableMessage(withProviders('never'), {}, 45000, false);
  assert.match(m, /at their limit/);
  assert.match(m, /switched off for Claude sessions/);
});
