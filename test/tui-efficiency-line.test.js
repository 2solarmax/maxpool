// The TUI Cache + Moves lines (two-line rework 2026-11-19, owner question): under
// Routing, only with traffic, red names the cause, low volume says so instead of
// numbers, and each line fits the terminal width. Cache first, Moves directly under.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { strip } = __tuiTest;
const acct = (n, type = 'oauth', extra = {}) => ({ name: n, type, accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, ...extra });
const am = (n = 2) => new AccountManager(Array.from({ length: n }, (_, i) => acct(`c${i + 1}`)), 0.9);
const lease = a => { a.inFlight++; return { account: a, weight: 1, startedAt: Date.now() - 100, requestInfo: {} }; };
const served = (m, a, u, extra = {}) => m.releaseAccount(lease(a), { success: true, status: 200, usage: u, ...extra });

function frameAt(tui, columns) {
  const saved = { columns: process.stdout.columns, rows: process.stdout.rows, write: process.stdout.write };
  let buf = '';
  process.stdout.columns = columns; process.stdout.rows = 40;
  process.stdout.write = s => { buf += s; return true; };
  try { tui._render(); } finally { Object.assign(process.stdout, saved); }
  return strip(buf).split(/\r?\n/);
}

test('renders Cache then Moves directly under the Routing line, and not at all without traffic', () => {
  const quiet = new TUI({ accountManager: am(), config: { proxy: { port: 3456 } } });
  assert.equal(quiet._cacheLine(100), null, 'no traffic, no Cache line');
  assert.equal(quiet._movesLine(100), null, 'no traffic, no Moves line');
  const lines = frameAt(quiet, 100);
  assert.ok(!lines.some(l => l.trim().startsWith('Cache')), 'not in the frame');
  assert.ok(!lines.some(l => l.trim().startsWith('Moves')), 'not in the frame');

  const m = am();
  served(m, m.accounts[0], { in: 1000, cr: 90_000, cc: 0, out: 10 });   // 98.9%, still low volume
  for (let i = 0; i < 24; i++) served(m, m.accounts[0], { in: 1000, cr: 90_000, cc: 0, out: 10 });
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  const frame = frameAt(tui, 120);
  const routing = frame.findIndex(l => l.trim().startsWith('Routing'));
  const cache = frame.findIndex(l => l.trim().startsWith('Cache'));
  const moves = frame.findIndex(l => l.trim().startsWith('Moves'));
  assert.ok(routing >= 0, 'Routing line present');
  assert.ok(cache === routing + 1, `Cache directly under Routing (routing=${routing}, cache=${cache})`);
  assert.ok(moves === routing + 2, `Moves directly under Cache (moves=${moves})`);
  assert.match(frame[cache], /Claude 99%/, 'per-provider share');
  assert.doesNotMatch(frame[cache], /miss|of cost/, 'the overview shows cache hit rates');
  assert.match(frame[cache], /\[15m\/24h\] .*Claude 99%\/99%/, 'the two windows stay beside the provider');
  assert.match(frame[moves], /cross 0\/100/, 'the Moves line carries the move figures');
  tui.mode = 'routing';
  assert.match(frameAt(tui, 80).find(l => l.trim().startsWith('Cache misses')), /Claude 25k tok/, 'Routing includes detailed cache figures at terminal width');
});

test('80-column Cache keeps every provider visible and Routing shows all three miss counts', () => {
  const m = new AccountManager([
    acct('Claude fixture'), acct('GLM fixture', 'provider', { provider: 'zai', apiKey: 'test' }),
    acct('Codex fixture', 'oauth', { provider: 'codex' }),
  ]);
  const now = Date.now();
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  for (let i = 0; i < 25; i++) served(m, m.accounts[0], { in: 6000, cr: 4000, cc: 0, out: 1 });
  assert.match(strip(tui._cacheLine(80, now)), /Claude 40%\/40% · GLM —\/— · Codex —\/—/);
  for (let i = 0; i < 25; i++) {
    served(m, m.accounts[1], { in: 1000, cr: 9000, cc: 0, out: 1 });
    served(m, m.accounts[2], { in: 2000, cr: 8000, cc: 0, out: 1 });
  }
  const cache = strip(tui._cacheLine(80));
  assert.ok(cache.length <= 80, cache);
  assert.match(cache, /Claude 40%\/40% · GLM 90%\/90% · Codex 80%\/80%/, cache);
  assert.match(cache, /⚠/, 'the cache alert remains visible alongside all three providers');
  assert.doesNotMatch(cache, /miss|of cost/);
  tui.mode = 'routing';
  const detail = frameAt(tui, 80).find(row => row.trim().startsWith('Cache misses'));
  assert.match(detail, /\[15m\]  Claude 150k tok · GLM 25k tok · Codex 50k tok/, detail);
});

