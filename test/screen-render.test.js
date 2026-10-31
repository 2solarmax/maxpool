import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Runs the REAL page script against a stub DOM and a stub status response.
const html = readFileSync(new URL('../src/screen.html', import.meta.url), 'utf8');
const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));

async function render(status) {
  const app = { innerHTML: '' };
  const stub = { onclick: null, onkeydown: null, value: '' };
  const sandbox = {
    document: { getElementById: id => (id === 'app' ? app : stub) },
    localStorage: { getItem: () => 'k', setItem() {}, removeItem() {} },
    fetch: async () => ({ status: 200, ok: true, json: async () => status }),
    setInterval: () => 0, setTimeout: () => 0, clearTimeout: () => {}, clearInterval: () => {}, console, Date, Object, String, Math, isFinite,
  };
  vm.runInNewContext(script, sandbox);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  return app.innerHTML;
}

test('screen: a cloud account appears once, and the header counts only this machine', async () => {
  const out = await render({
    accounts: [
      { name: 'kira', type: 'oauth', quota: {} },
      { name: 'reports ☁', type: 'oauth', remote: true, quota: {} },
    ],
    pools: [{ name: 'team', ok: true, accounts: [{ name: 'reports', type: 'oauth', quota: {} }] }],
  });
  assert.match(out, /1 on this Mac/, out.slice(0, 300));
  assert.match(out, /1 cloud/);
  assert.equal((out.match(/reports/g) || []).length, 1, 'cloud account rendered exactly once');
  assert.match(out, /kira/);
});
