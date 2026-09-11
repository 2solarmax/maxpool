// The thread gate: hand the client the signal it already knows, never rebuild a transcript.
//
// Driver 2026-09-10. Claude Code >= 2.1.265 leaves the conversation on Anthropic's
// servers and sends only the tail plus a thread reference — removing the self-containment
// maxpool's routing rests on. Measured: 10 of 12 live requests carry it; a non-owner
// Anthropic account 404s and GLM rejects the truncated transcript with [1214].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThreadOwners, readThreadIntent, threadRefusalBody, THREAD_UNSUPPORTED_CODE }
  from '../src/thread-gate.js';

const B = (o) => Buffer.from(JSON.stringify(o));
const cont = B({ model: 'm', thread: { type: 'continue', previous_message_id: 'msg_1' }, messages: [] });
const create = B({ model: 'm', thread: { type: 'create' }, messages: [] });
const plain = B({ model: 'm', messages: [] });

test('the refusal body is byte-shaped for the CLIENT\'s classifier', () => {
  // The client reads e.error.details.error_code; anything else and it shows a hard error
  // to the user instead of resending stateless. This is PRE-MORTEM #1.
  const b = threadRefusalBody('glm max@gomokka.com');
  assert.equal(b.error.details.error_code, THREAD_UNSUPPORTED_CODE);
  assert.equal(THREAD_UNSUPPORTED_CODE, 'thread_unsupported_request');
  assert.equal(b.type, 'error');
  assert.equal(b.error.type, 'invalid_request_error');
  assert.ok(JSON.parse(JSON.stringify(b)).error.details.error_code, 'survives serialization');
});

test('reads the three thread intents, and shrugs at junk', () => {
  assert.equal(readThreadIntent(cont).kind, 'continue');
  assert.equal(readThreadIntent(create).kind, 'create');
  assert.equal(readThreadIntent(plain).kind, 'none');
  assert.equal(readThreadIntent(Buffer.from('not json')).kind, 'none');
  assert.equal(readThreadIntent(B({ thread: 'nonsense' })).kind, 'none');
  // previous_message_id alone, in diagnostics, is not a thread continuation
  assert.equal(readThreadIntent(B({ diagnostics: { previous_message_id: 'x' } })).kind, 'none');
});

test('a continue routed to a NON-owner is refused', () => {
  const o = new ThreadOwners();
  o.noteServed('s1', 'max@gomokka.com', readThreadIntent(create));
  assert.equal(o.shouldRefuse('s1', 'glm glm1@gomokka.com', readThreadIntent(cont)), true);
  assert.equal(o.shouldRefuse('s1', 'mk@dubner.io', readThreadIntent(cont)), true);
});

test('a continue routed to the OWNER is forwarded — the saving is taken', () => {
  const o = new ThreadOwners();
  o.noteServed('s1', 'max@gomokka.com', readThreadIntent(create));
  assert.equal(o.shouldRefuse('s1', 'max@gomokka.com', readThreadIntent(cont)), false);
});

test('a CREATE is never refused — it carries the full transcript', () => {
  const o = new ThreadOwners();
  o.noteServed('s1', 'max@gomokka.com', readThreadIntent(create));
  for (const a of ['glm glm1@gomokka.com', 'kimi max@gomokka.com', 'anyone']) {
    assert.equal(o.shouldRefuse('s1', a, readThreadIntent(create)), false, a);
  }
});

test('a request with no thread is never refused — the existing path is untouched', () => {
  const o = new ThreadOwners();
  assert.equal(o.shouldRefuse('s1', 'anyone', readThreadIntent(plain)), false);
});

test('refusals are bounded — a client that does not downgrade is not looped forever', () => {
  // PRE-MORTEM #2: refusing every turn would double request volume and read as a hang.
  const o = new ThreadOwners({ maxRefusals: 2 });
  const i = readThreadIntent(cont);
  o.noteServed('s1', 'owner', readThreadIntent(create));
  assert.equal(o.shouldRefuse('s1', 'other', i), true);  o.noteRefused('s1');
  assert.equal(o.shouldRefuse('s1', 'other', i), true);  o.noteRefused('s1');
  assert.equal(o.shouldRefuse('s1', 'other', i), false, 'bounded fail-open after the cap');
});

test('serving resets the refusal streak', () => {
  const o = new ThreadOwners({ maxRefusals: 2 });
  const i = readThreadIntent(cont);
  o.noteServed('s1', 'owner', readThreadIntent(create));
  o.noteRefused('s1'); o.noteRefused('s1');
  assert.equal(o.shouldRefuse('s1', 'other', i), false);
  o.noteServed('s1', 'other', i);                       // 'other' now holds it
  assert.equal(o.shouldRefuse('s1', 'third', i), true, 'streak cleared, gate armed again');
});

test('an unknown session refuses — the safe direction', () => {
  // No record (maxpool restarted mid-conversation) means we cannot know the owner.
  // Refusing costs one round-trip; forwarding could 404/1214 in the user's face.
  const o = new ThreadOwners();
  assert.equal(o.shouldRefuse('never-seen', 'anyone', readThreadIntent(cont)), true);
});

test('missing session or account never refuses', () => {
  const o = new ThreadOwners();
  assert.equal(o.shouldRefuse('', 'a', readThreadIntent(cont)), false);
  assert.equal(o.shouldRefuse('s', '', readThreadIntent(cont)), false);
});

test('the owner map is bounded and LRU-evicts', () => {
  const o = new ThreadOwners({ maxSessions: 10 });
  for (let i = 0; i < 50; i++) o.noteServed(`s${i}`, 'acct', readThreadIntent(create));
  assert.equal(o.size, 10, 'ceiling holds');
  // the newest survive, the oldest are gone
  assert.equal(o.shouldRefuse('s49', 'acct', readThreadIntent(cont)), false, 'newest retained');
  assert.equal(o.shouldRefuse('s0', 'acct', readThreadIntent(cont)), true, 'oldest evicted');
});
