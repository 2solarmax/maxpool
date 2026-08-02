import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SERVER = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
const AM = readFileSync(new URL('../src/account-manager.js', import.meta.url), 'utf8');

test('the Kimi fallback model default is current', () => {
  // It read 'kimi-k2.7' while the fleet had moved to k3. Only a bare/older client hits
  // this path (cc all sends x-maxpool-kimi-model from the llm_config SSOT), but a stale
  // default silently downgrades exactly the clients least able to notice.
  const m = /headerValue\(headers, 'x-maxpool-kimi-model'\) \|\| '([^']+)'/.exec(SERVER);
  assert.ok(m, 'the kimi default is where the test expects it');
  assert.doesNotMatch(m[1], /k2/, `stale Kimi default: ${m[1]}`);
});

test('the GLM fallback model defaults are current', () => {
  const opus = /'x-maxpool-zai-opus-model'\)[^|]*\|\|[^|]*\|\| '([^']+)'/.exec(SERVER);
  assert.ok(opus, 'the zai opus default is where the test expects it');
  assert.doesNotMatch(opus[1], /glm-4/, `stale GLM default: ${opus[1]}`);
});

test('the large-context pin stays REACTIVE, never a hardcoded provider ceiling', () => {
  // Verified 2026-08-02: GLM 5.2 and Kimi K3 both accepted a ~400K-token payload. A
  // hardcoded ~256K assumption would now bench providers that can serve — costing exactly
  // the capacity this fallback exists to provide. Learning the limit from a real rejection
  // self-corrects as providers grow.
  assert.match(AM, /_isSessionLargeContext\(requestInfo\)/, 'the pin is keyed on an observed rejection');
  const fn = /_isSessionLargeContext\(requestInfo = \{\}\) \{[\s\S]*?\n  \}/.exec(AM)[0];
  assert.doesNotMatch(fn, /256|262144|1_000_000/, 'no hardcoded context ceiling in the predicate');
});
