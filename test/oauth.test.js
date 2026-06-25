import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importCredentials } from '../src/oauth.js';

test('importCredentials reads a Claude Code credentials file (claudeAiOauth wrapper)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-oauth-'));
  try {
    const file = join(dir, '.credentials.json');
    await writeFile(file, JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-file',
        refreshToken: 'sk-ant-ort01-file',
        expiresAt: 1782413579470,
        subscriptionType: 'max',
        rateLimitTier: 'default',
      },
    }));
    const creds = await importCredentials(file);
    assert.equal(creds.accessToken, 'sk-ant-oat01-file');
    assert.equal(creds.refreshToken, 'sk-ant-ort01-file');
    assert.equal(creds.subscriptionType, 'max');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('importCredentials accepts a flat (unwrapped) credentials file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-oauth-'));
  try {
    const file = join(dir, '.credentials.json');
    await writeFile(file, JSON.stringify({
      accessToken: 'sk-ant-oat01-flat',
      refreshToken: 'sk-ant-ort01-flat',
      expiresAt: 1782413579470,
    }));
    const creds = await importCredentials(file);
    assert.equal(creds.accessToken, 'sk-ant-oat01-flat');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('importCredentials gives an actionable error when no file and no Keychain creds', async () => {
  // Point at a path that does not exist. On a machine with Claude Code logged
  // in via Keychain this returns creds; in CI/non-darwin it must throw a clear,
  // actionable message rather than a raw ENOENT.
  const missing = join(tmpdir(), 'maxpool-does-not-exist-xyz', '.credentials.json');
  try {
    const creds = await importCredentials(missing);
    // Keychain fallback succeeded (darwin + logged in): must be well-formed.
    assert.ok(creds.accessToken, 'Keychain fallback returned creds without accessToken');
  } catch (err) {
    // No file and no Keychain: the message must guide the user, not leak ENOENT.
    assert.doesNotMatch(err.message, /ENOENT/, 'error leaked raw ENOENT');
    assert.match(err.message, /Claude Code|Keychain|logged in|import --json/i);
  }
});
