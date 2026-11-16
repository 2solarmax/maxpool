// Per-request cache figures (`cache r180k w3k in1k[ MISS]`), ported from upstream
// 62ff3a5 (#642) with one change: a big prompt that neither read nor wrote the cache is
// a MISS, not 'none' — z.ai never reports cache writes, so a cold GLM turn looked clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheUsageLabel, cacheUsageState } from '../src/usage-label.js';

test('the label rounds to k and reads a missing figure as 0', () => {
  assert.equal(cacheUsageLabel({ cache_read_input_tokens: 180_400, cache_creation_input_tokens: 2_600, input_tokens: 1_200 }), 'cache r180k w3k in1k');
  assert.equal(cacheUsageLabel({ input_tokens: 7, output_tokens: 3 }), 'cache r0 w0 in7');
  assert.equal(cacheUsageLabel({ cache_read_input_tokens: 'x', input_tokens: -4 }), 'cache r0 w0 in0');
});

test('no usage, no label', () => {
  assert.equal(cacheUsageLabel(null), '');
  assert.equal(cacheUsageLabel(undefined), '');
  assert.equal(cacheUsageLabel({}), '');
});

test('the state follows the share read from the cache, and a miss says MISS', () => {
  assert.equal(cacheUsageState({ cache_read_input_tokens: 90, cache_creation_input_tokens: 5, input_tokens: 5 }), 'hit');
  assert.equal(cacheUsageState({ cache_read_input_tokens: 89, cache_creation_input_tokens: 6, input_tokens: 5 }), 'partial');
  assert.equal(cacheUsageState({ cache_read_input_tokens: 50, cache_creation_input_tokens: 50, input_tokens: 0 }), 'partial');
  assert.equal(cacheUsageState({ cache_read_input_tokens: 49, cache_creation_input_tokens: 51, input_tokens: 0 }), 'miss');
  assert.equal(cacheUsageState({ input_tokens: 100 }), 'none', 'a small uncached request is not a miss');
  assert.equal(cacheUsageLabel({ cache_read_input_tokens: 0, cache_creation_input_tokens: 180_000, input_tokens: 1_000 }), 'cache r0 w180k in1k MISS');
  assert.doesNotMatch(cacheUsageLabel({ input_tokens: 100 }), /MISS/);
});

test('a big prompt that neither read nor wrote the cache (cold GLM turn) is a MISS', () => {
  assert.equal(cacheUsageState({ cache_read_input_tokens: 0, input_tokens: 2000 }), 'miss');
  assert.equal(cacheUsageState({ input_tokens: 48_000 }), 'miss');
  assert.equal(cacheUsageLabel({ input_tokens: 48_000, output_tokens: 10 }), 'cache r0 w0 in48k MISS');
  assert.equal(cacheUsageState({ input_tokens: 1999 }), 'none', 'below the floor stays none');
});
