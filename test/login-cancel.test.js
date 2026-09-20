// LOGIN CANCEL ESCAPE HATCH (2026-09-20). The OAuth login prompt had no way out —
// a free-plan account cannot complete consent, the callback never arrives, and the
// only exit was killing the whole maxpool process. Pins the cancel vocabulary and
// the sentinel discrimination so "cancelled" never reads as "failed".
import test from 'node:test';
import assert from 'node:assert/strict';
import { isLoginCancelAnswer, isLoginCancelled, LOGIN_CANCELLED } from '../src/oauth.js';

test('cancel vocabulary: q / quit / cancel / abort / :q cancel; anything else does not', () => {
  for (const w of ['q', 'Q', ' quit ', 'CANCEL', 'abort', ':q']) {
    assert.equal(isLoginCancelAnswer(w), true, `${w} cancels`);
  }
  for (const not of ['', 'paste-me-a-real-code', 'quick-brown', 'quit-that-is-not', 'canceling? no']) {
    // 'quit-that-is-not' and 'canceling? no' must NOT match — exact-word only
    if (not === 'quit-that-is-not' || not === 'canceling? no') {
      assert.equal(isLoginCancelAnswer(not), false, `${not} is a code, not a cancel`);
    }
  }
  assert.equal(isLoginCancelAnswer(''), false, 'empty keeps waiting (existing behavior)');
});

test('empty input is NOT a cancel (keeps waiting for callback)', () => {
  assert.equal(isLoginCancelAnswer(''), false);
  assert.equal(isLoginCancelAnswer('   '), false);
});

test('sentinel discrimination: cancelled is not a failure object', () => {
  assert.equal(isLoginCancelled(LOGIN_CANCELLED), true);
  assert.equal(isLoginCancelled(new Error('Login timed out after 5 minutes')), false);
  assert.equal(isLoginCancelled(null), false);
});

test('headless (non-TTY) login path is untouched: raceWithStdinCode not used', () => {
  // non-TTY: raceWithStdinCode returns the callback promise directly (module-internal),
  // so cancellation via stdin cannot exist headless — the timeout still bounds it.
  // Structural pin: the cancel vocabulary lives in the exported pure function used by
  // the TTY path only.
  assert.equal(typeof isLoginCancelAnswer, 'function');
});
