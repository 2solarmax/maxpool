// One fixed client identity per upstream account (2026-11-07): a pooled account must
// present the same device id and one machine profile on every request, whoever sent
// it. Rewrite operates on the RAW body string — byte fidelity of everything outside
// metadata.user_id is part of the contract (red-team M1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { virtualDeviceId, rewriteMetadataUserIdRaw, normalizeClientHeaders } from '../src/client-identity.js';

const acct = { name: 'max@gomokka.com', type: 'oauth', accountUuid: 'U-123' };
const other = { name: 'personal', type: 'oauth', accountUuid: 'U-999' };
// Built with JSON.stringify so the escaped-string-in-string form is exactly what a
// real client sends (a hand-typed template gets the escaping wrong — caught while
// writing the test, which is the point of building it properly).
const ccBody = (device, sess, extra = '') => JSON.stringify({
  model: 'claude-opus-5-5', max_tokens: 2000,
  metadata: { user_id: JSON.stringify({ device_id: device, account_uuid: '', session_id: sess }) },
  messages: [{ role: 'user', content: `${extra} id 9007199254740993` }] });
const legacyBody = (uid) => JSON.stringify({ metadata: { user_id: uid }, model: 'm', messages: [] });

test('device id is stable per account and differs across accounts; key rotation safe', () => {
  assert.equal(virtualDeviceId(acct), virtualDeviceId(acct));
  assert.notEqual(virtualDeviceId(acct), virtualDeviceId(other));
  // provider rows seed by NAME: rotating the z.ai key must not change the identity
  const glm = { name: 'glm max@gomokka.com', type: 'provider', credential: 'key-old' };
  assert.equal(virtualDeviceId(glm), virtualDeviceId({ ...glm, credential: 'key-new' }));
});

test('Claude Code metadata.user_id rewritten to the account device; session preserved; big ints byte-identical', () => {
  const body = ccBody('INSTALL-A', 'sess-1');
  const out = rewriteMetadataUserIdRaw(body, acct);
  assert.notEqual(out, null);
  const uid = JSON.parse(JSON.parse(out).metadata.user_id);
  assert.equal(uid.device_id, virtualDeviceId(acct));
  assert.equal(uid.session_id, 'sess-1');
  assert.equal(uid.account_uuid, 'U-123');
  assert.ok(out.includes('9007199254740993'), 'the untouched rest of the body is byte-identical');
  // a different person's install → the SAME account identity
  const out2 = rewriteMetadataUserIdRaw(ccBody('INSTALL-B', 'sess-2'), acct);
  assert.equal(JSON.parse(JSON.parse(out2).metadata.user_id).device_id, virtualDeviceId(acct));
  // idempotent: rewriting the rewritten body changes nothing
  assert.equal(rewriteMetadataUserIdRaw(out, acct), null);
});

test('legacy user_<hex>_account_<uuid> form is rewritten too', () => {
  const body = legacyBody('user_abc123_account__session_s9');
  const out = rewriteMetadataUserIdRaw(body, acct);
  assert.match(JSON.parse(out).metadata.user_id, new RegExp(`^user_${virtualDeviceId(acct)}_account_U-123_session_s9$`));
});

test('non-Claude-Code metadata is untouched', () => {
  for (const uid of ['my-app-user', '{"custom":1}', '{"device_id":"x"}', 'user_bad']) {
    const body = legacyBody(uid);
    assert.equal(rewriteMetadataUserIdRaw(body, acct), null, uid);
  }
  assert.equal(rewriteMetadataUserIdRaw('{"model":"m"}', acct), null);
  // metadata object (not a string) — not ours
  assert.equal(rewriteMetadataUserIdRaw('{"metadata":{"user_id":{"a":1}},"model":"m"}', acct), null);
});

test('headers: machine profile pinned for Claude Code; versions and non-CC untouched', () => {
  const a = { 'user-agent': 'claude-cli/2.1.319 (external, sdk-cli)', 'x-stainless-os': 'MacOS', 'x-stainless-arch': 'arm64', 'x-stainless-package-version': '0.128.0' };
  assert.equal(normalizeClientHeaders(a), true);
  const b = { 'user-agent': 'claude-cli/2.1.200 (external, sdk-cli)', 'x-stainless-os': 'Windows', 'x-stainless-arch': 'x64', 'x-stainless-package-version': '0.99.0' };
  normalizeClientHeaders(b);
  assert.equal(b['x-stainless-os'], 'MacOS'); assert.equal(b['x-stainless-arch'], 'arm64');
  // version stays as sent (no cross-restart regressions)
  assert.match(b['user-agent'], /^claude-cli\/2\.1\.200 /);
  assert.equal(b['x-stainless-package-version'], '0.99.0');
  const c = { 'user-agent': 'my-proxy/1.0', 'x-stainless-os': 'Linux' };
  assert.equal(normalizeClientHeaders(c), false);
  assert.equal(c['x-stainless-os'], 'Linux');
});
