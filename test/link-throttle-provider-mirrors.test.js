// A 'throttled' pin refusal means the cloud's ANTHROPIC egress is held (the cloud only
// refuses 'throttled' for account.type !== 'provider'). Cooling the link's GLM/Kimi
// provider mirrors too would black out GLM routing for up to 30 s even though the cloud
// would happily serve GLM. markLinkMirrorsCooldown must cool only Claude-egress rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function build() {
  const am = new AccountManager([
    { name: 'claude-a ☁', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'glm-a ☁', type: 'provider', provider: 'zai', authToken: 'k' },
    { name: 'glm-b ☁', type: 'provider', provider: 'zai', authToken: 'k2' },
  ], 0.9);
  for (const a of am.accounts) a.remote = { linkName: 'team' };
  return am;
}

test('a throttled link cooldown never touches provider (GLM/Kimi) mirror rows', () => {
  const am = build();
  const from = am.accounts[0];
  const cooled = am.markLinkMirrorsCooldown(from, 30_000);
  const cooledNames = cooled.map(a => a.name);
  assert.ok(cooledNames.includes('claude-a ☁'), 'the refusing Claude row is cooled');
  assert.ok(!cooledNames.includes('glm-a ☁'), 'a GLM provider mirror must NOT be cooled');
  assert.ok(!cooledNames.includes('glm-b ☁'), 'a GLM provider mirror must NOT be cooled');
  assert.equal(am.accounts[1].cooldownUntil || 0, 0, 'GLM row has no cooldown set');
  assert.equal(am.accounts[2].cooldownUntil || 0, 0, 'GLM row has no cooldown set');
});

test('the cooldown still covers every Claude mirror row of the link', () => {
  const am = build();
  am.addAccount({ name: 'claude-b ☁', type: 'oauth', configSourced: true, runtime: false });
  const claudeB = am.accounts.find(a => a.name === 'claude-b ☁');
  claudeB.remote = { linkName: 'team' };
  const cooled = am.markLinkMirrorsCooldown(am.accounts[0], 30_000);
  const cooledNames = cooled.map(a => a.name);
  assert.ok(cooledNames.includes('claude-a ☁') && cooledNames.includes('claude-b ☁'),
    'both Claude mirror rows of the link are cooled');
  assert.ok(!cooledNames.includes('glm-a ☁'));
});
