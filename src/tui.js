import { createInterface } from 'node:readline';
import { fetchProfile, loginOAuth, tokenFingerprint } from './oauth.js';
import { appendEventLog, setConsoleStdoutSuppressed } from './event-log.js';

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

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = s => s.replace(ANSI_RE, '');
const vw = s => strip(s).length;

// ── Accounts-table columns ───────────────────────────────────
// Fixed column widths shared by the header row (acctHeader) AND every data row, so
// the header labels stay aligned with the columns they name. The Account/Provider/
// Status/Quota start offsets (4/25/35/49) are pure functions of these widths + the
// 4-col row prefix, independent of the quota-bar width.
const NAME_W = 20;         // a.name.slice(0, NAME_W).padEnd(NAME_W) — fits a full email like 2solarmax@gmail.com (19)
const PROVIDER_W = 9;      // providerLabel(a).padEnd(PROVIDER_W) — fits "Anthropic"
const STATUS_W = 13;       // rpad(status, STATUS_W) — fits "throttled 59s"
const ROW_PREFIX = '    '; // ' ' + sel(1) + cur(1) + ' ' — 4 cols before the name

// Human provider name for the accounts-table "Provider" column. account.provider
// is 'anthropic' for oauth/apikey accounts (they ARE Anthropic — the oauth-vs-key
// billing split is still shown by the Ses/Wk vs Tok/Req quota-bar labels, not here),
// and 'zai'/'kimi' for the GLM/Kimi fallback providers. Explicit map + a graceful
// Titlecase default so a future provider (Codex/Grok) renders sanely; truncated to
// the column width so a long name can never misalign the row.
const PROVIDER_LABELS = { anthropic: 'Anthropic', zai: 'z.ai', kimi: 'Moonshot', openai: 'OpenAI', codex: 'Codex', grok: 'Grok', xai: 'Grok' };
function providerLabel(a) {
  const key = a.provider || (a.type === 'provider' ? 'provider' : 'anthropic');
  const label = PROVIDER_LABELS[key] || (key.charAt(0).toUpperCase() + key.slice(1));
  return label.slice(0, PROVIDER_W);
}

/**
 * Aligned column header for the accounts table. Names the three columns that carry
 * NO inline label (Account / Type / Status) plus a group label over the two quota
 * bars (Quota). The per-bar naming (Ses/Wk for OAuth, Tok/Req for API keys) and the
 * load fields (Now/15m/1h) stay inline per row — they're row-type-dependent and
 * begin at a variable offset — so the header stops after the Quota group label.
 */
function acctHeader(W) {
  const quota = W >= 88 ? 'Quota (used% · resets-in)' : 'Quota';
  return ROW_PREFIX
    + 'Account'.padEnd(NAME_W) + ' '
    + 'Provider'.padEnd(PROVIDER_W) + ' '
    + 'Status'.padEnd(STATUS_W) + ' '
    + quota;
}

