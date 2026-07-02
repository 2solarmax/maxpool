import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RestartController } from '../src/restart-controller.js';

function controller() {
  const events = [];
  const rc = new RestartController({
    pauseAdmission: () => events.push('paused'),
    restartNow: () => events.push('restarted'),
    log: message => events.push(message),
  });
  return { rc, events };
}

test('restart ignores queued requests and waits for existing upstream work', () => {
  const { rc, events } = controller();
  rc.requestStarted(1);
  rc.requestRouted(1, 'personal');
  rc.requestStarted(2);
  rc.requestRouted(2, '(queued)');

  rc.requestRestart();
  assert.equal(rc.pending, true);
  rc.requestEnded(1);

  assert.equal(events.at(-1), 'restarted');
  assert.equal(rc.activeRequests.has(2), true);
});

test('continuous post-barrier queued traffic cannot postpone restart', () => {
  const { rc, events } = controller();
  rc.requestStarted(1);
  rc.requestRouted(1, 'mk@gomokka');
  rc.requestRestart();

  for (let id = 2; id <= 100; id++) {
    rc.requestStarted(id);
    rc.requestRouted(id, '(queued)');
  }
  assert.equal(events.includes('restarted'), false);

  rc.requestEnded(1);
  assert.equal(events.filter(event => event === 'restarted').length, 1);
});

test('OAuth relay is upstream work and drains before restart', () => {
  const { rc, events } = controller();
  rc.requestStarted(1);
  rc.requestRouted(1, '(oauth relay)');
  rc.requestRestart();
  assert.equal(events.includes('restarted'), false);

  rc.requestEnded(1);
  assert.equal(events.at(-1), 'restarted');
});

test('new OAuth relay is rejected after restart admission closes', () => {
  const { rc, events } = controller();
  rc.requestStarted(1);
  rc.requestRouted(1, 'personal');
  rc.requestRestart();

  assert.equal(rc.requestStarted(2), false);
  rc.requestRouted(2, '(oauth relay)');
  rc.requestEnded(1);

  assert.equal(events.filter(event => event === 'restarted').length, 1);
  assert.equal(rc.upstreamRequests.has(2), false);
});

test('restart runs exactly once when the final upstream route becomes queued', () => {
  const { rc, events } = controller();
  rc.requestStarted(1);
  rc.requestRouted(1, 'partnerships');
  rc.requestRestart();

  rc.requestRouted(1, '(queued)');
  rc.requestEnded(1);
  rc.requestRestart();

  assert.equal(events.filter(event => event === 'restarted').length, 1);
});

// Bounded-drain regression: a long upstream request (streaming/thinking, or a
// held 7-day-heartbeat stream) must NOT pin the restart on "Restart pending…"
// forever — the drain is bounded and forces the restart on timeout.
function controllerWithFakeTimer(opts = {}) {
  const events = [];
  let fired = null;
  let cleared = false;
  const rc = new RestartController({
    pauseAdmission: () => events.push('paused'),
    restartNow: () => events.push('restarted'),
    log: message => events.push(message),
    setTimeoutFn: fn => { fired = fn; return { __fake: true }; },
    clearTimeoutFn: () => { cleared = true; },
    ...opts,
  });
  return { rc, events, fireTimer: () => fired?.(), wasCleared: () => cleared };
}

test('bounded drain forces restart when upstream work overruns the timeout', () => {
  const { rc, events, fireTimer } = controllerWithFakeTimer();
  rc.requestStarted(1);
  rc.requestRouted(1, 'personal'); // long upstream request that never ends
  rc.requestRestart();

  assert.equal(rc.pending, true);
  assert.equal(events.includes('restarted'), false, 'does not restart while upstream is in flight');

  fireTimer(); // drain timeout elapses
  assert.equal(events.filter(e => e === 'restarted').length, 1, 'forced restart after the bounded drain');
});

test('natural drain clears the force-timer and never double-restarts', () => {
  const { rc, events, fireTimer, wasCleared } = controllerWithFakeTimer();
  rc.requestStarted(1);
  rc.requestRouted(1, 'personal');
  rc.requestRestart();

  rc.requestEnded(1); // drains naturally → restart happens now
  assert.equal(events.filter(e => e === 'restarted').length, 1);
  assert.equal(wasCleared(), true, 'force-timer cleared once the drain completes naturally');

  fireTimer(); // a stale timer firing must not restart a second time
  assert.equal(events.filter(e => e === 'restarted').length, 1, 'no double restart');
});
