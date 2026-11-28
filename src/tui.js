import { createInterface } from 'node:readline';
import { routingSources } from './routing-report.js';
import { CAPACITY_BANDS } from './routing-service-analytics.js';
import { TANK_MIN_UTIL } from './capacity-ledger.js';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeSync } from 'node:fs';
import { isatty } from 'node:tty';
import { homedir } from 'node:os';
import { fetchProfile, loginOAuth, tokenFingerprint, isLoginCancelled, sameUser, sameAccountIdentity, organizationUnknownMatch, resolveOrganizations, suggestAccountName } from './oauth.js';
import { configuredAccountProvider, findAccountConfigIndex, findClaudeOAuthLoginIndex, isClaudeOAuthAccount, planClaudeOAuthLogin } from './account-config.js';
import { appendEventLog, setConsoleStdoutSuppressed } from './event-log.js';
import { sendLoginToPool } from './cloud-login.js';
import { sendProviderToPool } from './cloud-login.js';
import { describeLinkError } from './pool-link.js';
import { normalizeRemoteResets, resolveStickyBusyBudget } from './account-manager.js';
import { appliesTo } from './claude-reset-grants.js';
import { LISTING_FRESH_MS } from './reset-timing.js';
import { resetOutcomeLabel } from './reset-policy.js';
import { cacheUsageLabel, cacheUsageState } from './usage-label.js';
import { subscriptionTermsFor } from './subscription-terms.js';

// Running as the background service (tools/pool-service): set by its launchd plist.
const serviceMode = () => process.env.MAXPOOL_SERVICE === '1';

// ── ANSI helpers ─────────────────────────────────────────────

const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'.split('');
const ESC = '\x1b[';
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;

const bold = s => `${BOLD}${s}${RESET}`;
const dim = s => `${DIM}${s}${RESET}`;
const fg = (c, s) => `${ESC}${c}m${s}${RESET}`;
const green = s => fg(32, s);
const yellow = s => fg(33, s);
const red = s => fg(31, s);
const cyan = s => fg(36, s);
const gray = s => fg(90, s);
const dimUnderline = s => `${ESC}2;4m${s}${RESET}`;
// The cache figures of a request line, by whether the cache held (#642 port, 2026-11-15).
const CACHE_PAINT = { hit: green, partial: yellow, miss: red, none: dim };

// Terminal output budget (2026-11-12: the pool froze for up to 60s inside a synchronous
// TTY write() — a full-screen redraw per log line, 4.9 GB in 12h49m). Frames are
// coalesced to one per RENDER_MIN_INTERVAL_MS (≤10/s), an unchanged frame is re-sent
// only after REPAINT_MS, and nothing is written while the terminal has not drained.
const RENDER_MIN_INTERVAL_MS = 100;
const REPAINT_MS = 5000;
const EXIT_SEQ = `${ESC}?25h${ESC}?1049l`;   // show cursor + leave the alt screen

/**
 * Write to the terminal synchronously at PROCESS EXIT. The TUI turns its output
 * non-blocking, and Node drops a non-blocking stream's queued bytes on exit — the exit
 * sequence written through the stream never arrives and the shell is left in the
 * dashboard (pre-mortem r2 B1, real-pty probe). Blocking back on + a direct fd write
 * delivers it. Exit paths only: a blocking write is exactly what froze the pool.
 */
export function writeTerminalSync(s) {
  if (!isatty(1)) return;
  try { process.stdout._handle?.setBlocking?.(true); } catch { /* not a libuv tty */ }
  try { writeSync(1, s); } catch { /* terminal gone */ }
}

/**
 * Re-enter raw mode after another process reset the terminal (post-update reassert).
 * setRawMode is tcsetattr(TCSADRAIN): it blocks the WHOLE process until the terminal
 * has read everything already sent (2026-11-12, measured 2.8s on a paused pty). So the
 * toggle waits until our own queued output has drained — the remaining wait is the
 * kernel's ~1 KB — and a terminal that is not reading at all gets it on 'drain'.
 * Resolves true when reclaimed now, false when deferred to 'drain'.
 * 'drain' is emitted only after a write crossed the stream's high-water mark, so a
 * deferred reclaim also polls the queue length and goes ahead once it is empty
 * (2026-11-13: a frame below 16 KB never produced 'drain'). Fallback only: a worker
 * with a terminal helper (terminal-mode.js) never switches on its own thread. `guard` is re-checked
 * at reclaim time (a TUI stopped meanwhile must not be put back in raw mode);
 * `onDeferredReclaim` runs once the deferred reclaim actually happened.
 */
export async function reclaimRawMode({
  stdin = process.stdin, stdout = process.stdout, flush, timeoutMs = 1500,
  guard = () => true, onDeferredReclaim = () => {}, pollMs = 100,
} = {}) {
  if (!stdin.isTTY) return true;
  // OFF then ON: Node short-circuits setRawMode(true) while it believes isRaw is already
  // true, and the reset happened in ANOTHER process (verified on a real pty 2026-08-07).
  const reclaim = () => {
    if (!guard()) return;
    try { stdin.setRawMode(false); stdin.setRawMode(true); stdin.resume(); } catch { /* terminal gone */ }
  };
  if (!flush || await flush({ timeoutMs })) { reclaim(); return true; }
  let settled = false;
  const later = () => {
    if (settled) return;
    settled = true;
    clearInterval(poll);
    stdout.removeListener?.('drain', later);
    reclaim();
    try { onDeferredReclaim(); } catch { /* never */ }
  };
  // Only once our queue is EMPTY (polled, or 'drain'): a mere shrink — one whole write
  // landed — fired the switch on the serving thread while a bursty terminal still held
  // several bursts of ours, stalling the pool for each (red-team round 2). Our queue
  // cannot grow without bound meanwhile: the dashboard stops writing at the high-water
  // mark and owes one frame on 'drain', so a busy dashboard still reaches 'drain'.
  const poll = setInterval(() => { if (stdout.writableLength === 0) later(); }, pollMs);
  poll.unref?.();
  stdout.once('drain', later);
  return false;
}

/**
 * Call `cb` once, as soon as the terminal has taken everything queued for it (our
 * write queue is empty) — polled, since 'drain' fires only after a write crossed the
 * high-water mark. Returns a cancel function.
 */
export function whenTerminalCaughtUp(cb, { stdout = process.stdout, pollMs = 100 } = {}) {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearInterval(poll);
    stdout.removeListener?.('drain', onDrain);
    cb();
  };
  const onDrain = () => { if (!stdout.writableLength) finish(); };
  const poll = setInterval(onDrain, pollMs);
  poll.unref?.();
  stdout.on?.('drain', onDrain);
  if (!stdout.writableLength) Promise.resolve().then(finish);
  return () => { if (done) return; done = true; clearInterval(poll); stdout.removeListener?.('drain', onDrain); };
}

/**
 * reclaimRawMode + the update-window measurement (release B, B11): says how long the new
 * worker took to take the terminal back, or that it was deferred to the terminal's drain
 * (and how long that took when it finally happened). `now`/`log` are injectable for tests.
 */