function rpad(s, w) {
  const gap = w - vw(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/** Truncate a string with ANSI codes to exactly w visible characters, then reset. */
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
  return out + RESET;
}

/** Fit a line to exactly w columns: truncate if too long, pad if too short. */
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

function quotaLabel(ratio, resetTs, width) {
  const rst = formatReset(resetTs);
  if (ratio == null || isNaN(ratio)) return (rst || '-').slice(0, width);
  const pct = `${Math.max(0, Math.min(100, ratio * 100)).toFixed(0)}%`;
  const full = rst ? `${pct} ${rst}` : pct;
  if (full.length <= width) return full;
  return (rst || pct).slice(0, width);
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

function loadText(load) {
  const cur = load?.current || {};
  const m15 = load?.last15m || {};
  const h1 = load?.last1h || {};
  // "Now" = what this account is handling right THIS moment: N in-flight requests
  // (and their combined weight ~ payload size, the scheduler's load input). Kept
  // distinct from the "15m"/"1h" THROUGHPUT counts that follow, which the old
  // "Load X/Y" label collided with.
  const inflight = cur.inFlight || 0;
  const weight = cur.activeWeight || 0;
  const now = weight > 0 ? `Now ${inflight} (${weight}w)` : `Now ${inflight}`;
  const recent = `${m15.requests || 0}r`;
  const recentAvg = m15.avgMs != null ? ` ${formatMs(m15.avgMs)}` : '';
  const hour = `${h1.requests || 0}r`;
  const fails = (m15.failed || 0) > 0 ? ` ${red(`${m15.failed}f`)}` : '';
  return `${now}  15m ${recent}${recentAvg}${fails}  1h ${hour}`;
}

function weeklyPolicyText(am, account) {
  if (!am?._weeklyState || !account || account.type === 'provider') return '';
  const state = am._weeklyState(account);
  if (!state || state === 'unknown' || state === 'normal') return '';
  const rawState = am._weeklyRawState?.(account) || state;
  const used = Number(account.quota?.unified7d);
  const pct = Number.isFinite(used)
    ? ` ${Math.max(0, Math.min(100, used * 100)).toFixed(0)}%`
    : '';
  const paceOnly = state !== rawState && rawState !== 'exhausted';
  const label = paceOnly ? `Pace ${state}` : `Wk ${state}`;
  const text = paceOnly ? label : `${label}${pct}`;
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

export const __tuiTest = { formatReset, quotaLabel, bar, emptyBar, strip, loadText, countdown, acctHeader, fitLine, providerLabel };

function timestamp() {
  return new Date().toLocaleTimeString('en-US', { hour12: false });
}

// ── TUI class ────────────────────────────────────────────────

export class TUI {
  constructor({ accountManager, config, saveConfig, syncAccounts, onQuit, onRestart }) {
    this.am = accountManager;
    this.config = config;
    this.saveConfig = saveConfig;
    this.syncAccounts = syncAccounts;
    this.onQuit = onQuit;
    this.onRestart = onRestart;
    // Set by index.js after construction (a deferred closure, not a constructor literal —
    // avoids the const TDZ on applyUpdateIfReady, which is defined after `new TUI`).
    this.checkNow = null;
    this.updateBusy = null;   // live progress text while an update check/apply runs

    this.log = [];           // completed activity entries
    this.active = new Map(); // in-flight requests
    this.mode = 'normal';    // normal | accounts | routing | select | input | confirm
    this.selAction = null;   // prefer | toggle | delete
    this.selIdx = 0;
    this.inputPrompt = '';
    this.inputBuf = '';
    this.inputCb = null;
    this.inputSensitive = false;
    this.confirmTitle = '';
    this.confirmDetail = '';
    this.confirmCb = null;
    this.frame = 0;
    this.running = false;
    this.timer = null;
    this._origLog = null;
    this._origErr = null;
  }

  // ── lifecycle ──────────────────────────────────────

  start() {
    try {
      process.stdin.setRawMode(true);
    } catch (err) {
      process.stderr.write(`[Maxpool] TUI unavailable (${err.code || err.message}); continuing with plain logs.\n`);
      return false;
    }

    this.running = true;
    process.stdout.write(`${ESC}?1049h${ESC}?25l`);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    this._dataHandler = d => this._onData(d);
    this._resizeHandler = () => this.render();
    process.stdin.on('data', this._dataHandler);
    process.stdout.on('resize', this._resizeHandler);

    // Redirect console to activity log
    this._origLog = console.log;
    this._origErr = console.error;
    console.log = (...a) => this._addLog(a.join(' '));
    console.error = (...a) => this._addLog(a.join(' '));

    this.render();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER.length;
      this.render();
    }, 500);
    return true;
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._origLog) { console.log = this._origLog; console.error = this._origErr; }
    process.stdin.removeListener('data', this._dataHandler);
    process.stdout.removeListener('resize', this._resizeHandler);
    process.stdout.write(`${ESC}?25h${ESC}?1049l`);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
  }

  // ── server hooks ───────────────────────────────────

  onRequestStart(id, info) {
    this.active.set(id, { ...info, t: timestamp(), started: Date.now(), account: null });
    this.render();
  }

  onRequestRouted(id, info) {
    const r = this.active.get(id);
    if (r) r.account = info.account;
  }

  onRequestEnd(id, info) {
    const r = this.active.get(id);
    this.active.delete(id);
    const dur = r ? ((Date.now() - r.started) / 1000).toFixed(1) : '?';
    const acct = info.account || r?.account || '?';
    // Tag PROVIDER-routed requests with the maxpool session id so provider traffic
    // (when-exhausted overflow, or an incompatible-session pin) is traceable back to
    // the session that caused it: grep the event log for `→ glm-fallback … [sess X]`,
    // then `ps eww -p <pid> | grep x-maxpool-session` to find the terminal. Truthiness
    // guard — a header-less request has sessionKey '' (server.js headerValue) → no tag.
    const isProvider = this.am.accounts.find(a => a.name === acct)?.type === 'provider';
    const tag = (isProvider && r?.sessionKey) ? `  [sess ${String(r.sessionKey).slice(0, 8)}]` : '';
    this._addLog(`${info.method} ${info.path} → ${acct} (${info.status}, ${dur}s)${tag}`);
  }

  _addLog(msg) {
    msg = msg.replace(/^\[Maxpool\]\s*/, '');
    // Persist too — in TUI mode console is re-pointed here, bypassing the console
    // mirror, so this is where TUI-mode lines reach the on-disk event log.
    appendEventLog(msg);
    this.log.unshift({ t: timestamp(), msg });
    if (this.log.length > 200) this.log.length = 200;
    if (this.running) this.render();
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
      if (typed) { this.inputBuf += typed; this.render(); }
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
      case 'providers': this._keyProviders(k); break;
      case 'select': this._keySelect(k); break;
      case 'input':  this._keyInput(k); break;
      case 'confirm': this._keyConfirm(k); break;
    }
    this.render();
  }

  _keyNormal(k) {
    if (k === 'q') {
      this._confirm(
        'Stop Maxpool?',
        'New requests will stop; active requests will drain before the server exits.',
        () => { this.stop(); this.onQuit?.(); },
      );
    } else if (k === 'r') {
      this._confirm(
        'Restart Maxpool?',
        'Pause new requests, drain active work, then start the updated server.',
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
    } else if (k === 'p') {
      this.mode = 'providers';
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
      this.render();
      Promise.resolve(this.checkNow())
        .catch(() => {})
        .finally(() => {
          // If an update was found+applied, the seamless reload replaces this worker and
          // this never renders. Otherwise report the outcome in place.
          this.updateBusy = null;
          if (this.mode === 'updates') this.render();
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

  _routingLine(routing, xpText) {
    return ` Routing  ${cyan(routing)}${xpText}`;
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

  _keyAccounts(k) {
    if (k === 'k') {
      this.mode = 'input';
      this.inputPrompt = 'Anthropic API key';
      this.inputBuf = '';
      this.inputSensitive = true;
      this.inputCb = value => {
        if (!value) return;
        this._confirm(
          'Add this API key?',
          'Store it in Maxpool config as a new Anthropic API account.',
          () => this._doAddKey(value),
        );
      };
    } else if (k === 'l') {
      this._confirm(
        'Log in / re-authenticate via browser?',
        'Opens a browser. Logging into an account that\'s already added RE-AUTHENTICATES it in place (revives a reauth/error account) — no duplicate. Otherwise a new account is added.',
        () => this._doLogin(),
      );
    } else if (k === 'n' && this.am.accounts.length > 0) {
      this._startSelection('rename');
    } else if (k === 't' && this.am.accounts.length > 0) {
      this._startSelection('toggle');
    } else if (k === 'd' && this.am.accounts.length > 0) {
      this._startSelection('delete');
    } else if (k === 'esc' || k === 'q') {
      this.mode = 'normal';
    }
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

  _keyProviders(k) {
    if (k === 'a') {
      this._providerAddStep('type');
    } else if (k === 'd') {
      this._startProviderSelection('delete');
    } else if (k === 't') {
      this._startProviderSelection('toggle');
    } else if (k === 'esc' || k === 'q') {
      this.mode = 'normal';
    }
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
        if (provider !== 'zai' && provider !== 'kimi') { this._addLog('Type must be zai or kimi'); this.mode = 'providers'; return; }
        this._providerAddStep('secret', { ...prev, provider });
      };
    } else if (step === 'secret') {
      this.mode = 'input';
      this.inputPrompt = `${prev.name}: GCP secret name OR paste API key directly`;
      this.inputBuf = '';
      this.inputSensitive = false;
      this.inputCb = async value => {
        const input = String(value || '').trim();
        if (!input) { this.mode = 'providers'; return; }
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
          this._addLog(`Account "${name}" already exists`); this.mode = 'providers'; return;
        }
        await this._doAddProvider({ ...prev, name });
      };
    }
  }

  async _doAddProvider({ name, provider, secretName, apiKey }) {
    this.mode = 'providers';
    if (secretName) this._addLog(`Resolving secret "${secretName}" from GCP…`);
    else this._addLog(`Adding "${name}" with direct API key…`);
    this.render();
    try {
      let token = null;
      if (secretName) {
        const { resolveSecret } = await import('../secret-resolver.js');
        token = await resolveSecret(secretName);
        if (!token) {
          this._addLog(`✗ Secret "${secretName}" not found in GCP — create it first: gcloud secrets create ${secretName} --data-file=-`);
          return;
        }
      } else {
        token = apiKey;
      }
      // Add to config (persistence) and activate immediately.
      const { atomicConfigUpdate } = await import('../config.js');
      await atomicConfigUpdate(cfg => {
        if (!Array.isArray(cfg.providers)) cfg.providers = [];
        const entry = { name, provider };
        if (secretName) entry.secretName = secretName;
        else entry.apiKey = apiKey;
        cfg.providers.push(entry);
      });
      // Activate in the running process.
      this.am.loadConfigProviders([{ name, provider, secretName, token }]);
      const a = this.am.accounts.find(a => a.name === name);
      if (a && secretName) a.secretName = secretName;
      this._addLog(`✓ Added "${name}" (${provider})${secretName ? ` — GCP secret "${secretName}"` : ' — direct key'}`);
    } catch (err) {
      this._addLog(`✗ Failed to add provider: ${err.message}`);
    }
  }

  _startProviderSelection(action) {
    const providers = this.am.accounts.filter(a => a.type === 'provider');
    if (!providers.length) { this._addLog('No providers to manage'); return; }
    this._selOptions = providers.map(a => a.index);
    this._selLabels = providers.map(a => {
      const enabled = a.enabled !== false;
      const tag = a.configSourced ? ' (GCP)' : ' (header)';
      const secret = a.secretName ? ` [${a.secretName}]` : '';
      return `${a.name}${tag}${secret}${enabled ? '' : ' ✕'}`;
    });
    this.selAction = action;
    this.mode = 'select';
  }

  _renderProviders(buf, _width) {
    const providers = this.am.accounts.filter(a => a.type === 'provider');
    buf.push(`${bold('Providers (GLM / Kimi)')}  ${dim('— managed via GCP Secret Manager')}`);
    buf.push('');
    if (!providers.length) {
      buf.push(dim('  No providers configured.'));
      buf.push('');
      buf.push(dim('  Press ') + bold('a') + dim(' to add one. You\'ll need:'));
      buf.push(dim('    1. An API key from z.ai (GLM) or Moonshot (Kimi)'));
      buf.push(dim('    2. The key stored in GCP: ') + 'gcloud secrets create <name> --data-file=-');
      buf.push(dim('    3. The GCP secret name (e.g. RESTRICTED_MAXPOOL_ZAI_NEW)'));
      return;
    }
    for (const a of providers) {
      const enabled = a.enabled !== false;
      const tag = a.configSourced ? dim(' (GCP)') : dim(' (header)');
      const secret = a.secretName ? dim(` [${a.secretName}]`) : '';
      const status = a.status === 'error' ? red(a.lastError || 'error')
        : enabled ? green('active') : red('✕');
      const q = a.quota;
      const ses = q?.providerSes != null ? ` Ses ${Math.round(q.providerSes * 100)}%` : '';
      buf.push(`  ${enabled ? '' : dim('')} ${bold(a.name)} ${a.provider}${tag}${secret} ${status}${ses}`);
    }
  }

  _keyRouting(k) {
    if (k === 'a') {
      this._confirm(
        'Use automatic routing?',
        'Spread new requests across healthy accounts using load, quota, and recent errors.',
        () => this._setAutomaticRouting(),
      );
    } else if (k === 'p' && this.am.accounts.some(account => account.type !== 'provider')) {
      this._startSelection('prefer');
    } else if (k === 'g' || k === 'k') {
      this._cycleProviderClaudeFallback(k === 'g' ? 'zai' : 'kimi');
    } else if (k === 'f' || k === 'F') {
      // Cycle the cross-provider fallback policy in place — reversible + non-destructive,
      // so no confirm dialog (unlike restart/delete). Accept F too (Shift-f muscle memory).
      this._cycleCrossProviderPolicy();
    } else if (k === 'esc' || k === 'q') {
      this.mode = 'normal';
    }
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

  async _cycleCrossProviderPolicy() {
    const order = ['never', 'when-exhausted', 'always'];
    const cur = this.am._crossProviderFallbackPolicy();
    const next = order[(order.indexOf(cur) + 1) % order.length];
    this.am.setCrossProviderFallbackPolicy(next);
    this.config.scheduler = { ...(this.config.scheduler || {}), crossProviderFallbackPolicy: next };
    await this.saveConfig(this.config);
    this._addLog(`Cross-provider fallback: ${next}`);
  }

  _keySelect(k) {
    // Provider selection (from the providers screen) uses its own option list.
    if (this._selOptions && (this.selAction === 'delete' || this.selAction === 'toggle')
      && this.mode === 'select' && this.am.accounts[this._selOptions[0]]?.type === 'provider') {
      const opts = this._selOptions;
      const position = Math.max(0, opts.indexOf(this.selIdx));
      if (k === 'up' || k === 'k') this.selIdx = opts[Math.max(0, position - 1)] ?? this.selIdx;
      else if (k === 'down' || k === 'j') this.selIdx = opts[Math.min(opts.length - 1, position + 1)] ?? this.selIdx;
      else if (k === 'enter') {
        const account = this.am.accounts[this.selIdx];
        if (!account) { this.mode = 'providers'; return; }
        if (this.selAction === 'toggle') {
          const enable = !account.enabled;
          this._confirm(
            `${enable ? 'Enable' : 'Disable'} "${account.name}"?`,
            enable ? 'Allow this provider to receive requests again.' : 'Stop routing to it. Active requests continue.',
            () => { this._doToggle(this.selIdx, enable); this.mode = 'providers'; },
          );
        } else if (this.selAction === 'delete') {
          this._confirm(
            `Delete provider "${account.name}"?`,
            account.configSourced
              ? 'Removes it from config and GCP reference. The GCP secret itself stays — delete it separately if needed.'
              : 'Removes the runtime provider. It returns on the next request that sends its token.',
            async () => {
              if (account.configSourced) {
                try {
                  const { atomicConfigUpdate } = await import('../config.js');
                  await atomicConfigUpdate(cfg => {
                    if (Array.isArray(cfg.providers)) {
                      cfg.providers = cfg.providers.filter(p => p.name !== account.name);
                    }
                  });
                } catch (err) { this._addLog(`Config update failed: ${err.message}`); }
              }
              this.am.removeAccount(this.selIdx);
              this._addLog(`Deleted provider "${account.name}"`);
              this.mode = 'providers';
            },
          );
        }
      }
      else if (k === 'esc' || k === 'q') { this.mode = 'providers'; }
      return;
    }

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
      if (this.selAction === 'prefer') {
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
        this._confirm(
          `Delete "${account.name}"?`,
          'Permanently remove it from Maxpool config. Deletion is blocked while it has active requests.',
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
      }
    }
    else if (k === 'esc' || k === 'q') { this.mode = 'normal'; }
  }

  _startSelection(action) {
    const selectable = this._selectableIndexes(action);
    if (!selectable.length) {
      this._addLog(action === 'prefer'
        ? 'No enabled Claude account is available for manual preference'
        : 'No configurable account is available for this action');
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
    return [...nonProv, ...prov];
  }

  _selectableIndexes(action) {
    // Map over _displayOrder() BEFORE filtering so the nav array is in DISPLAY order
    // with the existing selectability filter intact — _keySelect steps this array, so
    // visual order == nav order automatically and it can never land on a provider
    // (prefer) or a non-configurable runtime account.
    return this._displayOrder()
      .map(index => ({ account: this.am.accounts[index], index }))
      .filter(({ account }) => {
        if (action === 'prefer') return account.type !== 'provider' && account.enabled;
        // Enable/disable also works on runtime providers (GLM/Kimi) — a session-only
        // toggle, since they're not in config. Rename/delete stay config-account-only.
        if (action === 'toggle') return this._configAccountIndex(account) >= 0 || account.type === 'provider';
        return this._configAccountIndex(account) >= 0;
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

  _confirm(title, detail, cb) {
    this.mode = 'confirm';
    this.confirmTitle = title;
    this.confirmDetail = detail;
    this.confirmCb = cb;
  }

  _clearConfirm() {
    this.mode = 'normal';
    this.confirmTitle = '';
    this.confirmDetail = '';
    this.confirmCb = null;
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

  // Browser OAuth login — the SAME flow re-authenticates an existing account (matched
  // by accountUuid) or adds a new one. When the login is for an account already added,
  // we say so, keep its name, and skip the "name this account" prompt — so it's clear
  // it's a RE-AUTH in place (revives a dead-refresh/reauth account), not a duplicate.
  async _doLogin() {
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    // Mute the console-log MIRROR to stdout during the interactive prompt so routing
    // logs (console.log, e.g. the glm-fallback 429 churn) don't flood over the readline
    // "Name this account" prompt. The prompts + errors use process.stdout.write, which
    // BYPASSES the mirror, so they stay visible. Login runs only on the terminal-owning
    // primary (mirror baseline false), so the finally restores it to false.
    setConsoleStdoutSuppressed(true);
    try {
      process.stdout.write('\nOpening browser to log into Claude…\n');
      const creds = await loginOAuth();
      const profile = await fetchProfile(creds.accessToken);
      const existing = this._findExistingOAuthAccount(profile);
      let name;
      if (existing) {
        process.stdout.write(`\nThis Claude account is already added as "${existing.name}" — re-authenticating it in place (no duplicate).\n`);
        name = existing.name;
      } else {
        const suggested = profile?.email
          || `account-${this.config.accounts.filter(a => a.name.startsWith('account-')).length + 1}`;
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await new Promise(resolve => rl.question(`Name this NEW account [${suggested}]: `, resolve));
        rl.close();
        name = String(answer || '').trim() || suggested;
      }
      // Lift the mute BEFORE the upsert so its persist-confirmation (a console.log,
      // deliberately visible during the stopped-TUI login) reaches the user.
      setConsoleStdoutSuppressed(false);
      // Message honors the ACTUAL result: if a manually-typed name collided with a
      // different existing account, upsert updates in place → "Re-authenticated", never
      // a false "Added new account".
      const { updated } = await this._upsertOAuthAccount({ creds, profile, name, source: 'login' });
      process.stdout.write(updated
        ? `\nRe-authenticated "${name}". Returning to maxpool…\n`
        : `\nAdded new account "${name}". Returning to maxpool…\n`);
    } catch (e) {
      process.stdout.write(`\nLogin failed: ${e.message}\n`);
    } finally {
      setConsoleStdoutSuppressed(false);   // restore on every path (incl. the catch)
      if (wasRunning) this.start();
    }
  }

  // Rename an account in config and in the running manager.
  async _doRename(idx, newName) {
    const account = this.am.accounts[idx];
    if (!account) { this._addLog('Account no longer exists'); return; }
    if (!newName) { this._addLog('Rename cancelled (empty name)'); return; }
    if (this.am.accounts.some((a, i) => i !== idx && a.name === newName)) {
      this._addLog(`An account named "${newName}" already exists`); return;
    }
    const cfgIdx = this._configAccountIndex(account);
    if (cfgIdx < 0) { this._addLog(`Cannot rename "${account.name}" (not in config)`); return; }
    const old = account.name;
    const prev = this.config.accounts[cfgIdx].name;
    this.config.accounts[cfgIdx].name = newName;
    if (this.config.routing?.preferredAccount === old) this.config.routing.preferredAccount = newName;
    try {
      await this.saveConfig(this.config);
    } catch (error) {
      this.config.accounts[cfgIdx].name = prev;
      throw error;
    }
    account.name = newName; // update the running account manager
    this._addLog(`Renamed "${old}" → "${newName}"`);
  }

  // Upsert an OAuth account into config + the running manager. Dedupes by
  // accountUuid, then name. Shared by import and browser login.
  async _upsertOAuthAccount({ creds, profile, name, source, verb = 'Added' }) {
    if (!name) {
      name = profile?.email
        || `account-${this.config.accounts.filter(a => a.name.startsWith('account-')).length + 1}`;
    }
    const entry = {
      name, type: 'oauth', source,
      accountUuid: profile?.accountUuid || null,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    };

    let idx = entry.accountUuid
      ? this.config.accounts.findIndex(a => a.accountUuid === entry.accountUuid)
      : -1;
    if (idx < 0) idx = this.config.accounts.findIndex(a => a.name === name);

    if (idx >= 0) {
      const previous = this.config.accounts[idx];
      entry.enabled = previous.enabled;
      this.config.accounts[idx] = entry;
      // Update the AccountManager to the FRESH tokens BEFORE persisting. The
      // saveConfig writer (index.js) derives the ON-DISK tokens from the
      // AccountManager, not from config.accounts — so persisting first writes the
      // STALE pre-re-auth token (typically the dead one we're re-authing away from)
      // to disk. The account then works in memory but boots DEAD on the next restart
      // (a just-re-authed token rejected as invalid_grant). A later refresh does NOT
      // heal disk (persistTokenRefresh's generation guard skips a disk token that
      // != _refreshedFrom), so disk must be made correct right here.
      const amAcct = this.am.accounts.find(account =>
        (entry.accountUuid && account.accountUuid === entry.accountUuid) || account.name === name
      );
      if (amAcct) {
        amAcct.credential = creds.accessToken;
        amAcct.refreshToken = creds.refreshToken;
        amAcct.expiresAt = creds.expiresAt;
        amAcct.accountUuid = entry.accountUuid;
        amAcct.name = name;
        // Fresh tokens from re-auth revive a dead-refresh account. This in-place
        // update is the actual re-login path (the index.js reconcile sees no change
        // and never calls updateAccountTokens), so refreshDead MUST be cleared here.
        amAcct.refreshDead = false;
        if (amAcct.status === 'error') amAcct.status = 'active';
      }
      try {
        await this.saveConfig(this.config);
      } catch (error) {
        // Persist failed (e.g. disk full). The browser re-auth genuinely SUCCEEDED,
        // so KEEP the AccountManager on the fresh tokens — reverting it to the dead
        // token would brick a working in-memory account. Roll back only the
        // config.accounts mirror and surface the error; disk self-heals on the next
        // saveConfig (the AM-derived writer re-writes the fresh token).
        this.config.accounts[idx] = previous;
        throw error;
      }
      this._addLog(`Updated account "${name}"`);
      // Confirm the fresh token actually reached DISK (saveConfig awaited above +
      // the AM was updated before it, so disk now holds creds.refreshToken). This
      // is the verifiable proof a re-auth "stuck" — its fp must match the on-disk
      // token; a later "REJECTED sent fp=<other>" then means an upstream revocation,
      // not a lost persist. console.log (not _addLog) so it's VISIBLE during the
      // stopped-TUI login flow, mirroring the sibling "Persisted rotated token" line.
      console.log(`[Maxpool] Re-authenticated "${name}" — fresh token persisted (fp=${tokenFingerprint(creds.refreshToken)})`);
      return { updated: true, name };
    } else {
      this.config.accounts.push(entry);
      try {
        await this.saveConfig(this.config);
      } catch (error) {
        this.config.accounts.pop();
        throw error;
      }
      this.am.addAccount(entry);
      this._addLog(`${verb} account "${name}"`);
      return { updated: false, name };
    }
  }

  // Find an already-configured OAuth account matching a fresh browser-login profile —
  // by accountUuid (primary), then name===email — the SAME precedence _upsertOAuthAccount
  // dedupes on, so the login flow can honestly say "re-authenticating" vs "adding new".
  _findExistingOAuthAccount(profile) {
    const uuid = profile?.accountUuid || null;
    const email = profile?.email || null;
    let acct = uuid ? this.config.accounts.find(a => a.type === 'oauth' && a.accountUuid === uuid) : null;
    if (!acct && email) acct = this.config.accounts.find(a => a.type === 'oauth' && a.name === email);
    return acct || null;
  }

  async _doAddKey(apiKey) {
    const key = String(apiKey || '').trim();
    if (!key) { this._addLog('No API key entered'); return; }
    const n = this.config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    const name = `api-${n}`;
    const entry = { name, type: 'apikey', apiKey: key };
    this.config.accounts.push(entry);
    try {
      await this.saveConfig(this.config);
    } catch (error) {
      this.config.accounts.pop();
      throw error;
    }
    this.am.addAccount(entry);
    this._addLog(`Added API key account "${name}"`);
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
    if (account.accountUuid) {
      const byUuid = this.config.accounts.findIndex(candidate => candidate.accountUuid === account.accountUuid);
      if (byUuid >= 0) return byUuid;
    }
    return this.config.accounts.findIndex(candidate => candidate.name === account.name);
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
        this.am.setAccountEnabled(idx, enabled);
        if (!enabled && this.am.preferredAccountName === account.name) this.am.setRoutingMode?.('automatic');
        this._addLog(`${enabled ? 'Enabled' : 'Disabled'} provider "${account.name}" — ${enabled ? 'routing resumed' : 'benched (stays off across cc all + restart; re-enable here anytime)'}`);
        return;
      }
      this._addLog(`Cannot ${enabled ? 'enable' : 'disable'} "${account.name}" here (not in config)`);
      return;
    }
    const previous = this.config.accounts[configIndex].enabled;
    this.config.accounts[configIndex].enabled = enabled;
    const previousRouting = this.config.routing;
    const resetsRouting = !enabled && this.config.routing?.preferredAccount === account.name;
    if (resetsRouting) {
      this.config.routing = { mode: 'automatic', preferredAccount: null };
    }
    try {
      await this.saveConfig(this.config);
    } catch (error) {
      this.config.accounts[configIndex].enabled = previous;
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
    const configIndex = this._configAccountIndex(account);
    if (configIndex < 0) {
      this._addLog(`Cannot permanently delete runtime provider "${name}" from the TUI`);
      return;
    }
    const wasEnabled = account.enabled;
    this.am.setAccountEnabled(idx, false);
    if (account.inFlight > 0) {
      this.am.setAccountEnabled(idx, wasEnabled);
      this._addLog(`Cannot delete "${name}" because a request started; the account was not changed`);
      return;
    }

    const [removedConfig] = this.config.accounts.splice(configIndex, 1);
    const previousRouting = this.config.routing;
    if (this.config.routing?.preferredAccount === name) {
      this.config.routing = { mode: 'automatic', preferredAccount: null };
    }
    try {
      await this.saveConfig(this.config);
    } catch (error) {
      this.config.accounts.splice(configIndex, 0, removedConfig);
      this.config.routing = previousRouting;
      this.am.setAccountEnabled(idx, wasEnabled);
      throw error;
    }
    if (!this.am.removeAccount(idx)) {
      this.config.accounts.splice(configIndex, 0, removedConfig);
      this.config.routing = previousRouting;
      this.am.setAccountEnabled(idx, wasEnabled);
      await this.saveConfig(this.config);
      throw new Error(`Account "${name}" became active before deletion completed`);
    }
    if (this.selIdx >= this.am.accounts.length) this.selIdx = Math.max(0, this.am.accounts.length - 1);
    this._addLog(`Deleted account "${name}"`);
  }

  // ── rendering ──────────────────────────────────────

  render() {
    if (!this.running) return;
    // Guard against re-entry: clearing an expired quota logs, and _addLog calls
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
      process.stdout.write(`${ESC}H${ESC}2JTerminal too small (need 40x8+)\r\n`);
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
    const routing = this.am.routingMode === 'preferred'
      ? `Manual preference: ${this.am.preferredAccountName} (automatic failover)`
      : 'Automatic load balancing';
    // Cross-provider fallback policy — only meaningful when GLM/Kimi providers are in
    // the pool (profile=all). never=strict pin (yellow), when-exhausted=default (cyan),
    // always=peer (green).
    const hasProviders = this.am.accounts.some(a => a.type === 'provider');
    let xpText = '';
    if (hasProviders) {
      xpText = this._crossProviderText();
      // Overflow visibility: when GLM/Kimi actually served requests recently, surface the
      // volume so provider traffic isn't a mystery — it's overflow that spilled here while
      // OAuth was saturated. Reuses the SAME 15m load window as the per-row "15m Nr" column.
      const now = Date.now();
      let provReq = 0;
      for (const a of this.am.accounts) {
        if (a.type === 'provider') provReq += this.am._loadSummary?.(a, 15 * 60_000, now)?.requests || 0;
      }
      if (provReq > 0) xpText += `  ${dim('·')}  ${yellow(`providers: ${provReq} req/15m`)}`;
    }
    lines.push(this._routingLine(routing, xpText));
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

    // ── Accounts
    if (this.am.accounts.length === 0) {
      lines.push('');
      lines.push(yellow('  No accounts configured. Press [a] to add one.'));
    } else {
      lines.push('');
      // Aligned column header (dim + underline so it reads as chrome, not data). It
      // labels the fixed columns that have no inline label; the Ses/Wk/Tok/Req and
      // Now/15m/1h labels stay inline per row. It sits DIRECTLY above the rows — the
      // abbreviation glossary is a FOOTER below the rows (a caption), never between
      // the header and the data (a left-aligned sentence there reads as a broken,
      // misaligned second header).
      lines.push(dimUnderline(acctHeader(W)));
      const showBoth = W >= 70;
      // 65/54 = the fixed pre-bar column span (prefix + Account + Provider + Status +
      // gaps); grew by +4 with the wider 20-col Account column (was 61/50 at NAME_W 16).
      const bw = showBoth
        ? Math.max(5, Math.min(20, Math.floor((W - 65) / 2)))
        : Math.max(5, Math.min(20, W - 54));

      // Claude/OAuth accounts first, providers (GLM/Kimi fallback) last — a stable
      // display order over the canonical am.accounts array (which stays untouched so
      // routing/index-keyed actions are unaffected). Selection navigation shares the
      // SAME order via _selectableIndexes → _displayOrder.
      for (const i of this._displayOrder()) {
        lines.push(this._renderAcct(i, bw, showBoth));
      }
      // Glossary FOOTER (expands the abbreviations the header + inline labels can't
      // spell out). Below the rows so it never breaks the header↔column alignment.
      if (W >= 88) {
        lines.push(' ' + dim('Legend  Ses = 5h · Wk = 7d · Now = in-flight (weight) · 15m/1h = served (avg · f = fails)'));
      }
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
    const aHdr = ` Activity${acTag} `;
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

    // Completed log
    // 2 = separator + footer; confirm adds its detail line; updates adds its detail block.
    const footerH = this.mode === 'confirm' ? 3
      : this.mode === 'updates' ? 2 + this._renderUpdatesDetail().length
      : 2;
    const space = Math.max(0, H - lines.length - footerH);
    for (let i = 0; i < space && i < this.log.length; i++) {
      lines.push(`   ${gray(this.log[i].t)}  ${this.log[i].msg}`);
    }

    // Pad to fill
    while (lines.length < H - footerH) lines.push('');

    // Providers panel — shown when the user is on the providers screen
    if (this.mode === 'providers' || this.mode === 'select') {
      const pLines = [];
      this._renderProviders(pLines, W);
      lines.push(...pLines);
    }

    // ── Footer
    lines.push(' ' + dim('─'.repeat(W - 2)));
    if (this.mode === 'confirm') lines.push(` ${this.confirmDetail}`);
    // Updates DETAIL — without this, pressing 'u' changed only the one-line footer at the
    // very bottom of a busy screen, which reads as "nothing happened" (reported twice).
    // Every other mode draws something visible; this one must too.
    if (this.mode === 'updates') lines.push(...this._renderUpdatesDetail());
    lines.push(this._renderFooter());

    // Write buffer
    let buf = `${ESC}H`;
    for (let i = 0; i < H; i++) {
      buf += fitLine(lines[i] || '', W);
      if (i < H - 1) buf += '\r\n';
    }
    // Show cursor only in input mode
    buf += this.mode === 'input' ? `${ESC}?25h` : `${ESC}?25l`;
    process.stdout.write(buf);
  }

  _renderAcct(idx, bw, showBoth) {
    const a = this.am.accounts[idx];
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
    const rawName = a.name.slice(0, NAME_W).padEnd(NAME_W);
    // A disabled account reads as "off" — dim the whole name. Applied as a SINGLE SGR
    // (never dim(bold(...)) — bold()'s trailing RESET would cancel the dim mid-string),
    // so a disabled row is never also bold-selected.
    const name = a.enabled === false ? dim(rawName) : (isSel ? bold(rawName) : rawName);

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
    const upstreamBlocking = a.type !== 'provider' && this.am._isUpstreamThrottleBlocking?.();
    let effectiveStatus = a.enabled === false ? 'disabled' : a.status;
    if (a.enabled !== false && upstreamBlocking && a.status === 'active') {
      effectiveStatus = a.inFlight > 0 ? 'probing' : 'waiting';
    }
    // "blocked" = Anthropic is rejecting the WHOLE account (a 'rejected' unified
    // status corroborated by an exhausted unified bucket). A per-model cap (Fable)
    // is NOT account-wide — it shows as the separate "… maxed" tag, leaving the
    // status column truthful. Keys on a.status (not effectiveStatus) so a genuine
    // block wins even inside an upstream-throttle window.
    if (a.enabled !== false && a.status === 'active' && this.am._isAccountWideRejected?.(a)) {
      effectiveStatus = 'blocked';
    }
    // A dead refresh token surfaces as "reauth" (re-login needed) rather than a
    // generic "error", so the user knows the fix. Display-only — account.status
    // stays 'error' so routing/eligibility still exclude it.
    if (a.enabled !== false && a.refreshDead) effectiveStatus = 'reauth';
    switch (effectiveStatus) {
      case 'active':    status = isCur ? green('active') : 'active'; break;
      case 'reauth':    status = yellow('reauth'); break;
      case 'blocked':   status = red('blocked'); break;
      case 'probing':   status = green('probing'); break;
      case 'waiting':   status = yellow('waiting'); break;
      case 'paused':    status = yellow('paused'); break;
      case 'disabled':  status = red('✕ disabled'); break;
      case 'throttled': {
        // A transient auto-recovering cooldown — show the remaining time (from
        // rateLimitedUntil) so it reads as "recovering in Ns", not stuck.
        const cd = countdown(a.rateLimitedUntil);
        status = yellow(cd ? `throttled ${cd}` : 'throttled');
        break;
      }
      case 'exhausted': status = red('exhausted'); break;
      case 'error':     status = red('error'); break;
      default:          status = a.status || 'ready';
    }
    // Widened from 10 to fit "throttled 59s" so the quota bars stay column-aligned.
    status = rpad(status, STATUS_W);

    if (a.type === 'provider') {
      return this._renderProviderAcct(sel, cur, name, type, status, a, bw, showBoth);
    }

    // Quota ratios — prefer unified (Claude Max), fall back to standard (API key)
    const q = a.quota;
    let r1 = null, r2 = null, l1 = 'Ses', l2 = 'Wk ', t1 = null, t2 = null;

    if (q.unified5h != null || q.unified7d != null) {
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

    let line = ` ${sel}${cur} ${name} ${type} ${status} ${l1} ${bar(r1, bw, t1)}`;
    if (showBoth) {
      // "no weekly cap on this plan" is a DIFFERENT state from "not read yet", and
      // both render as an empty bar. Say which, so a healthy uncapped account
      // (privacy@gomokka.com, measured 2026-08-06) doesn't read as broken.
      line += (r2 == null && q.weeklyAbsent)
        ? `  ${l2} ${emptyBar('none', bw)}`
        : `  ${l2} ${bar(r2, bw, t2)}`;
    }
    const weekly = weeklyPolicyText(this.am, a);
    if (weekly) line += `  ${weekly}`;
    // Per-model weekly caps (e.g. Fable, while the unified weekly still has
    // headroom). Show the ACTUAL utilization — "Fable 90%" (yellow) while high but
    // still usable, "Fable maxed" (red) ONLY at genuine exhaustion. This is the
    // SAME predicate the router benches on (_scopedExhausted), so "maxed" renders
    // iff the model is actually benched — 90%/critical is no longer mislabelled.
    const exhaustedFloor = this.am.scheduler?.weeklyExhaustedThreshold ?? 0.999;
    const reserveFloor = this.am.scheduler?.weeklyReserveThreshold ?? 0.85;
    const scopedTags = [];
    for (const [fam, e] of Object.entries(q.scopedWeekly || {})) {
      if (!e || e.isActive === false || e.utilization == null) continue;
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
    line += this._probeHealthNote(a);
    line += `  ${dim(loadText(this._accountLoad(a)))}`;
    return line;
  }

  /** Freshness suffix for an account row. Empty when the probe is current. When
   *  stale, names the cause from the last recorded probe failure (e.g. a 429 from
   *  the usage endpoint) so a self-throttling probe reads as "rate-limited" rather
   *  than an unexplained "stale". Leading spaces included so callers append raw. */
  _probeHealthNote(a) {
    // A dead account (reauth / disabled) already surfaces its state in the status
    // column, and its quota reading is frozen and moot — the prober skips it, so a
    // "stale·probe 401" here is just the perpetual echo of the 401 that killed it.
    // Only annotate probe-staleness for LIVE accounts, where a failing probe
    // (e.g. a 429) is a real, actionable signal.
    if (a?.refreshDead || a?.enabled === false) return '';
    if (!this.am._quotaProbeStale?.(a)) return '';   // probe fresh (or off) → nothing to flag; interval>0 after this
    // The background probe IS stale — but only flag it if something DISPLAYED is
    // actually stale. An OAuth account's Ses/Wk bars come from unified5h/7d, which
    // response headers refresh on every served request (updateQuota → lastHeaderQuotaAt);
    // so a BUSY oauth account with a header-fresh reading and no probe-only scoped
    // cap is NOT stale, even if its background probe is 429-throttled. Provider bars
    // and per-model scoped caps ARE probe-only, so for those a stale probe genuinely
    // means stale data → keep flagging.
    const q = a.quota || {};
    const reserveFloor = this.am.scheduler?.weeklyReserveThreshold ?? 0.85; // mirrors _renderAcct's scoped-tag gate
    const hasDisplayedScopedCap = Object.values(q.scopedWeekly || {}).some(
      e => e && e.isActive !== false && e.utilization != null && e.utilization >= reserveFloor);
    if (a.type !== 'provider' && !hasDisplayedScopedCap) {
      const interval = this.am.quotaProbeIntervalMs; // > 0 here (else _quotaProbeStale returned false)
      const headerFresh = q.lastHeaderQuotaAt && (Date.now() - q.lastHeaderQuotaAt) <= Math.max(3 * interval, 180_000);
      if (headerFresh) return '';
    }
    const s = q.lastProbeErrorStatus;
    if (s === 429) return `  ${yellow('stale·rate-limited')}`;
    if (s) return `  ${yellow('stale·probe ' + s)}`;
    return `  ${dim('stale')}`;
  }

  _renderProviderAcct(sel, cur, name, type, status, a, bw = 11, showBoth = true) {
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
    } else if (q.providerQuotaSource === 'console-only') {
      sesCell = emptyBar('n/a', bw);
      wkCell = emptyBar('n/a', bw);
      note = `  ${dim('console-only')}`;
    } else {
      sesCell = emptyBar('probing', bw);
      wkCell = emptyBar('probing', bw);
    }

    let line = ` ${sel}${cur} ${name} ${type} ${status} Ses ${sesCell}`;
    if (showBoth) line += `  Wk  ${wkCell}`;
    line += note;
    // Same recent-load columns as OAuth (providers track inFlight + load events),
    // plus a compact Last <status> <ms> — the one signal that matters for a
    // rarely-hit fallback (loadText reads 0r when idle).
    line += `  ${dim(loadText(this._accountLoad(a)))}`;
    if (a.lastStatus) line += `  ${dim('Last')} ${statusColor(a.lastStatus)} ${dim(formatMs(a.lastResponseMs))}`;
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
    return {
      current: {
        inFlight: account.inFlight,
        activeWeight: account.activeWeight,
      },
      last15m: this.am._loadSummary(account, 15 * 60 * 1000, now),
      last1h: this.am._loadSummary(account, 60 * 60 * 1000, now),
    };
  }

  _renderFooter() {
    switch (this.mode) {
      case 'normal':
        return ` ${bold('a')} Accounts  ${bold('p')} Providers  ${bold('m')} Routing  ${bold('s')} Sync  ${bold('u')} Updates  ${bold('r')} Restart  ${bold('q')} Stop`;
      case 'updates': {
        const state = this._autoUpdateOn() ? green('on') : dim('off');
        return ` ${bold('c')} Check & apply now  ${bold('t')} Automatic updates: ${state} ↻  ${bold('Esc')} Back`;
      }
      case 'accounts':
        return ` ${bold('l')} Login/re-auth (browser)  ${bold('k')} API key  ${bold('n')} Rename  ${bold('t')} Enable/disable  ${bold('d')} Delete  ${bold('Esc')} Back`;
      case 'providers':
        return ` ${bold('a')} Add provider  ${bold('d')} Delete  ${bold('t')} Enable/disable  ${bold('Esc')} Back`;
      case 'routing': {
        // Show the CURRENT cross-provider policy inline so pressing f visibly changes it
        // right here at the footer (the policy also renders in the header, far from the
        // keypress — the "f does nothing" report).
        const g = this.am._claudeFallbackFor?.('zai') || 'never';
        const k = this.am._claudeFallbackFor?.('kimi') || 'never';
        return ` ${bold('a')} Automatic  ${bold('p')} Preference  ${bold('g')} GLM: ${cyan(g)} ↻  ${bold('k')} Kimi: ${cyan(k)} ↻  ${bold('Esc')} Back`;
      }
      case 'select': {
        const act = this.selAction === 'prefer'
          ? 'prefer'
          : this.selAction === 'toggle'
            ? 'enable/disable'
            : this.selAction === 'rename'
              ? 'rename'
              : 'delete';
        return ` ${dim('↑↓')} select  ${bold('Enter')} ${act}  ${bold('Esc')} cancel`;
      }
      case 'input':
        return ` ${this.inputPrompt}: ${this.inputSensitive ? '•'.repeat(this.inputBuf.length) : this.inputBuf}█`;
      case 'confirm':
        return ` ${bold(this.confirmTitle)}  ${bold('y')} Yes  ${bold('n')} No`;
      default:
        return '';
    }
  }
}
