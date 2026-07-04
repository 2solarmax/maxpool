import { createInterface } from 'node:readline';
import { fetchProfile, loginOAuth } from './oauth.js';
import { appendEventLog } from './event-log.js';

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

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const strip = s => s.replace(ANSI_RE, '');
const vw = s => strip(s).length;

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

export const __tuiTest = { formatReset, quotaLabel, bar, strip, loadText, countdown };

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
    this._addLog(`${info.method} ${info.path} → ${acct} (${info.status}, ${dur}s)`);
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
        () => { this.stop(); this.onRestart?.(); },
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
    }
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
        'Log in via browser?',
        'Opens a browser to add any Claude account; you name it afterward.',
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

  _keyRouting(k) {
    if (k === 'a') {
      this._confirm(
        'Use automatic routing?',
        'Spread new requests across healthy accounts using load, quota, and recent errors.',
        () => this._setAutomaticRouting(),
      );
    } else if (k === 'p' && this.am.accounts.some(account => account.type !== 'provider')) {
      this._startSelection('prefer');
    } else if (k === 'esc' || k === 'q') {
      this.mode = 'normal';
    }
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

  _selectableIndexes(action) {
    return this.am.accounts
      .map((account, index) => ({ account, index }))
      .filter(({ account }) => {
        if (action === 'prefer') return account.type !== 'provider' && account.enabled;
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

  // Browser OAuth login: any Claude account, named afterward. Suspends the TUI
  // around the interactive flow (browser + name prompt), then resumes.
  async _doLogin() {
    const wasRunning = this.running;
    if (wasRunning) this.stop();
    try {
      process.stdout.write('\nOpening browser to log into Claude…\n');
      const creds = await loginOAuth();
      const profile = await fetchProfile(creds.accessToken);
      const suggested = profile?.email
        || `account-${this.config.accounts.filter(a => a.name.startsWith('account-')).length + 1}`;
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise(resolve => rl.question(`Name this account [${suggested}]: `, resolve));
      rl.close();
      const name = String(answer || '').trim() || suggested;
      await this._upsertOAuthAccount({ creds, profile, name, source: 'login', verb: 'Added' });
      process.stdout.write(`\nAdded account "${name}". Returning to maxpool…\n`);
    } catch (e) {
      process.stdout.write(`\nLogin failed: ${e.message}\n`);
    } finally {
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
      try {
        await this.saveConfig(this.config);
      } catch (error) {
        this.config.accounts[idx] = previous;
        throw error;
      }
      const amAcct = this.am.accounts.find(account =>
        (entry.accountUuid && account.accountUuid === entry.accountUuid) || account.name === name
      );
      if (amAcct) {
        amAcct.credential = creds.accessToken;
        amAcct.refreshToken = creds.refreshToken;
        amAcct.expiresAt = creds.expiresAt;
        amAcct.accountUuid = entry.accountUuid;
        amAcct.name = name;
        if (amAcct.status === 'error') amAcct.status = 'active';
      }
      this._addLog(`Updated account "${name}"`);
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
    }
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
      this._addLog(`Cannot ${enabled ? 'enable' : 'disable'} runtime provider "${account.name}" here`);
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
    const left = bold(' Maxpool');
    const port = this.config.proxy?.port || 3456;
    const right = `Port ${port} ${green('▲')} `;
    lines.push(left + ' '.repeat(Math.max(1, W - vw(left) - vw(right))) + right);
    lines.push(' ' + dim('─'.repeat(W - 2)));
    const routing = this.am.routingMode === 'preferred'
      ? `Manual preference: ${this.am.preferredAccountName} (automatic failover)`
      : 'Automatic load balancing';
    lines.push(` Routing  ${cyan(routing)}`);
    const queuedCount = this.am.queueState?.waiting?.length || 0;
    if (this.am._isUpstreamThrottleBlocking?.() || queuedCount) {
      const throttle = this.am.upstreamThrottle;
      const remaining = throttle.until ? Math.max(0, Math.ceil((throttle.until - Date.now()) / 1000)) : 0;
      const state = this.am._isUpstreamThrottleBlocking?.()
        ? throttle.probeInFlight ? 'probing recovery' : `retry in ${remaining}s`
        : 'recovering';
      const queued = queuedCount;
      const oldest = queued ? Math.max(0, Date.now() - this.am.queueState.waiting[0].queuedAt) : 0;
      const queueText = queued ? `  queued ${queued}  oldest ${formatMs(oldest)}` : '';
      lines.push(` ${yellow(' Anthropic upstream throttled')}  ${dim(state + queueText)}`);
    }

    // ── Accounts
    if (this.am.accounts.length === 0) {
      lines.push('');
      lines.push(yellow('  No accounts configured. Press [a] to add one.'));
    } else {
      lines.push('');
      const showBoth = W >= 70;
      const bw = showBoth
        ? Math.max(5, Math.min(20, Math.floor((W - 56) / 2)))
        : Math.max(5, Math.min(20, W - 45));

      for (let i = 0; i < this.am.accounts.length; i++) {
        lines.push(this._renderAcct(i, bw, showBoth));
      }
    }

    // ── Activity header
    lines.push('');
    const ac = this.active.size;
    const acTag = ac > 0 ? `  ${cyan(ac + ' active')}` : '';
    const aHdr = ` Activity${acTag} `;
    lines.push(aHdr + dim('─'.repeat(Math.max(1, W - vw(aHdr)))));

    // Active requests
    const now = Date.now();
    for (const [, r] of this.active) {
      const el = ((now - r.started) / 1000).toFixed(1);
      const sp = cyan(SPINNER[this.frame]);
      const a = r.account ? ` → ${r.account}` : '';
      lines.push(` ${sp} ${gray(r.t)}  ${r.method} ${r.path}${a} ${dim(`(${el}s...)`)}`);
    }

    // Completed log
    const footerH = this.mode === 'confirm' ? 3 : 2;
    const space = Math.max(0, H - lines.length - footerH);
    for (let i = 0; i < space && i < this.log.length; i++) {
      lines.push(`   ${gray(this.log[i].t)}  ${this.log[i].msg}`);
    }

    // Pad to fill
    while (lines.length < H - footerH) lines.push('');

    // ── Footer
    lines.push(' ' + dim('─'.repeat(W - 2)));
    if (this.mode === 'confirm') lines.push(` ${this.confirmDetail}`);
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
    // Highlight the currently-active account. In manual mode that's the
    // preferred account; in automatic mode it's the one most recently routed
    // to (currentIndex). Previously only manual mode highlighted anything, so
    // in automatic load-balancing no row was ever marked current.
    const isCur = this.am.routingMode === 'preferred'
      ? a.name === this.am.preferredAccountName
      : idx === this.am.currentIndex;
    const isSel = this.mode === 'select' && idx === this.selIdx;

    // Prefix: selection marker + current marker
    const sel = isSel ? cyan('>') : ' ';
    const cur = isCur ? green('►') : ' ';

    // Name (bold if selected)
    const rawName = a.name.slice(0, 12).padEnd(12);
    const name = isSel ? bold(rawName) : rawName;

    // Type
    const type = gray(a.type.padEnd(7));

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
    // Anthropic is actively REJECTING this account right now (e.g. a per-model weekly
    // sub-limit the general utilization % doesn't expose). It's unusable — surface
    // that instead of a benign green "active", so a low weekly % (the bar keeps its
    // true value) is never misread as available headroom.
    // Keys on a.status (not effectiveStatus) so a rejected account reads 'blocked'
    // even inside an upstream-throttle window (where it would otherwise show
    // probing/waiting) — a rejected account is unusable, not part of the recovery.
    if (a.enabled !== false && a.quota?.unifiedStatus === 'rejected' && a.status === 'active') {
      effectiveStatus = 'blocked';
    }
    switch (effectiveStatus) {
      case 'active':    status = isCur ? green('active') : 'active'; break;
      case 'blocked':   status = red('blocked'); break;
      case 'probing':   status = green('probing'); break;
      case 'waiting':   status = yellow('waiting'); break;
      case 'paused':    status = yellow('paused'); break;
      case 'disabled':  status = gray('disabled'); break;
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
    status = rpad(status, 13);

    if (a.type === 'provider') {
      return this._renderProviderAcct(sel, cur, name, type, status, a);
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
      line += `  ${l2} ${bar(r2, bw, t2)}`;
    }
    const weekly = weeklyPolicyText(this.am, a);
    if (weekly) line += `  ${weekly}`;
    line += `  ${dim(loadText(this._accountLoad(a)))}`;
    return line;
  }

  _renderProviderAcct(sel, cur, name, type, status, a) {
    const completed = a.completedRequests || 0;
    const failed = a.failedRequests || 0;
    const active = a.inFlight || 0;
    const last = a.lastStatus ? `${statusColor(a.lastStatus)} ${formatMs(a.lastResponseMs)}` : '-';
    const q = a.quota || {};
    let limit = '';
    if (q.genericLimit != null && q.genericRemaining != null) {
      const used = q.genericLimit - q.genericRemaining;
      const reset = formatReset(q.genericReset);
      limit = `  Lim ${used}/${q.genericLimit}${reset ? ` ${reset}` : ''}`;
    }
    const err = a.lastError ? `  Err ${String(a.lastError).slice(0, 18)}` : '';
    return ` ${sel}${cur} ${name} ${type} ${status} Act ${String(active).padStart(2)}  OK ${String(completed).padStart(3)}  Fail ${String(failed).padStart(2)}  Last ${last}  ${dim(loadText(this._accountLoad(a)))}${limit}${err}`;
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
        return ` ${bold('a')} Accounts  ${bold('m')} Routing  ${bold('s')} Sync  ${bold('r')} Restart  ${bold('q')} Stop`;
      case 'accounts':
        return ` ${bold('l')} Login (browser)  ${bold('k')} API key  ${bold('n')} Rename  ${bold('t')} Enable/disable  ${bold('d')} Delete  ${bold('Esc')} Back`;
      case 'routing':
        return ` ${bold('a')} Automatic  ${bold('p')} Manual preference  ${bold('Esc')} Back`;
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