export async function reclaimRawModeLogged({ stdout = process.stdout, log = m => console.log(`[Maxpool] ${m}`), now = Date.now, ...rest } = {}) {
  const t0 = now();
  const done = await reclaimRawMode({
    stdout, ...rest,
    onDeferredReclaim: () => log(`reload: terminal reclaimed after drain in ${now() - t0}ms`),
  });
  if (done) log(`reload: terminal reclaimed in ${now() - t0}ms`);
  else log('reload: terminal reclaim deferred to drain');
  return done;
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = s => s.replace(ANSI_RE, '');
const vw = s => strip(s).length;

// ── Accounts-table columns ───────────────────────────────────
// Fixed column widths shared by the header row (acctHeader) AND every data row, so
// the header labels stay aligned with the columns they name. The Account/Provider/
// Status/MRst/ARst/Quota start offsets are pure functions of these widths +
// the 4-col row prefix, independent of the quota-bar width.
const NAME_W = 20;         // a.name.slice(0, NAME_W).padEnd(NAME_W) — fits a full email like 2solarmax@gmail.com (19)
const CACHE_W = 8;
// On an 80-column display retain the reset and quota readings by shortening the name.
// The analytics detail always displays the full name. Wider terminals show all 20 characters.
function nameWidth(width) {
  const compact = NAME_W - CACHE_W - 1;
  return Math.min(NAME_W, compact + Math.max(0, width - 80));
}
const WHERE_W = 5;         // 'Local' / 'Cloud' — where the account is provisioned
const PROVIDER_W = 9;      // providerLabel(a).padEnd(PROVIDER_W) — fits "Anthropic"
const STATUS_W = 13;       // rpad(status, STATUS_W) — fits "throttled 59s"
const MRST_W = 11;         // 'MRst' column (model resets) — FIXED width (fits '2Fable~118d': count AND expiry, owner 2026-11-11);
                           // a variable width ('0' vs '1~21d') shifted every quota bar per row.
const ARST_W = 7;          // 'ARst' column (account-level resets) — FIXED width (fits '1~118d?'); owner 2026-11-15: model and
                           // account resets in ONE mixed cell read as confusing, so they are two aligned columns.
// '5hR' column (five-hour reset cards) — FIXED width (fits '2~3d?'). Owner 2026-11-27:
// five-hour cards may be spent, "and they should probably have their own column". The
// cell is BLANK for every account the column does not apply to (anything but a z.ai
// account); a z.ai account with a fresh listing and no card shows a dim 0, and one
// whose listing is missing or stale shows nothing green. It is shown only where it fits
// (see show5hColumn): from 139 columns, so it never squeezes a quota bar.
const FIVE_HOUR_RST_W = 5;
const ROW_PREFIX = '    '; // ' ' + sel(1) + cur(1) + ' ' — 4 cols before the name

// Human provider name for the accounts-table "Provider" column. account.provider
// is 'anthropic' for oauth/apikey accounts (they ARE Anthropic — the oauth-vs-key
// billing split is still shown by the Ses/Wk vs Tok/Req quota-bar labels, not here),
// and 'zai'/'kimi' for the GLM/Kimi fallback providers. Explicit map + a graceful
// Titlecase default so a future provider (Codex/Grok) renders sanely; truncated to
// the column width so a long name can never misalign the row.
const PROVIDER_LABELS = { anthropic: 'Anthropic', zai: 'z.ai', kimi: 'Moonshot', openai: 'OpenAI', codex: 'Codex', grok: 'Grok', xai: 'Grok' };
/** 'Cloud' for an account mirrored from a linked team pool, 'Local' otherwise. */
function whereCell(a) {
  return a?.remote ? cyan('Cloud'.padEnd(WHERE_W)) : dim('Local'.padEnd(WHERE_W));
}

function providerLabel(a) {

  const key = a.provider || (a.type === 'provider' ? 'provider' : 'anthropic');
  const label = PROVIDER_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
  return label.slice(0, PROVIDER_W);
}

/**
 * Aligned column header for the accounts table. Names the three columns that carry
 * NO inline label (Account / Type / Status) plus a group label over the quota bars
 * (Quota). The per-bar naming (Ses/Fbl/Wk for OAuth, Tok/Fbl/Req for API keys) and the
 * load fields (Now/15m/1h) stay inline per row — they're row-type-dependent and
 * begin at a variable offset — so the header stops after the Quota group label.
 */
/** Whether the five-hour-card column is shown at this terminal width. It takes its own
 *  fixed width plus the gap after it, so it is shown only where that costs nothing
 *  else: MEASURED against barLayout — below 139 columns it would shrink the quota bars
 *  (120: 13→10) or drop the Fable bar outright (127), and an 80-column terminal already
 *  has no spare cell. From 139 every bar keeps its full width with the column present.
 *  Below it the accounts table is exactly what it was. */
const FIVE_HOUR_COL_FITS_W = 139;
const show5hColumn = W => W >= FIVE_HOUR_COL_FITS_W;
const fiveHourColSpan = W => (show5hColumn(W) ? FIVE_HOUR_RST_W + 1 : 0);

function acctHeader(W) {
  const quota = W >= 88 ? 'Quota (used% · resets-in)' : 'Quota';
  return ROW_PREFIX
    + 'Account'.padEnd(nameWidth(W)) + ' '
    + 'Cache 3h'.padStart(CACHE_W) + ' '
    + 'Where'.padEnd(WHERE_W) + ' '
    + 'Provider'.padEnd(PROVIDER_W) + ' '
    + 'Status'.padEnd(STATUS_W) + ' '
    + 'MRst'.padEnd(MRST_W) + ' '
    + 'ARst'.padEnd(ARST_W) + ' '
    + (show5hColumn(W) ? '5hR'.padEnd(FIVE_HOUR_RST_W) + ' ' : '')
    + quota;
}

/** padStart by VISIBLE width (ANSI color codes take no columns). */
function lpadVis(s, w) {
  const gap = w - vw(s);
  return gap > 0 ? ' '.repeat(gap) + s : s;
}

/**
 * Which quota bars fit a terminal W columns wide, and how wide each bar is. The
 * space before the first bar comes from the column widths above, never from a
 * hard-coded number (the old number went stale when the reset columns were added).
 * Each extra bar costs its label gap ("  Fbl " or "  Wk  ") plus one bar width.
 * Under 70 columns only the session bar shows, 5 to 20 wide; from 70 the weekly
 * bar joins it, both 5 to 20 wide. The Fable bar joins only once all three can be
 * 9 wide (127 columns), the narrowest bar that still shows "100% 2d5h", and three
 * bars stop growing at 11 wide, so the row never passes column 133 and the tags
 * after the bars (cap, prefer, staleness) keep the room they have with two bars.
 * Narrower terminals keep today's two bars plus the "Fable NN%" tag.
 * When no account reports a session window, the session bar is left out: the
 * weekly bar always shows and the Fable bar joins it from 112 columns.
 */
const barStart = width => ROW_PREFIX.length + nameWidth(width) + 1 + CACHE_W + 1 + WHERE_W + 1 + PROVIDER_W + 1 + STATUS_W + 1 + MRST_W + 1 + ARST_W + fiveHourColSpan(width) + 1 + 'Ses '.length;
const BAR_GAP = '  Wk  '.length;
const BAR_MIN_W = 5;
const BAR_MAX_W = 20;
const FABLE_BAR_MIN_W = 9;
const THREE_BAR_MAX_W = 11;
function barLayout(W, showSession = true) {
  const showBoth = W >= 70 || !showSession;
  const others = (showSession ? 1 : 0) + (showBoth ? 1 : 0);
  const start = barStart(W);
  const showFable = W >= start + (others + 1) * FABLE_BAR_MIN_W + others * BAR_GAP;
  const bars = others + (showFable ? 1 : 0);
  const free = W - start - (bars - 1) * BAR_GAP;
  const fit = Math.floor(free / bars);
  const maxW = bars === 3 ? THREE_BAR_MAX_W : BAR_MAX_W;
  const bw = Math.max(BAR_MIN_W, Math.min(maxW, fit));
  return { showSession, showBoth, showFable, bw };
}

/** True when the account's first bar (Ses, or Tok for an API key) has a reading. */
function hasSessionReading(a) {
  const q = a?.quota || {};
  if (a?.type === 'provider') return q.providerSes != null;
  return q.unified5h != null || (q.tokensLimit != null && q.tokensRemaining != null);
}

function rpad(s, w) {
  const gap = w - vw(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/** Truncate a string with ANSI codes to exactly w visible characters, then reset.
 *  The trailing RESET is appended only when something was actually cut — a no-op
 *  truncate that unconditionally appended it shifted `.padEnd()` (raw-length) fields
 *  4 columns narrow for every string shorter than the width (red-team round 3, RT3-4). */
function truncate(s, w) {
  let visible = 0;
  let out = '';
  let i = 0;
  while (i < s.length && visible < w) {
    if (s[i] === '\x1b') {
      const end = s.indexOf('m', i);
      if (end >= 0) { out += s.slice(i, end + 1); i = end + 1; continue; }
    }
    out += s[i];
    visible++;
    i++;
  }
  return visible < w ? out + ' '.repeat(w - visible) + RESET : out + RESET;
}

// How much history a Headroom figure really covers: the full window, or less just after a restart.
function headroomSpan(r) {
  const windowMs = Number.isFinite(r.windowMs) && r.windowMs > 0 ? r.windowMs : 900_000;
  const span = Number.isFinite(r.observedMs) ? Math.min(windowMs, r.observedMs) : windowMs;
  return span < 60_000 ? '<1m' : Math.round(span / 60_000) + 'm';
}

/** Fit a line to exactly w columns: truncate if too long, pad if too short. */
/** Truncate only when too wide (no padding) — for header lines. */
function truncLine(s, w) {
  return vw(s) > w ? truncate(s, w) : s;
}

// How far back the accounts screen lists what became of each automatic reset.
const RESET_OUTCOME_SHOWN_MS = 7 * 24 * 3600_000;

function agoLabel(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** The "Resets" line under the accounts table (owner 2026-11-28): what became of each
 *  account's latest automatic reset — spent at 100%, spent as last resort with the share
 *  of the window used, or expired unused. Weekly resets, five-hour cards and per-model
 *  grants; newest first, last seven days, as many as fit. Null when nothing to show. */
export function resetOutcomesLine(accounts, width, now = Date.now()) {
  const items = [];
  for (const a of accounts || []) {
    // A cloud mirror carries the holder's own outcomes in its status export.
    if (!a || a.enabled === false) continue;
    for (const [window, o] of Object.entries(a.resetOutcomes || {})) {
      if (!o || !Object.hasOwn(RESET_OUTCOME_WINDOWS, window)) continue;
      const label = resetOutcomeLabel(o);
      // An expiry is stamped at the reset's own end, which the pool may see hours later;
      // the line says when it was SEEN (seenAt), so a fresh observation never reads "7d ago".
      const at = Number.isFinite(o.seenAt) ? o.seenAt : o.at;
      if (!label || !Number.isFinite(at) || now - at > RESET_OUTCOME_SHOWN_MS || at > now + 60_000) continue;
      const name = String(a.name).replace(/[\x00-\x1f\x7f-\x9f]/g, '');
      items.push({ at, text: `${name} ${RESET_OUTCOME_WINDOWS[window]}${label}, ${agoLabel(now - at)}` });
    }
  }
  if (!items.length) return null;
  items.sort((x, y) => y.at - x.at);
  const head = ' Resets  ';
  let line = head;
  let shown = 0;
  for (const it of items) {
    const next = (shown ? line + ' · ' : line) + it.text;
    // The first entry is cut to fit like every other one; width counts visible cells.
    if (!shown && vw(next) > width - 1) return dim(truncLine(next, Math.max(0, width - 2)) + '…');
    if (vw(next) > width - 1 && shown) break;
    line = next;
    shown++;
  }
  return shown ? dim(line) : null;
}

const RESET_OUTCOME_WINDOWS = Object.freeze({
  weekly: '', '5h': 'five-hour card ', model: 'model grant ',
});

function fitLine(s, w) {
  const v = vw(s);
  if (v > w) return truncate(s, w);
  if (v < w) return s + ' '.repeat(w - v);
  return s;
}

function formatReset(resetTs) {
  if (!resetTs) return '';
  const ms = resetTs - Date.now();
  if (ms <= 0) return '';
  const mins = Math.ceil(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const rm = mins % 60;
  if (hrs < 24) return rm > 0 ? `${hrs}h${rm}m` : `${hrs}h`;
  const days = Math.floor(hrs / 24);
  const rh = hrs % 24;
  return rh > 0 ? `${days}d${rh}h` : `${days}d`;
}

function resetSummary(account) {
  return account.quota?.codexResetCredits ?? account.codexResetCredits;
}

/** The expiry part of a Codex reset cell: `~11h` / `~3d` for the soonest expiring
 *  credit, `~never` when every credit is confirmed non-expiring, nothing when the pool
 *  does not know (no recent read of the credit rows). Unknown and non-expiring must
 *  never look alike. `expiry` is the sanitized summary — counts and times only. */
function codexExpirySuffix(expiry, now) {
  if (!expiry || !(expiry.count > 0)) return '';
  if (expiry.earliestExpiresAt == null) return '~never';
  const left = expiry.earliestExpiresAt - now;
  if (!(left > 0)) return '';
  const days = left / 86400_000;
  return days < 1 ? `~${Math.max(1, Math.round(days * 24))}h` : `~${Math.max(1, Math.round(days))}d`;
}

function codexResetCells(account, now = Date.now(), expiry = null) {
  const reset = resetSummary(account);
  let label = '-';
  if (account.enabled !== false && Number.isInteger(reset?.available) && reset.available >= 0) {
    label = String(reset.available);
    // Only a count that exists can have an expiry; a count of none shows none.
    const suffix = reset.available > 0 ? codexExpirySuffix(expiry, now) : '';
    if ((label + suffix).length <= ARST_W) label += suffix;
    const stale = reset.stale || account.refreshDead || account.subscriptionGone
      || (reset.checkedAt != null && now - reset.checkedAt > LISTING_FRESH_MS);
    if (stale && (label + '?').length <= ARST_W) label += '?';
    if (stale) label = gray(label);
    else label = reset.available > 0 ? green(label) : gray(label);
  }
  return rpad(gray('-'), MRST_W) + ' ' + rpad(label, ARST_W);
}

/** The five-hour-card cell ('5hR') — owner 2026-11-27: five-hour cards "should have
 *  their own column, and they should show nothing where they don't apply".
 *  Four DIFFERENT facts, never shown alike:
 *    blank        the column does not apply — anything but a z.ai account
 *    dim 0        a z.ai account whose card listing is fresh and shows NO 5h card
 *    n~3d green   n live five-hour cards, soonest expiry first (spendable now)
 *    n? grey      cards seen, but the listing is stale or old: a count we cannot vouch for
 *    ? grey       a z.ai account whose card listing was never read (unknown — NOT a zero)
 *  A disabled account shows blank too: its cards are not ours to spend, so a count would
 *  imply otherwise. */
function fiveHourResetCell(account, now = Date.now()) {
  const blank = ' '.repeat(FIVE_HOUR_RST_W);
  if (!account || account.provider !== 'zai' || account.enabled === false) return blank;
  const rc = account.resetCards;
  if (!rc || !Array.isArray(rc.fiveHour)) return rpad(gray('?'), FIVE_HOUR_RST_W);
  const stale = rc.stale === true || account.refreshDead || account.subscriptionGone
    || (rc.checkedAt != null && now - rc.checkedAt > LISTING_FRESH_MS);
  const live = rc.fiveHour.filter(c => c && !c.expired && (c.expiresAt == null || c.expiresAt > now));
  if (!live.length) {
    // No card. A stale "no card" is still a zero worth showing, but never in green.
    const text = rpad(stale ? gray('0?') : gray('0'), FIVE_HOUR_RST_W);
    return text;
  }
  let soonest = Infinity;
  for (const c of live) if (c.expiresAt != null && c.expiresAt < soonest) soonest = c.expiresAt;
  let text = String(live.length);
  if (soonest !== Infinity) {
    const days = (soonest - now) / 86400_000;
    text += days < 1 ? `~${Math.max(1, Math.round(days * 24))}h` : `~${Math.max(1, Math.round(days))}d`;
  }
  if (text.length > FIVE_HOUR_RST_W) text = String(live.length);
  if (stale && (text + '?').length <= FIVE_HOUR_RST_W) text += '?';
  return rpad(stale ? gray(text) : green(text), FIVE_HOUR_RST_W);
}

function codexLoginArgs(cli, name, account) {
  const args = [cli, 'login', '--codex'];
  if (name) args.push('--name', name);
  if (account?.remote) args.push('--cloud', '--pool', account.remote.linkName);
  else if (account) args.push('--local');
  return args;
}

function canRedeemCodexCredit(credit, now = Date.now()) {
  return credit?.status === 'available' && credit.supportedByPlan !== false
    && (credit.expiresAt == null || credit.expiresAt > now);
}

function quotaLabel(ratio, resetTs, width) {
  const rst = formatReset(resetTs);
  if (ratio == null || isNaN(ratio)) return (rst || '-').slice(0, width);
  const pct = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(0)}%`;
  const full = rst ? `${pct} ${rst}` : pct;
  if (full.length <= width) return full;
  return (rst || pct).slice(0, width);
}

/** Compact token count for the capacity page. Tokens are the apples-to-apples unit
 *  across Claude / GLM / Kimi, so the column must stay narrow and scannable. */
function formatTokens(n) {
  if (n == null) return '--';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

const ANALYTICS_PERIODS = ['1h', '24h', '7d', 'all'];

function cachePercent(window) {
  if (!Number.isFinite(window?.hit)) return '—';
  return Math.round(window.hit * 100) + '%' + (window.partial ? '*' : '');
}

function analyticsProvider(key) {
  return { claude: 'Claude', glm: 'GLM', kimi: 'Kimi', codex: 'Codex' }[key]
    || PROVIDER_LABELS[key] || key;
}

function formatMs(ms) {
  if (ms == null || isNaN(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec % 60);
  return `${min}m${String(rem).padStart(2, '0')}s`;
}

/** Coarse human duration for AGE and NEXT-REFRESH text: "45s", "12m", "2h".
 *  Deliberately not formatMs — "quota 12m03s old" spends precision on a number
 *  nobody reads to the second, and the extra digits are what made the old cell
 *  look like machine output. */
function formatAge(ms) {
  if (ms == null || isNaN(ms) || ms < 0) return '';
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

function statusColor(status) {
  if (status == null) return '-';
  if (status >= 200 && status < 300) return green(String(status));
  if (status === 429) return yellow(String(status));
  if (status >= 500) return red(String(status));
  return String(status);
}

/** Short live countdown to a timestamp, SINGLE-unit so it stays ≤3 chars
 *  ("41s"/"5m"/"23h"/"2d") and never overflows the status column: seconds under a
 *  minute (the common throttle cooldown), then minute/hour/day. '' once elapsed.
 *  Accepts a numeric ms timestamp (live account field) or an ISO string (snapshot). */
function countdown(ts) {
  if (!ts) return '';
  const target = typeof ts === 'string' ? Date.parse(ts) : ts;
  const ms = target - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.ceil(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.ceil(ms / 3_600_000)}h`;
  return `${Math.ceil(ms / 86_400_000)}d`;
}

/** ACTIVITY cell — "is this account working, and is it healthy?" in plain words.
 *  Rewritten twice on owner feedback (2026-08-27): first to symbols ("▶2 · 17/h ·
 *  8.5s"), which read as secret code; now to words. Average latency is GONE —
 *  "how long each request takes" is not something the owner acts on. An idle
 *  account renders NOTHING.
 *
 *    2 live · 17 req/hr · 1 failed · 3 slow connections to cloud
 *    17 req/hr                 working, idle this second
 *    (blank)                   resting — nothing to say
 *
 *  "slow connection(s) to cloud" (renamed from "link drops", 2026-11-22, owner wording): the connection to the
 *  team pool in the cloud gave out mid-request — the Mac's network, not the
 *  account. Yellow, never folded into "failed", fades 15m after it clears.
 */
function loadText(load) {
  const inflight = load?.current?.inFlight || 0;
  const hourReq = load?.last1h?.requests || 0;
  const failed = load?.last15m?.failed || 0;
  const linkFailed = load?.last15m?.linkFailed || 0;
  const bounced = load?.last15m?.bounced || 0;
  const eff = load?.last15m?.efficiency;
  // Dim below the volume floors (too few turns to mean much). A cloud row's figure is the
  // serving pool's own, team-wide on that account — tagged (team).
  const cacheTxt = eff && eff.hit != null ? `cache ${Math.round(eff.hit * 100)}%` : null;
  const cache = cacheTxt
    ? `${eff.lowVolume ? dim(cacheTxt) : cacheTxt}${load.last15m.team ? dim(' (team)') : ''}` : null;
  if (!inflight && !hourReq && !failed && !linkFailed && !bounced && !cache) return '';
  const parts = [];
  if (inflight) parts.push(`${inflight} live`);
  if (hourReq) parts.push(`${hourReq} req/hr`);
  if (cache) parts.push(cache);
  if (bounced) parts.push(dim(`${bounced} bounced`));
  if (failed) parts.push(red(`${failed} failed`));
  if (linkFailed) parts.push(yellow(`${linkFailed} slow connection${linkFailed === 1 ? '' : 's'} to cloud`));
  return parts.join(' · ');
}

/** The usage CAP is an account PROPERTY, not a state — so it renders whenever one
 *  is set, on every account type, whatever the account is doing. It previously
 *  lived inline in the provider branch only, so the OAuth account the feature was
 *  built for (max@gomokka.com) showed no cap anywhere: reported 2026-08-27, "I need
 *  to be able to see whether an account has a cap or not." Yellow while the cap is
 *  actively holding traffic back, dim otherwise. */
function capText(a, benched, am) {
  if (a?.capUtilization == null) return '';
  const floorPct = Math.round(a.capUtilization * 100);
  // DYNAMIC CAP (2026-09-24): the configured value is only a FLOOR — what routing
  // actually holds the account to right now is the ramped effective cap, which climbs
  // as the window nears its reset. Showing the floor alone would state a number the
  // scheduler is not using. `cap 50%>67%` reads as "reserved 50%, currently allowing
  // 67%"; the two collapse to one number while the cap sits at its floor, so an
  // early-window dynamic account looks exactly like the fixed one it replaced.
  // The WINDOW is named, not just the number. `cap 50%>75%` alone is ambiguous in the
  // way that matters for the decision the row exists to support ("is it safe for me to
  // use this account myself right now?"): a lift driven by the 5h window means reduced
  // protection for minutes, the same number off the weekly means DAYS of it. Council
  // finding 2026-09-24.
  const eff = capEffectivePct(am, a);
  const t = (eff != null && eff.pct !== floorPct)
    ? `cap ${floorPct}%>${eff.pct}% ${eff.window}`
    : `cap ${floorPct}%`;
  return benched ? yellow(t) : dim(t);
}

/** What routing is ACTUALLY enforcing on this account right now: the worse (lower) of
 *  its two windows' effective caps — the one that benches first — AND WHICH window that
 *  is. Returns {pct, window:'5h'|'wk'} or null for a fixed cap / when the manager cannot
 *  compute one. The window label is load-bearing: the same percentage means "protection
 *  is thin for the next few minutes" off the 5h window and "thin for days" off the weekly. */
function capEffectivePct(am, a) {
  if (!am?._effectiveCap || a?.capMode !== 'dynamic') return null;
  const vals = [['ses', '5h'], ['wk', 'wk']]
    .map(([w, label]) => ({ v: am._effectiveCap(a, w), window: label }))
    .filter(e => typeof e.v === 'number' && Number.isFinite(e.v));
  if (!vals.length) return null;
  const worst = vals.reduce((lo, e) => (e.v < lo.v ? e : lo));
  return { pct: Math.round(worst.v * 100), window: worst.window };
}

/** PER-ACCOUNT SETTINGS the user set by hand — the last column's whole job
 *  (owner, 2026-08-27: "the last column should contain any and all settings that
 *  are custom per account"). Fleet-wide settings (routing mode, peak policy) stay
 *  in the top header where they already live; only what is scoped to THIS account
 *  belongs on THIS row.
 *    preferred   this account is the manual routing pin (the 'p' key)
 *    cap NN%     its reserved-capacity ceiling (the 'c' key)
 *  Deliberately NOT here: automatic routing policies (peak, fast-refill) — those
 *  are the system's behaviour, not the user's settings; they keep their own tags.
 */
function settingsTags(am, a) {
  const tags = [];
  if (am?.routingMode === 'preferred' && a?.name === am.preferredAccountName) {
    tags.push(cyan('preferred'));
  }
  const capTag = capText(a, capBenched(am, a), am);
  if (capTag) tags.push(capTag);
  // A switched-off account whose credentials ALSO died keeps "disabled" in the status
  // column (so the disabled inventory stays readable at a glance) and carries the second
  // problem here. Without this the row would hide the fact that re-enabling it later
  // yields a broken account — the 2026-08-10 report that 8 disabled accounts were all
  // sitting on dead credentials.
  if (a?.enabled === false) {
    if (a.refreshDead) tags.push(yellow('needs login'));
    else if (a.subscriptionGone) tags.push(red('no sub'));
    return tags;   // disabled: never show card inventory either (owner gate)
  }
  return tags;
}

/** The session (5h) window is what keeps traffic off this account: a pure mirror of
 *  the router's _isSessionQuotaUnavailable, without its expiry-clearing write.
 *  Which readings expire on their reset is the ROUTER's rule, copied here: it clears
 *  the Claude 5h reading and the API-key limits when their reset passes, but NEVER
 *  a provider's (GLM/Kimi) providerSes — that stays until the next usage probe, so a
 *  provider past its reset stamp is still refused and must not read "active". */
/** $ per 1M processed tokens, monthly-normalized (audit D8, 2026-11-18): a monthly
 *  price buys 30.44/7 = 4.3486 weekly tanks per month, so the per-token price is
 *  price ÷ (weeklyTank × 4.3486) — the old code divided by ONE week's tank, making
 *  every price on the screen 4.35x too high (\$0.07 shown where the truth is \$0.0155).
 *  3 significant digits so small true prices never round to \$0.00 (D10). */
function pricePerMTokens(monthlyPrice, weeklyTankTokens) {
  if (!(monthlyPrice > 0) || !(weeklyTankTokens > 0)) return null;
  const perM = monthlyPrice / (weeklyTankTokens * (30.44 / 7) / 1e6);
  if (!(perM > 0)) return null;
  // Significant digits (red team F5): toFixed(3) still printed $0.000 for a $30/mo
  // plan over a 21.8B tank. Show 2 significant figures below 10 cents.
  if (perM >= 0.1) return '$' + perM.toFixed(2);
  // 2 significant digits below 10 cents: $0.015 (not $0.02), $0.0029 (not $0.003).
  return '$' + Number(perM.toPrecision(2)).toString();
}

/** Why a row has no finished, admitted cycle (audit D16, 2026-11-18): a plain '--'
 *  collapsed several distinct causes. Returns a short word for the Prev cell:
 *   '1st wk MM-DD' — no finished cycle yet; the first one closes on that date
 *   'old count'    — finished cycles exist but all predate the 2026-11-06 token count
 *   'too short'    — finished cycles exist but none was long/strong enough to measure
 *  null when the row HAS admitted history (the numbers render instead). */
function historyReason(am, a, win, nowOpen) {
  const hist = am?.capacityHistory ? am.capacityHistory(a, win) : (am?.capacity?.closedCycles?.(a.name, win) || []);
  if (!hist.length) {
    const ws = nowOpen?.windowStartedAt ?? a?.remoteOpen?.[win]?.windowStartedAt ?? null;
    const span = win === 'wk' ? 7 * 86400_000 : 5 * 3600_000;
    if (Number.isFinite(ws)) {
      const end = new Date(ws + span);
      const mm = String(end.getUTCMonth() + 1).padStart(2, '0'), dd = String(end.getUTCDate()).padStart(2, '0');
      return win === 'wk' ? `1st wk ${mm}-${dd}` : 'first 5h';
    }
    return 'no week yet';
  }
  if (hist.every(c => (c.axis ?? 'io') !== 'all')) return 'old count';
  return 'too short';
}

function sessionFull(am, a) {
  const q = a?.quota || {};
  const now = Date.now();
  const bench = am?._sessionBenchThreshold?.(a, now);
  if (!Number.isFinite(bench)) return false;
  const expired = reset => reset != null && now >= reset;
  if (q.unified5h != null && !expired(q.unified5hReset) && q.unified5h >= bench) return true;
  const apiLive = !(q.resetsAt && now >= new Date(q.resetsAt).getTime());
  if (apiLive && q.tokensLimit != null && q.tokensRemaining != null
      && 1 - q.tokensRemaining / q.tokensLimit >= bench) return true;
  if (apiLive && q.requestsLimit != null && q.requestsRemaining != null
      && 1 - q.requestsRemaining / q.requestsLimit >= bench) return true;
  if (q.providerSes != null && q.providerSes >= bench) return true;
  return false;
}

/** True when the WEEKLY window is what keeps traffic off this account — the router's
 *  own tier (_weeklyTier, the non-clearing half of _weeklyRawState) says 'exhausted'.
 *  Claude weekly readings are cleared at their reset by the manager, so a passed reset
 *  reads as free here without clearing anything; GLM readings are kept until the next
 *  usage check and the router keeps refusing until then, so they are judged as they
 *  stand. (Max 2026-11-18: four GLM rows read "active" next to "Wk 100%".) */
function weekFull(am, a, now = Date.now()) {
  if (typeof am?._weeklyTier !== 'function' || !a?.quota) return false;
  if (a.type !== 'provider' && a.quota.unified7dReset != null && now >= a.quota.unified7dReset) return false;
  return am._weeklyTier(a, now) === 'exhausted';
}

/** True when the reservation is what is currently keeping traffic off this account
 *  — either window at or past the cap. Reads the manager's own predicate so the
 *  label can never disagree with routing. */
function capBenched(am, a) {
  if (a?.capUtilization == null) return false;
  const q = a.quota || {};
  const ses = a.type === 'provider' ? q.providerSes : q.unified5h;
  const wk = a.type === 'provider' ? q.providerWk : q.unified7d;
  // Each reading is judged against ITS OWN window's cap — under the dynamic cap the
  // two differ (a 5h window nearly over is lifted while the weekly is still at its
  // floor), so passing the default window for both would mislabel one of them.
  if (am?._capped?.(a, ses, 'ses') || am?._capped?.(a, wk, 'wk')) return true;
  // Providers: the router's weekly gate judges max(5h, weekly) against the WEEKLY
  // cap (_weeklyRawState), so a 5h reading over the weekly cap benches it too.
  if (a.type === 'provider' && (ses != null || wk != null)) {
    return !!am?._capped?.(a, Math.max(ses ?? 0, wk ?? 0), 'wk');
  }
  return false;
}

export function weeklyPolicyText(am, account) {
  if (!am?._weeklyState || !account || account.type === 'provider') return '';
  const state = am._weeklyState(account);
  // USAGE CAP: the reservation outranks every tier label — a capped account is NOT
  // exhausted, it's deliberately held, and labelling it "Wk exhausted 50%" (red team)
  // while the bar shows half-full misstates the owner's own setting.
  if (state === 'capped') {
    // The WEEKLY window's own effective cap — the number that actually benched it.
    const eff = am._effectiveCap?.(account, 'wk');
    const pct = Math.round((Number.isFinite(eff) ? eff : account.capUtilization || 0) * 100);
    return yellow(`Cap ${pct}%`);
  }
  if (!state || state === 'unknown' || state === 'normal') return '';
  // SAY IT ONCE (2026-08-27). An account Anthropic is rejecting outright already
  // says so twice on this row: the Wk bar reads 100%, and the Status column reads
  // "exhausted". A third "Wk exhausted 100%" tag was pure repetition, and it pushed
  // the genuinely-informative tags (Cap, a per-model sub-limit) off to the right.
  // Dropped ONLY when the Status column carries the same fact — a soft/reserve/
  // critical row, or an exhausted-by-threshold row the status column shows as
  // "active", still needs the tag.
  if (am._isAccountWideRejected?.(account)) return '';
  const rawState = am._weeklyRawState?.(account) || state;
  const used = Number(account.quota?.unified7d);
  const pct = Number.isFinite(used)
    ? ` ${Math.max(0, Math.min(100, used * 100)).toFixed(0)}%`
    : '';
  const paceOnly = state !== rawState && rawState !== 'exhausted';
  const label = paceOnly ? `Pace ${state}` : `Wk ${state}`;
  let text = paceOnly ? label : `${label}${pct}`;
  // Critical-unlock visibility (2026-08-24): a red "Wk critical 96%" row that is
  // ACTIVELY ROUTING must say why, or the user watches a benched-looking account
  // hoover traffic with no explanation (the peak-shipped-invisible lesson).
  if (state === 'critical') {
    const u = am.criticalUnlockSummary?.(account);
    if (u) {
      const eta = u.etaMs != null ? ` ${(u.etaMs / 60000).toFixed(0)}m` : '';
      text += u.reason === 'prereset'
        ? ` ·drain${eta}`
        : u.reason === 'pressure' ? ' ·relief' : ' ·peak-relief';
    }
  }
  if (state === 'critical' || state === 'exhausted') return state !== rawState ? yellow(text) : red(text);
  if (state === 'reserve') return yellow(text);
  return cyan(text);
}

/**
 * Render a progress bar using background colors with text overlaid.
 * The label (e.g. "Ses 2h30m" or "45%") is drawn on top of the bar.
 */
function bar(ratio, w = 10, resetTs) {
  if (ratio == null || isNaN(ratio)) {
    // No data — dim background, show label or dash
    const label = quotaLabel(ratio, resetTs, w);
    const text = label.slice(0, w);
    const pad = w - text.length;
    const lp = Math.floor(pad / 2);
    const rp = pad - lp;
    return `${ESC}100m${' '.repeat(lp)}${text}${' '.repeat(rp)}${RESET}`;
  }

  ratio = Math.max(0, Math.min(1, ratio));
  const f = Math.round(ratio * w);
  // Background colors: 42=green, 43=yellow, 41=red; 100=bright black (gray) for empty
  const bg = ratio < 0.7 ? 42 : ratio < 0.9 ? 43 : 41;

  // Build the label to overlay: show both usage and reset when it fits.
  const label = quotaLabel(ratio, resetTs, w);
  const text = label.slice(0, w);
  const pad = w - text.length;
  const lp = Math.floor(pad / 2);
  const rp = pad - lp;
  const chars = (' '.repeat(lp) + text + ' '.repeat(rp));

  // Split chars into filled (colored bg) and empty (gray bg) portions
  const filled = chars.slice(0, f);
  const empty = chars.slice(f);

  let out = '';
  if (filled) out += `${ESC}${bg};97m${filled}`;
  if (empty) out += `${ESC}100;37m${empty}`;
  out += RESET;
  return out;
}

// A gray placeholder the EXACT visible width of a bar(), for a quota that's absent
// or unpollable (label "—" / "n/a" / "probing"). Mirrors bar()'s no-data branch so
// provider rows stay column-aligned with OAuth rows.
function emptyBar(label, w = 10) {
  const text = String(label).slice(0, w);
  const pad = Math.max(0, w - text.length);
  const lp = Math.floor(pad / 2);
  const rp = pad - lp;
  return `${ESC}100m${' '.repeat(lp)}${text}${' '.repeat(rp)}${RESET}`;
}

/**
 * The "Fbl" bar: one model family's weekly limit, which Anthropic counts separately
 * from the account-wide weekly. Drawn with the same bar() as Ses and Wk, so it reads
 * the same way (used% and time to reset). Shows the empty dash cell when there is
 * nothing to show: a provider row, no probe result yet, or a limit Anthropic marks
 * as inactive. Routing
 * and the "Fable NN%" tag ignore an inactive limit too, so the bar stays quiet as well.
 */
function scopedWeeklyBar(quota, family, w) {
  const e = quota?.scopedWeekly?.[family];
  // is_active=false still carries a REAL reading (percent + reset days out): the
  // limit exists and counts. Only a MISSING reading dashes.
  if (!e || e.utilization == null) return emptyBar('—', w);
  return bar(e.utilization, w, e.resetAt);
}

/** Write a provider's enabled flag into the CONFIG entry `loadConfigProviders` reads.
 *
 *  A config-sourced provider is re-created from config on every reload
 *  (`enabled: entry.enabled !== false`), so a runtime-only flag is undone by the next
 *  auto-update. Measured 2026-09-11: Kimi, disabled by the owner, came back enabled
 *  after an update because its config entry carried no `enabled` key.
 *
 *  Returns `{changed, previous}` so the caller can roll back if the save fails.
 *  `changed:false` means there is no config entry — a header-derived provider, whose
 *  runtime-only flag IS durable for it.
 */
export function applyProviderEnabledToConfig(config, name, enabled) {
  const list = config?.providers;
  if (!Array.isArray(list)) return { changed: false, previous: undefined };
  const i = list.findIndex(p => p?.name === name);
  if (i < 0) return { changed: false, previous: undefined };
  const previous = list[i].enabled;
  list[i].enabled = enabled;
  return { changed: true, previous };
}

export const __tuiTest = { applyProviderEnabledToConfig, formatReset, quotaLabel, bar, emptyBar, scopedWeeklyBar, barLayout, strip, loadText, countdown, acctHeader, fitLine, providerLabel, weeklyPolicyText, capText, capEffectivePct, codexLoginArgs, codexResetCells, codexExpirySuffix, fiveHourResetCell, show5hColumn, barStart };

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ── TUI class ────────────────────────────────────────────────

/** Compact plan cell: "Max Q $134/mo". '--' when no plan is configured (no guessing).
 *  D13 (audit 2026-11-18): when no plan OBJECT exists but the pool knows a live
 *  monthly price (the z.ai prober's subscription reading), show the price so the
 *  Plan cell and the row's $/1M agree — a '--' Plan next to a priced $/1M was a
 *  contradiction on all 13 GLM rows. */
function planLabel(plan, priceAccount = null, am = null) {
  if (!plan) {
    const p = am?.monthlyPriceFor?.(priceAccount);
    if (p != null) return `--  $${Math.round(p)}/mo`;
    return '--';
  }
  const cad = { monthly: 'M', quarterly: 'Q', annual: 'A', annually: 'A', yearly: 'A' }[plan.cadence] || '';
  const tier = (plan.tier || '').replace(/^(claude|glm coding)\s+/i, '');
  const monthly = plan.priceUsd != null && plan.billingMonths ? plan.priceUsd / plan.billingMonths : null;
  return [tier, cad, monthly != null ? `$${Math.round(monthly)}/mo` : ''].filter(Boolean).join(' ') || '--';
}

/** Where a finished browser login goes. mirror → that team pool; a brand-new
 *  account (no mirror, not already local) with a keyed linked pool → ask (first
 *  keyed link); else local. */
export function decideLoginTarget({ mirror, links, existing, accountUuid }) {
  if (mirror) return { kind: 'mirror', mirror };
  if (existing) return { kind: 'local' };
  const link = (Array.isArray(links) ? links : []).find(l => l && l.url && l.key);
  if (!link) return { kind: 'local' };
  // The team pool dedupes by account id; without it a re-login would ADD a duplicate.
  if (!accountUuid) return { kind: 'no-uuid' };
  return { kind: 'ask-team', link };
}

export class TUI {
  constructor({ accountManager, config, saveConfig, syncAccounts, onQuotaRecheck, onQuit, onRestart, spawnDetached,
    codexResetDetails, redeemCodexReset, onSetCodexAutoRedeem }) {
    this.am = accountManager;
    // Runs the tmux detach for q in service mode; a seam so tests never start tmux.
    this._spawnDetached = spawnDetached || ((cmd, args) => {
      try { spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* no tmux */ }
    });
    this.config = config;
    this.saveConfig = saveConfig;
    this.syncAccounts = syncAccounts;
    this.onQuotaRecheck = onQuotaRecheck;
    this.onQuit = onQuit;
    this.onRestart = onRestart;
    this.codexResetDetails = codexResetDetails;
    this.redeemCodexReset = redeemCodexReset;
    this.onSetCodexAutoRedeem = onSetCodexAutoRedeem;
    this._startedAt = Date.now();   // the efficiency line's "since restart" window
    // Set by index.js after construction (a deferred closure, not a constructor literal —
    // avoids the const TDZ on applyUpdateIfReady, which is defined after `new TUI`).
    this.checkNow = null;
    this.updateBusy = null;   // live progress text while an update check/apply runs

    this.log = [];           // completed activity entries
    this.active = new Map(); // in-flight requests
    this.mode = 'normal';    // normal | accounts | routing | capacity | select | input | confirm | providers | addtype
    this.analyticsMetrics = new WeakMap();
    this.capacityWindow = 'wk'; // default weekly — the true tank (owner 2026-10-31); 'w' toggles to 5h
    // Hide disabled accounts from the table. With 8 dead/disabled accounts the live
    // ones scroll off the top; `h` collapses them to a one-line summary.
    // Restored from config so an auto-update/reload does not un-hide what the user hid.
    this.hideDisabled = this.config?.ui?.hideDisabled === true;
    this.selAction = null;   // prefer | toggle | delete
    this.selIdx = 0;
    this.inputPrompt = '';
    this.inputBuf = '';
    this.inputCb = null;
    this.inputSensitive = false;
    this.confirmTitle = '';
    this.confirmDetail = '';
    this.confirmCb = null;
    this.confirmReturnMode = 'normal';
    this.codexResets = null;
    this.frame = 0;
    this.running = false;
    this.timer = null;
    this._origLog = null;
    this._origErr = null;
    // Terminal output state (2026-11-12 freeze fix): _nb = stdout made non-blocking by
    // start(); _renderTimer = the one scheduled coalesced render; _lastFrame /
    // _lastFullWriteAt = what the terminal last got and when; _forceNext = the next
    // frame must be sent even if unchanged; _drainArmed = one 'drain' listener pending.
    this._nb = false;
    this._renderTimer = null;
    this._lastRenderAt = 0;
    this._lastFrame = null;
    this._lastFullWriteAt = 0;
    this._forceNext = false;
    this._drainArmed = false;
    this._onDrain = () => { this._drainArmed = false; if (this.running) this.render(); };
  }

  // ── lifecycle ──────────────────────────────────────

  /** `rawWhenDrained` (a worker that is already serving — reload takeover, a respawn):
   *  enter raw mode only once the terminal has taken our first frame. setRawMode is
   *  tcsetattr(TCSADRAIN) and blocks the WHOLE process until the terminal has read
   *  everything queued; on a terminal that is not reading that is forever, and the port
   *  goes dead with it (2026-11-13). So the dashboard is drawn non-blocking first and the
   *  mode switch waits for the terminal (reclaimRawMode) — the keyboard, not the serving,
   *  is what a stalled terminal delays. A terminal that took the frame at once gets raw
   *  mode synchronously, so a broken one still falls back to plain logs (returns false). */
  start({ rawWhenDrained = false, modeSwitcher = null } = {}) {
    const rawError = err => `[Maxpool] TUI unavailable (${err.code || err.message}); continuing with plain logs.\n`;
    if (rawWhenDrained) {
      if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
        process.stderr.write(rawError({ message: 'stdin is not a terminal' }));
        return false;
      }
    } else {
      try {
        process.stdin.setRawMode(true);
      } catch (err) {
        process.stderr.write(rawError(err));
        return false;
      }
    }

    this.running = true;
    // Never block the pool on its own terminal (2026-11-12): Node writes a TTY
    // synchronously, so a terminal that fell behind stopped EVERY request for up to 60s.
    // Real TTYs only (r2 S3); a later stop() leaves it non-blocking (the exit path alone
    // turns blocking back on — writeTerminalSync).
    if (!this._nb && isatty(process.stdout.fd) && typeof process.stdout._handle?.setBlocking === 'function') {
      process.stdout._handle.setBlocking(false);
      this._nb = true;
    }
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this._dataHandler = d => this._onData(d);
    this._resizeHandler = () => this.forceRender();
    process.stdin.on('data', this._dataHandler);
    process.stdout.on('resize', this._resizeHandler);

    // Redirect console to activity log
    this._origLog = console.log;
    this._origErr = console.error;
    console.log = (...a) => this._addLog(a.join(' '));
    console.error = (...a) => this._addLog(a.join(' '));

    this.forceRender();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.requestRender();
    }, 500);
    if (rawWhenDrained && modeSwitcher) {
      // Off this thread (terminal-mode.js): the pool keeps serving however long the
      // terminal takes to read. Without a helper (no controlling terminal) fall back.
      modeSwitcher.setRaw(true).then(r => {
        if (r.ok) {
          if (r.ms >= 100) appendEventLog(`[Maxpool] TUI: keyboard ready after the terminal caught up (${r.ms}ms)`);
          return;
        }
        if (!this.running) return;
        appendEventLog(`[Maxpool] TUI: terminal helper unavailable (${r.error}); keyboard waits for the terminal to read`);
        reclaimRawMode({ flush: o => this.flushOutput(o), guard: () => this.running }).catch(() => {});
      }).catch(() => {});
    } else if (rawWhenDrained) {
      if (!process.stdout.writableLength) {
        // The terminal took the whole frame: it is reading, so the drain wait is short.
        try {
          process.stdin.setRawMode(true);
        } catch (err) {
          this.stop({ keepRaw: true });
          console.error(rawError(err).trim());
          return false;
        }
      } else {
        reclaimRawMode({ flush: o => this.flushOutput(o), guard: () => this.running })
          .then(now => { if (!now) appendEventLog('[Maxpool] TUI: keyboard waits for the terminal to read (raw mode deferred to drain)'); })
          .catch(() => {});
      }
    }
    return true;
  }

  /** Stop drawing frames (no more renders, no drain wake-up) and stop taking keys, so
   *  nothing typed during a hand-off wait acts; the screen stays as is. */
  _haltRendering() {
    this.running = false;
    if (this._dataHandler) process.stdin.removeListener('data', this._dataHandler);
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    if (this._drainArmed) { process.stdout.removeListener('drain', this._onDrain); this._drainArmed = false; }
  }

  /** `exiting`: called from the process-exit path — the exit sequence must be written
   *  synchronously or it is lost with the non-blocking stream's queue (r2 B1).
   *  `keepRaw`: leave the terminal's raw mode as is. Node switches it with
   *  tcsetattr(TCSADRAIN), which BLOCKS the whole process until the terminal has read
   *  everything already sent (measured: 2.8s for a terminal that read nothing for 3s) —
   *  so a process that keeps serving after stop() must not switch it while the
   *  terminal may be behind. */
  stop({ exiting = false, keepRaw = false } = {}) {
    this._haltRendering();
    if (this._origLog) { console.log = this._origLog; console.error = this._origErr; }
    process.stdin.removeListener('data', this._dataHandler);
    process.stdout.removeListener('resize', this._resizeHandler);
    if (exiting) writeTerminalSync(EXIT_SEQ);
    else process.stdout.write(EXIT_SEQ);
    if (!keepRaw) { try { process.stdin.setRawMode(false); } catch {} }
    process.stdin.pause();
  }

  /** Give the terminal up to someone else (a self-update's new worker, a login prompt)
   *  while this process keeps running (r2 B2): let the frames a slow terminal is still
   *  taking land, then the exit sequence, each bounded by timeoutMs — so the next
   *  writer never interleaves with our queue, and blocking is never turned back on. */
  async handOff({ timeoutMs = 1500, flushing = null, keepRaw = false } = {}) {
    await (flushing || this.beginHandOff({ timeoutMs }));
    this.stop({ keepRaw });
    await this.flushOutput({ timeoutMs });
  }

  /** First half of handOff, started early so the terminal catches up while the caller
   *  does other work: stop drawing and taking keys, and return the flush (pass it to
   *  handOff as `flushing`). Gate on that promise — `running` is already false. */
  beginHandOff({ timeoutMs = 1500 } = {}) {
    this._haltRendering();
    return this.flushOutput({ timeoutMs });
  }

  /** Resolve once the terminal has taken everything queued for it: true when drained,
   *  false at timeoutMs. 'drain' fires only after a write hit the high-water mark, so
   *  the queue length is polled too. */
  flushOutput({ timeoutMs = 1500 } = {}) {
    const out = process.stdout;
    if (!out.writableLength) return Promise.resolve(true);
    return new Promise(resolve => {
      const finish = drained => {
        clearTimeout(deadline); clearInterval(poll);
        out.removeListener('drain', onDrain);
        resolve(drained);
      };
      const onDrain = () => { if (!out.writableLength) finish(true); };
      const deadline = setTimeout(() => finish(false), timeoutMs);
      const poll = setInterval(onDrain, 25);
      out.on('drain', onDrain);
    });
  }

  // ── server hooks ───────────────────────────────────

  onRequestStart(id, info) {
    this.active.set(id, { ...info, t: timestamp(), started: Date.now(), account: null, caller: info.caller || null, conversation: info.conversation || null });
    this.requestRender();
  }

  onRequestRouted(id, info) {
    const r = this.active.get(id);
    if (r) r.account = info.account;
  }

  /** First response byte reached the client (server.js markFirstByte). */
  onRequestFirstByte(id) {
    const r = this.active.get(id);
    if (r && r.firstByteAt == null) r.firstByteAt = Date.now();
  }

  onRequestEnd(id, info) {
    const r = this.active.get(id);
    this.active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    // Named-caller attribution (team pools): prefix the log line with the person
    // whose pool key authenticated the request. Null on legacy/local setups.
    const who = info.caller || r?.caller ? `${info.caller || r?.caller} · ` : '';
    // Tag PROVIDER-routed requests with the maxpool session id so provider traffic
    // (when-exhausted overflow, or an incompatible-session pin) is traceable back to
    // the session that caused it: grep the event log for `→ glm-fallback … [sess X]`,
    // then `ps eww -p <pid> | grep x-maxpool-session` to find the terminal. Truthiness
    // guard — a header-less request has sessionKey '' (server.js headerValue) → no tag.
    const isProvider = this.am.accounts.find(a => a.name === acct)?.type === 'provider';
    // Turn tags (2026-11-08): [sess <terminal>] on provider rows (unchanged), and
    // [cv <conversation> <terminal>] on every row — the exact join a cache analysis
    // needs between a transcript turn and the ACCOUNT that served it (previously
    // only a timestamp window, too noisy to separate an account switch from cache
    // expiry; peer audit 2026-11-08). Short: log stays scannable.
    const provTag = (isProvider && r?.sessionKey) ? `  [sess ${String(r.sessionKey).slice(0, 8)}]` : '';
    const cv = info.conversation || r?.conversation;
    const cvTag = cv ? `  [cv ${cv.slice(0, 8)} ${String(info.sessionKey || r?.sessionKey || '').slice(0, 8)}]` : '';
    // ttfb LAST: the UPSTREAM wait of the attempt that served — its fetch resolve
    // minus its own forward start (D, 2026-11-10). Never measured from arrival:
    // that would add queue wait and earlier failover attempts. Falls back to the
    // client-write stamp from arrival when no upstream pair exists (a request that
    // never reached upstream, the link path). Omitted when no byte was ever sent.
    let ttfbMs = null;
    if (info.firstUpstreamByteAt != null && info.upstreamForwardStartAt != null) {
      ttfbMs = info.firstUpstreamByteAt - info.upstreamForwardStartAt;
    } else if (r?.firstByteAt != null) {
      ttfbMs = r.firstByteAt - r.started;
    }
    const ttfbTag = ttfbMs != null ? ` ttfb=${(Math.max(0, ttfbMs) / 1000).toFixed(1)}s` : '';
    // B8: ' ns' = a non-streaming request (strict false: the oauth relay carries no shape, so no tag).
    const nsTag = info.stream === false ? ' ns' : '';
    // The served attempt's cache figures (~25B, well inside the 480B line cap): whether
    // the cache held is the one thing a request line could not say (#642 port).
    const cacheLabel = cacheUsageLabel(info.cacheUsage);
    const cacheTag = cacheLabel ? ` ${CACHE_PAINT[cacheUsageState(info.cacheUsage)](cacheLabel)}` : '';
    // ttfb= stays the LAST field — the request-line contract (reset-count-stale-and-ttfb
    // test 13); the cache tag goes just before it.
    this._addLog(`${who}${info.method} ${info.path} → ${acct} (${info.status}, ${dur}s)${nsTag}${provTag}${cvTag}${cacheTag}${ttfbTag}`);
  }

  _addLog(msg) {
    msg = msg.replace(/^\[Maxpool\]\s*/, '');
    // Persist too — in TUI mode console is re-pointed here, bypassing the console
    // mirror, so this is where TUI-mode lines reach the on-disk event log.
    appendEventLog(msg);
    this.log.unshift({ t: timestamp(), msg });
    if (this.log.length > 200) this.log.length = 200;
    // Scheduled, not drawn: a burst of N lines is ONE frame (was N full screens).
    this.requestRender();
  }

  // ── input handling ─────────────────────────────────

  _onData(d) {
    if (d === '\x1b[A') return this._key('up');
    if (d === '\x1b[B') return this._key('down');
    if (d === '\x1b') return this._key('esc');
    if (d === '\x03') return this._key('ctrl-c');
    if (d === '\x7f' || d === '\x08') return this._key('bs');

    // Input mode accepts typed AND pasted text. A terminal delivers a paste as
    // one multi-char chunk — often wrapped in bracketed-paste markers and/or
    // ending in a newline. Sanitize the chunk instead of all-or-nothing
    // rejecting it (which silently dropped pasted API keys): strip the paste
    // markers, take the text up to the first newline, drop control chars, append
    // it, and treat an embedded newline as Enter (submit).
    if (this.mode === 'input') {
      // Prepend any partial escape held from the previous chunk so a bracketed-
      // paste marker split across two stdin reads (e.g. "\x1b[20" then "0~key")
      // is recognized rather than appended as literal text.
      let chunk = (this._pendingPaste || '') + d;
      this._pendingPaste = '';
      chunk = chunk.replace(/\x1b\[20[01]~/g, '');
      // Hold back a trailing fragment that could be the start of a paste marker.
      const partial = chunk.match(/\x1b(?:\[(?:2(?:0[01]?)?)?)?$/);
      if (partial) {
        this._pendingPaste = partial[0];
        chunk = chunk.slice(0, chunk.length - partial[0].length);
      }
      const nlIdx = chunk.search(/[\r\n]/);
      const typed = (nlIdx === -1 ? chunk : chunk.slice(0, nlIdx))
        .split('')
        .filter(c => c >= ' ' && c !== '\x7f')
        .join('');
      if (typed) { this.inputBuf += typed; this.forceRender(); }
      if (nlIdx !== -1) { this._pendingPaste = ''; return this._key('enter'); }
      return;
    }

    if (d === '\r' || d === '\n') return this._key('enter');
    if (d.length === 1 && d >= ' ') return this._key(d);
  }

  _key(k) {
    if (k === 'ctrl-c') { this.stop(); this.onQuit?.(); return; }

    switch (this.mode) {
      case 'normal': this._keyNormal(k); break;
      case 'accounts': this._keyAccounts(k); break;
      case 'routing': this._keyRouting(k); break;
      case 'updates': this._keyUpdates(k); break;
      case 'capacity': this._keyCapacity(k); break;
      case 'people': this._keyPeople(k); break;
      case 'analytics': this._keyAnalytics(k); break;
      case 'addtype': this._keyAddType(k); break;
      case 'select': this._keySelect(k); break;
      case 'input':  this._keyInput(k); break;
      case 'confirm': this._keyConfirm(k); break;
      case 'codexResets': this._keyCodexResets(k); break;
    }
    this.forceRender();
  }

  /** Close every viewer of the service dashboard (viewers are view-only); the pool
   *  keeps running. `-s pool` detaches all clients of the session, deterministically. */
  detachView() {
    const sock = process.env.MAXPOOL_TMUX_SOCK;
    this._spawnDetached('tmux', [...(sock ? ['-S', sock] : []), 'detach-client', '-s', 'pool']);
  }

  _keyNormal(k) {
    if (k === 'q' && serviceMode()) {
      // Under the background service the pool lives in a tmux pane launchd owns:
      // stopping it here would only make launchd cold-restart it. q closes the view.
      this.detachView();
    } else if (k === 'q') {
      this._confirm(
        'Stop Maxpool?',
        'New requests will stop; active requests will drain before the server exits.',
        () => { this.stop(); this.onQuit?.(); },
      );
    } else if (k === 'r') {
      this._confirm(
        'Restart Maxpool?',
        // Say what actually happens to the user's sessions. The old text ("pause new
        // requests, drain active work") was accurate but hid the consequence: with
        // several long requests in flight, NEW requests get a 503 for up to the drain
        // window, and every running session sees a retry. Reported 2026-08-10: "I click
        // restart, then yes, and NOTHING happens" — while ~30 sessions were 503-ing.
        this._restartConfirmDetail(),
        // Do NOT stop the TUI here — let the reload path own it: cold restart stops
        // it in restartWorkerNow, a seamless reload in releaseBatonAndDrain (on
        // MSG_RELEASE). If the reload ROLLS BACK (new worker fails to boot), neither
        // fires, so the TUI keeps rendering instead of being stranded in plain-log
        // mode. (The worker also self-heals admission — see index.js reload watchdog.)
        () => { this.onRestart?.(); },
      );
    } else if (k === 'a') {
      this.mode = 'accounts';
    } else if (k === 'm') {
      this.mode = 'routing';
    } else if (k === 's') {
      this._confirm(
        'Sync accounts now?',
        'Reload account credentials and newly added accounts from the config file.',
        () => this._doSync(),
      );
    } else if (k === 'u') {
      this.mode = 'updates';
    } else if (k === 'v') {
      this._openAnalytics();
    } else if (k === 'y') {
      this.mode = 'capacity';
    } else if (k === 'p') {
      this.mode = 'people';
    } else if (k === 'h') {
      this.hideDisabled = !this.hideDisabled;
      this._addLog(this.hideDisabled ? 'Hiding disabled accounts' : 'Showing all accounts');
      // Persist the view choice; a reload otherwise resets it to "show all" every time.
      // Fully defensive: a VIEW preference must never break the toggle itself, and the
      // TUI is constructed without a config in several tests and in early startup.
      if (this.config) {
        this.config.ui = { ...(this.config.ui || {}), hideDisabled: this.hideDisabled };
        try { this.saveConfig?.(this.config)?.catch?.(() => {}); } catch { /* view-only */ }
      }
    }
    // Enable/disable lives ONLY under [a] Accounts now (with rename/delete/login) —
    // one home for every account mutation, instead of a duplicate top-level toggle.
  }

  // Automatic updates are "on" only when the whole chain is enabled: check npm →
  // install to disk → seamlessly reload. Any one off means a release won't land hands-free.
  _autoUpdateOn() {
    const c = this.config || {};
    return c.updateCheck !== false && c.autoUpdate === true && c.autoApply === true;
  }

  _keyUpdates(k) {
    if (k === 'c') {
      // Check & apply now — the dance-killer: pull the latest + seamless-reload in place,
      // no quit/relaunch. STAY on this screen and show live progress: bouncing straight
      // back to the dashboard was indistinguishable from "nothing happened".
      if (!this.checkNow) { this._addLog('Update check unavailable on this worker'); return; }
      if (this.updateBusy) return;                       // already running
      this.updateBusy = 'Checking npm…';
      this.forceRender();
      Promise.resolve(this.checkNow())
        .catch(() => {})
        .finally(() => {
          // If an update was found+applied, the seamless reload replaces this worker and
          // this never renders. Otherwise report the outcome in place.
          this.updateBusy = null;
          if (this.mode === 'updates') this.forceRender();
        });
    } else if (k === 't') {
      this._toggleAutoUpdate();
    } else if (k === 'esc' || k === 'q') {
      this.mode = 'normal';
    }
  }

  /** The visible Updates panel. Answers, at a glance: what am I running, is anything
   *  newer, is it automatic, and what is happening right now. */
  /** The Routing header line. Split out so a test can assert the RENDERED string —
   *  matching source text is how a header that contradicted routing survived review. */
  /** The "Cross-provider: …" fragment. Its own method so a test can assert what the user
   *  actually sees without needing a TTY — the previous version read a superseded global
   *  and contradicted routing, and only a source-text test would have "passed" on it. */
  _crossProviderText() {
    // Show the EFFECTIVE policy, i.e. what actually governs routing. Since per-provider
    // settings were added, `_claudeFallbackFor(provider)` decides — and the legacy global
    // knob this used to read is only its fallback when a provider has no entry of its own.
    // Reading the global made the header contradict both the footer and reality: it said
    // "when-exhausted" while GLM and Kimi were each set to "always" and routing agreed
    // with the footer, not the header.
    const provs = this.am.accounts.filter(a => a.type === 'provider');
    if (!provs.length) return '';   // no GLM/Kimi in this pool — the whole line is meaningless
    const eff = [...new Set(provs.map(a => this.am._claudeFallbackFor?.(a.provider)
      || this.am._crossProviderFallbackPolicy?.() || 'when-exhausted'))];
    const colour = v => (v === 'never' ? yellow(v) : v === 'always' ? green(v) : cyan(v));
    if (eff.length === 1) {
      return `  ${dim('·')}  ${dim('Cross-provider:')} ${colour(eff[0])}`;
    } else {
      // Providers disagree — naming each is the only honest summary; a single word here
      // would misdescribe at least one of them.
      const parts = provs.map(a => `${a.provider === 'zai' ? 'GLM' : a.provider === 'kimi' ? 'Kimi' : a.provider}: `
        + colour(this.am._claudeFallbackFor?.(a.provider) || 'never'));
      return `  ${dim('·')}  ${dim('Cross-provider:')} ${parts.join(dim(' / '))}`;
    }
  }

  /** The peak fragment for the routing header: `GLM peak · ends in 2h05m` while any
   *  provider is inside its window, '' otherwise. Names the window end so the 4h
   *  shape is legible; per-account detail lives in the row tags. `now` is injectable
   *  so a test can assert the rendered string without waiting for 06:00 UTC. */
  _peakHeaderNote(now = Date.now()) {
    const parts = [];
    const seen = new Set();
    for (const a of this.am.accounts) {
      if (a.type !== 'provider' || seen.has(a.provider)) continue;
      seen.add(a.provider);
      const st = this.am._peakStateFor?.(a.provider, now);
      if (!st?.inPeak || !st.endsAt) continue;
      const label = a.provider === 'zai' ? 'GLM' : a.provider === 'kimi' ? 'Kimi' : a.provider;
      const mins = Math.max(0, Math.ceil((st.endsAt - now) / 60_000));
      parts.push(`${yellow(label + ' peak')} ${dim(`ends in ${Math.floor(mins / 60)}h${String(mins % 60).padStart(2, '0')}m`)}`);
    }
    return parts.join('  ');
  }

  /** ` People  max 120 · ahmed 40 · andrey 7` — requests per person since start.
   *  Merges this pool's named callers with every linked team pool's callers (the
   *  cloud's view of who used it). '' when nobody named has used the pool. */
  _peopleLine(W = 80) {
    const totals = new Map();
    for (const [n, c] of this.am.callerCounts || []) totals.set(n, (totals.get(n) || 0) + c);
    for (const l of this.am.poolLinks || []) {
      for (const [n, v] of Object.entries(l.status?.callers || {})) {
        totals.set(n, Math.max(totals.get(n) || 0, v?.requests || 0));
      }
    }
    totals.delete('legacy-key');
    if (!totals.size) return '';
    const parts = [...totals.entries()].sort((x, y) => y[1] - x[1])
      .map(([n, c]) => `${n} ${cyan(String(c))}`);
    const line = ` People   ${parts.join(dim(' · '))}`;
    return vw(line) > W ? line.slice(0, W) : line;
  }

  _routingLine(routing, xpText) {
    return ` Routing  ${cyan(routing)}${xpText}`;
  }

  /** Keep the two cache windows paired with each provider in the overview. */
  _cacheLine(W = 80, now = Date.now()) {
    const recent = this.am.efficiencyOverall?.('last15m', now);
    if (!recent) return null;
    const day = this.am.efficiency24h?.(now) || {};
    const dayHit = group => group?.hit != null && group.served >= 20 ? group.hit : null;
    const groups = [['claude', 'Claude'], ['glm', 'GLM']];
    if (recent.codex || day.codex) groups.push(['codex', 'Codex']);
    const hasDay = groups.some(([key]) => dayHit(day[key]) != null);
    if (!hasDay && groups.every(([key]) => !(recent[key]?.served || recent[key]?.bounced))) return null;
    const sinceMs = now - (this._startedAt ?? now);
    const since = sinceMs < 15 * 60_000 ? dim(`  since restart ${Math.max(1, Math.round(sinceMs / 60_000))}m`) : '';
    if (!hasDay && groups.every(([key]) => !recent[key] || recent[key].lowVolume)) {
      return truncLine(` Cache    ${dim('— (little traffic)')}${since}`, W);
    }
    const pct = hit => hit == null ? dim('—') : `${Math.round(hit * 100)}%`;
    const parts = groups.map(([key, label]) => {
      const period = recent[key];
      const short = pct(period?.hit);
      return `${label} ${period?.lowVolume && period.hit != null ? dim(short) : short}/${pct(dayHit(day[key]))}`;
    });
    const figures = `${dim('[15m/24h]')}  ${parts.join(' · ')}`;

    const claude = recent.claude;
    const hour = this.am.efficiencyOverall('last1h', now).claude;
    const drift = !claude.lowVolume && !hour.lowVolume && claude.hit != null && hour.hit != null && hour.hit - claude.hit >= 0.15;
    const severe = !claude.lowVolume && claude.hit != null && claude.hit < 0.5;
    if (severe) {
      const account = this._worstCacheAccount() || '?';
      const prefix = ` ${red('Cache')}    `;
      const line = `${prefix}${red(`⚠ Claude ${pct(claude.hit)} on ${account}`)} · ${figures}`;
      if (vw(line) <= W) return truncLine(line + since, W);
      return truncLine(`${prefix}${figures} · ${red(`⚠ ${account}`)}`, W);
    }
    const warn = (!claude.lowVolume && claude.hit != null && claude.hit < 0.7) || drift;
    return truncLine(` ${warn ? yellow('Cache') : green('Cache')}    ${figures}${since}`, W);
  }

  _missTxt(t) {
    if (t == null) return '—';
    return t >= 1e6 ? `${(t / 1e6).toFixed(1)}M tok` : `${Math.round(t / 1000)}k tok`;
  }

  /** The moves half of the old efficiency line: causes only, no cache figures.
   *  cross/100 is the costly signal (the prompt re-wrote wholesale on the new
   *  family). same-family moves split by WHY they left the holder — outscored (the
   *  sibling won on load), hold-ceiling (the depth cap released it), released (a
   *  hold gate let go) — so a wave of moves names its driver instead of a bare
   *  count. "glm moved-busy" (renamed from the mislabeled "busy-bounced": these
   *  are moves, not bounces) stays as the GLM capacity note. */
  _movesLine(W = 80, now = Date.now()) {
    const eff = this.am.efficiencyOverall?.('last15m', now);
    if (!eff) return null;
    const groups = [eff.claude, eff.glm, eff.codex].filter(Boolean);
    const total = field => groups.reduce((sum, group) => sum + (group[field] || 0), 0);
    const by = (field, key) => groups.reduce((sum, group) => sum + (group[field]?.[key] || 0), 0);
    const served = total('served');
    const bounced = total('bounced');
    if (served + bounced === 0) return null;
    if (served === 0) return truncLine(` Moves   ${dim('— (no served traffic)')}`, W);
    const pctTxt = x => `${Math.round(x * 100)}%`;
    const per100 = n => Math.round(n * 100 / served);
    const cross = total('movedCross');
    const same = total('movedSame');
    const why = k => by('movedByWhy', k);
    const parts = [`cross ${per100(cross)}/100`];
    if (same) {
      const whyTxt = ['outscored', 'holdCeiling', 'released', 'other'].filter(k => why(k) > 0)
        .map(k => `${k === 'holdCeiling' ? 'hold-ceiling' : k} ${why(k)}`).join(' · ');
      parts.push(`same ${same}${whyTxt ? ` (${whyTxt})` : ''}`);
    }
    const cause = k => by('movedByCause', k);
    const causeTxt = ['busy', 'balance', 'wall', 'link'].filter(k => cause(k) > 0).map(k => `${k} ${cause(k)}`).join(' · ');
    if (causeTxt) parts.push(causeTxt);
    const bounceShare = bounced / (served + bounced);
    if (bounced) parts.push(`bounced ${pctTxt(bounceShare)}${bounceShare > 0.05 ? dim(` (worst: ${this._mostBouncedAccount(now) || '?'})`) : ''}`);
    const glmBusy = eff.glm?.movedByCause?.busy || 0;
    if (glmBusy) parts.push(`glm moved-busy ${glmBusy}`);
    const waited = total('waited');
    if (waited) parts.push(`busy-waits ${waited} (avg ${(total('waitMs') / waited / 1000).toFixed(1)}s)`);

    // RED — moves/bounces only (cache health lives on the Cache line).
    const wtm = total('waitThenMoved');
    let red_ = null;
    if (per100(cross) > 2) red_ = `cross moves ${per100(cross)}/100 — most refusals on ${this._mostBouncedAccount(now) || '?'}`;
    else if (bounceShare > 0.1) red_ = `${pctTxt(bounceShare)} bounced — most on ${this._mostBouncedAccount(now) || '?'}`;
    else if (wtm * 100 / Math.max(1, served) > 0.5) red_ = `${wtm} waits still moved — on ${this._mostBouncedAccount(now) || '?'}`;
    if (red_) {
      const metrics = parts.join(' · ');
      const warning = red(`⚠ ${red_}`);
      const line = ` ${red('Moves')}   ${warning} · ${metrics}  ${dim('[15m]')}`;
      return truncLine(vw(line) <= W ? line : ` ${red('Moves')}   ${dim('[15m]')} ${metrics} · ${warning}`, W);
    }
    const warn = per100(cross) > 1 || bounceShare > 0.05;
    return truncLine(` ${warn ? yellow('Moves') : green('Moves')}   ${parts.join(' · ')}  ${dim('[15m]')}`, W);
  }

  /** Are the accounts keeping up right now? Reads the router's own hold of requests (waiting for
   *  capacity), never upstream latency. Judged from the worst worker that reports it. */
  _capacityLine(W = 80, now = Date.now()) {
    let report;
    try { report = routingSources(this.am, now); } catch { return null; }
    const rank = { short: 3, tight: 2, ok: 1, quiet: 0 };
    // Sanitized at ingress (routingSources): numbers are finite, states are members of the set,
    // and a worker whose report carries no usable recent block is excluded here.
    const rows = report.filter(s => s.report?.recent && !s.stale && Object.hasOwn(rank, s.report.recent.state));
    if (!rows.length) return null;
    const worst = rows.reduce((a, b) => (rank[b.report.recent.state] > rank[a.report.recent.state] ? b : a));
    const r = worst.report.recent;
    // A worker that reports no headroom (older link, malformed block) must not vanish silently:
    // name how many are excluded so "Keeping up" is never read as all-workers-all-clear.
    const missing = report.length - rows.length;
    const hint = missing > 0 ? ` ${dim('· ' + missing + ' not reporting')}` : '';
    const where = (worst === report[0] ? '' : ` ${dim('on ' + worst.name)}`) + hint;
    // A remote verdict can be up to the 5-minute freshness cutoff old, and its oldest-wait figure
    // only moves when that worker sends a new report.
    const age = worst === report[0] ? 0 : Math.max(0, now - worst.report.asOf);
    const aged = age > 60_000 ? ` ${dim(Math.round(age / 60_000) + 'm old')}` : '';
    const time = n => !Number.isFinite(n) ? '—' : n < 1000 ? n + 'ms' : n < 60_000 ? (n / 1000).toFixed(n < 10_000 ? 1 : 0) + 's' : Math.round(n / 60_000) + 'm';
    const label = `${dim('[' + headroomSpan(r) + ']')}`;
    if (r.state === 'quiet') {
      // Quiet still says what is held right now (a hold is direct evidence at any volume), carries
      // the span, and says how many workers reported no headline.
      const bits = [];
      if (r.pending) bits.push(`${r.pending} waiting, oldest ${time(r.oldestWaitMs)}`);
      if (missing > 0) bits.push(`${missing} not reporting`);
      const inner = bits.length ? ' · ' + bits.join(' · ') : '';
      const on = worst === report[0] ? '' : ` ${dim('on ' + worst.name)}`;
      return truncLine(` ${dim('Headroom')}  ${dim('— (little traffic' + inner + ')')}  ${label}${on}`, W);
    }
    const parts = [(r.pending ? `${r.pending} waiting, oldest ${time(r.oldestWaitMs)}` : ''),
      `${r.queuedRequests || 0} of ${r.requests || 0} waited`,
      (r.queuedRequests ? `longest ≤${time(r.longestWaitMs)}` : ''),
      (r.capacityDenied ? `${r.capacityDenied} refused` : '')].filter(Boolean);
    const text = { ok: green('Keeping up'), tight: yellow('Getting tight'), short: red('Short of accounts') }[r.state];
    const head = { ok: green('Headroom'), tight: yellow('Headroom'), short: red('Headroom') }[r.state];
    const build = () => ` ${head}  ${text}  ${label}${aged}  ${parts.join(' · ')}${where}`;
    // Keep the state and what is waiting; shed the least urgent figures when the terminal is narrow.
    while (parts.length > 1 && vw(build()) > W) parts.pop();
    return truncLine(build(), W);
  }

  /** The Claude row with the lowest cache share in the window (enough volume only). */
  _worstCacheAccount() {
    let worst = null;
    for (const a of this.am.accounts) {
      if (a.enabled === false || a.type === 'provider' || a.provider === 'codex') continue;
      const e = this._accountLoad(a)?.last15m?.efficiency;
      if (e && !e.lowVolume && e.hit != null && (!worst || e.hit < worst.hit)) worst = { name: a.name, hit: e.hit };
    }
    return worst?.name || null;
  }

  /** The row with the most pinned refusals (bounces) seen by this pool in the window. */
  _mostBouncedAccount(now = Date.now()) {
    let best = null;
    for (const a of this.am.accounts) {
      const n = this.am._loadSummary(a, 15 * 60_000, now).bounced;
      if (n > 0 && (!best || n > best.n)) best = { name: a.name, n };
    }
    return best?.name || null;
  }

  /** One line per unreachable team pool, so a lost connection reads as ONE cause
   *  instead of every cloud row turning red. '' lines are skipped by the caller. */
  _cloudLinkLines(W = 80, now = Date.now()) {
    const out = [];
    for (const l of this.am.poolLinks || []) {
      if (!l.lastError && l.lastOkAt != null) continue;
      const since = l.downSince ?? l.lastOkAt;
      const forTxt = since ? ` for ${formatAge(now - since)}` : '';
      const synced = l.lastOkAt ? ` · last synced ${new Date(l.lastOkAt).toLocaleTimeString()}` : '';
      const why = l.lastOkAt == null && !l.lastError ? 'connecting…' : describeLinkError(l.lastError);
      const line = ` Cloud    ${yellow(`⟐ ${l.name} unreachable${forTxt}`)} ${dim('—')} ${why}${dim(`. Cloud accounts paused; local accounts still serving${synced}.`)}`;
      out.push(fitLine(line, W));
    }
    return out;
  }

  _renderUpdatesDetail() {
    const v = this.am.versionInfo;
    const running = v?.current ? `v${v.current}` : 'unknown';
    const auto = this._autoUpdateOn();
    const out = [];
    out.push(` ${bold('Updates')}`);
    if (!v) {
      out.push(` ${dim('Running')} ${running}   ${dim('· checking npm for a newer version…')}`);
    } else if (v.hasUpdate && v.latest) {
      out.push(` ${dim('Running')} ${running}   ${yellow(`v${v.latest} is available`)}`);
      out.push(auto
        ? ` ${dim('It installs itself automatically. Press')} ${bold('c')} ${dim('to get it right now.')}`
        : ` ${dim('Automatic updates are off. Press')} ${bold('c')} ${dim('to install it now, or')} ${bold('t')} ${dim('to turn automatic on.')}`);
    } else {
      out.push(` ${dim('Running')} ${running}   ${green('up to date')}`);
      out.push(` ${dim(auto ? 'New versions install themselves.' : 'Automatic updates are off — press t to turn them on.')}`);
    }
    if (this.updateBusy) out.push(` ${cyan(SPINNER[this.frame])} ${dim(this.updateBusy)}`);
    return out;
  }

  async _toggleAutoUpdate() {
    const turnOn = !this._autoUpdateOn();
    // ON = the full hands-free chain; OFF = keep checking (banner still shows) but never
    // install/reload without the user. Mutating this.config (=== the object index.js's
    // update timer reads) takes effect live; saveConfig persists it (index.js writes these
    // three keys) so it survives a restart.
    this.config.updateCheck = true;
    this.config.autoUpdate = turnOn;
    this.config.autoApply = turnOn;
    try {
      await this.saveConfig(this.config);
      this._addLog(`Automatic updates ${turnOn ? 'on' : 'off'}`);
    } catch (error) {
      this._addLog(`Could not save update setting: ${error.message}`);
    }
    this.mode = 'normal';
  }

  /** Live description of what pressing restart will do RIGHT NOW — counts the
   *  in-flight requests that must drain and states the worst-case pause, so the
   *  confirm is honest about the cost instead of hiding it behind "drain active work". */
  _restartConfirmDetail() {
    const inFlight = this.active?.size || 0;
    const sessions = new Set([...(this.active?.values() || [])].map(r => r.sessionKey).filter(Boolean)).size;
    const drainSec = Math.round((this.config?.restartDrainTimeoutMs ?? 10_000) / 1000);
    if (inFlight === 0) {
      return 'Nothing is in flight, so this restarts immediately. Running sessions reconnect on their next request.';
    }
    const s = sessions === 1 ? '' : 's';
    return `${inFlight} request${inFlight === 1 ? '' : 's'} from ${sessions} session${s} are in flight. `
      + `They finish first (up to ${drainSec}s), and during that window NEW requests get a "restarting" retry. `
      + 'Sessions are not lost — they reconnect automatically.';
  }

  _keyAccounts(k) {
    if (k === 'a') {
      // ONE entry point for every account type. Previously `l` (browser) and `k`
      // (Anthropic API key) were the only options and GLM/Kimi had no path at all —
      // the provider screen existed but nothing in the Accounts UI led to it
      // (reported 2026-08-10: "it only offers anthropic accounts via browser").
      this.mode = 'addtype';
    } else if (k === 'k') {
      // Kept as a shortcut; the `a` flow reaches the same place.
      this._addAccountOfType('anthropic-key');
    } else if (k === 'l') {
      this._confirm(
        'Log in / re-authenticate via browser?',
        'Opens a browser. Logging into an account that\'s already added (same user, same organization) RE-AUTHENTICATES it in place (revives a reauth/error account) — no duplicate. Another organization of the same user, or a new user, is added as a new account.',
        () => this._doLogin(),
      );
    } else if (k === 'c' && this.am.accounts.some(a => a.provider === 'codex')) {
      this._startSelection('codexLogin');
    } else if (k === 'r' && this.codexResetDetails && this.am.accounts.some(a => a.provider === 'codex' && !a.remote)) {
      this._startSelection('codexResets');
    } else if (k === 'v' && this.onQuotaRecheck) {
      this._startSelection('check quota');
    } else if (k === 'n' && this.am.accounts.length > 0) {
      this._startSelection('rename');
    } else if (k === 't' && this.am.accounts.length > 0) {
      this._startSelection('toggle');
    } else if (k === 'u' && this.am.accounts.length > 0) {
      // USAGE CAP (owner-directed 2026-08-26): reserve capacity — the proxy benches
      // this account at the chosen % of both the 5h and weekly windows, keeping the
      // rest for personal use. Enter 1-99 to set; enter 0 to remove (fully utilized).
      this._startSelection('cap');
    } else if (k === 'd' && this.am.accounts.length > 0) {
      this._startSelection('delete');
    } else if (k === 'esc' || k === 'q') {
      this.mode = 'normal';
    }
  }

  // ── unified add-account flow ────────────────────────────────────────────────
  // Every account type lands here so there is
  // exactly ONE thing to learn: press `a`, pick a type, supply a credential.
  static ADD_TYPES = [
    { key: '1', id: 'anthropic-oauth', label: 'Anthropic subscription', hint: 'log in with a browser (Max / Pro plan)' },
    { key: '2', id: 'anthropic-key',   label: 'Anthropic API key',      hint: 'pay-per-token key from console.anthropic.com' },
    { key: '3', id: 'zai',             label: 'GLM (z.ai) API key',     hint: '' },
    { key: '4', id: 'kimi',            label: 'Kimi (Moonshot) API key', hint: '' },
    { key: '5', id: 'chatgpt',         label: 'ChatGPT subscription',   hint: 'log in with a browser' },
  ];

  _keyAddType(k) {
    if (k === 'esc' || k === 'q') { this.mode = 'accounts'; return; }
    const pick = TUI.ADD_TYPES.find(t => t.key === k);
    if (pick) this._addAccountOfType(pick.id);
  }

  _addAccountOfType(typeId) {
    if (typeId === 'chatgpt') {
      this.mode = 'accounts';
      this._confirm('Connect ChatGPT?', 'Choose where to save the account, then sign in with your browser.',
        () => this._doChatGPTLogin());
      return;
    }
    if (typeId === 'anthropic-oauth') {
      this.mode = 'accounts';
      this._confirm(
        'Log in / re-authenticate via browser?',
        'Opens a browser. Logging into an account that is already added (same user, same organization) RE-AUTHENTICATES it in place — no duplicate. Another organization of the same user is added as a new account.',
        () => this._doLogin(),
      );
      return;
    }
    if (typeId === 'anthropic-key') {
      this.mode = 'input';
      this.inputPrompt = 'Anthropic API key — paste it, or type a GCP secret name';
      this.inputBuf = '';
      this.inputSensitive = false;   // a GCP NAME is not a secret; the key is masked on save
      this.inputCb = async value => {
        const input = String(value || '').trim();
        if (!input) { this.mode = 'accounts'; return; }
        const key = await this._resolveCredential(input);
        if (!key) return;
        this.mode = 'accounts';
        this._confirm('Add this API key?', 'Store it in Maxpool config as a new Anthropic API account.',
          () => this._doAddKey(key));
      };
      return;
    }
    // GLM / Kimi — the provider path. Same two credential sources.
    this._providerAddStep('secret', { provider: typeId === 'kimi' ? 'kimi' : 'zai' });
  }

  /** Accept EITHER a pasted API key or a GCP Secret Manager name, and return the key.
   *  A GCP name is UPPER_SNAKE with no dots; real keys carry dots/mixed case. Resolving
   *  here (not at each call site) is what makes "type it or point at GCP" one concept. */
  async _resolveCredential(input) {
    const looksLikeSecretName = /^[A-Z][A-Z0-9_-]{2,60}$/.test(input) && !input.includes('.');
    if (!looksLikeSecretName) return input;   // a pasted key
    this._addLog(`Resolving GCP secret "${input}"…`);
    this.forceRender();
    try {
      const { resolveSecret } = await import('./secret-resolver.js');
      const v = await resolveSecret(input);
      if (!v) {
        this._addLog(`✗ GCP secret "${input}" not found (or gcloud is not authenticated). ` +
          'Run: gcloud auth application-default login');
        this.mode = 'accounts';
        return null;
      }
      return v;
    } catch (err) {
      this._addLog(`✗ Could not reach GCP: ${err.message}`);
      this.mode = 'accounts';
      return null;
    }
  }

  _renderAddType(buf) {
    buf.push(`${bold('Add an account')}   ${dim('pick what you have')}`);
    buf.push('');
    for (const t of TUI.ADD_TYPES) {
      buf.push(`   ${bold(t.key)}  ${t.label.padEnd(26)}${dim(t.hint || '')}`);
    }
    buf.push('');
    buf.push(dim('   Reconnect from Accounts: l for Claude, c for ChatGPT.'));
    buf.push('');
    // Kept verbatim from the deleted Providers panel — the only place that explained
    // BOTH credential sources and the gcloud command a non-owner needs.
    buf.push(dim('   For 2-4, two ways to supply the key:'));
    buf.push(dim('     A) Paste it — stored in your config (0600). No cloud setup.'));
    buf.push(dim('     B) Type a GCP Secret Manager name — the key never touches disk.'));
    buf.push(dim('        Store it:  ') + 'gcloud secrets create MY_KEY --data-file=-');
    buf.push(dim('        Maxpool reads it as YOU:  ') + 'gcloud auth application-default login');
    buf.push(dim('        Delete the secret and the account stops working everywhere.'));
  }

  // Derive a human-readable account name from a GCP secret name.
  // RESTRICTED_AL_MAXPOOL_ZAI → glm al  |  ZAI_API_KEY → glm primary
  // RESTRICTED_MAX_KIMI_API_KEY → kimi max  |  KIMI_API_KEY → kimi primary
  static deriveProviderName(provider, secretName) {
    const provLabel = provider === 'kimi' ? 'kimi' : 'glm';
    const s = String(secretName || '').toUpperCase();
    // Try to extract a user from RESTRICTED_<USER>_...
    const m = /^RESTRICTED_([A-Z]+)_/.exec(s);
    const user = m ? m[1].toLowerCase() : null;
    return user ? `${provLabel} ${user}` : `${provLabel} primary`;
  }


  // Multi-step input for adding a provider. Steps: type → secret/key → name.
  // Name LAST so it can be pre-filled from the secret (RESTRICTED_AL_MAXPOOL_ZAI →
  // "glm al") instead of asking the user to invent one before they've said which
  // account it is.
  _providerAddStep(step, prev = {}) {
    if (step === 'type') {
      this.mode = 'input';
      this.inputPrompt = 'Provider type (zai or kimi)';
      this.inputBuf = 'zai';
      this.inputSensitive = false;
      this.inputCb = value => {
        const provider = String(value || '').trim().toLowerCase();
        if (provider !== 'zai' && provider !== 'kimi') { this._addLog('Type must be zai or kimi'); this.mode = 'accounts'; return; }
        this._providerAddStep('secret', { ...prev, provider });
      };
    } else if (step === 'secret') {
      this.mode = 'input';
      this.inputPrompt = `${prev.provider === 'kimi' ? 'Kimi' : 'GLM'} key — paste it, or type a GCP secret name`;
      this.inputBuf = '';
      this.inputSensitive = false;
      this.inputCb = async value => {
        const input = String(value || '').trim();
        if (!input) { this.mode = 'accounts'; return; }
        // Heuristic: a GCP secret name is uppercase/dashes/underscores and short.
        // An API key is long and contains dots/mixed-case/alphanumeric.
        const looksLikeSecretName = /^[A-Z][A-Z0-9_-]{2,60}$/.test(input) && !input.includes('.');
        const keyed = looksLikeSecretName ? { secretName: input } : { apiKey: input };
        // The name step is LAST so it can offer a default derived from the secret —
        // `RESTRICTED_AL_MAXPOOL_ZAI` → `glm al`. Pre-filled and editable: press Enter
        // to accept, or type over it.
        this._providerAddStep('name', { ...prev, ...keyed });
      };
    } else if (step === 'name') {
      this.mode = 'input';
      this.inputPrompt = 'Name for this provider (Enter to accept)';
      this.inputBuf = TUI.deriveProviderName(prev.provider, prev.secretName || '');
      this.inputSensitive = false;
      this.inputCb = async value => {
        const name = String(value || '').trim() || TUI.deriveProviderName(prev.provider, prev.secretName || '');
        if (this.am.accounts.some(a => a.name === name)) {
          this._addLog(`Account "${name}" already exists`); this.mode = 'accounts'; return;
        }
        await this._doAddProvider({ ...prev, name });
      };
    }
  }

  async _doAddProvider({ name, provider, secretName, apiKey }, { toTeam = null } = {}) {
    this.mode = 'accounts';
    if (secretName) this._addLog(`Resolving secret "${secretName}" from GCP…`);
    else this._addLog(`Adding "${name}" with direct API key…`);
    this.forceRender();
    try {
      let token = null;
      if (secretName) {
        const { resolveSecret } = await import('./secret-resolver.js');
        token = await resolveSecret(secretName);
        if (!token) {
          this._addLog(`✗ Secret "${secretName}" not found in GCP — create it first: gcloud secrets create ${secretName} --data-file=-`);
          return;
        }
      } else {
        token = apiKey;
      }
      // TEAM-POOL CHOICE (2026-11-18, parity with the Claude login flow): when a linked
      // pool exists and the caller did not already decide, ask once — cloud recommended
      // (the key serves the whole team there), laptop on 'l'. A chosen team target sends
      // the key over the link's authenticated channel and saves NOTHING locally.
      const link = this.am.poolLinks?.[0] || null;
      let team = toTeam;
      if (team == null && link && !this.am.accounts.some(a => a.type === 'provider' && a.credential === token)) {
        // The screen's own key handler is live: hand the terminal off first (as the
        // Claude login does), or the question draws over the screen and the answer
        // keystroke ('l' = log in) also fires the screen's action.
        const wasRunning = this.running;
        setConsoleStdoutSuppressed(true);
        let where;
        try {
          if (wasRunning) await this.handOff();
          where = String(await this._ask(`\nAdd "${name}" to the team pool "${link.name}" (recommended) or this laptop only? [T/l]: `) || '').trim().toLowerCase();
        } finally {
          setConsoleStdoutSuppressed(false);
          if (wasRunning) this.start();
        }
        team = where !== 'l';
      }
      if (team && link) {
        this._addLog(`Sending "${name}" to the team pool (${link.name})…`);
        this.forceRender();
        const r = await sendProviderToPool({ url: link.url, key: link.key, name, provider, apiKey: token, secretName });
        if (r.ok) {
          this._addLog(`✓ ${r.result === 'exists' ? `"${r.name}" already in` : `Added "${r.name}" to`} the team pool (${link.name}). Nothing saved on this laptop.`);
        } else if (r.status === 409 && r.code === 'name_taken') {
          this._addLog(`✗ The team pool already has a provider named "${name}" with a different key. Nothing was added${r.suggestedName ? ` — try the name "${r.suggestedName}"` : ' — choose another name'}`);
        } else {
          this._addLog(`✗ Team pool failed — ${r.error}. NOTHING saved locally; try again.`);
        }
        return;
      }
      // Add to config (persistence) and activate immediately.
      const { atomicConfigUpdate } = await import('./config.js');
      await atomicConfigUpdate(cfg => {
        if (!Array.isArray(cfg.providers)) cfg.providers = [];
        const entry = { name, provider };
        if (secretName) entry.secretName = secretName;
        else entry.apiKey = apiKey;
        cfg.providers.push(entry);
      });
      // Activate in the running process.
      // Whole list, not just the new entry: loadConfigProviders drops every idle config
      // provider missing from what it is given, with its learned quota state.
      this.am.loadConfigProviders([...this.am.configProviderEntries(), { name, provider, secretName, token }]);
      const a = this.am.accounts.find(a => a.name === name);
      if (a && secretName) a.secretName = secretName;
      this._addLog(`✓ Added "${name}" (${provider})${secretName ? ` — GCP secret "${secretName}"` : ' — direct key'}`);
    } catch (err) {
      this._addLog(`✗ Failed to add provider: ${err.message}`);
    }
  }



  _keyRouting(k) {
    if (k === 'a' && this.am.routingMode !== 'preferred') {
      this._addLog('No account is pinned — routing is already automatic');
    } else if (k === 'a') {
      this._confirm(
        'Unpin and use automatic routing?',
        'Removes the pinned account. New requests are spread across all healthy accounts again.',
        () => this._setAutomaticRouting(),
      );
    } else if (k === 'p' && this.am.accounts.some(account => account.type !== 'provider')) {
      this._startSelection('prefer');
    } else if (k === 'f' || k === 'F' || k === 'm' || k === 'M') {
      // Cycle the named routing mode — reversible + non-destructive, so no confirm
      // dialog (unlike restart/delete). `f` is kept for muscle memory from the old
      // cross-provider knob this replaced; `m` is the mnemonic (mode).
      this._cycleRoutingMode();
    } else if (k === 'd' || k === 'D') {
      // Toggle peak de-preference. THE knob that matters: with it ON, the peak window
      // OVERRIDES your routing mode for 4h every weekday (balance stops being balance).
      // OFF keeps the weekly cap but lets your chosen mode run all day.
      this._togglePeakDepreference();
    } else if (k === 'c' || k === 'C') {
      // Cycle the peak weekly cap: off → 25% → 50% → 75% → never-during-peak.
      this._cyclePeakCap();
    } else if (k === 'o' && this.am.accounts.some(a => a.provider === 'codex')) {
      this._toggleChatGPTSessionRouting().catch(error => this._addLog(`Could not save: ${error.message}`));
    } else if (k === 'g' || k === 'k') {
      // Per-provider Claude→provider fallback. Only affects routing under `sticky`
      // mode — under balance/prefer-* the mode itself controls eligibility. Still
      // safe to set (it'll apply if you switch back to sticky).
      this._cycleProviderClaudeFallback(k === 'g' ? 'zai' : 'kimi');
    } else if (k === 'b' || k === 'B') {
      // STICKY BUSY WAIT (2026-11-15): how long a conversation waits for its own busy
      // account before moving (a move re-writes its whole prompt cache).
      this._cycleStickyBusyBudget();
    } else if (k === 'w' || k === 'W') {
      // WEEKLY-AWARE SCORING (2026-09-16): fold weekly utilization into the routing
      // score, not just the 5h session. Without it, an account at 89% weekly with a
      // fresh session window scores as cheap and keeps winning all day.
      this._toggleWeeklyAware();
    } else if (k === 'esc' || k === 'q') {
      this.mode = 'normal';
    }
  }

  async _toggleChatGPTSessionRouting() {
    const next = this.am._sessionRoutingFor('codex') === 'same-provider' ? 'cross-provider' : 'same-provider';
    const previous = this.config.scheduler;
    const scheduler = { ...previous };
    scheduler.providers = { ...scheduler.providers, codex: { ...scheduler.providers?.codex, sessionRouting: next } };
    this.config.scheduler = scheduler;
    try {
      await this.saveConfig(this.config);
    } catch (error) {
      if (this.config.scheduler === scheduler) this.config.scheduler = previous;
      throw error;
    }
    this.am.scheduler.providers = { ...this.am.scheduler.providers, codex: scheduler.providers.codex };
    this._addLog(next === 'same-provider' ? 'ChatGPT sessions stay on ChatGPT' : 'ChatGPT sessions can switch providers');
  }

  /** Cycle ONE provider's Claude→provider setting. Turning it ON is the risky direction
   *  (a Claude session can finish on that provider), so it asks first; turning it back off
   *  is always safe and never prompts. */
  _cycleProviderClaudeFallback(providerKey) {
    const order = ['never', 'when-exhausted', 'always'];
    const label = providerKey === 'zai' ? 'GLM' : 'Kimi';
    const cur = this.am._claudeFallbackFor?.(providerKey) || 'never';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    const apply = async () => {
      this.am.setClaudeFallbackForProvider?.(providerKey, next);
      const sched = { ...(this.config.scheduler || {}) };
      sched.providers = { ...(sched.providers || {}) };
      sched.providers[providerKey] = { ...(sched.providers[providerKey] || {}), claudeFallback: next };
      this.config.scheduler = sched;
      try { await this.saveConfig(this.config); } catch (e) { this._addLog(`Could not save: ${e.message}`); }
      this._addLog(`${label} takes over when Claude is out: ${next}`);
    };
    if (cur === 'never') {
      this._confirm(
        `Let ${label} take over when Claude is out?`,
        `A session that starts on Claude can finish on ${label}. Most move back to Claude fine. If ${label} runs a web search, that session stays on ${label} until you start a new one.`,
        apply,
      );
      return;
    }
    apply();
  }

  /** The five named routing modes, in cycle order. Each carries the plain-English
   *  line the header shows, so the name the operator picks and the behaviour they
   *  get are described by ONE string — the old `never/when-exhausted/always` knob
   *  read as "load balance across everything" and did nothing of the sort. */
  static ROUTING_MODES = [
    { id: 'balance', label: 'Balance all',
      help: 'Score every request across Claude, GLM and Kimi. Busiest accounts get less.' },
    { id: 'prefer-claude', label: 'Prefer Claude',
      help: 'Claude first; GLM/Kimi pick up the overflow when Claude is loaded.' },
    { id: 'prefer-zai', label: 'Prefer GLM',
      help: 'GLM first; Claude/Kimi pick up the overflow when GLM is loaded.' },
    { id: 'prefer-kimi', label: 'Prefer Kimi',
      help: 'Kimi first; Claude/GLM pick up the overflow when Kimi is loaded.' },
    { id: 'sticky', label: 'One account per session',
      help: 'Each session stays on the account it started on. No spreading.' },
  ];

  _routingModeDef(id) {
    return TUI.ROUTING_MODES.find(m => m.id === id) || TUI.ROUTING_MODES[0];
  }

  /** Toggle peak de-preference for every provider that HAS a peak window. This is the
   *  setting that silently overrides the routing mode during the window, so it gets a
   *  first-class key rather than living only in the config file. */
  async _togglePeakDepreference() {
    const fams = [...new Set(this.am.accounts.filter(a => a.type === 'provider').map(a => a.provider))]
      .filter(p => (this.am._peakSettingsFor?.(p)?.windows || []).length > 0);
    if (!fams.length) { this._addLog('No provider has a peak window configured'); return; }
    const next = !(this.am._peakSettingsFor(fams[0]).depreference);
    for (const p of fams) this.am.setPeakSettingsForProvider?.(p, { peakDepreference: next });
    this.config.scheduler = { ...(this.config.scheduler || {}) };
    this.config.scheduler.providers = { ...(this.am.scheduler.providers || {}) };
    await this.saveConfig(this.config);
    this._addLog(next
      ? 'Peak hours: GLM ranks last during the window (overrides the routing mode)'
      : 'Peak hours: routing runs normally during the window (the cap still applies)');
  }

  /** Cycle the peak weekly cap across the values that mean something. */
  async _cyclePeakCap() {
    const order = [1, 0.75, 0.5, 0.25, 0];
    const fams = [...new Set(this.am.accounts.filter(a => a.type === 'provider').map(a => a.provider))]
      .filter(p => (this.am._peakSettingsFor?.(p)?.windows || []).length > 0);
    if (!fams.length) { this._addLog('No provider has a peak window configured'); return; }
    const cur = this.am._peakSettingsFor(fams[0]).cap;
    const idx = order.findIndex(v => Math.abs(v - cur) < 1e-9);
    const next = order[(idx === -1 ? 0 : idx + 1) % order.length];
    for (const p of fams) this.am.setPeakSettingsForProvider?.(p, { peakCap: next });
    this.config.scheduler = { ...(this.config.scheduler || {}) };
    this.config.scheduler.providers = { ...(this.am.scheduler.providers || {}) };
    await this.saveConfig(this.config);
    this._addLog(next === 1 ? 'Peak cap: off (no weekly limit during peak)'
      : next === 0 ? 'Peak cap: never use GLM during peak hours'
        : `Peak cap: bench a GLM account once it passes ${Math.round(next * 100)}% of its weekly quota`);
  }

  /** Toggle weekly-aware routing for the whole fleet. One scheduler flag — when OFF the
   *  score sees only the 5h session (the pre-2026-09-16 behavior); when ON the weekly
   *  number is folded in, so a nearly-exhausted account loses to a fresh one at ALL
   *  hours, not just after its session window resets. */
  async _toggleWeeklyAware() {
    const next = this.am.scheduler.weeklyAwareScoring === false;
    this.am.scheduler.weeklyAwareScoring = next;
    const sched = { ...(this.config.scheduler || {}) };
    sched.weeklyAwareScoring = next;
    this.config.scheduler = sched;
    try {
      await this.saveConfig(this.config);
    } catch (e) {
      // Roll back both the live flag and the mirror so an unsaved toggle can't
      // silently revert on the next reload — same pattern as the sibling
      // _cycleProviderClaudeFallback (tui.js).
      this.am.scheduler.weeklyAwareScoring = !next;
      this.config.scheduler = sched.weeklyAwareScoring === next ? { ...sched, weeklyAwareScoring: !next } : sched;
      this._addLog(`Could not save: ${e.message}`);
      return;
    }
    this._addLog(next
      ? 'Weekly-aware routing: ON — accounts near their weekly limit rank last, all day'
      : 'Weekly-aware routing: OFF — score sees only the 5h session window again');
  }

  static STICKY_BUSY_STEPS = [15_000, 30_000, 60_000, 120_000, 0];

  _stickyBusyLabel() {
    // The value IN FORCE — the server's own resolver, so an env override shows as such.
    const { ms, fromEnv } = resolveStickyBusyBudget(this.am.scheduler);
    const txt = ms > 0 ? `${Math.round(ms / 1000)}s` : 'off';
    return fromEnv ? `${txt} (env)` : txt;
  }

  /** Cycle the busy-account wait. Live: the server reads it per request, so the next
   *  request uses the new value; saved so it survives a restart. */
  async _cycleStickyBusyBudget() {
    if (resolveStickyBusyBudget(this.am.scheduler).fromEnv) {
      // Saving a setting the server ignores would make the screen lie about the wait.
      this._addLog('Wait for busy account is pinned by MAXPOOL_STICKY_BUSY_BUDGET_MS — unset it to change it here');
      return;
    }
    const steps = TUI.STICKY_BUSY_STEPS;
    const cur = this.am.scheduler.stickyBusyBudgetMs ?? 60_000;
    const next = steps[(steps.indexOf(cur) + 1) % steps.length];
    this.am.scheduler.stickyBusyBudgetMs = next;
    const prevSched = this.config.scheduler;
    this.config.scheduler = { ...(prevSched || {}), stickyBusyBudgetMs: next };
    try {
      await this.saveConfig(this.config);
    } catch (e) {
      this.am.scheduler.stickyBusyBudgetMs = cur;
      this.config.scheduler = prevSched;
      this._addLog(`Could not save: ${e.message}`);
      return;
    }
    this._addLog(next > 0
      ? `Wait for busy account: up to ${Math.round(next / 1000)}s before a conversation moves to another account`
      : 'Wait for busy account: off — a busy account moves the conversation at once');
  }

  async _cycleRoutingMode() {
    const modes = TUI.ROUTING_MODES;
    const cur = this.am.scheduler?.routingMode || 'sticky';
    const next = modes[(modes.findIndex(m => m.id === cur) + 1) % modes.length];
    this.am.setProviderRoutingMode?.(next.id);
    this.config.scheduler = { ...(this.config.scheduler || {}), routingMode: next.id };
    // Clear the stale legacy policy so it can't contradict the new mode in
    // /maxpool/status or be read by code that still references it.
    delete this.config.scheduler.crossProviderFallbackPolicy;
    await this.saveConfig(this.config);
    this._addLog(`Routing: ${next.label} — ${next.help}`);
  }

  _keySelect(k) {
    const selectable = this._selectableIndexes(this.selAction);
    const position = Math.max(0, selectable.indexOf(this.selIdx));
    if (k === 'up' || k === 'k') this.selIdx = selectable[Math.max(0, position - 1)] ?? this.selIdx;
    else if (k === 'down' || k === 'j') this.selIdx = selectable[Math.min(selectable.length - 1, position + 1)] ?? this.selIdx;
    else if (k === 'enter') {
      const account = this.am.accounts[this.selIdx];
      if (!account) {
        this.mode = 'normal';
        return;
      }
      if (this.selAction === 'check quota') {
        this.mode = 'accounts';
        this._addLog(this.onQuotaRecheck(account));
      } else if (this.selAction === 'prefer') {
        if (account.type === 'provider') {
          this._addLog('Manual preference is available only for Claude accounts');
          return;
        }
        if (!account.enabled) {
          this._addLog(`Enable "${account.name}" before selecting it as the manual preference`);
          return;
        }
        this._confirm(
          `Use manual preference for "${account.name}"?`,
          'Move idle sessions on their next request; fail over and return automatically.',
          () => this._setPreferredRouting(account.name),
        );
      } else if (this.selAction === 'toggle') {
        const enable = !account.enabled;
        this._confirm(
          `${enable ? 'Enable' : 'Disable'} "${account.name}"?`,
          enable
            ? 'Allow this account to receive new requests again.'
            : 'Stop assigning new requests to it. Active requests will continue.',
          () => this._doToggle(this.selIdx, enable),
        );
      } else if (this.selAction === 'delete') {
        // A GCP-backed row: say what deleting does NOT do, so nobody thinks the key
        // is gone from the cloud.
        const secret = account.secretName
          ? ` The GCP secret "${account.secretName}" is left alone — delete it separately if you want the key gone.`
          : '';
        this._confirm(
          `Delete "${account.name}"?`,
          `Permanently remove it from Maxpool config. Deletion is blocked while it has active requests.${secret}`,
          () => this._doDelete(this.selIdx),
        );
      } else if (this.selAction === 'rename') {
        const targetIdx = this.selIdx;
        const current = account.name;
        this.mode = 'input';
        this.inputPrompt = `New name for "${current}"`;
        this.inputBuf = '';
        this.inputSensitive = false;
        this.inputCb = value => this._doRename(targetIdx, String(value || '').trim());
      } else if (this.selAction === 'codexLogin') {
        this._confirm('Reconnect ChatGPT?', `Open browser for "${account.remote?.remoteName || account.name}".`,
          () => this._doChatGPTLogin(account), 'accounts');
      } else if (this.selAction === 'codexResets') {
        this._showCodexResets(account).catch(error => this._addLog(`Could not read resets: ${error.message}`));
      } else if (this.selAction === 'cap') {
        const targetIdx = this.selIdx;
        const current = account.name;
        const existingAcct = this.am.accounts[targetIdx];
        const existing = existingAcct?.capUtilization;
        const existingMode = existingAcct?.capMode;
        const nowLabel = existing
          ? `${Math.round(existing * 100)}%${existingMode === 'dynamic' ? ' dynamic' : ' fixed'}`
          : 'off';
        this.mode = 'input';
        // Plain-English prompt (owner 2026-10-13: "I'm not sure how does this work.
        // I want to keep the dynamic floor, but I also want to raise the basic cap").
        // Type just a number = the dynamic cap's STARTING level: routing USES the
        // account up to NN% of each window, and the allowance rises toward the
        // switch threshold as the window nears its reset (by elapsed time —
        // _effectiveCap), so unused capacity isn't stranded. fNN = fixed stop at NN%.
        // 0 / off = no cap. Kept short: the typed value must stay on an 80-col line.
        this.inputPrompt = `Cap ${current}, now ${nowLabel}. 75=use to 75%+rises near reset f75=hard 0=off`;
        this.inputBuf = '';
        this.inputSensitive = false;
        this.inputCb = value => this._doSetCap(targetIdx, String(value || '').trim());
      }
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _startSelection(action) {
    const selectable = this._selectableIndexes(action);
    if (!selectable.length) {
      const unavailable = action === 'check quota' ? 'No local Claude subscription to check'
        : 'No configurable account is available for this action';
      this._addLog(action === 'prefer'
        ? 'No enabled Claude account is available for manual preference' : unavailable);
      return;
    }
    this.mode = 'select';
    this.selAction = action;
    this.selIdx = selectable.includes(this.am.currentIndex) ? this.am.currentIndex : selectable[0];
  }

  // Real am.accounts indices in DISPLAY order: non-provider (Claude/OAuth/apikey)
  // accounts first, providers (GLM/Kimi fallback) last, stable within each group.
  // The single source of truth for row order — the render loop AND selection nav
  // both iterate it, so the highlight can never desync from the visible list. The
  // canonical am.accounts array order is never mutated (routing/index actions safe).
  _displayOrder() {
    const nonProv = [];
    const prov = [];
    this.am.accounts.forEach((a, i) => (a.type === 'provider' ? prov : nonProv).push(i));
    // GROUP providers by family (all GLM together, all Kimi together). Providers land
    // in the config array in the order they were ADDED, so a GLM account added after a
    // Kimi rendered below it — same-provider accounts split across the table (reported
    // 2026-08-17: "accounts need to be grouped by provider... you shouldn't be mixing
    // Anthropic with Z.ai and Moonshot"). Stable: group by first-seen order, preserving
    // the within-family order and never reordering OAuth rows.
    const familyFirstSeen = new Map();
    for (const idx of prov) {
      const fam = this.am.accounts[idx].provider || 'other';
      if (!familyFirstSeen.has(fam)) familyFirstSeen.set(fam, []);
      familyFirstSeen.get(fam).push(idx);
    }
    const provGrouped = [...familyFirstSeen.values()].flat();
    // Owner 2026-10-29: Where is the PRIMARY grouping — local rows first, cloud rows
    // after — and the existing ordering (providers grouped by family, OAuth as-added)
    // stays intact WITHIN each group.
    const all = [...nonProv, ...provGrouped];
    return [...all.filter(i => !this.am.accounts[i].remote), ...all.filter(i => this.am.accounts[i].remote)];
  }

  _selectableIndexes(action) {
    // Map over _displayOrder() BEFORE filtering so the nav array is in DISPLAY order
    // with the existing selectability filter intact — _keySelect steps this array, so
    // visual order == nav order automatically and it can never land on a provider
    // (prefer) or a non-configurable runtime account.
    return this._displayOrder()
      .map(index => ({ account: this.am.accounts[index], index }))
      .filter(({ account }) => {
        if (action === 'check quota') return account.type === 'oauth' && account.provider !== 'codex' && account.credential
          && !account.remote && !account.poolBenchedBy && !account.refreshDead;
        if (action === 'prefer') return account.type !== 'provider' && account.enabled;
        if (action === 'codexLogin') return account.provider === 'codex';
        if (action === 'codexResets') return account.provider === 'codex' && !account.remote;
        // Enable/disable works on EVERY row — including a session-created provider,
        // where it is the DURABLE action (exportRuntimeProviders persists `enabled`,
        // and the header path never re-enables a row the user benched).
        if (action === 'toggle') return true;
        // Rename/delete need a config entry to act on. That now includes config
        // PROVIDERS (via _isConfigBacked), which the old accounts-only lookup excluded.
        // A SESSION row is still barred: renaming it forks a duplicate (upsertRuntime
        // Account matches by NAME, so the next header request recreates the original
        // and the same key lands on two accounts), and deleting it undoes itself.
        return this._isConfigBacked(account);
      })
      .map(({ index }) => index);
  }

  _keyInput(k) {
    if (k === 'enter') {
      const cb = this.inputCb;
      const v = this.inputBuf;
      this.mode = 'normal'; this.inputCb = null; this.inputBuf = ''; this.inputSensitive = false; this._pendingPaste = '';
      cb?.(v);
    }
    else if (k === 'esc') {
      this.mode = 'normal'; this.inputCb = null; this.inputBuf = ''; this.inputSensitive = false; this._pendingPaste = '';
    }
    else if (k === 'bs') { this.inputBuf = this.inputBuf.slice(0, -1); }
    else if (k.length === 1) { this.inputBuf += k; }
  }

  _keyConfirm(k) {
    if (k === 'y') {
      const cb = this.confirmCb;
      this._clearConfirm();
      Promise.resolve(cb?.()).catch(error => {
        this._addLog(`Action failed: ${error.message}`);
      });
    } else if (k === 'n' || k === 'esc' || k === 'q') {
      this._clearConfirm();
    }
  }

  _confirm(title, detail, cb, returnMode = 'normal') {
    this.mode = 'confirm';
    this.confirmTitle = title;
    this.confirmDetail = detail;
    this.confirmCb = cb;
    this.confirmReturnMode = returnMode;
  }

  _clearConfirm() {
    this.mode = this.confirmReturnMode;
    this.confirmTitle = '';
    this.confirmDetail = '';
    this.confirmCb = null;
    this.confirmReturnMode = 'normal';
  }

  // ── account operations ─────────────────────────────

  async _doSync() {
    try {
      this._addLog('Reloading config...');
      const count = await this.syncAccounts();
      if (count > 0) {
        this._addLog(`Synced ${count} new account(s) from config`);
      } else {
        this._addLog('Config reloaded, credentials refreshed');
      }
    } catch (e) {
      this._addLog(`Sync failed: ${e.message}`);
    }
  }

  async _doChatGPTLogin(account) {
    const wasRunning = this.running;
    setConsoleStdoutSuppressed(true);
    try {
      if (wasRunning) await this.handOff();
      const name = account
        ? account.remote?.remoteName || account.name
        : String(await this._ask('ChatGPT account name (optional): ') || '').trim();
      const cli = fileURLToPath(new URL('./index.js', import.meta.url));
      const child = spawn(process.execPath, codexLoginArgs(cli, name, account), { stdio: 'inherit' });
      const [code] = await once(child, 'exit');
      if (code !== 0) {
        this._addLog('ChatGPT sign-in did not finish');
        return;
      }
      await this.syncAccounts?.();
      await Promise.allSettled((this.am.poolLinks || []).map(link => link.poll()));
    } finally {
      setConsoleStdoutSuppressed(false);
      if (wasRunning) this.start();
    }
  }

  async _showCodexResets(account, notice = '') {
    const state = { account, credits: [], selected: 0, busy: true, notice };
    this.codexResets = state;
    this.mode = 'codexResets';
    this.forceRender();
    try {
      const result = await this.codexResetDetails(account.name);
      if (result.error) state.notice = `Could not read resets: ${result.error}`;
      else state.credits = (result.credits || []).filter(credit => canRedeemCodexCredit(credit));
    } catch (error) {
      state.notice = `Could not read resets: ${error.message}`;
    } finally {
      state.busy = false;
      if (this.codexResets === state) this.forceRender();
    }
  }

  _keyCodexResets(k) {
    const state = this.codexResets;
    if (k === 'esc' || k === 'q') {
      this.codexResets = null;
      this.mode = 'accounts';
      return;
    }
    if (!state || state.busy) return;
    if (k === 'up' || k === 'k') state.selected = Math.max(0, state.selected - 1);
    else if (k === 'down' || k === 'j') state.selected = Math.min(Math.max(0, state.credits.length - 1), state.selected + 1);
    else if (k === 'r') {
      this._showCodexResets(state.account).catch(error => this._addLog(`Could not read resets: ${error.message}`));
    } else if (k === 'enter' && this.redeemCodexReset) {
      const credit = state.credits[state.selected];
      if (state.account.enabled === false || !canRedeemCodexCredit(credit)) {
        state.notice = 'This reset cannot be redeemed.';
        return;
      }
      this._confirm('Redeem this reset?', 'Uses one banked reset and refreshes eligible Codex limits.',
        async () => {
          state.busy = true;
          let notice;
          try {
            const result = await this.redeemCodexReset(state.account.name, credit.id);
            notice = result.redeemed ? 'Reset redeemed.' : `Reset not redeemed: ${result.reason || result.error || 'provider declined'}`;
          } catch (error) {
            notice = `Could not redeem reset: ${error.message}`;
          }
          if (this.codexResets === state) await this._showCodexResets(state.account, notice);
        }, 'codexResets');
    } else if (k === 'a' && this.onSetCodexAutoRedeem) {
      // On unless the owner turned it off (an unset account is enrolled by default).
      const enabled = state.account.autoRedeemReset !== false;
      this._confirm(enabled ? 'Turn off automatic resets?' : 'Allow automatic resets?',
        enabled ? 'Banked resets remain available for manual use.' : 'Allow the pool to redeem eligible resets for this account.',
        async () => {
          try {
            await this.onSetCodexAutoRedeem(state.account.name, !enabled);
            state.account.autoRedeemReset = !enabled;
            state.notice = enabled ? 'Automatic resets off.' : 'Automatic resets on.';
          } catch (error) {
            state.notice = `Could not save settings: ${error.message}`;
          }
          this.forceRender();
        }, 'codexResets');
    }
  }

  _renderCodexResets(maxRows) {
    const state = this.codexResets;
    const out = ['', ` ${bold('Codex resets')}  ${state.account.name}`];
    const summary = resetSummary(state.account);
    if (Number.isInteger(summary?.available)) {
      const balance = summary.available + (summary.available === 1 ? ' banked reset' : ' banked resets');
      out.push(' ' + balance);
    }
    const quota = state.account.quota;
    const windows = [];
    if (quota.unified5h != null) windows.push(`5h ${quotaLabel(quota.unified5h, quota.unified5hReset, 20)}`);
    if (quota.unified7d != null) windows.push(`Weekly ${quotaLabel(quota.unified7d, quota.unified7dReset, 20)}`);
    if (windows.length) out.push(` ${windows.join('  ·  ')}`);
    if (state.notice) out.push(` ${state.notice.replace(/[\x00-\x1f\x7f-\x9f]/g, '')}`);
    if (state.busy) out.push(dim(' Reading reset inventory…'));
    else if (state.credits.length === 0) out.push(dim(' No reset details available'));
    const visible = Math.max(1, maxRows - out.length);
    const start = Math.max(0, state.selected - visible + 1);
    for (const [offset, credit] of state.credits.slice(start, start + visible).entries()) {
      const title = String(credit.title || 'Usage reset').replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 34);
      const expiry = credit.expiresAt == null ? '' : formatReset(credit.expiresAt);
      const status = 'Banked';
      out.push(` ${start + offset === state.selected ? '›' : ' '} ${title}  ${dim(status + (expiry ? ' · expires in ' + expiry : ''))}`);
    }
    return out;
  }

  // Browser OAuth login — the SAME flow re-authenticates an existing account (matched
  // by user + organization) or adds a new one. When the login is for an account already added,
  // we say so, keep its name, and skip the "name this account" prompt — so it's clear
  // it's a RE-AUTH in place (revives a dead-refresh/reauth account), not a duplicate.
  async _doLogin() {
    const wasRunning = this.running;
    // Mute the console-log MIRROR to stdout during the interactive prompt so routing
    // logs (console.log, e.g. the glm-fallback 429 churn) don't flood over the readline
    // "Name this account" prompt. The prompts + errors use process.stdout.write, which
    // BYPASSES the mirror, so they stay visible. Login runs only on the terminal-owning
    // primary (mirror baseline false), so the finally restores it to false. Muted BEFORE
    // the hand-off: its stop() hands console.log back to the mirror while the second
    // flush still waits, and those lines would print onto the user's normal screen.
    setConsoleStdoutSuppressed(true);
    try {
      if (wasRunning) await this.handOff();   // r2 B2: bounded flush + exit sequence before the prompt
      process.stdout.write('\nOpening browser to log into Claude…\n');
      const creds = await loginOAuth();
      const profile = await fetchProfile(creds.accessToken);
      // Owner shape (D15/D16, 2026-10-30): if the browser login belongs to an
      // account that LIVES in a linked team pool, the fresh login goes STRAIGHT
      // there — never persisted locally (single writer: one account, one home).
      // Same keystroke as a local re-auth; the routing is by where the account
      // lives, so nothing is selected and no menu appears.
      await this._routeLogin(creds, profile);
    } catch (e) {
      if (isLoginCancelled(e)) {
        process.stdout.write('\nLogin cancelled.\n');
      } else {
        process.stdout.write(`\nLogin failed: ${e.message}\n`);
      }
    } finally {
      setConsoleStdoutSuppressed(false);   // restore on every path (incl. the catch)
      if (wasRunning) this.start();
    }
  }

  // Where a finished browser login goes. Pure decision (see decideLoginTarget):
  // a mirror match → that team pool; a brand-new account with a linked team pool →
  // ask once (default team pool); otherwise the local save path.
  async _routeLogin(creds, profile) {
    const mirror = this._findRemoteMirrorFor(profile);
    const existing = mirror ? null : await this._matchLogin(profile);
    const decision = decideLoginTarget({ mirror, links: this.am.poolLinks, existing, accountUuid: profile?.accountUuid });
    if (decision.kind === 'no-uuid') {
      setConsoleStdoutSuppressed(false);
      process.stdout.write("\nCould not read this account's id — the team pool needs it. Nothing was saved; try again.\n");
      return;
    }
    if (decision.kind === 'mirror') {
      setConsoleStdoutSuppressed(false);
      await this._sendLoginToRemote(decision.mirror, creds, profile);
      return;
    }
    let name;
    if (existing) {
      process.stdout.write(`\nThis Claude account is already added as "${existing.name}" — re-authenticating it in place (no duplicate).\n`);
      name = existing.name;
    } else {
      const sibling = this._oauthAccounts().find(a => sameUser(a, profile));
      if (sibling) process.stdout.write(`\nSame Claude user as "${sibling.name}": adding a second account.\n`);
      const suggested = suggestAccountName(this.config.accounts, profile);
      let toTeam = false;
      if (decision.kind === 'ask-team') {
        const where = String(await this._ask(`\nThis is a new account. Add it to the team pool "${decision.link.name}" (recommended) or this laptop only? [T/l]: `) || '').trim().toLowerCase();
        toTeam = where !== 'l';
      }
      const answer = await this._ask(`Name this NEW account [${suggested}]: `);
      name = String(answer || '').trim() || suggested;
      if (toTeam) {
        setConsoleStdoutSuppressed(false);
        await this._sendLoginToTarget(
          { url: decision.link.url, key: decision.link.key, linkName: decision.link.name },
          name, creds, profile, { newAccount: true });
        return;
      }
    }
    // Lift the mute BEFORE the upsert so its persist-confirmation (a console.log,
    // deliberately visible during the stopped-TUI login) reaches the user.
    setConsoleStdoutSuppressed(false);
    // Message honors the ACTUAL result: if a manually-typed name collided with a
    // different existing account, upsert updates in place → "Re-authenticated", never
    // a false "Added new account".
    const { updated, name: savedName = name } = await this._upsertOAuthAccount({ creds, profile, name, source: 'login' });
    process.stdout.write(updated
      ? `\nRe-authenticated "${savedName}". Returning to maxpool…\n`
      : `\nAdded new account "${savedName}". Returning to maxpool…\n`);
  }

  // One readline question → answer string.
  async _ask(question) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await new Promise(resolve => rl.question(question, resolve));
    rl.close();
    return answer;
  }

  // The browser login belongs to a linked team pool iff a mirror row carries the
  // same account uuid (M2: mirrors hold remoteUuid, never accountUuid, so a
  // uuid-first matcher cannot alias onto a local account).
  _findRemoteMirrorFor(profile) {
    if (!profile?.accountUuid) return null;
    // Exact match first (user + org). A mirror whose org is unknown (the cloud
    // pool saved the account before organizations were recorded) still owns the
    // login when it is the only same-user mirror: re-authenticate it rather than
    // add a second row. Two known orgs never alias.
    const mirrors = this.am.accounts.filter(a => a.remote && a.enabled !== false
      && configuredAccountProvider(a) === 'anthropic' && sameUser({ accountUuid: a.remoteUuid }, profile));
    return mirrors.find(a => sameAccountIdentity({ accountUuid: a.remoteUuid, organizationUuid: a.remoteOrganizationUuid }, profile))
      || (profile.organizationUuid && mirrors.filter(a => !a.remoteOrganizationUuid).length === 1
        ? mirrors.find(a => !a.remoteOrganizationUuid) : null);
  }

  // Send a fresh browser login to the linked team pool that OWNS this account
  // (D15/D16). Never falls back to a local save — a network failure here must
  // surface, not silently create a second writer on this laptop.
  async _sendLoginToRemote(mirror, creds, profile) {
    const remote = mirror.remote;
    const name = remote.remoteName || mirror.name;
    return this._sendLoginToTarget(remote, name, creds, profile, { newAccount: false });
  }

  // Shared sender. target = {url, key, linkName}. Same single-writer rule for a
  // NEW account: a failure never falls back to a local save.
  async _sendLoginToTarget(remote, name, creds, profile, { newAccount }) {
    process.stdout.write(newAccount
      ? `\nSending new account "${name}" to the team pool (${remote.linkName})…\n`
      : `\n"${name}" lives in the team pool (${remote.linkName}) — sending the fresh login there…\n`);
    const r = await sendLoginToPool({ url: remote.url, key: remote.key, name, profile, creds });
    if (r.ok) {
      process.stdout.write(`\nDone: "${name}" ${r.result === 'added' ? 'added to' : 're-authenticated in'} the team pool${newAccount ? ` (${remote.linkName})` : ''}. Nothing was saved on this laptop.\n`);
      this._addLog(`Remote login: "${name}" → team pool ${remote.linkName} (${r.result})`);
    } else if (r.kind === 'unreachable') {
      process.stdout.write(`\n${r.error}. NOTHING was saved on this laptop — try again in a moment.\n`);
    } else {
      process.stdout.write(`\n${r.error}. NOTHING was saved on this laptop — not retried locally.\n`);
    }
  }

  // Rename an account in config and in the running manager.
  /**
   * USAGE CAP setter — persists to config (rollback on write failure) and applies
   * live. `0` / `off` / `100` REMOVE the cap (fully utilized); 1-99 set it. Runtime
   * providers (not in config) keep the cap in memory like their `enabled` flag —
   * it rides state.json across restarts and must also survive `cc all` header
   * re-upserts (the upsert guard in account-manager).
   */
  async _doSetCap(idx, raw) {
    const account = this.am.accounts[idx];
    if (!account) { this._addLog('Account no longer exists'); return; }
    const v = String(raw || '').trim().toLowerCase();
    const off = v === '' || v === '0' || v === 'off' || v === '100';
    // MODE PREFIX/SUFFIX: a bare number means the DYNAMIC cap (the default since
    // 2026-09-24 — the floor that lifts as the window nears reset); `f` marks the
    // fixed cap explicitly. `d` is accepted as the explicit dynamic spelling so the
    // two modes are symmetric to type.
    const explicitFixed = /^f/.test(v) || /f$/.test(v);
    let pct = null;
    if (!off) {
      const digits = v.replace(/[fd]/g, '');
      pct = parseInt(digits, 10);
      if (!Number.isInteger(pct) || pct < 1 || pct > 99) {
        this._addLog(`Usage cap must be 1-99, optionally f-prefixed for fixed (0 to remove) — got "${raw}"`);
        return;
      }
    }
    const cap = off ? null : pct / 100;
    const mode = cap == null ? null : (explicitFixed ? 'fixed' : 'dynamic');

    const loc = this._configLocation(account);
    if (loc) {
      const before = this.config[loc.array][loc.index];
      const entry = { ...before };
      if (cap == null) delete entry.capUtilization;
      else entry.capUtilization = cap;
      if (mode == null) delete entry.capMode;
      else entry.capMode = mode;
      this.config[loc.array][loc.index] = entry;
      try {
        await this.saveConfig(this.config, { collection: loc.array, before, after: entry, fields: ['capUtilization', 'capMode'] });
      } catch (error) {
        this.config[loc.array][loc.index] = before;
        throw error;
      }
    }
    // No loc: a runtime provider — in-memory + state.json persistence (same as enabled).
    account.capUtilization = cap;
    account.capMode = mode;
    this._addLog(cap == null
      ? `Usage cap removed for "${account.name}" — fully utilized`
      : mode === 'dynamic'
        ? `Dynamic cap ${pct}% set for "${account.name}" — it keeps ${100 - pct}% free early in each window, then opens up as the window nears its reset so nothing is stranded`
        : `Fixed cap ${pct}% set for "${account.name}" — the proxy stops routing to it at ${pct}% of the 5h and weekly windows`);
  }

  async _doRename(idx, newName) {
    const account = this.am.accounts[idx];
    if (!account) { this._addLog('Account no longer exists'); return; }
    if (!newName) { this._addLog('Rename cancelled (empty name)'); return; }
    if (this.am.accounts.some((a, i) => i !== idx && a.name === newName)) {
      this._addLog(`An account named "${newName}" already exists`); return;
    }
    const loc = this._configLocation(account);
    if (!loc) {
      // Renaming a SESSION row forks it: upsertRuntimeAccount matches by NAME, so the
      // next `cc all` request recreates the original and the same key ends up on two
      // accounts — double-counted quota and routing weight.
      this._addLog(`Cannot rename "${account.name}" — it comes from a running cc session, not your config`);
      return;
    }
    const cfgIdx = loc.index;
    const cfgArray = loc.array;
    const old = account.name;
    const before = this.config[cfgArray][cfgIdx];
    const entry = { ...before, name: newName };
    const wasPreferred = this.config.routing?.preferredAccount === old;
    this.config[cfgArray][cfgIdx] = entry;
    if (wasPreferred) this.config.routing.preferredAccount = newName;
    try {
      await this.saveConfig(this.config, { collection: cfgArray, before, after: entry, fields: ['name'] });
    } catch (error) {
      this.config[cfgArray][cfgIdx] = before;
      if (wasPreferred) this.config.routing.preferredAccount = old;
      throw error;
    }
    account.name = newName; // update the running account manager
    this._addLog(`Renamed "${old}" → "${newName}"`);
  }

  // Upsert Claude OAuth into config and the running manager.
  async _upsertOAuthAccount({ creds, profile, name, source, verb = 'Added' }) {
    const { index: idx, entry } = planClaudeOAuthLogin(this.config.accounts, { creds, profile, name, source },
      [...(this.config.providers || []), ...this.am.accounts]);
    name = entry.name;

    if (idx >= 0) {
      const previous = this.config.accounts[idx];
      this.config.accounts[idx] = entry;
      // Revive the account in memory even if the disk write fails.
      const amAcct = this._runningAccount(previous);
      if (amAcct) {
        amAcct.credential = creds.accessToken;
        amAcct.refreshToken = creds.refreshToken;
        amAcct.expiresAt = creds.expiresAt;
        amAcct.accountUuid = entry.accountUuid;
        amAcct.organizationUuid = entry.organizationUuid;
        amAcct.name = name;
        // Fresh tokens from re-auth revive a dead-refresh account. This in-place
        // update is the actual re-login path (the index.js reconcile sees no change
        // and never calls updateAccountTokens), so refreshDead MUST be cleared here.
        amAcct.refreshDead = false;
        if (amAcct.status === 'error') amAcct.status = 'active';
      }
      try {
        await this.saveConfig(this.config, { before: previous, after: entry,
          fields: ['source', 'accountUuid', 'organizationUuid', 'accessToken', 'refreshToken', 'expiresAt'] });
      } catch (error) {
        // Persist failed (e.g. disk full). The browser re-auth genuinely SUCCEEDED,
        // so KEEP the AccountManager on the fresh tokens — reverting it to the dead
        // token would brick a working in-memory account. Roll back only the
        // config.accounts mirror and surface the error.
        this.config.accounts[idx] = previous;
        throw error;
      }
      this._addLog(`Updated account "${name}"`);
      // The fingerprint matches the persisted grant and stays visible while the TUI is stopped.
      console.log(`[Maxpool] Re-authenticated "${name}" — fresh token persisted (fp=${tokenFingerprint(creds.refreshToken)})`);
      return { updated: true, name };
    } else {
      this.config.accounts.push(entry);
      try {
        const saved = await this.saveConfig(this.config, { after: entry });
        if (saved?.name) entry.name = saved.name;
      } catch (error) {
        const failed = this.config.accounts.indexOf(entry);
        if (failed >= 0) this.config.accounts.splice(failed, 1);
        throw error;
      }
      this.am.addAccount(entry);
      this._addLog(`${verb} account "${entry.name}"`);
      return { updated: false, name: entry.name };
    }
  }

  // Decide what a fresh browser-login profile is: an account already in the pool
  // (re-authenticate in place) or a new one. Same-user entries that do not know
  // their organization are read first; when one still cannot be read, the user decides.
  async _matchLogin(profile) {
    await this._resolveOrganizations(profile);
    const existing = this._findExistingOAuthAccount(profile);
    if (this._organizationUnknown(existing, profile)) return this._confirmReauth(existing);
    return existing;
  }

  // Fill in the organization of same-user entries that lack one, reading each with
  // the running account's live token (read only, never refreshed), and mirror the
  // result to the manager. The upsert that follows persists it.
  async _resolveOrganizations(profile) {
    if (!profile?.accountUuid) return;
    await resolveOrganizations(this._oauthAccounts(), profile.accountUuid, entry => this._liveCredentials(entry));
    this._mirrorOrganizations(profile);
  }

  _liveCredentials(entry) {
    const live = this._runningAccount(entry);
    return live ? { accessToken: live.credential, expiresAt: live.expiresAt } : entry;
  }

  _mirrorOrganizations(profile) {
    const known = this._oauthAccounts().filter(a => sameUser(a, profile) && a.organizationUuid);
    for (const entry of known) this._mirrorOrganization(entry);
  }

  _mirrorOrganization(entry) {
    const live = this._runningAccount(entry);
    if (live) live.organizationUuid = entry.organizationUuid;
  }

  _runningAccount(entry) {
    const local = this.am.accounts.filter(account => !account.remote);
    return local[findClaudeOAuthLoginIndex(local, entry)];
  }

  _oauthAccounts() {
    return this.config.accounts.filter(isClaudeOAuthAccount);
  }

  // Find an already-configured OAuth account matching a fresh browser-login profile —
  // the same user in the same organization; else a same-user entry that does not know
  // its organization (the login then asks); else, for a profile without a uuid,
  // name===email; else an entry saved before uuids were stored. The SAME precedence
  // _upsertOAuthAccount dedupes on, so the login flow can honestly say
  // "re-authenticating" vs "adding new".
  _findExistingOAuthAccount(profile) {
    const accounts = this._oauthAccounts();
    const email = profile?.email || null;
    if (!profile?.accountUuid) return (email && accounts.find(a => a.name === email)) || null;
    return accounts.find(a => sameAccountIdentity(a, profile))
      || organizationUnknownMatch(accounts, profile)
      || accounts.find(a => !a.accountUuid && a.name === email)
      || null;
  }

  // True when the match rests on the user alone: the entry's organization is unknown
  // while the login names one.
  _organizationUnknown(existing, profile) {
    return Boolean(existing?.accountUuid && profile?.organizationUuid && !existing.organizationUuid);
  }

  // The user decides a same-user login whose organization could not be read: Enter
  // or r re-authenticates the entry, a adds a second account; anything else asks again.
  async _confirmReauth(existing) {
    const choice = await this._askReauthOrAdd(existing.name);
    if (choice === 'add') return null;
    if (choice === 'reauth') return existing;
    return this._confirmReauth(existing);
  }

  async _askReauthOrAdd(name) {
    const raw = await this._ask(`Same Claude user as "${name}", organization unknown. Re-authenticate it (r) or add a second account (a)? [r] `);
    const answer = String(raw || '').trim().toLowerCase();
    if (['', 'r', 're-authenticate'].includes(answer)) return 'reauth';
    return ['a', 'add'].includes(answer) ? 'add' : null;
  }

  async _doAddKey(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) { this._addLog('No API key entered'); return; }
    const n = this.config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    const name = `api-${n}`;
    const entry = { name, type: 'apikey', apiKey: key };
    this.config.accounts.push(entry);
    try {
      const saved = await this.saveConfig(this.config, { after: entry });
      if (saved?.name) entry.name = saved.name;
    } catch (error) {
      this.config.accounts.pop();
      throw error;
    }
    this.am.addAccount(entry);
    this._addLog(`Added API key account "${entry.name}"`);
  }

  async _setAutomaticRouting() {
    const previous = this.config.routing;
    this.config.routing = { mode: 'automatic', preferredAccount: null };
    try {
      await this.saveConfig(this.config);
    } catch (error) {
      this.config.routing = previous;
      throw error;
    }
    this.am.setRoutingMode('automatic');
    this._addLog('Routing set to automatic load balancing');
  }

  async _setPreferredRouting(name) {
    const account = this.am.accounts.find(candidate => candidate.name === name);
    if (!account?.enabled || account.type === 'provider') {
      throw new Error(`Claude account "${name}" must be enabled before it can be preferred`);
    }
    const previous = this.config.routing;
    this.config.routing = { mode: 'preferred', preferredAccount: name };
    try {
      await this.saveConfig(this.config);
    } catch (error) {
      this.config.routing = previous;
      throw error;
    }
    this.am.setRoutingMode('preferred', name);
    this._addLog(`Routing now prefers "${name}" with automatic failover`);
  }

  _configAccountIndex(account) {
    if (!account) return -1;
    const provider = configuredAccountProvider(account);
    const local = this.config.accounts.filter(candidate => candidate.type === account.type
      && configuredAccountProvider(candidate) === provider);
    const match = local[findAccountConfigIndex(local, account)];
    if (match) return this.config.accounts.indexOf(match);
    // Older Claude config rows can hold settings under just the account name.
    if (account.remote || provider !== 'anthropic') return -1;
    return this.config.accounts.findIndex(candidate => candidate.name === account.name
      && candidate.type == null && candidate.provider == null);
  }

  /** Where does this account live in config — `accounts` or `providers`?
   *  A config PROVIDER (GLM/Kimi from config.providers) is just as durable as an OAuth
   *  account, but _configAccountIndex only ever searched config.accounts, so providers
   *  reported -1 and were excluded from rename/delete. With the Providers screen gone,
   *  that would strand them in config forever. Returns { array, index } or null. */
  _configLocation(account) {
    if (!account) return null;
    const accIdx = this._configAccountIndex(account);
    if (accIdx >= 0) return { array: 'accounts', index: accIdx };
    const provs = this.config.providers;
    if (Array.isArray(provs)) {
      const pIdx = provs.findIndex(p => p.name === account.name && (!account.provider || p.provider === account.provider));
      if (pIdx >= 0) return { array: 'providers', index: pIdx };
    }
    return null;
  }

  /** True when this row can be permanently removed/renamed — i.e. it is backed by a
   *  config entry. A SESSION row (created from `cc all` headers, not in config) is not:
   *  deleting it is a lie because the next request recreates it. */
  _isConfigBacked(account) {
    return this._configLocation(account) !== null;
  }

  async _doToggle(idx, enabled) {
    const account = this.am.accounts[idx];
    if (!account) return;
    const configIndex = this._configAccountIndex(account);
    if (configIndex < 0) {
      // A runtime provider (GLM/Kimi) isn't in config — it's re-created from the `cc all`
      // request headers — but its enable/disable IS durable: the flag persists in memory
      // across `cc all` requests (the header upsert never re-enables it) and to state.json
      // on the next save, so it stays benched across a restart too. Re-enable it here the
      // same way whenever the user wants it back — there's no "removed forever" state.
      if (account.type === 'provider') {
        // A CONFIG-SOURCED provider (one with a `providers:` entry) is re-created from
        // config on every reload — `loadConfigProviders` computes `enabled: entry.enabled
        // !== false` — so a runtime-only flag is silently undone by the next update or
        // restart. Persist it where that read happens. Measured 2026-09-11: Kimi, disabled
        // by the owner, came back enabled after an auto-update because its config entry
        // had no `enabled` key. Header-derived providers (no config entry) keep the
        // runtime-only path below, which is durable for them.
        const applied = applyProviderEnabledToConfig(this.config, account.name, enabled);
        if (applied.changed) {
          try {
            const entry = this.config.providers.find(provider => provider.name === account.name);
            await this.saveConfig(this.config, { collection: 'providers', before: entry, after: entry, fields: ['enabled'] });
          } catch (error) {
            applyProviderEnabledToConfig(this.config, account.name, applied.previous);
            throw error;
          }
        }
        this.am.setAccountEnabled(idx, enabled);
        if (!enabled && this.am.preferredAccountName === account.name) this.am.setRoutingMode?.('automatic');
        this._addLog(`${enabled ? 'Enabled' : 'Disabled'} provider "${account.name}" — ${enabled ? 'routing resumed' : 'benched (stays off across cc all + restart; re-enable here anytime)'}`);
        return;
      }
      this._addLog(`Cannot ${enabled ? 'enable' : 'disable'} "${account.name}" here (not in config)`);
      return;
    }
    const entry = this.config.accounts[configIndex];
    const previous = entry.enabled;
    entry.enabled = enabled;
    const previousRouting = this.config.routing;
    const resetsRouting = !enabled && this.config.routing?.preferredAccount === account.name;
    if (resetsRouting) {
      this.config.routing = { mode: 'automatic', preferredAccount: null };
    }
    try {
      await this.saveConfig(this.config, { before: entry, after: entry, fields: ['enabled'] });
    } catch (error) {
      entry.enabled = previous;
      this.config.routing = previousRouting;
      throw error;
    }
    this.am.setAccountEnabled(idx, enabled);
    this._addLog(`${enabled ? 'Enabled' : 'Disabled'} account "${account.name}"`);
  }

  async _doDelete(idx) {
    if (idx < 0 || idx >= this.am.accounts.length) return;
    const account = this.am.accounts[idx];
    const name = account.name;
    if (account.inFlight > 0) {
      this._addLog(`Cannot delete "${name}" while ${account.inFlight} request(s) are active; disable it and retry when idle`);
      return;
    }
    const loc = this._configLocation(account);
    if (!loc) {
      // A SESSION row: a running `cc all` is handing maxpool this key, so deleting it
      // would be undone by the next request. Disabling IS durable here — the header
      // path never re-enables a benched row — so point the user at the action that works.
      this._addLog(`"${name}" comes from a running cc session, so deleting it would not stick — press t to switch it off instead (that survives restarts)`);
      return;
    }
    const configIndex = loc.index;
    const configArray = loc.array;
    const wasEnabled = account.enabled;
    this.am.setAccountEnabled(idx, false);
    if (account.inFlight > 0) {
      this.am.setAccountEnabled(idx, wasEnabled);
      this._addLog(`Cannot delete "${name}" because a request started; the account was not changed`);
      return;
    }

    const [removedConfig] = this.config[configArray].splice(configIndex, 1);
    const previousRouting = this.config.routing;
    if (this.config.routing?.preferredAccount === name) {
      this.config.routing = { mode: 'automatic', preferredAccount: null };
    }
    let removedOnDisk;
    try {
      removedOnDisk = await this.saveConfig(this.config, { collection: configArray, before: removedConfig });
    } catch (error) {
      this.config[configArray].splice(configIndex, 0, removedConfig);
      this.config.routing = previousRouting;
      this.am.setAccountEnabled(idx, wasEnabled);
      throw error;
    }
    if (!this.am.removeAccount(idx)) {
      this.config[configArray].splice(configIndex, 0, removedConfig);
      this.config.routing = previousRouting;
      this.am.setAccountEnabled(idx, wasEnabled);
      if (removedOnDisk !== null) {
        await this.saveConfig(this.config, { collection: configArray, after: removedOnDisk || removedConfig });
      }
      throw new Error(`Account "${name}" became active before deletion completed`);
    }
    if (this.selIdx >= this.am.accounts.length) this.selIdx = Math.max(0, this.am.accounts.length - 1);
    this._addLog(`Deleted account "${name}"`);
  }

  // ── rendering ──────────────────────────────────────

  /** Draw on the next tick at the latest — N calls inside one tick draw ONE frame
   *  (2026-11-12: every log line used to redraw the full screen synchronously and the
   *  pool froze on a terminal that fell behind). */
  requestRender() {
    if (!this.running || this._renderTimer) return;
    const wait = Math.max(0, RENDER_MIN_INTERVAL_MS - (Date.now() - this._lastRenderAt));
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this.render();
    }, wait);
    this._renderTimer.unref?.();
  }

  /** Draw NOW (keystroke, resize, takeover): the user is waiting on this frame. */
  forceRender() {
    if (!this.running) return;
    if (this._renderTimer) { clearTimeout(this._renderTimer); this._renderTimer = null; }
    this._forceNext = true;
    this.render();
  }

  render() {
    if (!this.running) return;
    // Guard against re-entry: clearing an expired quota logs, and _addLog schedules
    // render() again — without this the nested call would render twice.
    if (this._rendering) return;
    this._rendering = true;
    try {
      this._render();
    } finally {
      this._rendering = false;
    }
  }

  _render() {
    // Reset the display the instant a quota window (e.g. 5-hour session) expires,
    // instead of waiting for the next request to clear it.
    this.am.refreshExpiredQuotas();
    const W = process.stdout.columns || 80;
    const H = process.stdout.rows || 24;

    if (W < 40 || H < 8) {
      this._writeScreen(`${ESC}H${ESC}2JTerminal too small (need 40x8+)\r\n`);
      return;
    }

    if (this.mode === 'analytics') {
      this._writeScreen(this._renderAnalyticsPage(W, H), W, H);
      return;
    }

    const lines = [];

    // ── Header
    const v = this.am.versionInfo;
    const verStr = v?.current ? ` ${dim('v' + v.current)}` : '';
    // Auto-update state next to the version, so it's obvious whether a published release
    // lands hands-free (green "auto-update on") or needs a manual 'u' (dim "off").
    const auto = this._autoUpdateOn()
      ? green('· auto-update on')
      : dim('· auto-update off');
    const left = bold(' Maxpool') + verStr + ' ' + auto;
    const port = this.config.proxy?.port || 3456;
    const right = `Port ${port} ${green('▲')} `;
    lines.push(left + ' '.repeat(Math.max(1, W - vw(left) - vw(right))) + right);
    lines.push(' ' + dim('─'.repeat(W - 2)));
    // Usage by person (owner 2026-10-29: "the only thing missing is usage by person").
    // Local named callers + each linked team pool's callers, one compact line.
    const people = this._peopleLine(W);
    if (people) lines.push(people);
    // Restart/reload in progress: admission is paused while active requests drain, then
    // the process swaps. Without live feedback the screen looks FROZEN (identical
    // dashboard, nothing moving) from R→Yes until the swap — the reported bug. Show an
    // animated draining indicator. It clears when the swap completes (fresh worker
    // renders) or a rollback resumes admission (admissionPaused → false).
    if (this.am.admissionPaused) {
      // Total TUI in-flight — an honest, user-meaningful "your work is finishing" count.
      // (The reload gates its drain on UPSTREAM requests only, so this can read slightly
      // higher than the controller's gating count; queued/idle ones reconnect, not lost.)
      const inflight = this.active.size;
      const detail = inflight > 0
        ? `draining ${inflight} active request${inflight === 1 ? '' : 's'}…`
        : 'finishing up…';
      lines.push(` ${cyan(SPINNER[this.frame])} ${yellow('Restarting')}  ${dim(detail)}`);
    }
    // Update reminder: a prominent, actionable banner when a newer npm version is
    // published — nothing when on latest or the check hasn't resolved (no permanent
    // blank line). The persistent banner IS the reminder; a long-lived session's
    // periodic re-check keeps it current (index.js updateTimer refreshes versionInfo).
    if (v?.hasUpdate && v?.latest) {
      // No more "run npm i -g, then press r" — that manual dance is what the Updates menu
      // kills. Auto-update ON: it applies itself; either way 'u' pulls + reloads in place.
      const how = this._autoUpdateOn() ? 'applying automatically · or press u now' : 'press u to update now';
      lines.push('  ' + yellow(`↑ Update available: v${v.current} → v${v.latest}`) + dim(`  ·  ${how}`));
    }
    // Routing header: name the mode + show the one-line description the operator
    // picked when cycling. Under `preferred`, show the manual-preference line (still
    // available via the 'p' key on the routing screen).
    let routing;
    if (this.am.routingMode === 'preferred') {
      routing = `Manual preference: ${this.am.preferredAccountName} (automatic failover)`;
    } else {
      // Label ONLY here. The one-line description belongs on the routing screen (and in
      // the log line when the mode changes) — inlining it here pushed the provider-volume
      // and cross-provider fragments off the right edge at 120 columns.
      routing = this._routingModeDef(this.am.scheduler?.routingMode || 'sticky').label;
    }
    // WHERE CLAUDE CODE ROUTES (owner 2026-11-01: "can the app show where the Claude
    // Code app is routing to now?"). Reads the same switch file rc-gate re-reads per
    // request, so the header always agrees with the live path. Direct mode is RED —
    // it means the pool is bypassed and accounts are idle.
    try {
      let mode = 'pool';
      try { mode = readFileSync(homedir() + '/.config/rc-gate-route', 'utf8').trim() || 'pool'; } catch { /* absent = pool */ }
      routing += mode === 'direct' ? `  ·  Claude Code: ${red('DIRECT (pool bypassed)')}` : `  ·  Claude Code: ${green('pool')}`;
    } catch { /* display-only */ }
    // Cross-provider fallback policy — only meaningful when GLM/Kimi providers are in
    // the pool (profile=all). never=strict pin (yellow), when-exhausted=default (cyan),
    // always=peer (green).
    const hasProviders = this.am.accounts.some(a => a.type === 'provider');
    const mode = this.am.scheduler?.routingMode || 'sticky';
    let xpText = '';
    // Only show the cross-provider fragment under sticky — under balance/prefer-*, the
    // MODE controls routing and claudeFallback is inert. Showing it there made the
    // header read "Balance all · Cross-provider: always" which looked like two
    // conflicting settings when only the first one does anything.
    if (hasProviders) {
      // PEAK (SC9): name an active window — the feature must be visible, not silent.
      // Only while a provider is genuinely in-window, so an off-peak screen is
      // byte-identical to today (render parity, TEST PLAN H1).
      // Cross-provider fragment is sticky-only — under other modes it is inert and
      // reading "always" next to "Balance all" looked like two conflicting controls.
      if (mode === 'sticky') xpText = this._crossProviderText();
      // PEAK note is APPENDED after, never before: the sticky assignment above
      // overwrites xpText wholesale, so prepending silently discarded the peak note
      // in sticky — which is DEFAULT_SCHEDULER.routingMode, the TUI's own fallback,
      // AND the legacy-policy migration target (red-team 2026-08-18).
      const peakNote = this._peakHeaderNote();
      if (peakNote) xpText += (xpText ? '  ' : '') + peakNote;
      // Overflow visibility: when GLM/Kimi actually served requests recently, surface the
      // volume so provider traffic isn't a mystery. This is DATA, not a control — shown
      // in every mode. Reuses the SAME 15m load window as the per-row "15m Nr" column.
      const now = Date.now();
      let provReq = 0;
      for (const a of this.am.accounts) {
        if (a.type === 'provider') provReq += this.am._loadSummary?.(a, 15 * 60_000, now)?.requests || 0;
      }
      if (provReq > 0) xpText += `  ${dim('·')}  ${yellow(`providers: ${provReq} req/15m`)}`;
    }
    lines.push(this._routingLine(routing, xpText));
    const efficiencyNow = Date.now();
    const cacheLine = this._cacheLine(W, efficiencyNow);
    if (cacheLine != null) lines.push(cacheLine);
    const movesLine = this._movesLine(W, efficiencyNow);
    if (movesLine != null) lines.push(movesLine);
    const capacityLine = this._capacityLine(W, efficiencyNow);
    if (capacityLine != null) lines.push(capacityLine);
    lines.push(...this._cloudLinkLines(W));
    const queuedCount = this.am.queueState?.waiting?.length || 0;
    // Throttle and WAITING are different things and used to share one line labelled
    // "Anthropic upstream throttled" — so a request parked purely because every account
    // is at its quota was either invisible (no throttle) or described as a throttle it
    // wasn't. Waiting is the headline state of this proxy; it gets its own line, always
    // shown whenever anything is parked, naming what it is waiting FOR.
    if (this.am._isUpstreamThrottleBlocking?.()) {
      const throttle = this.am.upstreamThrottle;
      const remaining = throttle.until ? Math.max(0, Math.ceil((throttle.until - Date.now()) / 1000)) : 0;
      const state = throttle.probeInFlight ? 'probing recovery' : `retry in ${remaining}s`;
      lines.push(` ${yellow(' Anthropic upstream throttled')}  ${dim(state)}`);
    }
    if (queuedCount) {
      const oldest = Math.max(0, Date.now() - this.am.queueState.waiting[0].queuedAt);
      // Name the soonest thing that would release them, so a long wait reads as
      // "waiting for a known reset" rather than "hung".
      let why = 'waiting for capacity';
      try {
        const plan = this.am.nextRetryForRequest?.({}, new Set()) || {};
        if (Number.isFinite(plan.retryAfterMs) && plan.retryAfterMs > 0) {
          why = `next account frees in ~${formatMs(plan.retryAfterMs)}`;
        } else if (plan.cause) {
          why = `waiting (${plan.cause.replace(/_/g, ' ')})`;
        }
      } catch { /* display-only; never let the oracle break the render */ }
      lines.push(` ${cyan(' Parked')} ${dim(`${queuedCount} request${queuedCount === 1 ? '' : 's'} held  oldest ${formatMs(oldest)}  ·  ${why}`)}`);
    }

    // ── Capacity page — a DEDICATED screen, not a footer panel. It replaces the
    // account/activity body wholesale so the six columns get the full width; the
    // header above (version, routing, throttle) stays so the operator never loses
    // where they are. Reads the in-memory ledger only — no fs per frame.
    if (this.mode === 'capacity') {
      lines.push(...this._renderCapacityPage(W));
      while (lines.length < H - 2) lines.push('');
      lines.push(' ' + dim('─'.repeat(W - 2)));
      lines.push(this._renderFooter());
      this._writeScreen(lines, W, H);
      return;
    }
    if (this.mode === 'people') {
      lines.push(...this._renderPeoplePage(W));
      while (lines.length < H - 2) lines.push('');
      lines.push(' ' + dim('─'.repeat(W - 2)));
      lines.push(this._renderFooter());
      this._writeScreen(lines, W, H);
      return;
    }
    if (this.mode === 'codexResets') {
      const maxRows = H - lines.length - 2;
      lines.push(...this._renderCodexResets(maxRows).slice(0, Math.max(0, maxRows)));
      while (lines.length < H - 2) lines.push('');
      lines.push(' ' + dim('─'.repeat(W - 2)));
      lines.push(this._renderFooter());
      this._writeScreen(lines, W, H);
      return;
    }

    // ── Accounts
    if (this.am.accounts.length === 0) {
      lines.push('');
      lines.push(yellow('  No accounts configured. Press [a] to add one.'));
    } else {
      lines.push('');
      // Aligned column header (dim + underline so it reads as chrome, not data). It
      // labels the fixed columns that have no inline label; the Ses/Fbl/Wk/Tok/Req and
      // Now/15m/1h labels stay inline per row. It sits DIRECTLY above the rows — the
      // abbreviation glossary is a FOOTER below the rows (a caption), never between
      // the header and the data (a left-aligned sentence there reads as a broken,
      // misaligned second header).
      lines.push(dimUnderline(acctHeader(W)));
      // Sticky: once any account has reported a session window in this run, keep the
      // Ses column. A window that simply expires on an idle pool nulls its reading
      // until the next request or probe; dropping and re-adding the column then
      // would make every bar jump width. Pools that never report one keep it hidden.
      this._sessionColumnSeen = this._sessionColumnSeen || this.am.accounts.some(hasSessionReading);
      // Below 70 columns only ONE bar fits: Wk (real data) wins over a latched-but-
      // expired Ses, so the collapse logic still applies at narrow widths.
      const latch = W >= 70 ? this._sessionColumnSeen : this.am.accounts.some(hasSessionReading);
      const { showSession, showBoth, showFable, bw } = barLayout(W, latch);

      // Claude/OAuth accounts first, providers (GLM/Kimi fallback) last — a stable
      // display order over the canonical am.accounts array (which stays untouched so
      // routing/index-keyed actions are unaffected). Selection navigation shares the
      // SAME order via _selectableIndexes → _displayOrder.
      let hidden = 0;
      const showSelectedCodex = this.mode === 'select'
        && (this.selAction === 'codexLogin' || this.selAction === 'codexResets');
      for (const i of this._displayOrder()) {
        // Same key also hides local copies guarded by the duplicate guard — they are
        // effectively off (owner 2026-10-29: "should it hide the local ones that are
        // in the cloud... they're effectively disabled as well"). No separate key.
        // One predicate shared with the Capacity page so the two row orders cannot drift.
        const account = this.am.accounts[i];
        const hiddenByChoice = this.hideDisabled && !(showSelectedCodex && account.provider === 'codex');
        if (this.am.hiddenOnMainScreen(account, hiddenByChoice)) { hidden++; continue; }
        lines.push(this._renderAcct(i, bw, showBoth, showFable, showSession, W));
      }
      if (hidden > 0) {
        lines.push(` ${dim(`… ${hidden} disabled account${hidden === 1 ? '' : 's'} hidden — press h to show`)}`);
      }
      const outcomes = resetOutcomesLine(this.am.accounts, W);
      if (outcomes) lines.push(outcomes);
      // The glossary FOOTER is gone (owner, 2026-08-27). A legend is a symptom: it
      // exists to decode a row that could not be read on its own. Every cell now
      // says what it means in words ("2 live · 17 req/hr", "quota 12m old ·
      // refreshing in 45s"), so there is nothing left to decode — and one fewer
      // line of chrome between the operator and the data.
    }

    // ── Activity header
    lines.push('');
    // "N active" reads as "N sessions" — but this is in-flight REQUESTS (Claude Code
    // fans out many parallel subagent requests per session). Label it "in-flight" and
    // show the distinct SESSION count (subagents of one terminal share one session key)
    // so a busy 1-2 sessions firing dozens of requests isn't mistaken for a leak.
    const ac = this.active.size;
    const sessions = new Set([...this.active.values()].map(r => r.sessionKey).filter(Boolean)).size;
    const acTag = ac > 0
      ? `  ${cyan(ac + ' in-flight')}${sessions ? dim(` · ${sessions} session${sessions === 1 ? '' : 's'}`) : ''}`
      : '';
    const aHdr = ` Activity${acTag}   ${bold('v')} Analytics `;
    lines.push(aHdr + dim('─'.repeat(Math.max(1, W - vw(aHdr)))));

    // Active requests
    const now = Date.now();
    // NEWEST FIRST, matching the completed log directly below (which is `unshift`ed).
    // A Map iterates in INSERTION order, so this block used to run oldest-first while the
    // log under it ran newest-first — the panel disagreed with itself and the newest thing
    // that happened was buried in the middle of the screen.
    for (const [, r] of [...this.active].reverse()) {
      const el = ((now - r.started) / 1000).toFixed(1);
      const sp = cyan(SPINNER[this.frame]);
      const a = r.account ? ` → ${r.account}` : '';
      lines.push(` ${sp} ${gray(r.t)}  ${r.method} ${r.path}${a} ${dim(`(${el}s...)`)}`);
    }

    // Providers panel — BEFORE the log so it lands inside the visible region. It used
    // to be pushed after the pad-to-full-height loop, so every line fell past the
    // bottom edge and the screen rendered only its header (reported 2026-08-10:
    // "when I click on providers I just see the title — how is that helpful?").
    if (this.mode === 'addtype') {
      const aLines = [];
      this._renderAddType(aLines);
      lines.push('', ...aLines);
    }

    // Completed log
    // 2 = separator + footer; confirm adds its detail line; updates adds its detail block.
    const codexAccountActions = this.mode === 'accounts' && this.am.accounts.some(a => a.provider === 'codex');
    const routingDetail = this.mode === 'routing' ? this._renderRoutingDetail(W, efficiencyNow) : null;
    const footerH = this.mode === 'confirm' || codexAccountActions ? 3
      : this.mode === 'updates' ? 2 + this._renderUpdatesDetail().length
      : routingDetail ? 2 + routingDetail.length
      : 2;
    const space = Math.max(0, H - lines.length - footerH);
    for (let i = 0; i < space && i < this.log.length; i++) {
      lines.push(`   ${gray(this.log[i].t)}  ${this.log[i].msg}`);
    }

    // The footer is the screen's controls — it must never be pushed off. On a short
    // terminal cut the BODY from the bottom, and say so.
    if (lines.length > H - footerH) {
      const keep = Math.max(0, H - footerH - 1);
      const hidden = lines.length - keep;
      lines.length = keep;
      lines.push(` ${dim(`… ${hidden} more row${hidden === 1 ? '' : 's'} — make the window taller to see them`)}`);
    }

    // Pad to fill
    while (lines.length < H - footerH) lines.push('');

    // ── Footer
    lines.push(' ' + dim('─'.repeat(W - 2)));
    if (this.mode === 'confirm') lines.push(` ${this.confirmDetail}`);
    if (codexAccountActions) {
      const resets = this.codexResetDetails && this.am.accounts.some(a => a.provider === 'codex' && !a.remote);
      lines.push(` ${bold('c')} Reconnect ChatGPT${resets ? `  ${bold('r')} Codex resets` : ''}`);
    }
    // Updates DETAIL — without this, pressing 'u' changed only the one-line footer at the
    // very bottom of a busy screen, which reads as "nothing happened" (reported twice).
    // Every other mode draws something visible; this one must too.
    if (this.mode === 'updates') lines.push(...this._renderUpdatesDetail());
    if (routingDetail) lines.push(...routingDetail);
    lines.push(this._renderFooter());

    this._writeScreen(lines, W, H);
  }

  /** Full-screen buffer write: cursor home, H rows fitted to W, then hide the cursor
   *  (shown only in input mode). The ONLY frame writer: it coalesces (an unchanged
   *  frame is skipped unless forced / REPAINT_MS-old) and never writes into a terminal
   *  that has not drained the last frame — it owes one render on 'drain' instead
   *  (2026-11-12 freeze fix). Memory stays bounded: the stream's own high-water mark
   *  stops us, and at most one frame is owed. */
  _writeScreen(lines, W, H) {
    let buf;
    if (typeof lines === 'string') {
      buf = lines;   // pre-built screen (e.g. "Terminal too small")
    } else {
      buf = `${ESC}H`;
      for (let i = 0; i < H; i++) {
        buf += fitLine(lines[i] || '', W);
        if (i < H - 1) buf += '\r\n';
      }
      // Show cursor only in input mode
      buf += this.mode === 'input' ? `${ESC}?25h` : `${ESC}?25l`;
    }
    this._lastRenderAt = Date.now();
    if (!this._forceNext && this._lastFrame === buf && Date.now() - this._lastFullWriteAt < REPAINT_MS) return;
    if (this._nb && process.stdout.writableNeedDrain) {
      if (!this._drainArmed) { this._drainArmed = true; process.stdout.once('drain', this._onDrain); }
      return;   // frame owed: written once, on 'drain'
    }
    this._forceNext = false;
    // A queued frame can sit below Node's writable high-water mark, so
    // 'drain' will not fire. Keep one outstanding frame and let the periodic
    // renderer retry once the terminal accepts it.
    if (this._nb && process.stdout.writableLength > 0) return;
    this._lastFrame = buf;
    this._lastFullWriteAt = Date.now();
    process.stdout.write(buf);
  }

  _renderAcct(idx, bw, showBoth, showFable = showBoth, showSession = true, width = 100) {
    let a = this.am.accounts[idx];
    // A row benched by the duplicate guard renders the CLOUD's live copy (status,
    // bars, in-flight, request counts) — never the stale local snapshot. Identity
    // and name stay local so the row doesn't move.
    const live = a?.poolBenchedBy ? this.am.remoteRowFor?.(a) : null;
    if (live) {
      const r = live.row;
      // B2 (2026-11-10): the overlay also carries the cloud twin's RESETS via the
      // same normalizeRemoteResets the mirror rows use. When the twin's snapshot is
      // MISSING the reset fields (one failed link poll — the "2 → gone → back"
      // flicker through a new path), keep the PREVIOUS overlay marked not-fresh,
      // never 0.
      let resetsOverlay;
      if (r.resetGrants != null || r.resetCards != null || r.capLift != null) {
        const nr = normalizeRemoteResets(r);
        resetsOverlay = { resetGrants: nr.resetGrants, resetCards: nr.resetCards, capLift: nr.capLift, resetOutcomes: nr.resetOutcomes };
      } else {
        const prev = a._twinResetsOverlay || {};
        resetsOverlay = {
          resetGrants: prev.resetGrants ? { ...prev.resetGrants, stale: true } : null,
          resetCards: prev.resetCards ? { ...prev.resetCards, stale: true } : null,
          capLift: prev.capLift ?? null,
          resetOutcomes: prev.resetOutcomes ?? null,
        };
      }
      a._twinResetsOverlay = resetsOverlay;   // remember for the next frame's fallback
      a = Object.assign(Object.create(Object.getPrototypeOf(a)), a, {
        quota: r.quota || {},  // all quota fields must come from the same owner
        inFlight: r.inFlight ?? 0,
        completedRequests: r.completedRequests ?? a.completedRequests,
        refreshDead: Boolean(r.refreshDead),
        rateLimitedUntil: r.rateLimitedUntil ? Date.parse(r.rateLimitedUntil) : null,
        resetGrants: resetsOverlay.resetGrants,
        resetCards: resetsOverlay.resetCards,
        capLift: resetsOverlay.capLift,
      });
    } else if (a?.poolBenchedBy) {
      a = { ...a, quota: {} }; // no cloud twin sample to display
    }

    // Highlight the ACTIVE account(s) — drives BOTH the ► marker and the green
    // "active" status color. In manual mode that's the single pinned account (all
    // traffic goes there). In automatic load-balancing there is no single "current"
    // account, so mark every account SERVING a request right now (inFlight > 0) —
    // an honest live view of what's working. When idle, nothing is marked; a
    // throttled/idle provider is never falsely flagged (the old "most recently
    // routed to" currentIndex could land the marker on an idle fallback).
    const isCur = this.am.routingMode === 'preferred'
      ? a.name === this.am.preferredAccountName
      : a.inFlight > 0;
    const isSel = this.mode === 'select' && idx === this.selIdx;

    // Prefix: selection marker + current marker
    const sel = isSel ? cyan('>') : ' ';
    const cur = isCur ? green('►') : ' ';

    // Name (bold if selected)
    // A cloud row is named exactly like the account (the Where column says Cloud);
    // its internal name carries a suffix only to stay unique next to a local copy.
    const nameW = nameWidth(width);
    const rawName = (a.remote ? a.remote.remoteName : a.name).slice(0, nameW).padEnd(nameW);
    // A disabled account reads as "off" — dim the whole name. Applied as a SINGLE SGR
    // (never dim(bold(...)) — bold()'s trailing RESET would cancel the dim mid-string),
    // so a disabled row is never also bold-selected.
    const label = a.enabled === false ? dim(rawName) : (isSel ? bold(rawName) : rawName);
    const cache = this._accountMetrics(this.am.accounts[idx])?.windows['3h'];
    const name = label + ' ' + lpadVis(cachePercent(cache), CACHE_W);

    // Provider column — the real vendor (Anthropic / z.ai / Moonshot), padded to
    // PROVIDER_W so "Anthropic" (9 chars) never overflows and shifts the row (incl.
    // its quota bars) out of alignment with the shorter provider labels. This single
    // cell is reused by both the oauth/apikey row below and _renderProviderAcct.
    const type = gray(providerLabel(a).padEnd(PROVIDER_W));

    // Status
    let status;
    // A shared upstream throttle holds the whole Claude pool, not any one
    // account. Don't mislabel healthy accounts as per-account "paused": show
    // the one running the recovery probe as "probing" and the rest "waiting"
    // (the pool-wide throttle banner above conveys the cause).
    const upstreamBlocking = a.type !== 'provider' && a.provider !== 'codex' && this.am._isUpstreamThrottleBlocking?.();
    // A mirror row whose link is down/stale is benched by syncRemoteMirrors with
    // enabled=false — show it as cloud-unreachable, never as "disabled" (which reads
    // as "I switched this off"). _cloud/_cloudOk were never set; key on a.remote.
    const linkDown = a.remote && (a.remote.link?.lastError || a.remote.link?.probeDown || a.remote.link?.lastOkAt == null);
    let effectiveStatus = a.remote && (linkDown || a.enabled === false)
      ? (linkDown ? 'cloud-down' : 'disabled')
      : (a.poolBenchedBy ? 'pool-benched' : (a.enabled === false ? 'disabled' : a.status));
    if (a.enabled !== false && upstreamBlocking && a.status === 'active') {
      effectiveStatus = a.inFlight > 0 ? 'probing' : 'waiting';
    }
    // Anthropic is rejecting the WHOLE account (a 'rejected' unified status
    // corroborated by an exhausted unified bucket). A per-model cap (Fable) is NOT
    // account-wide — it shows as the separate "… maxed" tag, leaving the status
    // column truthful. Keys on a.status (not effectiveStatus) so a genuine block
    // wins even inside an upstream-throttle window.
    // Named "exhausted", not "blocked" (2026-08-27): the row's own quota bar and
    // every other surface call this state exhausted, and two words for one state
    // read as two different problems.
    if (a.enabled !== false && a.status === 'active' && this.am._isAccountWideRejected?.(a)) {
      effectiveStatus = 'exhausted';
    }
    // A dead refresh token surfaces as "reauth" (re-login needed) rather than a
    // generic "error", so the user knows the fix. Display-only — account.status
    // stays 'error' so routing/eligibility still exclude it.
    // A DISABLED account still shows its auth state. Suppressing it meant disabling an
    // account hid the fact that it needs re-login: the row read "✕ disabled" whether the
    // credentials were fine or long dead, so re-enabling it later silently produced a
    // broken account. Reported 2026-08-10 with all 8 disabled accounts sitting on dead
    // credentials (HTTP 401) and no way to see it.
    // HELD BY ITS OWN LIMITS (2026-10-13). An account the router refuses must not read
    // "active": 16 requests sat parked for 35 minutes while two rows said "active" next
    // to an account held at its usage cap and another whose 5h window was full. Only
    // relabels an otherwise-active row; exhausted / throttled / auth states keep their
    // own (more specific) word. "capped" = the owner's usage cap is holding it;
    // "5h full" = its session window is used up until the reset shown on the row.
    // Pure predicates on purpose: _weeklyRawState/_isSessionQuotaUnavailable call
    // _clearExpiredQuotas, which MUTATES the quota (nulls an expired window), so calling
    // them here blanked this row's own bars mid-render. (_render already runs the
    // manager's expiry refresh once per frame, before any row is drawn.)
    if (a.enabled !== false && effectiveStatus === 'active') {
      if (capBenched(this.am, a)) effectiveStatus = 'capped';
      // The weekly wait outlasts the 5h one, so it names the account's state first.
      else if (weekFull(this.am, a)) effectiveStatus = 'exhausted';
      else if (sessionFull(this.am, a)) effectiveStatus = '5h full';
    }
    if (a.refreshDead) effectiveStatus = a.enabled === false ? 'disabled-reauth' : 'reauth';
    // Subscription gone (org-disabled 403): a DISTINCT state from reauth — re-logging in
    // will NOT fix it until the subscription is re-purchased. Says the actionable thing.
    // Same precedence rule as reauth above: when the account is ALSO switched off,
    // "disabled" stays the headline so the disabled inventory remains readable.
    else if (a.subscriptionGone) effectiveStatus = a.enabled === false ? 'disabled-nosub' : 'no sub';
    switch (effectiveStatus) {
      case 'active':    status = isCur ? green('active') : 'active'; break;
      case 'reauth':    status = yellow('reauth'); break;
      case 'blocked':   status = red('exhausted'); break;
      case 'probing':   status = green('probing'); break;
      case 'waiting':   status = yellow('waiting'); break;
      case 'paused':    status = yellow('paused'); break;
      case 'disabled':  status = red('✕ disabled'); break;
      case 'pool-benched': status = gray('in cloud'); break;
      // The banner above names the cause once; each row just says it is out of reach.
      case 'cloud-down': status = yellow('⟐ offline'); break;
      // Disabled AND needs re-login — both facts matter, and DISABLED LEADS.
      // The owner's question that drove this (2026-09-30): "when I disable the account
      // and then the token expires, does it show disabled or reauth? It needs to
      // continue to show disabled otherwise I'm confused as to which ones I have
      // disabled." Showing only '✕ reauth' made a deliberately-off account
      // indistinguishable from a live one with dead credentials, so the disabled
      // inventory could not be read off the screen at all. So the STATUS column always
      // says 'disabled' for an account you switched off, and the reason it ALSO cannot
      // serve rides as its own tag ("needs login" / "no sub") — collapsing both into one
      // '+' marker would lose the distinction between "log in again" (fixable) and
      // "subscription gone" (not fixable by logging in).
      case 'disabled-reauth':
      case 'disabled-nosub':  status = red('✕ disabled'); break;
      case 'no sub': status = red('✕ no sub'); break;
      case 'throttled': {
        // A transient auto-recovering cooldown — show the remaining time (from
        // rateLimitedUntil) so it reads as "recovering in Ns", not stuck.
        const cd = countdown(a.rateLimitedUntil);
        status = yellow(cd ? `throttled ${cd}` : 'throttled');
        break;
      }
      case 'exhausted': status = red('exhausted'); break;
      case 'capped':    status = yellow('capped'); break;
      case '5h full':   status = yellow('5h full'); break;
      case 'error':     status = red('error'); break;
      default:          status = a.status || 'ready';
    }
    // Widened from 10 to fit "throttled 59s" so the quota bars stay column-aligned.
    status = rpad(status, STATUS_W);

    // MRst/ARst columns — banked limit resets (owner request 2026-09-30: a separate
    // column showing 0 or the count). z.ai cards + Claude cedar_ember grants,
    // not-yet-expired, on ENABLED accounts only: a disabled account's resets are
    // not ours to spend, and showing a count there would imply otherwise.
    //
    // B3 grammar (2026-11-10), split into two cells 2026-11-15:
    //   MRst (width MRST_W)  model-scoped  nFable~Xd  e.g. 2Fable~114d ('-' when none)
    //   ARst (width ARST_W)  account-level n~Xd       e.g. 1~29d ('0' when none)
    //   unknown  n?   scope unknown (ARst only) — count shown, never claimed
    //   not-fresh = gray + trailing '?' when it fits (stale listing, dead account, old check)
    // Count = SUM of resetsLeft over spendable grants + live cards (not entries).
    // Overflow order: drop the suffix first, then collapse to total+'*'.
    // Expiry is checked LIVE here: grants endsAt>now, cards !expired &&
    // (expiresAt==null || expiresAt>now) — a frozen `expired` flag never keeps a
    // dead reset on screen (pre-mortem #18).
    let resetsCell;
    // The five-hour-card column rides at the end of the reset cells on EVERY row, so all
    // row types stay aligned. Blank (padded) where it does not apply or does not fit.
    const fiveHourCol = show5hColumn(width) ? ' ' + fiveHourResetCell(a, Date.now()) : '';
    if (a.provider === 'codex') {
      resetsCell = codexResetCells(a, Date.now(), this.am.codexResetExpiryFor?.(a, Date.now())) + fiveHourCol;
    } else {
      const now = Date.now();
      let general = 0;       // resetsLeft of general-weekly grants + live cards
      let scoped = 0;        // resetsLeft of model-scoped grants (tagged F)
      let unknown = 0;       // resetsLeft of scope-unknown grants
      let soonestG = Infinity;  // soonest expiry among account-level (general/unknown) resets
      let soonestS = Infinity;  // soonest expiry among model-scoped resets
      if (a.enabled !== false) {
        const liveCard = c => c && !c.expired && (c.expiresAt == null || c.expiresAt > now);
        const rc = a.resetCards;
        if (rc) {
          // WEEKLY cards only. Five-hour cards have their OWN column (5hR, owner
          // 2026-11-27) and are no longer folded into this account-level count.
          for (const c of (rc.weekly || [])) {
            if (liveCard(c)) { general += 1; if (c.expiresAt != null && c.expiresAt < soonestG) soonestG = c.expiresAt; }
          }
        }
        const rg = a.resetGrants;
        if (rg?.eligible !== false && rg) {
          for (const g of (rg.grants || [])) {
            if (!g || g.usableNow === false || g.paused || g.expired) continue;
            if (g.endsAt != null && g.endsAt <= now) continue;            // live expiry
            // Display counts GRANTS by identity, not capabilities (owner
            // 2026-11-11: the screen showed "3Fable" while Anthropic's own screen
            // says "two fable and one regular weekly"). A grant that directly
            // clears the general weekly (full-reset shape: clears includes
            // 'seven_day') IS a weekly reset however much else it also clears —
            // count it general, once. Model-only grants count scoped; the
            // give-back side effect adds no display count (B3.1 nuance, 2026-11-10).
            // Claim and lift still read appliesTo() — the full reset stays eligible
            // at a model wall, and narrow-first spending (2026-11-11) keeps it for
            // the weekly wall.
            const scopes = appliesTo(g);
            const clearsWeekly = (Array.isArray(g.clears) ? g.clears : []).includes('seven_day');
            const hasScoped = scopes.some(x => x !== 'general' && x !== 'session');
            const left = Math.max(0, Math.floor(g.resetsLeft ?? 1));
            let isScoped = false;
            if (clearsWeekly) general += left;
            else if (hasScoped) { scoped += left; isScoped = true; }
            else if (scopes.includes('general')) general += left;
            else unknown += left;
            if (g.endsAt != null) {
              if (isScoped) { if (g.endsAt < soonestS) soonestS = g.endsAt; }
              else if (g.endsAt < soonestG) soonestG = g.endsAt;
            }
          }
        }
      }
      const total = general + scoped + unknown;
      // Not-fresh (pre-mortem #15): stale listing, a dead account, or a check older
      // than 3x the grants cadence. An account that stopped being probed never gets
      // re-listed, so checkedAt alone would show a green count forever.
      // EACH listing is judged by what the account HAS (fixed 2026-11-27): a z.ai
      // account holds CARDS and never a Claude grant listing, so `a.resetGrants` is
      // null for it. The old `freshGrants = a.resetGrants && ...` was therefore false
      // for every z.ai account, and a card listed this very sweep rendered grey with
      // '?' — a fresh card that looked stale. A listing that does not apply to this
      // provider is fresh by definition; one that exists and is old is not.
      const listingFresh = l => !l || (l.stale !== true && (l.checkedAt == null || now - l.checkedAt <= LISTING_FRESH_MS));
      const freshGrants = listingFresh(a.resetGrants);
      const freshCards = listingFresh(a.resetCards);
      const notFresh = total > 0 && (!freshGrants || !freshCards || a.refreshDead || a.subscriptionGone);

      // Two cells (owner 2026-11-15): MRst = model-scoped resets, ARst = account-level.
      // Each cell has its OWN count, expiry and fit; the staleness flag is shared.
      const expirySuffix = (n, soonest) => {
        if (!(n > 0) || soonest === Infinity) return '';
        const days = (soonest - now) / 86400_000;
        return days < 1 ? `~${Math.max(1, Math.round(days * 24))}h` : `~${Math.max(1, Math.round(days))}d`;
      };
      // Fit to EXACTLY w: full form, then drop the suffix, then n+'*'. Not-fresh:
      // append '?' only when it fits; otherwise gray carries the staleness (a
      // '1+2Fable' -> '3?' collapse flipped the count on every self-update,
      // owner 2026-11-10).
      const renderCell = (core, suffix, n, w, sticky) => {
        let text = core + suffix;
        if (text.length > w) text = core;
        if (text.length > w) text = `${n}*`.slice(0, w);
        if (notFresh && n > 0 && !sticky && (text + '?').length <= w) text += '?';
        return rpad(n > 0 && !notFresh ? green(text) : gray(text), w);
      };
      // MRst: model-scoped grants spell the model ('2Fable'), never a bare F
      // (owner 2026-11-10: "What does the letter F mean?"). Nothing -> a dim dash.
      const mCell = scoped > 0
        ? renderCell(`${scoped}Fable`, expirySuffix(scoped, soonestS), scoped, MRST_W, false)
        : rpad(gray('-'), MRST_W);
      // ARst: account-level count; scope-unknown grants show 'n?' when they are all there is.
      const unknownOnly = unknown > 0 && general === 0;
      const aN = unknownOnly ? unknown : general;
      const aCore = unknownOnly ? `${unknown}?` : `${general}`;
      const aCell = aN > 0
        ? renderCell(aCore, expirySuffix(aN, soonestG), aN, ARST_W, unknownOnly)
        : rpad(gray('0'), ARST_W);
      resetsCell = mCell + ' ' + aCell + fiveHourCol;
    }

    if (a.type === 'provider') {
      return this._renderProviderAcct(sel, cur, name, type, status + ' ' + resetsCell, a, bw, showBoth, showFable, showSession);
    }

    // Quota ratios — prefer unified (Claude Max), fall back to standard (API key)
    const q = a.quota;
    let r1 = null, r2 = null, l1 = 'Ses', l2 = 'Wk ', t1 = null, t2 = null;

    if (a.provider === 'codex' || q.unified5h != null || q.unified7d != null) {
      r1 = q.unified5h;
      r2 = q.unified7d;
      t1 = q.unified5hReset;
      t2 = q.unified7dReset;
    } else {
      l1 = 'Tok';
      l2 = 'Req';
      r1 = (q.tokensLimit != null && q.tokensRemaining != null)
        ? 1 - q.tokensRemaining / q.tokensLimit : null;
      r2 = (q.requestsLimit != null && q.requestsRemaining != null)
        ? 1 - q.requestsRemaining / q.requestsLimit : null;
      t1 = q.resetsAt ? new Date(q.resetsAt).getTime() : null;
      t2 = t1;
    }

    const bars = [];
    // The Fable bar comes first, before the session and weekly bars, on every row
    // type, so each bar starts at the same offset on OAuth, API-key and provider rows.
    const barCount = Number(showFable) + Number(showSession) + Number(showBoth);
    const barsFit = width >= barStart(width) + barCount * BAR_MIN_W + (barCount - 1) * BAR_GAP;
    if (a.provider === 'codex' && !barsFit) {
      // With the fixed account columns, an 80-column terminal only has five
      // cells for the reading. Put the percentage before an optional long label.
      const used = r2 ?? r1;
      if (used != null) {
        const pct = `${Math.round(used * 100)}%`;
        const label = r2 != null ? 'Wk' : '5h';
        const space = width - (barStart(width) - 4);
        bars.push(space >= pct.length + label.length ? label + pct : pct);
      } else bars.push(dim('—'));
    } else {
      if (showFable) bars.push(a.provider === 'codex' ? ' '.repeat(4 + bw) : `Fbl ${scopedWeeklyBar(q, 'fable', bw)}`);
      if (showSession) bars.push(`${l1} ${bar(r1, bw, t1)}`);
      if (showBoth) {
        // "no weekly cap on this plan" is a DIFFERENT state from "not read yet", and
        // both render as an empty bar. Say which, so a healthy uncapped account
        // (privacy@gomokka.com, measured 2026-08-06) doesn't read as broken.
        bars.push((r2 == null && q.weeklyAbsent)
          ? `${l2} ${emptyBar('none', bw)}`
          : `${l2} ${bar(r2, bw, t2)}`);
      }
    }
    let line = ` ${sel}${cur} ${name} ${whereCell(a)} ${type} ${status} ${resetsCell} ${bars.join('  ')}`;
    const weekly = weeklyPolicyText(this.am, a);
    if (weekly) line += `  ${weekly}`;
    // Per-account SETTINGS (preferred pin, usage cap), whatever the account is
    // doing. weeklyPolicyText renders "Cap 50%" only while the cap is the ACTIVE
    // weekly state; these are the standing properties, so a capped account that is
    // exhausted, throttled or idle still says so. The cap is suppressed when the
    // weekly tag already IS the Cap label (no double tag).
    for (const tag of settingsTags(this.am, a)) {
      if (weekly.includes('Cap ') && tag.includes('cap ')) continue;
      line += `  ${tag}`;
    }
    // Per-model weekly caps (e.g. Fable, while the unified weekly still has
    // headroom). Show the ACTUAL utilization — "Fable 90%" (yellow) while high but
    // still usable, "Fable maxed" (red) ONLY at genuine exhaustion. This is the
    // SAME predicate the router benches on (_scopedExhausted), so "maxed" renders
    // iff the model is actually benched — 90%/critical is no longer mislabelled.
    const exhaustedFloor = this.am.scheduler?.weeklyExhaustedThreshold ?? 1;
    const reserveFloor = this.am.scheduler?.weeklyReserveThreshold ?? 0.85;
    const scopedTags = [];
    for (const [fam, e] of Object.entries(q.scopedWeekly || {})) {
      if (!e || e.utilization == null) continue;
      if (e.utilization < reserveFloor) continue;
      const Fam = fam.charAt(0).toUpperCase() + fam.slice(1);
      scopedTags.push(e.utilization >= exhaustedFloor
        ? red(`${Fam} maxed`)
        : yellow(`${Fam} ${Math.round(e.utilization * 100)}%`));
    }
    if (scopedTags.length) line += `  ${scopedTags.join(' ')}`;
    // Freshness: scoped caps are refreshed ONLY by the background probe (response
    // headers don't carry them). If the probe has gone stale, say so — and name the
    // cause (e.g. rate-limited) when a probe failure is on record — rather than imply
    // the last-known value is current.
    line += this._probeHealthNote(a, showFable);
    const act = loadText(this._accountLoad(a));
    if (act) line += `  ${dim(act)}`;
    return line;
  }

  /** Freshness suffix for an account row. Empty when the probe is current. When
   *  stale, names the cause from the last recorded probe failure (e.g. a 429 from
   *  the usage endpoint) so a self-throttling probe reads as "rate-limited" rather
   *  than an unexplained "stale". Leading spaces included so callers append raw. */
  _probeHealthNote(a, showFable = false) {
    // A dead account (reauth / disabled) already surfaces its state in the status
    // column, and its quota reading is frozen and moot — the prober skips it, so a
    // "stale·probe 401" here is just the perpetual echo of the 401 that killed it.
    // Only annotate probe-staleness for LIVE accounts, where a failing probe
    // (e.g. a 429) is a real, actionable signal.
    if (a?.refreshDead || a?.subscriptionGone || a?.enabled === false) return '';
    const q = a.quota || {};
    const remote = Boolean(a.remote || a.poolBenchedBy);
    const now = Date.now();
    const weeklyWall = a.type === 'oauth' && a.provider !== 'codex' && q.unified7d >= 1
      && (!q.unified7dReset || q.unified7dReset > now);
    if (a.poolBenchedBy && !Object.keys(q).length) return `  ${dim('cloud quota unavailable')}`;
    const interval = remote ? q.probeIntervalMs : this.am.quotaProbeIntervalMs;
    const hasPlan = remote ? interval !== 0 : interval > 0;
    const staleAfter = Math.max(3 * (interval || 0), 180_000);
    const ageStale = remote ? q.lastProbeOkAt && now - q.lastProbeOkAt > staleAfter : this.am._quotaProbeStale?.(a);
    if (!ageStale && !(hasPlan && (weeklyWall || q.probeRetryAt > now))) return '';
    // The background probe IS stale — but only flag it if something DISPLAYED is
    // actually stale. An OAuth account's Ses/Wk bars come from unified5h/7d, which
    // response headers refresh on every served request (updateQuota → lastHeaderQuotaAt);
    // so a BUSY oauth account with a header-fresh reading and no probe-only scoped
    // cap is NOT stale, even if its background probe is 429-throttled. Provider bars
    // and per-model scoped caps ARE probe-only, so for those a stale probe genuinely
    // means stale data → keep flagging. A scoped reading is DISPLAYED when its tag
    // shows (at or above the reserve floor) or, for Fable, whenever the Fbl bar is on
    // screen: the bar draws the reading at any level, so a stale low Fbl value must
    // carry the age marker too.
    const reserveFloor = this.am.scheduler?.weeklyReserveThreshold ?? 0.85; // mirrors _renderAcct's scoped-tag gate
    const hasDisplayedScopedCap = Object.entries(q.scopedWeekly || {}).some(([family, e]) =>
      e && e.isActive !== false && e.utilization != null
      && (e.utilization >= reserveFloor || (showFable && family === 'fable')));
    if (a.type !== 'provider' && !hasDisplayedScopedCap) {
      const headerFresh = q.lastHeaderQuotaAt && now - q.lastHeaderQuotaAt <= staleAfter;
      if (headerFresh && !weeklyWall && !(q.probeRetryAt > now)) return '';
    }
    // SAY WHAT HAPPENS NEXT (owner, 2026-08-27): "stale" / "stale·probe throttled"
    // named an internal mechanism and left the user with nothing to do. Nothing IS
    // the correct action — the prober retries on its own schedule and backs off
    // automatically when Anthropic rate-limits it — so the cell now states how old
    // the numbers are AND when they refresh, in that order.
    const age = q.lastProbeOkAt ? formatAge(Date.now() - q.lastProbeOkAt) : null;
    const ageText = age ? `quota ${age} old` : 'quota not read yet';
    const throttled = q.probeRetryAt > now || (q.lastProbeErrorStatus === 429
      && (q.lastProbeErrorAt ? q.lastProbeErrorAt >= (q.lastProbeOkAt || 0) : !remote));
    const nextAt = Math.max(q.probeRetryAt || 0, q.probeNextCheckAt || 0);
    let action;
    if (q.probeChecking && !(q.probeRetryAt > now)) action = remote ? 'cloud reported a check in progress' : 'refreshing now';
    else if (q.probeRecheckRequested) action = 'check queued';
    else if (nextAt) action = nextAt > now ? `next check due in ${formatAge(nextAt - now)}` : 'check due';
    else if (remote) action = interval === 0 ? 'cloud checks off' : 'cloud check time unavailable';
    else action = `${throttled ? 'retrying' : 'refreshing'} ${this._probeNextText()}`;
    const body = `${ageText} · ${throttled ? 'rate-limited, ' : ''}${action}`;
    return `  ${throttled ? yellow(body) : dim(body)}`;
  }

  /** Legacy local rows without individual timing can only name their next sweep. */
  _probeNextText() {
    if (this.am.quotaProbeSweeping) return 'on this or the next sweep';
    const at = this.am.quotaProbeNextSweepAt;
    if (at) {
      const ms = at - Date.now();
      return ms > 0 ? `in ${formatAge(ms)}` : 'on the next sweep';
    }
    const interval = this.am.quotaProbeIntervalMs;
    return interval > 0 ? 'on the next sweep' : 'shortly';
  }

  _renderProviderAcct(sel, cur, name, type, status, a, bw = 11, showBoth = true, showFable = showBoth, showSession = true) {
    const q = a.quota || {};

    // Ses/Wk bars in the SAME columns as OAuth rows (right after status) so the
    // whole table's bars line up. z.ai exposes a 5-hour token window (Ses) and —
    // when its monitor endpoint includes it — a weekly (Wk, intermittently absent →
    // "—"). Kimi's coding key has NO pollable quota (web console only) → "n/a" both
    // + a "console-only" note; not-yet-probed → "probing". Fields are the SEPARATE
    // provider* set, so a provider reading never leaks into an OAuth bar.
    let sesCell, wkCell, note = '';
    if (q.providerSes != null || q.providerWk != null) {
      sesCell = q.providerSes != null ? bar(q.providerSes, bw, q.providerSesReset) : emptyBar('—', bw);
      // z.ai's `max` plan genuinely has NO weekly token window (measured 2026-08-06:
      // one TOKENS_LIMIT, unit 3 = 5h). "none" says that; "—" read as a broken probe.
      wkCell = q.providerWk != null ? bar(q.providerWk, bw, q.providerWkReset)
        : emptyBar(q.weeklyAbsent ? 'none' : '—', bw);
      note = this._probeHealthNote(a);
      // OUTSIDE-USAGE tag (2026-10-27): someone else is spending this account's quota
      // with the same key. Red and first, because it explains every other symptom on
      // the row (wall hit too fast, cards vanishing) and the fix is a key rotation.
      if (a.outsideUsage?.outside) note += `  ${red(`key used outside pool ×${Math.max(1, Math.round(a.outsideUsage.zaiCalls / Math.max(1, a.outsideUsage.poolCalls)))}`)}`;
      // PEAK row tag (SC9): mirrors the router's own predicates — hard-barred = off,
      // tier 2 = over cap, tier 1 = peak (or "cap n/a" when the weekly is unreadable,
      // so the soft cap is inert). The label can never disagree with routing because
      // it reads the same predicates.
      if (this.am._peakHardBarred?.(a)) note += `  ${red('peak·off')}`;
      else {
        const tier = this.am._peakTier?.(a) || 0;
        const wu = this.am._peakWeeklyUtilization?.(a);
        if (tier === 2) note += `  ${yellow(`peak·capped ${Math.round((wu ?? 0) * 100)}%`)}`;
        else if (tier === 1) note += wu == null ? `  ${dim('peak·cap n/a')}` : `  ${yellow('peak')}`;
      }
      // FAST-REFILL tag (2026-08-25): mirrors the router's own _fastRefillMultiplier —
      // the label cannot disagree with routing because it reads the same predicate.
      // Only shown when a discount is actually applied (< 1).
      if (a.quota?.weeklyAbsent && this.am._fastRefillMultiplier) {
        const m = this.am._fastRefillMultiplier(a);
        if (m < 1) note += `  ${cyan(`fast·refill ×${m.toFixed(2)}`)}`;
      }
    } else if (q.providerQuotaSource === 'console-only') {
      sesCell = emptyBar('n/a', bw);
      wkCell = emptyBar('n/a', bw);
      note = `  ${dim('console-only')}`;
    } else if (q.noPlan) {
      // z.ai answered: this key's account has no coding plan (cancelled/expired).
      // Name it — "probing" here read as a pool fault for days (owner, 2026-11-08).
      sesCell = emptyBar('no plan', bw);
      wkCell = emptyBar('no plan', bw);
      note = `  ${red('z.ai says no coding plan — check billing')}`;
    } else {
      sesCell = emptyBar('probing', bw);
      wkCell = emptyBar('probing', bw);
    }
    // Settings ride OUTSIDE the quota-readable branch: an account with an
    // unreadable or not-yet-probed quota still HAS its reservation, and hiding the
    // setting whenever the probe is quiet is how a shipped feature reads as absent.
    for (const tag of settingsTags(this.am, a)) note += `  ${tag}`;

    const bars = [];
    // Fable is an Anthropic model family: a provider (GLM, Kimi, …) has no such limit,
    // so its row shows blank space where an OAuth row draws "Fbl <bar>" (owner
    // 2026-11-16: "why does it say Fable for GLM? That makes no sense"). Same visible
    // width ("Fbl " + bar), so Ses and Wk stay in the OAuth rows' columns.
    if (showFable) bars.push(' '.repeat(4 + bw));
    if (showSession) bars.push(`Ses ${sesCell}`);
    if (showBoth) bars.push(`Wk  ${wkCell}`);
    let line = ` ${sel}${cur} ${name} ${whereCell(a)} ${type} ${status} ${bars.join('  ')}`;
    line += note;
    // Same recent-load columns as OAuth (providers track inFlight + load events),
    // plus a compact Last <status> <ms> — the one signal that matters for a
    // rarely-hit fallback. loadText renders empty when fully idle.
    const act = loadText(this._accountLoad(a));
    if (act) line += `  ${dim(act)}`;
    // "Last 200 6.4s" next to a live "17/h · 6.4s" said the same thing twice. Keep it
    // for the two cases where it is the ONLY thing that speaks: a non-2xx last result
    // (always worth seeing), or an idle row whose activity cell is blank.
    const lastOk = a.lastStatus >= 200 && a.lastStatus < 300;
    if (a.lastStatus && (!lastOk || !act)) {
      line += `  ${dim('Last')} ${statusColor(a.lastStatus)} ${dim(formatMs(a.lastResponseMs))}`;
    }
    // Header-derived generic rate-limit (distinct from the monitor-endpoint quota),
    // if the provider upstream returns x-ratelimit-* headers — only when present.
    if (q.genericLimit != null && q.genericRemaining != null) {
      const reset = formatReset(q.genericReset);
      line += `  ${dim(`Lim ${q.genericLimit - q.genericRemaining}/${q.genericLimit}${reset ? ' ' + reset : ''}`)}`;
    }
    if (a.lastError) line += `  ${red('Err ' + String(a.lastError).slice(0, 18))}`;
    return line;
  }

  _accountLoad(account) {
    if (account.load) return account.load;
    if (!this.am?._loadSummary) return null;
    const now = Date.now();
    const base = w => {
      const load = this.am._loadSummary(account, w, now);
      const key = w === 15 * 60_000 ? 'last15m' : 'last1h';
      // A cloud row merges both pools' halves (rowEfficiencySummary): cache + served
      // from the serving pool's export (team-wide on that account), bounces / waits /
      // moves from this Mac's own events — the parts the cloud cannot see.
      const team = Boolean(account.remote && account._remoteLoad?.[key]?.efficiency);
      const efficiency = this.am.rowEfficiencySummary
        ? this.am.rowEfficiencySummary(account, key, now)
        : this.am._efficiencySummary(account, w, now);
      return team ? { ...load, efficiency, team: true } : { ...load, efficiency };
    };
    return {
      current: {
        inFlight: account.inFlight,
        activeWeight: account.activeWeight,
      },
      last15m: base(15 * 60 * 1000),
      last1h: base(60 * 60 * 1000),
    };
  }

  /** PEOPLE page (SC22) — usage by teammate. Rolling windows (24h/7d/30d, priors
   *  as DELTAS) + cumulative, requests AND tokens; merges this pool's served traffic
   *  with linked pools' callerWindows — each request counted once, at the pool that
   *  served it (red-team verdict 2026-10-29: delta = % on base>=50, raw otherwise;
   *  honesty footer for coverage + link sync; nobody-yet state, not zeros). */
  _renderPeoplePage(W = 80) {
    const out = [];
    out.push('');
    out.push(` ${bold('Usage by person')}  ${dim('— requests · ~7d = tokens · rolling windows · no double counting')}`);
    out.push('');

    const merged = new Map();
    const addWin = (name, w) => {
      const cur = merged.get(name) || { h24: 0, h24p: 0, d7: 0, d7p: 0, d30: 0, d30p: 0, total: 0, tok7: 0, paid7: 0 };
      for (const k of ['h24', 'h24p', 'd7', 'd7p', 'd30', 'd30p', 'total']) cur[k] += (w[k]?.req ?? 0);
      cur.tok7 += (w.d7?.tok ?? 0);
      cur.paid7 += (w.d7?.paid ?? 0);
      merged.set(name, cur);
    };
    for (const [n, w] of this.am.callerWindowStats?.() || []) addWin(n, w);
    for (const l of this.am.poolLinks || []) {
      const cw = l.status?.callerWindows || {};
      for (const [n, w] of Object.entries(cw)) addWin(n, w);
    }
    merged.delete('legacy-key');
    if (!merged.size) {
      out.push(dim('  Nobody has made a named request yet. Rows appear once requests'));
      out.push(dim('  carry personal pool keys.'));
      return out;
    }

    const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n);
    const fmtTok = t => t >= 1e6 ? (t / 1e6).toFixed(1) + 'M' : t >= 1000 ? Math.round(t / 1000) + 'k' : String(t);
    const delta = (cur, prior) => {
      if (!prior) return dim('--');
      const d = prior >= 50 ? `${cur > prior ? '+' : ''}${Math.round(((cur - prior) / prior) * 100)}%` : `${cur - prior >= 0 ? '+' : ''}${cur - prior}`;
      return d.startsWith('+') ? green(d) : d.startsWith('-') ? yellow(d) : dim(d);
    };
    const CW = 9;
    const header = '  ' + 'person'.padEnd(10)
      + ['24h', 'Δ24h', '7d', 'Δ7d', '30d', 'Δ30d', 'total', '~7d tok', '~7d paid'].map(c => c.padStart(CW)).join('');
    out.push(dimUnderline(fitLine(header, W)));

    const rows = [...merged.entries()].sort((a, b) => b[1].d7 - a[1].d7);
    const tot = { h24: 0, h24p: 0, d7: 0, d7p: 0, d30: 0, d30p: 0, total: 0, tok7: 0, paid7: 0 };
    for (const [name, w] of rows) {
      for (const k of Object.keys(tot)) tot[k] += w[k];
      out.push('  ' + name.slice(0, 10).padEnd(10)
        + [fmt(w.h24), delta(w.h24, w.h24p), fmt(w.d7), delta(w.d7, w.d7p), fmt(w.d30), delta(w.d30, w.d30p), fmt(w.total), fmtTok(w.tok7), fmtTok(w.paid7)]
          .map(c => lpadVis(String(c), CW)).join(''));
    }
    out.push(dim('  ' + 'total'.padEnd(10)
      + [fmt(tot.h24), delta(tot.h24, tot.h24p), fmt(tot.d7), delta(tot.d7, tot.d7p), fmt(tot.d30), delta(tot.d30, tot.d30p), fmt(tot.total), fmtTok(tot.tok7), fmtTok(tot.paid7)]
        .map(c => lpadVis(String(c), CW)).join('')));

    const link = (this.am.poolLinks || []).find(l => l.lastOkAt);
    out.push(dim('  tok = full prompt (input + cache read + cache write) + output, provider-native · paid = cache write + uncached input'));
    out.push(dim(`  rolling windows · restarts included${link ? ` · team pool synced ${new Date(link.lastOkAt).toLocaleTimeString()}` : ''}`));
    return out;
  }

  // Ten terminal frames per second need only one refresh per account per second.
  _accountMetrics(account, now = Date.now()) {
    const cached = this.analyticsMetrics.get(account);
    if (cached && now - cached.at < 1000) return cached.metrics;
    const metrics = this.am.accountCacheWindows?.(account, now);
    this.analyticsMetrics.set(account, { at: now, metrics });
    return metrics;
  }

  _openAnalytics() {
    this.analytics = { back: this.mode, providers: false, selected: 0, detail: false, scroll: 0 };
    this.mode = 'analytics';
  }

  _analyticsRows(now = Date.now()) {
    const state = this.analytics;
    if (state.rows && now - state.rows.at < 1000 && state.rows.providers === state.providers) return state.rows.values;
    let values;
    if (state.providers) {
      values = Object.entries(this.am.providerCacheWindows?.(now) || {}).map(([provider, metrics]) => ({
        name: analyticsProvider(provider), metrics,
      }));
    } else {
      // Disabled accounts can still have usage in the requested history.
      values = this.am.capacityRows(this._displayOrder()).map(row => {
        const account = this.am.accounts[row.index];
        return {
          name: row.displayName,
          provider: providerLabel(account),
          where: row.where,
          account,
          localAccount: account.remote && !row.unresolved
            ? row.group.map(index => this.am.accounts[index]).find(member => !member.remote) : null,
          metrics: this._accountMetrics(account, now),
        };
      });
    }
    state.rows = { values, at: now, providers: state.providers };
    return values;
  }

  _keyAnalytics(k) {
    const state = this.analytics;
    if (state.routing) {
      if (k === 'esc' || k === 'q' || k === 'r') { state.routing = false; state.scroll = 0; }
      else if (k === 't') { state.period = ({ '1h': '24h', '24h': '7d', '7d': '1h' })[state.period]; state.scroll = 0; }
      else if (k === 'w') { state.worker = (state.worker + 1) % routingSources(this.am, Date.now()).length; state.scroll = 0; }
      else if (k === 'up' || k === 'k') state.scroll = Math.max(0, state.scroll - 1);
      else if (k === 'down' || k === 'j') state.scroll++;
      return;
    }
    if (k === 'r' && !state.detail) {
      Object.assign(state, { routing: true, period: '24h', worker: 0, scroll: 0 });
      return;
    }
    if (k === 'esc' || k === 'q') {
      if (state.detail) { state.detail = false; state.scroll = 0; }
      else this.mode = state.back;
    } else if (state.detail) {
      if (k === 'down' || k === 'j') state.scroll++;
      if (k === 'up' || k === 'k') state.scroll = Math.max(0, state.scroll - 1);
    } else if (k === 'p') {
      state.providers = !state.providers;
      state.selected = 0;
    } else if (k === 'enter') {
      const row = this._analyticsRows()[state.selected];
      state.detail = row?.account || row?.name || false;
      state.scroll = 0;
    } else if (k === 'up' || k === 'k') {
      state.selected = Math.max(0, state.selected - 1);
    } else if (k === 'down' || k === 'j') {
      state.selected = Math.min(Math.max(0, this._analyticsRows().length - 1), state.selected + 1);
    }
  }

  _renderAnalyticsPage(W, H) {
    const state = this.analytics;
    if (state.routing) return this._renderRoutingPage(W, H);
    const rows = this._analyticsRows();
    state.selected = Math.max(0, Math.min(state.selected, rows.length - 1));
    const selected = state.detail && rows.find(row => (row.account || row.name) === state.detail);
    const lines = [bold(' Activity analytics · ' + (state.providers ? 'Providers' : 'Accounts'))];
    let footer;
    if (state.detail && selected) {
      const details = this._analyticsDetail(selected, W);
      const available = H - lines.length - 1;
      state.scroll = Math.max(0, Math.min(state.scroll, details.length - available));
      lines.push(...details.slice(state.scroll, state.scroll + available));
      footer = details.length > available ? ' ↑↓ Scroll   Esc Back' : ' Esc Back';
    } else {
      state.detail = false;
      lines.push(dim(' Cache hit % of observed input tokens'));
      const numericWidth = W >= 58 ? 7 : 5;
      const providerWidth = !state.providers && W >= 65 ? PROVIDER_W + 2 : 0;
      const nameW = Math.min(36, W - 3 - providerWidth - 4 * numericWidth);
      const lead = (name, provider) => truncate(name, nameW)
        + (providerWidth ? '  ' + truncate(provider || '', providerWidth - 2) : '');
      lines.push(dimUnderline('   ' + lead(state.providers ? 'Provider' : 'Account', 'Provider')
        + ['1h', '24h', '7d', 'All'].map(x => x.padStart(numericWidth)).join('')));
      const visible = Math.max(1, H - lines.length - 3);
      const top = Math.max(0, state.selected - visible + 1);
      for (const [offset, row] of rows.slice(top, top + visible).entries()) {
        const cursor = top + offset === state.selected ? cyan(' › ') : '   ';
        lines.push(cursor + lead(row.name, row.provider)
          + ANALYTICS_PERIODS.map(key => cachePercent(row.metrics?.windows[key]).padStart(numericWidth)).join(''));
      }
      if (!rows.length) lines.push(dim(' No usage data available.'));
      lines.push(dim(' All = since tracking. * = incomplete or estimated.'));
      if (rows.length > visible) lines.push(dim(` ${state.selected + 1} of ${rows.length}`));
      footer = ` ↑↓ Select  Enter Detail  p ${state.providers ? 'Accounts' : 'Providers'}  Esc Back`;
      footer = ' r Routing ' + footer;
      if (W < footer.length) footer = ' r Routing  ↑↓  Enter  p Group  Esc Back';
    }
    while (lines.length < H - 1) lines.push('');
    lines.push(footer);
    return lines;
  }

  _renderRoutingPage(W, H) {
    const state = this.analytics;
    const sources = routingSources(this.am, Date.now());
    const source = sources[state.worker] || sources[0];
    const report = source.report;
    const m = report?.service?.[state.period];
    const lines = [];
    const number = n => Number.isFinite(n) ? n.toLocaleString('en-US') : '—';
    const share = (n, d = 1) => Number.isFinite(n) && d > 0 ? (100 * n / d).toFixed(1) + '%' : '—';
    const time = n => !Number.isFinite(n) ? '—' : n < 1000 ? n + 'ms' : (n / 1000).toFixed(1) + 's';
    const safe = value => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
    const date = n => Number.isFinite(n) && n > 0 && n < 8.64e15 ? new Date(n).toISOString().slice(0, 16).replace('T', ' ') : '—';
    if (!m) lines.push(dim(' Routing telemetry unavailable from this worker.'));
    else {
      const r = report.recent;
      const le = (n, d) => d > 0 && Number.isFinite(n) ? '≤' + time(n) : '—';
      if (r) {
        const names = { ok: 'Keeping up', tight: 'Getting tight', short: 'Short of accounts', quiet: 'Little traffic' };
        lines.push(bold(' Headroom now  ' + (names[r.state] || '—')) + dim('  last ' + headroomSpan(r).replace('m', ' min')
          + (r.state === 'quiet' ? ' · ' + number(r.requests) + ' of ' + CAPACITY_BANDS.minRequests + ' requests needed' : '')));
        lines.push(' Waited ' + number(r.queuedRequests) + ' of ' + number(r.requests) + ' requests (' + share(r.queuedRequests, r.requests)
          + ')   Longest wait ' + le(r.longestWaitMs, r.requests) + '   p95 ' + le(r.waitP95Ms, r.requests));
        lines.push(' Waiting now ' + number(r.pending) + (r.pending ? '   Oldest ' + time(r.oldestWaitMs) : '')
          + '   Refused ' + number(r.capacityDenied) + '   Refused after waiting ' + number(r.refusedAfterWait));
        lines.push(dim(' Requests, not sessions. Wait = held by the router, not model speed.'));
        lines.push('');
      }
      lines.push(bold(' Timely completions  ' + share(m.timelyCompleted, m.requests))
        + '  ' + number(m.timelyCompleted) + ' / ' + number(m.requests));
      lines.push(dim(' Completed successfully with ≤' + time(m.waitTargetMs) + ' router wait, per finalized request.'));
      lines.push(' Arrivals ' + number(m.arrivals) + '   In progress ' + number(m.active)
        + '   Failed ' + number(m.failed) + '   Cancelled ' + number(m.cancelled) + '   Incomplete ' + number(m.incomplete));
      lines.push(' Queue wait  p90 ≤' + time(m.waitP90Ms) + '   p95 ≤' + time(m.waitP95Ms)
        + '   Queued ' + number(m.queuedRequests));
      if (m.queuedRequests > 0) lines.push(' Among queued requests  p95 ≤' + time(m.queuedWaitP95Ms));
      lines.push(' Serving ' + number(m.serving) + '   Peak requests ' + number(m.peakServing)
        + '   Peak identified sessions ' + number(m.peakSessions));
      lines.push(' Capacity denials ' + number(m.capacityDenied) + '   Input served from cache ' + share(m.cachedInputTokens, m.inputTokens));
      if (m.capacityDenied > 0) {
        lines.push('   Weekly ' + number(m.weeklyDenied) + '   Session ' + number(m.sessionDenied)
          + '   Concurrency ' + number(m.concurrencyDenied) + '   Other ' + number(m.unclassifiedDenied));
      }
      lines.push(dim(' Observed hours  ' + date(m.from) + ' to ' + date(m.to) + ' UTC'));
      lines.push(dim(' History · ' + (m.completeCoverage ? 'continuous coverage' : 'partial coverage') + ' · since ' + date(m.coverageSince) + ' UTC'));
      if (report.placement) {
        const p = report.placement;
        lines.push(' New-chat comparison since boot  ' + number(p.disagreed) + ' differed / ' + number(p.comparable) + ' comparable');
      }
      if (Array.isArray(m.accounts) && m.accounts.length) {
        lines.push('', bold(' Finalized requests by account'), dim(' Includes forwarded requests handled here.'));
        for (const a of m.accounts) {
          lines.push(' ' + safe(a.name) + '  ' + number(a.timelyCompleted) + '/' + number(a.requests)
            + ' timely  ·  p95 ≤' + time(a.waitP95Ms) + '  ·  peak ' + number(a.peakServing));
          if (a.concurrencyDenied > 0) lines.push(dim('   Concurrency refusals ' + number(a.concurrencyDenied)));
        }
      }
      lines.push('', bold(' Unused quota at reset · by account'));
      const meaning = { 'eligible-demand-served-elsewhere': 'eligible work served elsewhere', 'no-observed-demand': 'no work observed here',
        'fully-used': 'fully used', 'unattributed': 'cause undetermined', 'unknown': 'insufficient evidence' };
      const missing = { 'stale-reading': 'last reading too old', 'replaced-before-reset': 'window changed early',
        'conflicting-reset': 'conflicting reset times', 'disabled': 'account disabled', 'refill': 'quota refilled' };
      for (const row of Array.isArray(report.quotas) ? report.quotas : []) {
        lines.push(' ' + safe(row.name) + '  ·  ' + (row.window === 'ses' ? '5h only' : row.window === 'wk' ? 'weekly' : 'window unknown'));
        const cycles = Array.isArray(row.cycles) ? row.cycles : [];
        if (!cycles.length) lines.push(dim('   Awaiting a measured reset.'));
        for (const c of cycles) {
          const detail = c.unusedFraction == null ? (missing[c.reason] || 'insufficient evidence') : (meaning[c.attribution] || 'cause undetermined');
          lines.push('   ' + date(c.resetAt) + ' UTC  ' + share(c.unusedFraction) + '  ' + detail
            + (c.alternativeTurns > 0 ? ' (' + number(c.alternativeTurns) + ')' : ''));
        }
      }
      lines.push(dim(' Unused is estimated from peak usage and a fresh reading before reset.'));
      if (Array.isArray(report.daily) && report.daily.length) {
        lines.push('', bold(' Timely completions by UTC day'));
        for (const d of report.daily) {
          lines.push(' ' + date(d.day).slice(0, 10) + '   ' + number(d.timelyCompleted) + '/' + number(d.requests)
            + '   ' + share(d.timelyCompleted, d.requests) + '   denials ' + number(d.capacityDenied));
        }
      }
      if (report.recent) {
        const B = CAPACITY_BANDS, pct = n => Math.round(n * 100) + '%';
        lines.push('', bold(' How headroom is judged'));
        lines.push(dim(' Tight: ' + pct(B.tightWaitedShare) + ' or more of requests waited over ' + time(B.notableWaitMs) + ', any refusal, a request held '
          + time(B.tightOldestMs) + ' or more, or the slowest 5% of waited requests over ' + time(B.tightQueuedP95Ms) + '.'));
        lines.push(dim(' Short: ' + pct(B.shortWaitedShare) + ' or more waited over ' + time(B.notableWaitMs) + ', ' + pct(B.shortDeniedShare) + ' or more refused, or a request held '
          + time(B.shortOldestMs) + ' or more.'));
        lines.push(dim(' Shares and the slowest-5% rule need ' + B.minRequests + ' requests and ' + B.minWaited
          + ' waits over ' + time(B.notableWaitMs) + '; a refusal or a long hold counts at any volume.'));
        lines.push(dim(' Provisional. Measured healthy load: about 0.1% of requests wait; no backlog sample yet.'));
      }
      const sizing = report.provisioning;
      if (sizing) {
        lines.push('', bold(' Additional accounts'));
        lines.push(sizing.status === 'no-observed-demand' ? ' 0 for demand observed in the last three full weeks.' : ' Insufficient evidence for a subscription count.');
        lines.push(dim(' ' + number(sizing.coveredWeeks) + '/' + number(sizing.sampledWeeks) + ' weeks observed continuously; '
          + number(sizing.weeklyDenied) + ' weekly denials of ' + number(sizing.capacityDenied) + ' capacity denials.'));
        if (sizing.status !== 'no-observed-demand') lines.push(dim(' Need unmet weekly workload and comparable plan yield.'));
      }
    }
    const header = bold(' Routing analytics · ' + safe(source.name) + ' · ' + state.period) + (source.stale ? yellow(' · stale') : '');
    const height = Math.max(1, H - 2);
    state.scroll = Math.min(Math.max(0, lines.length - height), state.scroll);
    const view = [header, ...lines.slice(state.scroll, state.scroll + height)];
    while (view.length < H - 1) view.push('');
    view.push(W < 62 ? ' ↑↓ Scroll  t Time  w Worker  Esc Back' : ' ↑↓ Scroll   t Time window   w Worker   Esc Back');
    return view;
  }

  _analyticsDetail(row, W) {
    const cellW = W >= 54 ? 9 : 7;
    const labelW = W >= 54 ? 8 : 4;
    const out = [` ${bold(row.name)}`];
    if (row.account) out.push(' ' + [row.provider, row.where].filter(Boolean).join(' · '));
    const head = ' ' + 'Time'.padEnd(labelW)
      + ['Fresh', 'Read', 'Write', 'Output', 'Total'].map(k => k.padStart(cellW)).join('');
    out.push(dimUnderline(head));
    for (const period of ANALYTICS_PERIODS) {
      const w = row.metrics?.windows[period];
      const label = (period === 'all' ? 'All' : period) + (w?.partial ? '*' : '');
      const vals = w ? [w.input, w.cacheRead, w.cacheWrite, w.output, w.input + w.cacheRead + w.cacheWrite + w.output] : [];
      out.push(' ' + label.padEnd(labelW) + Array.from({ length: 5 }, (_, i) => formatTokens(vals[i]).padStart(cellW)).join(''));
    }
    out.push(dim(' Fresh = uncached input.'), dim(' Read/write = cache tokens.'));
    if (Number.isFinite(row.metrics?.since)) out.push(dim(' Tracking since ' + new Date(row.metrics.since).toISOString().slice(0, 10) + ' UTC'));
    if (Number.isFinite(row.metrics?.asOf) && Date.now() - row.metrics.asOf > 90_000) {
      out.push(dim(' Last report ' + new Date(row.metrics.asOf).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'));
    }
    if (ANALYTICS_PERIODS.some(key => row.metrics?.windows[key]?.partial)) out.push(dim(' * Incomplete history or estimated historical totals.'));
    if (row.account) {
      let terms = subscriptionTermsFor(this.config, row.account);
      let heading = ' Subscription';
      if (!terms.length && row.localAccount) {
        terms = subscriptionTermsFor(this.config, row.localAccount);
        if (terms.length) heading = ' Local subscription';
      }
      out.push('', bold(heading));
      if (!terms.length) out.push(dim(' No subscription terms configured.'));
      for (const term of terms) {
        const amount = term.price != null ? [term.currency, term.price].filter(x => x != null).join(' ') : '';
        if (amount || term.cadence) out.push(' ' + [amount, term.cadence].filter(Boolean).join(' · '));
        if (term.nextRenewal) out.push(' Next renewal  ' + term.nextRenewal);
      }
    }
    return out;
  }

  _keyCapacity(k) {
    if (k === 'v') { this._openAnalytics(); }
    else if (k === 'w') { this.capacityWindow = this.capacityWindow === 'wk' ? 'ses' : 'wk'; }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _keyPeople(k) {
    if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  /**
   * Capacity page — how much an account ACTUALLY delivers before it runs out.
   *
   * Each completed 5h/weekly cycle's token total IS that account's measured capacity
   * for the window, so the columns compare a Claude account and a GLM account on the
   * same axis. Only COMPLETE, never-disabled cycles count (a cycle maxpool sat out
   * part of is an observation, not a capacity).
   *
   * The no-weekly account (legacy z.ai plan) has no weekly TANK to fill, so its weekly
   * row is a rolling-7d THROUGHPUT — a volume, labelled as such, never a limit.
   */
  _renderCapacityPage(W) {
    const out = [];
    const win = this.capacityWindow === 'wk' ? 'wk' : 'ses';
    const ledger = this.am.capacity;
    const title = win === 'wk' ? 'Weekly (7d) capacity' : 'Session (5h) capacity';
    const windowLabel = win === 'wk' ? '7d windows' : '5h windows';
    out.push('');
    out.push(` ${bold(title)}  ${dim(`— tokens per ${windowLabel}, from completed cycles`)}`);
    out.push('');

    if (!ledger) { out.push(yellow('  Capacity ledger unavailable on this worker.')); return out; }

    // Owner-specified table (2026-08-26): the same shape for BOTH views —
    //   Current cycle (tokens + % used) · Prev cycle · Med (median) across all cycles · N cycles.
    // Current is the live window (estimate while it runs; frozen into the columns at
    // close). Prev/Avg/N are the completed-cycle history. The no-weekly account's
    // weekly view approximates capacity as avg session tank × 33.6 (7×24/5h windows).
    // Plan/Where are the leftmost extras and drop first when the terminal is narrow
    // (the numeric columns are the point of the page). Where = which pool's ledger holds
    // this account's cycles (cloud / laptop / both) — ONE row per account identity.
    const ALL_COLS = ['Current', 'Prev', 'Med-3', 'Med-all', 'N', '$/1M'];
    // Narrow terminals drop from the right, but Med-3 goes before Med-all.
    const DROP_ORDER = ['$/1M', 'N', 'Med-3', 'Med-all', 'Prev', 'Current'];
    const CW = 11;
    const nameW = 12;
    const WHERE_W = 7, PLAN_W = 16;
    let COLS = ALL_COLS;
    while (COLS.length > 1 && (nameW + PROVIDER_W + 2 + COLS.length * CW + 22) > W) {
      const drop = DROP_ORDER.find(c => COLS.includes(c));
      COLS = COLS.filter(c => c !== drop);
    }
    const showWhere = (nameW + PROVIDER_W + 2 + COLS.length * CW + WHERE_W + 1 + 22) <= W;
    const showPlan = showWhere && (nameW + PROVIDER_W + 2 + COLS.length * CW + WHERE_W + PLAN_W + 2 + 22) <= W;
    const header = '  ' + 'Account'.padEnd(nameW) + ' ' + 'Provider'.padEnd(PROVIDER_W) + ' '
      + (showWhere ? 'Where'.padEnd(WHERE_W) : '')
      + (showPlan ? 'Plan'.padEnd(PLAN_W) + ' ' : '')
      + COLS.map(c => c.padStart(CW)).join('');
    out.push(dimUnderline(fitLine(header, W)));

    const capRows = this.am.capacityRows
      ? this.am.capacityRows(this._displayOrder(), { hideDisabled: this.hideDisabled })
      : this._displayOrder().map(i => ({ index: i, group: [i], unresolved: false, displayName: this.am.accounts[i]?.name, where: null, priceAccount: this.am.accounts[i], plan: null, cache: null }));
    for (const cr of capRows) {
      const i = cr.index;
      const a = this.am.accounts[i];
      if (!a) continue;
      const name = truncate(cr.displayName + (cr.unresolved ? '?' : ''), nameW).padEnd(nameW);
      const prov = gray(providerLabel(a).padEnd(PROVIDER_W));
      const whereCell = showWhere ? gray((cr.where || '--').padEnd(WHERE_W)) : '';
      const planCell = showPlan ? gray(planLabel(cr.plan, cr.priceAccount, this.am).padEnd(PLAN_W) + ' ') : '';
      const lead = name + ' ' + prov + ' ' + whereCell + planCell;

      // The no-weekly plan has NO weekly window to complete — its weekly "capacity" is
      // derived: avg session tank × 33.6 (the number of 5h windows in 7 days). Shown
      // without a marker (owner 2026-08-26: the row's text states the derivation);
      // N is the count of session cycles it rests on.
      if (win === 'wk' && a.type === 'provider' && a.quota?.weeklyAbsent) {
        const sesTank = this.am.capacityTank?.(i, 'ses');
        // D11/D12 (audit 2026-11-18): the ×33.6 ceiling assumes every 5h window holds
        // the off-peak median, but z.ai peak windows (Mon-Fri 06:00-10:00 UTC, 20h of
        // 168h) hold ~1/3 of that (measured 218.6M vs 648.2M). Label the figure as a
        // ceiling ("max") so it reads as an upper bound, and mark N as 5h cycles —
        // the footer's "N = cycles in Med-all" is false on this row by construction.
        const approx = sesTank && sesTank.n > 0
          ? formatTokens(Math.round(sesTank.avg * (7 * 24) / 5)) : '--';
        const cellsByName = { Current: cyan((approx === '--' ? '--' : approx + ' max')), Prev: '--', 'Med-3': '--', 'Med-all': '--', N: sesTank?.n ? `${sesTank.n} (5h)` : '--' };
        // Same price cell as the main path: this account's weekly capacity IS the
        // derived tank (avg 5h × 33.6) — the price column must not go blank here.
        const p2 = this.am.monthlyPriceFor?.(cr.priceAccount);
        const weeklyDerived = sesTank?.avg ? Math.round(sesTank.avg * (7 * 24) / 5) : null;
        cellsByName['$/1M'] = gray((pricePerMTokens(p2, weeklyDerived) ?? '--').padStart(CW));
        out.push('  ' + lead
          + COLS.map(c => cellsByName[c].padStart(CW)).join('')
          + dim('  no weekly limit · avg 5h × 33.6 · peak hours hold less'));
        continue;
      }

      const tank = this.am.capacityTank?.(i, win);
      // A reading we cannot prove is from THIS window may describe the previous one —
      // keep the number but never mark it live; it becomes a proper column at close.
      const unprovenLive = tank?.source === 'live' && tank.fresh === false;
      const util = this.am._windowUtilization?.(a, win);
      const nowOpen = ledger.openCycle(a.name, win);

      // Current = the LIVE window (audit D2, 2026-11-18): the open cycle's own
      // estimate — its slope median when it has segments, else the whole-window
      // absolute (tokens÷util) when the ledger provably watched from the window
      // start. The closed median is what Med-all shows; repeating it in Current hid
      // the running week (kira showed 1.1B while its live week held 3.5B).
      // RED-TEAM F1 (2026-11-18): the same floors the ledger applies — a low-fullness
      // window (tokens÷1% = 100x rounding noise) and a late-joined window (an
      // understating lower bound) must NOT render; history shows instead. Mirrors
      // (no local ledger entry) read the exported OPEN cycle from the cloud (F2).
      let cur = '--';
      const localOpen = nowOpen;
      const remoteOpenCycle = a.remote ? (a.remoteOpen?.[win] || null) : null;
      const openSrc = localOpen
        ? { ...this.am.capacity?.exportOpenCycle?.(a.name, win), tokensSoFar: localOpen.tokensSoFar }
        : remoteOpenCycle;
      if (openSrc && openSrc.est) {
        cur = formatTokens(openSrc.est);
      } else if (openSrc
        && Number.isFinite(openSrc.peakUtilization) && openSrc.peakUtilization >= TANK_MIN_UTIL && openSrc.peakUtilization < 1
        && openSrc.tokensSoFar > 0
        && (openSrc.windowStartedAt == null || openSrc.startedAt == null
          || openSrc.startedAt <= openSrc.windowStartedAt + 60_000)) {
        // Whole-window absolute only (a late join divides a partial numerator by a
        // full-window denominator — a lower bound, and usually a bad one).
        cur = formatTokens(Math.round(openSrc.tokensSoFar / openSrc.peakUtilization));
      }
      if (cur === '--' && tank && !(tank.source === 'live' && unprovenLive)) {
        cur = formatTokens(tank.avg);   // no proven live reading — history as the fallback
      }
      const curPct = util != null && cur !== '--' ? dim(`@${Math.round(util * 100)}%`) : '';
      // Every history column is a TANK number (tokens ÷ closing %). Prev/N used to
      // come from windowStats — delivered tokens and a different cycle set — so one
      // row mixed units (2026-10-13 owner report; see tankStats' reading-set note).
      const cellsByName = {
        Current: cur.padStart(CW - (curPct ? curPct.length + 1 : 0)),
        // Prev = the newest FINISHED cycle (audit D4) — once Current is live, the
        // reader wants "what did last week hold", which is `last`, not the
        // second-newest (that comparison is Med-3's job).
        Prev: (tank?.source === 'cycles' && tank.last != null ? formatTokens(tank.last) : (historyReason(this.am, a, win, nowOpen) || '--')),
        'Med-3': (tank?.source === 'cycles' && tank.recent != null ? formatTokens(tank.recent) : '--'),
        'Med-all': (tank?.source === 'cycles' ? formatTokens(tank.avg) : '--'),
        // `n*` = at least one contributing cycle is a two-pool merge (no per-reading
        // samples survive a merge, so it is estimated from close-time tokens only).
        N: (tank?.source === 'cycles' ? String(tank.n) + (tank.mergedCount > 0 ? '*' : '') : '--'),
      };
      // $/1M (owner 2026-10-31 "price per token, not per subscription"): the measured
      // weekly tank divided by the plan's monthly-normalized price. Weekly in BOTH
      // views — a 5h tank refills ~33.6x per week, so the weekly figure is what a
      // month of subscription actually buys. '--' until a tank reading AND a price exist.
      const sesTankObj = this.am.capacityTank?.(i, 'ses');
      // Weekly-plan accounts: a measured weekly tank, or the derived form ses × 5.5 —
      // MEASURED weekly tanks run 5-7× the 5h tank (2026-10-31: glm1 1.27M→8.58M,
      // glm2 1.26M→6.85M, max+4 1.53M→7.21M): the weekly window holds ~5 full 5h
      // refills, not 33.6. The owner caught the ×33.6 error here ("your math seems
      // completely off"). weeklyAbsent plans (no weekly limit at all) keep ×33.6.
      const WK_PER_SES = 5.5;
      const wkTank = (a.quota?.weeklyAbsent && a.type === 'provider')
        ? (sesTankObj?.avg ? Math.round(sesTankObj.avg * (7 * 24) / 5) : null)
        : (this.am.capacityTank?.(i, 'wk')?.avg
          ?? (a.type === 'provider' && sesTankObj?.avg ? Math.round(sesTankObj.avg * WK_PER_SES) : null));
      const price = this.am.monthlyPriceFor?.(cr.priceAccount);
      const priceCell = pricePerMTokens(price, wkTank) ?? '--';
      cellsByName['$/1M'] = gray(priceCell.padStart(CW));
      const row = '  ' + lead
        + COLS.map(c => cellsByName[c].padStart(CW)).join('');
      out.push(row + (curPct ? ' ' + curPct : ''));
    }

    out.push('');
    // Legend rewritten for truthfulness (audit D14/D15/D16, 2026-11-18): every line
    // states what the code ACTUALLY does — the old "median of tokens ÷ % full across
    // readings" described a formula the code never ran, and no line explained a dash.
    out.push(' ' + dim('Capacity = tokens a FULL window holds. Per cycle: median of (tokens used ÷ rise in % full) over steps of ≥5 points. Med-3 = newest 3 cycles, Med-all = all admitted cycles.'));
    out.push(' ' + dim('One row per account. Where = which side holds its history: cloud, laptop or both. ? = identity unknown.'));
    // Axis honesty (audit 2026-11-17, finding 5): the figure counts processed tokens in
    // EACH provider's own tokenizer (GLM ≈ 0.6x Anthropic for the same prompt), and a
    // cache read (0.1x) weighs the same as a cache write (1.25x). So $/1M across a
    // Claude and a GLM row is not a like-for-like price per Claude-equivalent token.
    out.push(' ' + dim('Tokens = processed tokens (provider-native): input + cached + output, counted in each provider\'s own tokenizer.'));
    out.push(' ' + dim('N = cycles in Med-all (Med-3 uses the newest 3). N* = includes a cycle both pools saw (merged) — estimated from close-time tokens, less precise. Cycles before 2026-11-06 used a different token count and are never admitted (old count).'));
    out.push(' ' + dim('Current @% = the LIVE window, % full now. Prev = the newest finished cycle.'));
    out.push(' ' + dim('No finished week yet? Prev says why: "1st wk MM-DD" = first week ends then · "old count" = only weeks counted before 2026-11-06 · "too short" = finished weeks too short to measure.'));
    out.push(' ' + dim('$/1M = monthly plan price ÷ (weekly tank × 4.35), so it is the price a month of subscription actually buys per 1M tokens.'));
    return out;
  }

  /**
   * Routing DETAIL — what each key on this screen controls and how to undo it.
   * (2026-10-13: "the cap setting only changes GLM", "I pinned an account and have no
   * idea how to switch it back", "where is the cap for individual accounts?")
   */
  _renderRoutingDetail(W = 80, now = Date.now()) {
    // Every line fits 80 columns: a truncated explanation is no explanation.
    const out = [];
    const recent = this.am.efficiencyOverall?.('last15m', now);
    const misses = [['claude', 'Claude'], ['glm', 'GLM'], ['codex', 'Codex']]
      .filter(([key]) => recent?.[key]?.hit != null)
      .map(([key, label]) => `${label} ${this._missTxt(recent[key].missTokens)}`);
    if (misses.length) {
      out.push(truncLine(` Cache misses ${dim('[15m]')}  ${misses.join(' · ')}`, W));
    }
    const pinned = this.am.routingMode === 'preferred' && this.am.preferredAccountName;
    // The manual pin: state, what it does, and the way out — always visible.
    if (pinned) {
      out.push(` ${yellow(`Pinned to ${this.am.preferredAccountName}`)}  ${bold('a')} Unpin  ${bold('p')} Change`);
      out.push(` ${dim('It gets every request it can take; the others only cover for it.')}`);
    } else {
      out.push(` ${bold('p')} Pin one Claude account ${dim('(undo:')} ${bold('a')}${dim(')')}`);
      out.push(` ${dim('Sends everything to it first; the others only cover for it.')}`);
    }
    const hasPeak = this.am.accounts.some(a => a.type === 'provider'
      && (this.am._peakSettingsFor?.(a.provider)?.windows || []).length > 0);
    if (hasPeak) {
      out.push(` ${bold('c')} GLM peak cap ${dim('— GLM accounts only, in GLM peak hours. Not Claude.')}`);
    }
    out.push(` ${bold('b')} Wait for busy account  ${cyan(this._stickyBusyLabel())}`);
    if (this.am.accounts.some(a => a.provider === 'codex')) {
      const label = this.am._sessionRoutingFor('codex') === 'same-provider' ? 'Stay on ChatGPT' : 'Allow provider switches';
      out.push(` ${bold('o')} ChatGPT sessions  ${cyan(label)}`);
    }
    // Where the per-account cap actually is.
    out.push(` ${dim('Usage cap for ONE account:')} ${bold('Esc')} ${dim('then')} ${bold('a')} ${dim('→')} ${bold('u')} ${dim('(Claude or GLM)')}`);
    const capped = this.am.accounts.filter(a => a.capUtilization != null && a.enabled !== false);
    if (capped.length) {
      out.push(` ${dim('Caps set:')} ${capped.map(a => `${a.name} ${Math.round(a.capUtilization * 100)}%`).join(', ')}`);
    }
    return out;
  }

  _renderFooter() {
    switch (this.mode) {
      case 'normal':
        return ` ${bold('a')} Accounts  ${bold('m')} Routing  ${bold('v')} Analytics  ${bold('y')} Capacity  ${bold('p')} People  ${bold('h')} Hide disabled  ${dim('│')}  ${bold('u')} Updates  ${bold('r')} Restart  ${bold('q')} ${serviceMode() ? 'Close view' : 'Stop server'}`;
      case 'capacity': {
        const other = this.capacityWindow === 'wk' ? '5h session' : 'weekly (7d)';
        return ` ${bold('w')} Show ${cyan(other)}  ${bold('v')} Activity analytics  ${bold('Esc')} Back`;
      }
      case 'people':
        return ` ${bold('Esc')} Back`;
      case 'updates': {
        const state = this._autoUpdateOn() ? green('on') : dim('off');
        return ` ${bold('c')} Check & apply now  ${bold('t')} Automatic updates: ${state} ↻  ${bold('Esc')} Back`;
      }
      case 'accounts':
        return ` ${bold('a')} Add account  ${bold('l')} Re-auth (browser)  ${bold('n')} Rename  ${bold('t')} Enable/disable  ${bold('u')} Usage cap  ${bold('v')} Check quota  ${bold('d')} Delete  ${bold('Esc')} Back`;
      case 'codexResets': {
        const auto = this.onSetCodexAutoRedeem ? `  ${bold('a')} Auto: ${this.codexResets.account.autoRedeemReset !== false ? 'on' : 'off'}` : '';
        const state = this.codexResets;
        const selectable = state.account.enabled !== false
          && canRedeemCodexCredit(state.credits[state.selected]);
        const redeem = this.redeemCodexReset && selectable ? `  ${bold('Enter')} Redeem` : '';
        return ` ${dim('↑↓')} Select${redeem}  ${bold('r')} Refresh${auto}  ${bold('Esc')} Back`;
      }
      case 'addtype':
        return ` ${bold('1')}-${bold('5')} pick a type  ${bold('Esc')} Back`;
      case 'routing': {
        const mode = this._routingModeDef(this.am.scheduler?.routingMode || 'sticky');
        const hasProviders = this.am.accounts.some(a => a.type === 'provider');
        // g/k controls only affect routing under sticky — hide them under other modes
        // so the operator never cycles a knob that does nothing.
        const provPart = (hasProviders && mode.id === 'sticky')
          ? `  ${bold('g')} GLM: ${cyan(this.am._claudeFallbackFor?.('zai') || 'never')}  ${bold('k')} Kimi: ${cyan(this.am._claudeFallbackFor?.('kimi') || 'never')}`
          : '';
        // PEAK controls — always visible when a provider has a window, in-window or not.
        // They were config-file-only at first ship, which meant the feature was
        // undiscoverable from the UI (reported 2026-08-19). The state is shown next to
        // the key so you can read the current setting without opening the config.
        let peakPart = '';
        const peakFam = this.am.accounts.find(a => a.type === 'provider'
          && (this.am._peakSettingsFor?.(a.provider)?.windows || []).length > 0);
        if (peakFam) {
          const ps = this.am._peakSettingsFor(peakFam.provider);
          const st = this.am._peakStateFor?.(peakFam.provider);
          const now = st?.inPeak ? red(' NOW') : '';
          const dep = ps.depreference ? yellow('GLM last') : cyan('normal');
          const cap = ps.cap >= 1 ? 'off' : ps.cap === 0 ? 'never' : `${Math.round(ps.cap * 100)}%`;
          const wk = this.am.scheduler.weeklyAwareScoring === false ? yellow('5h-only') : cyan('weekly');
          // "cap" alone read as THE usage cap for every account (2026-10-13). It is not:
          // it only limits GLM accounts, only during GLM's peak hours. Say so.
          peakPart = `  ${dim('│')} ${bold(' d ')}Peak${now}: ${dep} ${bold(' c ')}GLM peak cap ${cyan(cap)} ${bold(' w ')}score:${wk}`;
        }
        // The pin and the account-cap pointer live in the DETAIL block above this line
        // (_renderRoutingDetail) — one footer line cannot carry them without truncating.
        return ` ${bold('f')} Routing: ${cyan(mode.label)} ↻${provPart}${peakPart}  ${bold('Esc')} Back`;
      }
      case 'select': {
        if (this.selAction === 'codexLogin' || this.selAction === 'codexResets') {
          const action = this.selAction === 'codexLogin' ? 'Reconnect' : 'View resets';
          return ` ${dim('↑↓')} Select Codex account  ${bold('Enter')} ${action}  ${bold('Esc')} Cancel`;
        }
        const act = this.selAction === 'prefer'
          ? 'prefer'
          : this.selAction === 'toggle'
            ? 'enable/disable'
            : this.selAction === 'rename'
              ? 'rename'
              : this.selAction === 'check quota' ? 'check quota' : 'delete';
        return ` ${dim('↑↓')} select  ${bold('Enter')} ${act}  ${bold('Esc')} cancel`;
      }
      case 'input': {
        // The typed value and the cursor are the whole point of this line — they are
        // NEVER truncated. On a narrow terminal the PROMPT gives way instead, keeping
        // its last words (nearest the value). Red-team 2026-10-13: the long cap
        // prompt pushed the input off a 200-column terminal entirely.
        const shown = this.inputSensitive ? '•'.repeat(this.inputBuf.length) : this.inputBuf;
        const full = ` ${this.inputPrompt}: ${shown}█`;
        const visible = full.replace(ANSI_RE, '');
        const budget = (process.stdout.columns || 80) - 2;
        if (visible.length <= budget) return full;
        const keep = Math.max(0, budget - (shown.length + 2)); // ' …' + value + cursor
        const cut = visible.length - budget;
        const trimmed = this.inputPrompt.length > cut + 1
          ? this.inputPrompt.slice(0, Math.max(1, keep - 1)) + '…'
          : this.inputPrompt;
        return ` ${trimmed}: ${shown}█`;
      }
      case 'confirm':
        return ` ${bold(this.confirmTitle)}  ${bold('y')} Yes  ${bold('n')} No`;
      default:
        return '';
    }
  }
}
