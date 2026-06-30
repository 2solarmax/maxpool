// Persistent, rotating, low-overhead event log so incidents are investigable
// after the fact (the TUI activity feed is in-memory only and scrolls away). It
// mirrors the existing `[Maxpool] …` console stream — routing, network errors,
// cooldowns, token refreshes, reloads, upstream-throttle — to a file that
// survives the terminal. Logging must NEVER throw into the proxy path, so every
// write is fire-and-forget and all errors are swallowed.

import { appendFile, stat, rename, chmod } from 'node:fs/promises';

const MAX_BYTES = 5 * 1024 * 1024;   // rotate at ~5 MB (one .1 backup kept)
const ROTATE_CHECK_MS = 2000;        // rotation-owner size-check cadence
// Cap each line below the platform PIPE_BUF (512 B on macOS) so concurrent
// O_APPEND writes from coexisting processes during a reload stay atomic (never
// interleave). 24-char ISO timestamp + space + body + newline must fit.
const MAX_BODY = 480;
const MAX_QUEUED = 10_000;            // bound the in-flight queue if the disk stalls

let logPath = null;
let manageRotation = false;           // SINGLE owner rotates (supervisor, or the lone unsupervised worker)
let rotationTimer = null;
let writeChain = Promise.resolve();
let queued = 0;
let dropped = 0;
let origConsole = null;

export function setEventLogPath(path, { manageRotation: owns = false } = {}) {
  logPath = path || null;
  manageRotation = Boolean(owns);
  if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
  if (logPath) {
    // 0600 even on a pre-existing file (appendFile's mode only applies on create).
    chmod(logPath, 0o600).catch(() => {});
    if (manageRotation) {
      rotationTimer = setInterval(() => { rotateIfNeeded().catch(() => {}); }, ROTATE_CHECK_MS);
      rotationTimer.unref?.();
    }
  }
}

/**
 * Redact obvious secrets BEFORE anything reaches disk. We only ever log summaries
 * (account names, statuses, error classes) — never raw tokens/headers/bodies — but
 * this is defense-in-depth so a future log line that happens to include a token
 * can't leak through the persisted file.
 */
export function redactSecrets(s) {
  return String(s)
    .replace(/sk-ant-[A-Za-z0-9._-]+/g, 'sk-ant-[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:access|refresh)_?token["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]')
    .replace(/(["']?api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]');
}

export function appendEventLog(msg) {
  if (!logPath || msg == null) return;
  if (queued >= MAX_QUEUED) { dropped++; return; } // disk stalled — drop, don't grow memory unbounded
  queued++;
  writeChain = writeChain.then(() => writeLine(msg)).catch(() => {}).finally(() => { queued--; });
}

// Truncate to at most maxBytes UTF-8 bytes (not chars) without splitting a
// multibyte codepoint, so the final line stays under PIPE_BUF for atomic O_APPEND.
function capBytes(s, maxBytes) {
  if (Buffer.byteLength(s) <= maxBytes) return s;
  let str = Buffer.from(s).subarray(0, maxBytes - 3).toString('utf8'); // room for '…' (3 B)
  if (str.endsWith('�')) str = str.slice(0, -1); // drop a partial trailing codepoint
  return str + '…';
}

async function writeLine(rawMsg) {
  const path = logPath;
  if (!path) return;
  try {
    // The drop sentinel is its OWN append so neither write exceeds PIPE_BUF.
    if (dropped > 0) {
      const n = dropped; dropped = 0;
      await appendFile(path, `${new Date().toISOString()} [event-log] dropped ${n} line(s) (disk stalled)\n`, { mode: 0o600 });
    }
    // Redaction + formatting on the DRAINED async chain, off the request hot path.
    let body = redactSecrets(String(rawMsg)).replace(/\s*\n\s*/g, ' ');
    body = capBytes(body, MAX_BODY);
    await appendFile(path, `${new Date().toISOString()} ${body}\n`, { mode: 0o600 });
  } catch { /* logging must never throw into the proxy */ }
}

// Rotation is run by a SINGLE owner's timer (never inside writeLine), so two
// coexisting processes during a reload can't both rename and clobber each other's
// archive. Appends are O_APPEND to the path, so a rename mid-stream just means the
// next append re-creates the live file — no lost current lines.
export async function rotateIfNeeded() {
  const path = logPath;
  if (!path) return;
  const st = await stat(path).catch(() => null);
  if (st && st.size > MAX_BYTES) await rename(path, `${path}.1`).catch(() => {});
}

/**
 * Tee console.log/console.error to the event log while preserving their normal
 * output (stdout in plain mode; the TUI separately re-points console at its ring
 * buffer, whose _addLog also calls appendEventLog, so TUI-mode lines persist too).
 */
export function installConsoleMirror() {
  if (origConsole) return; // idempotent
  origConsole = { log: console.log.bind(console), error: console.error.bind(console) };
  for (const method of ['log', 'error']) {
    const orig = origConsole[method];
    console[method] = (...args) => {
      try { appendEventLog(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ')); } catch { /* never */ }
      orig(...args);
    };
  }
}

/** Test-only barrier: resolves once every queued append has settled. */
export const flushEventLog = () => writeChain;

/** Test-only: restore console + reset all module state so tests don't bleed. */
export function __resetEventLogForTest() {
  if (origConsole) { console.log = origConsole.log; console.error = origConsole.error; origConsole = null; }
  if (rotationTimer) { clearInterval(rotationTimer); rotationTimer = null; }
  logPath = null; manageRotation = false; writeChain = Promise.resolve(); queued = 0; dropped = 0;
}