test('a red line names the cause and the account behind it — on its OWN line', () => {
  const m = am(2);
  const [a, b] = m.accounts;
  // a: 40% hit with real volume; b: healthy. Moves above 2/100 → the MOVES line is
  // red (cross count); the CACHE line is red for its OWN cause (Claude 40% on c1).
  for (let i = 0; i < 30; i++) {
    served(m, i % 3 === 0 ? b : a, { in: 6_000, cr: 4_000, cc: 0, out: 10 });
  }
  for (let i = 0; i < 3; i++) served(m, b, { in: 100, cr: 900, cc: 0 }, { moved: true, moveCause: 'busy' });
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  const cache = strip(tui._cacheLine(160));
  const moves = strip(tui._movesLine(160));
  // Cache red: low hit with the account behind it.
  assert.match(cache, /⚠ Claude 40% on c1/, `cache red names account: ${cache}`);
  // Moves red: the cross-count cause (no account here — no bounces booked).
  assert.match(moves, /⚠ cross moves/, `moves red names its cause: ${moves}`);
});

test('low volume says so instead of numbers, and both lines fit 65 columns', () => {
  const m = am();
  served(m, m.accounts[0], { in: 100, cr: 9_900, cc: 0, out: 1 });
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  const line = strip(tui._cacheLine(65));
  assert.match(line, /little traffic/, line);
  for (const W of [65, 100, 112, 140]) {
    assert.ok(strip(tui._cacheLine(W)).length <= W, `Cache fits ${W}: ${strip(tui._cacheLine(W)).length}`);
    assert.ok(strip(tui._movesLine(W)).length <= W, `Moves fits ${W}: ${strip(tui._movesLine(W)).length}`);
  }
  // With real volume the numbers appear and STILL fit 65.
  for (let i = 0; i < 30; i++) served(m, m.accounts[0], { in: 100, cr: 9_900, cc: 0 });
  for (let i = 0; i < 4; i++) served(m, m.accounts[0], { in: 100, cr: 9_900, cc: 0 }, { moved: true, moveCause: 'balance' });
  const full = strip(tui._movesLine(65));
  assert.ok(full.length <= 65, `Moves fits 65 with numbers: ${full.length}`);
  assert.match(full, /cross \d+\/100/, full);
  assert.ok(strip(tui._cacheLine(65)).length <= 65, 'Cache still fits 65 with numbers');
});

test('Headroom headline sits under Moves, names the state, and fits 80 columns', () => {
  const m = am();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
  // Drive the ledger from the same controllable clock so every recorded request stays inside the
  // 15-minute window however long the test takes, and held requests age by exactly the advance.
  m.routingService.now = () => clock;
  // A worker that has been watching for longer than the window, so the label shows the full 15m.
  m.routingService.started = clock - 20 * 60_000;
  for (let i = 0; i < 25; i++) served(m, m.accounts[0], { in: 1000, cr: 90_000, cc: 0, out: 10 });
  const fresh = () => { m._routingReport = null; };
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  assert.match(strip(tui._capacityLine(80)), /Headroom .*little traffic/);
  for (let i = 0; i < 35; i++) { const t = m.routingService.begin({}); t.route('c1'); t.finish('completed'); }
  fresh();
  assert.match(strip(tui._capacityLine(80)), /Headroom\s+Keeping up\s+\[15m\]\s+0 of 35 waited/);
  const held = [0, 1, 2].map(() => { const t = m.routingService.begin({}); t.wait(); return t; });
  clock += 42_000;
  fresh();
  const short = strip(tui._capacityLine(80));
  assert.match(short, /Short of accounts/);
  assert.match(short, /3 waiting, oldest 42s/);
  assert.equal(m.routingService.recent(undefined, clock).requests, 35, 'all 35 unwaited requests are still in the window');
  assert.ok([...short].length <= 80, 'fits 80 columns');
  const frame = frameAt(tui, 100);
  const moves = frame.findIndex(l => l.trim().startsWith('Moves'));
  const cap = frame.findIndex(l => l.trim().startsWith('Headroom'));
  assert.ok(moves > 0, 'the fixture produces a Moves row');
  assert.equal(cap, moves + 1, 'headline directly under Moves');
  held.forEach(t => t.finish('cancelled'));
  // Just after a restart the label says how little it has watched instead of claiming 15 minutes.
  m.routingService.started = clock - 3 * 60_000;
  fresh();
  assert.match(strip(tui._capacityLine(80)), /\[3m\]/);
  } finally { Date.now = realNow; }
});

