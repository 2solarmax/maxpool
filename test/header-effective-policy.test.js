import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function headerFor(policy, per = {}) {
  const am = new AccountManager(
    [{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 }],
    0.90, { crossProviderFallbackPolicy: policy, providers: per },
  );
  am.addAccount({ name: 'glm-fallback', type: 'provider', provider: 'zai', apiKey: 'z' });
  am.addAccount({ name: 'kimi-fallback', type: 'provider', provider: 'kimi', apiKey: 'k' });
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } }, saveConfig: async () => {} });
  // Assert what the user actually SEES, via the real render helper — not a source match.
  return { am, line: strip(tui._routingLine('Automatic load balancing', tui._crossProviderText())) };
}

test('the header shows the EFFECTIVE per-provider policy, not the legacy global', () => {
  // Reported 2026-08-05: the footer read "GLM: always / Kimi: always" while the header read
  // "when-exhausted". Routing follows the per-provider value, so the header described a knob
  // that governs nothing — contradicting both the footer and actual behaviour.
  const { am, line } = headerFor('when-exhausted', {
    zai: { claudeFallback: 'always' }, kimi: { claudeFallback: 'always' },
  });
  assert.equal(am._claudeFallbackFor('zai'), 'always', 'routing sees always');
  assert.notEqual(am._crossProviderFallbackPolicy(), 'always', 'the legacy global disagrees');
  assert.match(line, /Cross-provider:\s*always/, `header must follow routing, got: ${line}`);
  assert.doesNotMatch(line, /when-exhausted/, 'must not show the superseded global');
});

test('providers that DISAGREE are named separately, never collapsed to one word', () => {
  const { line } = headerFor('never', {
    zai: { claudeFallback: 'always' }, kimi: { claudeFallback: 'never' },
  });
  assert.match(line, /GLM:\s*always/, `got: ${line}`);
  assert.match(line, /Kimi:\s*never/, `got: ${line}`);
});

test('an unset provider still inherits the global — no behaviour change', () => {
  const { am, line } = headerFor('when-exhausted', {});
  assert.equal(am._claudeFallbackFor('zai'), 'when-exhausted');
  assert.match(line, /Cross-provider:\s*when-exhausted/, `got: ${line}`);
});
