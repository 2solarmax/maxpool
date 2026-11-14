// q under the background service (MAXPOOL_SERVICE=1): the dashboard runs inside a
// tmux pane owned by launchd, so "Stop Maxpool? yes" would only make launchd cold-
// restart the pool and drop every session's connection. In service mode q closes the
// VIEW (tmux detach) and never reaches the stop path; outside it nothing changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, __tuiTest } from '../src/tui.js';

function accountManager() {
  return { accounts: [], currentIndex: 0, routingMode: 'automatic', preferredAccountName: null };
}

function withServiceEnv(value, fn) {
  const prev = process.env.MAXPOOL_SERVICE;
  if (value == null) delete process.env.MAXPOOL_SERVICE; else process.env.MAXPOOL_SERVICE = value;
  try { return fn(); } finally {
    if (prev == null) delete process.env.MAXPOOL_SERVICE; else process.env.MAXPOOL_SERVICE = prev;
  }
}

function instrumented() {
  const calls = { detach: 0, confirm: 0, stop: 0, quit: 0 };
  const tui = new TUI({ accountManager: accountManager(), onQuit: () => { calls.quit++; } });
  tui.detachView = () => { calls.detach++; };
  const realConfirm = tui._confirm.bind(tui);
  tui._confirm = (...a) => { calls.confirm++; return realConfirm(...a); };
  tui.stop = () => { calls.stop++; };
  return { tui, calls };
}

test('service mode: q detaches the view and never asks to stop or stops', () => {
  withServiceEnv('1', () => {
    const { tui, calls } = instrumented();
    tui._keyNormal('q');
    assert.equal(calls.detach, 1, 'q must call the detach seam');
    assert.equal(calls.confirm, 0, 'q must not open the "Stop Maxpool?" prompt');
    assert.equal(calls.stop, 0);
    assert.equal(calls.quit, 0);
    assert.equal(tui.mode, 'normal');
  });
});

test('outside service mode: q still asks "Stop Maxpool?" and never detaches', () => {
  withServiceEnv(null, () => {
    const { tui, calls } = instrumented();
    tui._keyNormal('q');
    assert.equal(calls.detach, 0, 'no tmux detach outside the service');
    assert.equal(calls.confirm, 1);
    assert.equal(tui.mode, 'confirm');
    assert.match(tui.confirmTitle, /Stop Maxpool\?/);
  });
});

test('footer reads "q Close view" in service mode and "q Stop server" otherwise', () => {
  withServiceEnv('1', () => {
    const footer = __tuiTest.strip(new TUI({ accountManager: accountManager() })._renderFooter());
    assert.match(footer, /q Close view/);
    assert.doesNotMatch(footer, /Stop server/);
  });
  withServiceEnv(null, () => {
    const footer = __tuiTest.strip(new TUI({ accountManager: accountManager() })._renderFooter());
    assert.match(footer, /q Stop server/);
    assert.doesNotMatch(footer, /Close view/);
  });
});

test('the default detach seam targets the service socket and the pool session', () => {
  const prevSock = process.env.MAXPOOL_TMUX_SOCK;
  process.env.MAXPOOL_TMUX_SOCK = '/tmp/example/tmux.sock';
  try {
    const seen = [];
    const tui = new TUI({ accountManager: accountManager(), spawnDetached: (cmd, args) => seen.push([cmd, args]) });
    tui.detachView();
    assert.deepEqual(seen, [['tmux', ['-S', '/tmp/example/tmux.sock', 'detach-client', '-s', 'pool']]]);
  } finally {
    if (prevSock == null) delete process.env.MAXPOOL_TMUX_SOCK; else process.env.MAXPOOL_TMUX_SOCK = prevSock;
  }
});
