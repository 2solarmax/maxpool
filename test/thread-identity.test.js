// Thread identity (2026-11-17): judge a continue by the reply id it continues.
//
// Driver: 60 of 109 "No thread state" 404s were sibling agents inside ONE terminal —
// the per-terminal owner entry named one account while each sibling's thread lived on
// another. The reply's own message id is the exact thread key; the client sends it
// back as previous_message_id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadOwners, readThreadIntent } from '../src/thread-gate.js';

const B = (o) => Buffer.from(JSON.stringify(o));
const create = B({ model: 'm', thread: { type: 'create' }, messages: [] });
const contOf = (id) => B({ model: 'm', thread: { type: 'continue', previous_message_id: id }, messages: [] });

test('thread identity: readThreadIntent returns the previous_message_id', () => {
  assert.equal(readThreadIntent(contOf('msg_42')).previousMessageId, 'msg_42');
  assert.equal(readThreadIntent(B({ thread: { type: 'continue', previous_message_id: 'msg_1' } })).previousMessageId, 'msg_1');
  assert.equal(readThreadIntent(create).previousMessageId, undefined);
  // junk / missing id degrades to the legacy path
  assert.equal(readThreadIntent(B({ thread: { type: 'continue' } })).previousMessageId, null);
});

test('thread identity: the recorded holder passes, every other account is refused', () => {
  const o = new ThreadOwners();
  o.noteThreadId('msg_42', 'mk@gomokka');
  assert.equal(o.shouldRefuse('any-terminal', 'mk@gomokka', readThreadIntent(contOf('msg_42'))), false);
  assert.equal(o.shouldRefuse('any-terminal', 'max@dubner.io', readThreadIntent(contOf('msg_42'))), true);
  // a sibling agent in the SAME terminal, with its own thread on a different account
  assert.equal(o.shouldRefuse('any-terminal', 'partnerships', readThreadIntent(contOf('msg_42'))), true);
  o.noteThreadId('msg_43', 'partnerships');
  assert.equal(o.shouldRefuse('any-terminal', 'partnerships', readThreadIntent(contOf('msg_43'))), false);
  assert.equal(o.shouldRefuse('any-terminal', 'mk@gomokka', readThreadIntent(contOf('msg_43'))), true,
    'the terminal entry must not override the thread entry');
});

test('thread identity: an UNKNOWN id still refuses — safe direction, bounded per session', () => {
  const o = new ThreadOwners({ maxRefusals: 2 });
  assert.equal(o.shouldRefuse('s1', 'acct-a', readThreadIntent(contOf('never-seen'))), true);
  o.noteRefused('s1', 'acct-a');
  o.noteRefused('s1', 'acct-a');
  assert.equal(o.shouldRefuse('s1', 'acct-a', readThreadIntent(contOf('never-seen'))), false,
    'unknown thread falls to the bounded legacy path, not an infinite loop');
});

test('thread identity: a provider is still refused even when it "holds" the id', () => {
  const o = new ThreadOwners();
  o.noteThreadId('msg_9', 'glm max@gomokka.com');
  assert.equal(o.shouldRefuse('s1', 'glm max@gomokka.com', readThreadIntent(contOf('msg_9')), true), true,
    'a provider can never serve an Anthropic thread, even as the recorded holder');
});

test('thread identity: noteServed extends the thread onto whoever served the follow-up', () => {
  const o = new ThreadOwners();
  o.noteThreadId('msg_1', 'mk@gomokka');
  // a continue landed on a different Claude account; its reply msg_2 now belongs to that one
  o.noteServed('s1', 'max@dubner.io', readThreadIntent(contOf('msg_1')), 'msg_2');
  assert.equal(o.shouldRefuse('s1', 'max@dubner.io', readThreadIntent(contOf('msg_2'))), false);
  assert.equal(o.shouldRefuse('s1', 'mk@gomokka', readThreadIntent(contOf('msg_2'))), true);
});

test('thread identity: the thread map is bounded and LRU-evicts', () => {
  const o = new ThreadOwners({ maxThreads: 10 });
  for (let i = 0; i < 50; i++) o.noteThreadId(`msg_${i}`, 'acct');
  assert.equal(o.threadOwner('msg_49'), 'acct', 'newest retained');
  assert.equal(o.threadOwner('msg_0'), null, 'oldest evicted falls back to legacy');
});

test('thread identity: no id → noteThreadId is a no-op, nothing recorded', () => {
  const o = new ThreadOwners();
  o.noteThreadId('', 'acct');
  o.noteThreadId('msg_x', '');
  assert.equal(o.threadOwner('msg_x'), null);
  assert.equal(o.size, 0);
});

test('thread identity: the thread map has its own bound, far above the 500-session bound', () => {
  const o = new ThreadOwners();
  for (let i = 0; i < 5000; i++) o.noteThreadId(`msg_${i}`, 'acct');
  assert.equal(o.threadOwner('msg_0'), 'acct', '5,000 threaded turns must not evict the first');
  assert.equal(o.maxThreads, 20000);
});

test('thread identity: a continue refreshes its thread so a busy pool cannot evict it', () => {
  const o = new ThreadOwners({ maxThreads: 3 });
  o.noteThreadId('msg_live', 'one');
  o.noteThreadId('msg_x', 'one');
  o.noteThreadId('msg_y', 'one');
  o.shouldRefuse('s1', 'one', readThreadIntent(contOf('msg_live')));   // read bumps it
  o.noteThreadId('msg_z', 'one');                                       // evicts the oldest
  assert.equal(o.threadOwner('msg_live'), 'one', 'the just-read thread survives');
  assert.equal(o.threadOwner('msg_x'), null);
});

test('thread identity: a known NON-holder is refused under the per-session bound, then forwarded', () => {
  // Four sibling agents with threads on "A"; the terminal's account then moves to "B".
  // Refusing every one would downgrade every sibling to stateless for the session; past
  // the bound the real 404 lets the client replay with thread:create and keep threading.
  const o = new ThreadOwners({ maxRefusals: 2 });
  for (const id of ['x1', 'y1', 'z1', 'w1']) o.noteThreadId(id, 'A');
  const out = [];
  for (const id of ['x1', 'y1', 'z1', 'w1']) {
    const refuse = o.shouldRefuse('S', 'B', readThreadIntent(contOf(id)));
    if (refuse) o.noteRefused('S', 'B');
    out.push(refuse);
  }
  assert.deepEqual(out, [true, true, false, false]);
  // the holder itself still passes regardless of the streak
  assert.equal(o.shouldRefuse('S', 'A', readThreadIntent(contOf('x1'))), false);
});
