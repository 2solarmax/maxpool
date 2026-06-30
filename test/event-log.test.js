import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  setEventLogPath, appendEventLog, flushEventLog, redactSecrets,
  installConsoleMirror, rotateIfNeeded, __resetEventLogForTest,
} from '../src/event-log.js';

async function tmpLog() {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-evlog-'));
  return join(dir, 'maxpool.log');
}

test('appendEventLog writes a timestamped, redacted, newline-terminated line', async () => {
  const path = await tmpLog();
  setEventLogPath(path);
  appendEventLog('[Maxpool] Switched to account "personal"');
  await flushEventLog();
  const text = await readFile(path, 'utf-8');
  assert.match(text, /^\d{4}-\d\d-\d\dT[\d:.]+Z .*Switched to account "personal"\n$/);
  __resetEventLogForTest();
});

test('redactSecrets strips tokens/bearer/refresh+access tokens/api keys', () => {
  assert.match(redactSecrets('authorization: Bearer abc.def-123'), /Bearer \[redacted\]/);
  assert.match(redactSecrets('key sk-ant-oat01-AbC_dEf'), /sk-ant-\[redacted\]/);
  assert.match(redactSecrets('{"refresh_token":"rt_9aZ-bc.dEf01"}'), /\[redacted\]/);
  assert.match(redactSecrets('apiKey=AKIA1234567890abcd'), /\[redacted\]/);
  // a normal account name / status is NOT mangled
  assert.equal(redactSecrets('Switched to account "max@dubner.io" (200)'), 'Switched to account "max@dubner.io" (200)');
});

test('a multi-line message is collapsed to ONE line and capped < PIPE_BUF (macOS 512B atomicity)', async () => {
  const path = await tmpLog();
  setEventLogPath(path);
  appendEventLog('[Maxpool] boom\n  at a()\n  at b()');                 // multi-line stack
  appendEventLog('X'.repeat(2000));                                     // oversized ASCII
  appendEventLog('的'.repeat(600));                                     // oversized MULTIBYTE (3 B/char → ~1800 B)
  appendEventLog('🔥'.repeat(400));                                     // oversized emoji (4 B/char)
  await flushEventLog();
  const lines = (await readFile(path, 'utf-8')).split('\n').filter(Boolean);
  for (const line of lines) {
    assert.ok(!line.slice(25).includes('\n'), 'collapsed to a single line');
    // BYTE length must stay under PIPE_BUF even for multibyte content (the char-cap bug).
    assert.ok(Buffer.byteLength(line) < 512, `line stays < PIPE_BUF (bytes) for atomic O_APPEND, got ${Buffer.byteLength(line)}`);
  }
  assert.match(lines[0], /boom at a\(\) at b\(\)/);
  __resetEventLogForTest();
});

test('installConsoleMirror tees console.log to the file AND preserves output; reset restores console', async () => {
  const path = await tmpLog();
  setEventLogPath(path);
  const realLog = console.log;
  let passthrough = '';
  console.log = (...a) => { passthrough += a.join(' '); }; // capture the "original" the mirror should still call
  installConsoleMirror();
  console.log('[Maxpool] hello from the mirror');
  await flushEventLog();
  const text = await readFile(path, 'utf-8');
  assert.match(text, /hello from the mirror/, 'teed to the file');
  assert.match(passthrough, /hello from the mirror/, 'original console.log still called (output preserved)');
  __resetEventLogForTest();
  console.log = realLog;
});

test('appendEventLog NEVER throws on an unwritable path, and the queue drains', async () => {
  setEventLogPath('/this/path/does/not/exist/maxpool.log');
  assert.doesNotThrow(() => appendEventLog('[Maxpool] should be swallowed'));
  await flushEventLog(); // resolves (errors swallowed)
  __resetEventLogForTest();
});

test('rotation is best-effort and SINGLE-owner: rotateIfNeeded archives to .1 only when over the cap', async () => {
  const path = await tmpLog();
  setEventLogPath(path, { manageRotation: true });
  // Under cap → no rotation.
  await writeFile(path, 'small\n');
  await rotateIfNeeded();
  assert.equal(existsSync(`${path}.1`), false, 'no rotation under the size cap');
  // Over 5 MB → rotate to .1, live file then restarts on the next append.
  await writeFile(path, Buffer.alloc(5 * 1024 * 1024 + 1024, 0x61));
  await rotateIfNeeded();
  assert.equal(existsSync(`${path}.1`), true, 'archived to .1 when over the cap');
  const archive = await stat(`${path}.1`);
  assert.ok(archive.size > 5 * 1024 * 1024, 'the .1 archive holds the full pre-rotation content');
  appendEventLog('[Maxpool] post-rotation line');
  await flushEventLog();
  assert.match(await readFile(path, 'utf-8'), /post-rotation line/, 'live log restarted cleanly after rotation');
  __resetEventLogForTest();
});

test('disabled path: appendEventLog is a no-op when no path is set', async () => {
  __resetEventLogForTest(); // logPath = null
  assert.doesNotThrow(() => appendEventLog('[Maxpool] nothing should happen'));
  await flushEventLog();
});
