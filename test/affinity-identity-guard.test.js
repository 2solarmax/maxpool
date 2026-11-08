// Guard against conversation identity silently breaking (owner 2026-11-08: "make sure
// this cannot degrade silently ... self-healing"). Twice in one day a Claude Code
// request-shape detail made every turn hash to a new id and cache affinity went inert
// with every test green. Three layers pinned here:
//   1. CONTRACT: the hash is stable on the real request shape (moving cache_control +
//      per-request billing header), and still separates different conversations.
//   2. DETECTOR: a burst of ~all-new ids flips identity health to 'degraded'; healthy
//      reuse recovers it (hysteresis), one log line per transition.
//   3. SELF-HEAL: while degraded, affinity keys on the terminal, so stickiness keeps
//      working instead of switching off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';

const CC = "You are Claude Code, Anthropic's official CLI for Claude.";
const req = { method: 'POST', url: '/v1/messages' };
// The real Claude Code shape captured from live traffic on 2026-11-08 (content
// replaced, structure kept): system[0] = billing header with per-request cch +
// cc_prev_req; cache_control on the newest message only.
const realTurn = (turn, cch, prev) => Buffer.from(JSON.stringify({
  model: 'claude-opus-5-5',
  system: [
    { type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.314.3e7; cc_entrypoint=cli; cch=${cch}; cc_is_subagent=false; cc_prev_req=${prev}; cc_prompt_id=76a20dda-dd70-49fc;` },
    { type: 'text', text: CC, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'environment + memory (static per session)', cache_control: { type: 'ephemeral' } },
  ],
  messages: turn === 1
    ? [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'text', text: 'build X', cache_control: { type: 'ephemeral' } }] }]
    : [
        { role: 'user', content: [{ type: 'text', text: '<system-reminder>ctx</system-reminder>' }, { type: 'text', text: 'build X' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
        { role: 'user', content: [{ type: 'text', text: `turn ${turn}`, cache_control: { type: 'ephemeral' } }] },
      ],
}));

test('CONTRACT: real request shape → one stable id per conversation across turns', () => {
  const ids = [
    __serverTest.describeRequest(req, realTurn(1, 'e0527', 'req_A')).conversationHash,
    __serverTest.describeRequest(req, realTurn(2, '39f9e', 'req_B')).conversationHash,
    __serverTest.describeRequest(req, realTurn(3, '7a1c2', 'req_C')).conversationHash,
  ];
  assert.ok(ids[0]);
  assert.equal(new Set(ids).size, 1, `stable across turns: ${ids.join(' ')}`);
  const other = JSON.parse(realTurn(2, '39f9e', 'req_B'));
  other.messages[0].content[1].text = 'a DIFFERENT task';
  assert.notEqual(__serverTest.describeRequest(req, Buffer.from(JSON.stringify(other))).conversationHash, ids[0]);
});

const mgr = () => new AccountManager([
  { name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: 'U1', upstream: 'http://127.0.0.1:1' },
  { name: 'a2', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: 'U2', upstream: 'http://127.0.0.1:1' },
], 0.9, { routingMode: 'balance' });

function feed(m, { sessions, perSession, freshEvery }) {
  const now = Date.now();
  let i = 0;
  for (let s = 0; s < sessions; s++) {
    for (let r = 0; r < perSession; r++) {
      const conv = freshEvery === 1 ? `c${s}-${r}` : `c${s}-${Math.floor(r / freshEvery)}`;
      m._noteIdentityHealth({ sessionKey: `term-${s}`, conversationHash: conv }, now + (i++));
    }
  }
}

test('DETECTOR: every request a new id → degraded, with one log line', () => {
  const m = mgr();
  const logs = []; const orig = console.log; console.log = l => logs.push(String(l));
  try { feed(m, { sessions: 8, perSession: 12, freshEvery: 1 }); } finally { console.log = orig; }
  assert.equal(m.identityHealth.degraded, true);
  assert.equal(m.getStatus().affinityIdentity.state, 'degraded');
  assert.equal(logs.filter(l => l.includes('conversation identity looks BROKEN')).length, 1, 'exactly one transition line');
});

test('DETECTOR: healthy reuse stays ok; too-small samples never judge', () => {
  const m = mgr();
  feed(m, { sessions: 8, perSession: 12, freshEvery: 4 }); // 25% new — like real traffic
  assert.equal(m.identityHealth.degraded, false);
  const tiny = mgr();
  feed(tiny, { sessions: 3, perSession: 5, freshEvery: 1 }); // below per-session/total minimums
  assert.equal(tiny.identityHealth.degraded, false, 'no verdict on thin data');
});

test('DETECTOR: recovers once identity is healthy again (hysteresis)', () => {
  const m = mgr();
  feed(m, { sessions: 8, perSession: 12, freshEvery: 1 });
  assert.equal(m.identityHealth.degraded, true);
  m.identityHealth.samples = []; // a fresh window of healthy traffic
  const logs = []; const orig = console.log; console.log = l => logs.push(String(l));
  try { feed(m, { sessions: 8, perSession: 12, freshEvery: 6 }); } finally { console.log = orig; }
  assert.equal(m.identityHealth.degraded, false);
  assert.ok(logs.some(l => l.includes('identity healthy again')));
});

test('SELF-HEAL: degraded → affinity keys on the terminal, so stickiness keeps working', () => {
  const m = mgr();
  const broken = { sessionKey: 'term-x', affinityKey: 'term-x:new-every-time' };
  assert.equal(m._affinityKey(broken), 'term-x:new-every-time', 'healthy: per-conversation key');
  m.identityHealth.degraded = true;
  assert.equal(m._affinityKey(broken), 'term-x', 'degraded: per-terminal key');
  // and the terminal-level key really holds a turn on its account
  const l1 = m.acquireAccount({ sessionKey: 'term-x', affinityKey: 'term-x:id1', model: 'claude-opus-5-5', weight: 10 });
  m.releaseAccount(l1, { status: 200, success: true });
  const l2 = m.acquireAccount({ sessionKey: 'term-x', affinityKey: 'term-x:id2', model: 'claude-opus-5-5', weight: 10 });
  assert.equal(l2.account.name, l1.account.name, 'different (broken) ids, same terminal → same account');
  m.releaseAccount(l2, { status: 200, success: true });
});

test('WIRING: the detector runs on real request handling (acquireAccount), not only when called directly', () => {
  const m = mgr();
  const quiet = console.log; console.log = () => {};
  try {
    for (let s = 0; s < 8; s++) for (let r = 0; r < 12; r++) {
      const l = m.acquireAccount({ sessionKey: `t${s}`, conversationHash: `fresh-${s}-${r}`, affinityKey: `t${s}:fresh-${s}-${r}`, model: 'claude-opus-5-5', weight: 10 });
      m.releaseAccount(l, { status: 200, success: true });
    }
  } finally { console.log = quiet; }
  assert.equal(m.identityHealth.degraded, true, 'broken identity seen through acquireAccount flips health');
});

test('MIN SAMPLE: a few busy terminals that are all-new but below the total sample never judge', () => {
  const m = mgr();
  feed(m, { sessions: 2, perSession: 10, freshEvery: 1 }); // 20 requests: per-session ok, total < 60
  assert.equal(m.identityHealth.degraded, false);
});
