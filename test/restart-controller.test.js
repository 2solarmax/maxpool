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
