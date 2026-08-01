import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';

const SRC = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

test('the IPv6 race timeout is raised at startup, before any request', () => {
  // 2026-08-01: this machine's resolver returns an AAAA for api.anthropic.com that
  // BLACKHOLES (curl -6 exits 7) — a VPN advertising IPv6 it cannot carry. Node races that
  // leg 250ms into every connect and lets it kill the whole attempt, producing
  // UND_ERR_CONNECT_TIMEOUT / ETIMEDOUT on a healthy network: 6,848 failures in one day.
  assert.match(SRC, /net\.setDefaultAutoSelectFamilyAttemptTimeout\(/, 'the race timeout is set');
  const m = /setDefaultAutoSelectFamilyAttemptTimeout\(\s*Math\.max\(1000, Number\(process\.env\.MAXPOOL_FAMILY_ATTEMPT_TIMEOUT_MS\) \|\| (\d+)\)/.exec(SRC);
  assert.ok(m, 'env-overridable with a floor');
  assert.ok(Number(m[1]) >= 3000, `must exceed a real IPv4 connect on a VPN (0.6-2.8s measured); got ${m[1]}`);
});

test('it runs BEFORE the proxy server is constructed', () => {
  const setAt = SRC.indexOf('setDefaultAutoSelectFamilyAttemptTimeout');
  const useAt = SRC.indexOf('createProxyServer(');
  assert.ok(setAt > 0 && useAt > setAt, 'a per-connection default set after the first connect would be useless');
});

test("we did NOT ship ipv4first — measured unreliable, it still starts the doomed leg", () => {
  // Strip comments first: the rationale comment NAMES ipv4first, and matching prose
  // instead of code is exactly the false signal this suite exists to avoid.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .filter(l => !l.trim().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /setDefaultResultOrder\(\s*['"]ipv4first/,
    'ipv4first reorders preference but still races the blackholed address (6 of 14 in a degraded window)');
  assert.match(SRC, /ipv4first/, 'and the rejected option stays documented so it is not retried');
});

test('the runtime actually accepts the call (guards a Node API change)', () => {
  assert.equal(typeof net.setDefaultAutoSelectFamilyAttemptTimeout, 'function');
  const prev = net.getDefaultAutoSelectFamilyAttemptTimeout?.();
  net.setDefaultAutoSelectFamilyAttemptTimeout(5000);
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout(), 5000);
  if (typeof prev === 'number') net.setDefaultAutoSelectFamilyAttemptTimeout(prev);
});