test('Headroom headline shows the worst fresh worker by name and ignores a stale or older one', () => {
  const m = am();
  const now = Date.now();
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  const recent = (state, extra = {}) => ({ state, requests: 40, queuedRequests: 0, capacityDenied: 0, longestWaitMs: 0,
    pending: 0, oldestWaitMs: 0, windowMs: 900_000, observedMs: 900_000, ...extra });
  const link = (name, source, rec, extra = {}) => ({ name, lastOkAt: now, ...extra,
    status: { routingAnalytics: { version: 1, source, asOf: now, ...(rec ? { recent: rec } : {}) } } });
  const show = links => { m.poolLinks = links; m._routingReport = null; return strip(tui._capacityLine(100, now)); };
  // Local is quiet and so is the remote: a tie stays local, so no worker name.
  assert.doesNotMatch(show([link('Cloud', 'src-cloud', { state: 'quiet' })]), / on /);
  // A fresh remote in a worse state wins and is named; a stale one in a worse state is skipped.
  const tight = show([link('Cloud', 'src-cloud', recent('tight', { queuedRequests: 3, longestWaitMs: 7000 })),
    link('Stale', 'src-stale', recent('short', { queuedRequests: 20 }), { lastError: 'unreachable' }),
    { name: 'Older', status: {} }, link('NoHeadline', 'src-old', null)]);
  assert.match(tight, /Getting tight/);
  assert.match(tight, /3 of 40 waited/);
  assert.match(tight, /on Cloud/);
  assert.doesNotMatch(tight, /Stale|Short of accounts/);
  // Two fresh workers: the shorter-of-accounts one is shown.
  const short = show([link('Cloud', 'src-cloud', recent('tight', { queuedRequests: 3 })),
    link('Cloud2', 'src-cloud2', recent('short', { queuedRequests: 8 }))]);
  assert.match(short, /Short of accounts/);
  assert.match(short, /8 of 40 waited/);
  assert.match(short, /on Cloud2/);
  // Only stale workers report: nothing to say beyond this worker's own quiet line.
  assert.doesNotMatch(show([link('Stale', 'src-stale', recent('short'), { lastError: 'unreachable' })]), /Short of accounts| on /);
});

test('Headroom headline coerces a linked worker\'s figures and rejects inherited state names', () => {
  const m = am();
  const now = Date.now();
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  const show = recent => {
    m.poolLinks = [{ name: 'Cloud', lastOkAt: now, status: { routingAnalytics: { version: 1, source: 'src-cloud', asOf: now, recent } } }];
    m._routingReport = null;
    return strip(tui._capacityLine(100, now));
  };
  // Text, objects and huge numbers in a remote block never reach the screen as raw values.
  const hostile = show({ state: 'short', requests: '40 \u001b[31mRED', queuedRequests: '9', pending: '3', oldestWaitMs: { x: 1 },
    capacityDenied: [7], longestWaitMs: 'forever', windowMs: 'x', observedMs: 'y' });
  assert.match(hostile, /Short of accounts/);
  assert.match(hostile, /0 of 0 waited/);
  assert.doesNotMatch(hostile, /RED|forever|\[object|NaN|undefined/);
  // `toString` is on every object's prototype: it is not a state.
  const inherited = show({ state: 'toString', requests: 40, queuedRequests: 12 });
  assert.doesNotMatch(inherited, /Keeping up|Getting tight|Short of accounts|waited/);
  assert.match(inherited, /1 not reporting/);
});

test('Headroom headline says how many linked workers report no headroom, and how old a remote verdict is', () => {
  const m = am();
  const now = Date.now();
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  const recent = (state, extra = {}) => ({ state, requests: 40, queuedRequests: 0, capacityDenied: 0, longestWaitMs: 0,
    pending: 0, oldestWaitMs: 0, windowMs: 900_000, observedMs: 900_000, ...extra });
  const link = (name, source, rec, asOf = now) => ({ name, lastOkAt: now,
    status: { routingAnalytics: { version: 1, source, asOf, ...(rec ? { recent: rec } : {}) } } });
  const show = links => { m.poolLinks = links; m._routingReport = null; return strip(tui._capacityLine(100, now)); };
  // A worker that sends no headroom must not leave "Keeping up" reading as all-clear.
  const silent = show([link('Cloud', 'src-cloud', recent('ok')), link('Old', 'src-old', null), { name: 'Older', status: {} }]);
  assert.match(silent, /Keeping up/);
  assert.match(silent, /on Cloud · 2 not reporting/);
  // No linked worker, nothing missing: no hint.
  assert.doesNotMatch(show([link('Cloud', 'src-cloud', recent('ok'))]), /not reporting/);
  // A remote verdict says how old it is; a fresh one does not.
  assert.match(show([link('Cloud', 'src-cloud', recent('tight', { queuedRequests: 3 }), now - 4 * 60_000)]), /Getting tight\s+\[15m\] 4m old/);
  assert.doesNotMatch(show([link('Cloud', 'src-cloud', recent('tight', { queuedRequests: 3 }), now - 20_000)]), /old/);
});

test('quiet Headroom still shows a request being held and the span it covers', () => {
  const m = am();
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    // One controllable clock for the ledger AND the render. Reading the ledger at a made-up future
    // time and then at the real time runs the clock backwards, which the ledger treats (correctly)
    // as an observation gap and restarts the span.
    m.routingService.now = () => clock;
    m.routingService.started = clock - 20 * 60_000;
    const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
    const trace = m.routingService.begin({});
    trace.wait();
    clock += 3000;
    m._routingReport = null;
    assert.match(strip(tui._capacityLine(100, clock)), /little traffic · 1 waiting, oldest 3\.0s\)\s+\[15m\]/);
    trace.finish('cancelled');
    m._routingReport = null;
    const released = strip(tui._capacityLine(100, clock));
    assert.match(released, /little traffic\)\s+\[15m\]/);
    assert.doesNotMatch(released, /waiting/);
  } finally { Date.now = realNow; }
});
