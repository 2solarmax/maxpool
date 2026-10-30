import { strict as assert } from 'node:assert';

// Load server.js exports minimally? server.js is a big module; instead assert the
// source text wiring (constant + env override + minimum floor) and run a behavioral
// probe of the timeout value resolution.
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
assert.match(src, /MAXPOOL_LINK_TTFB_MS/, 'env override present');
assert.match(src, /Math\.max\(15_000, Number\(process\.env\.MAXPOOL_LINK_TTFB_MS\) \|\| UPSTREAM_TTFB_MS\)/, 'floor 15s, default = UPSTREAM_TTFB_MS');
assert.match(src, /setTimeout\(\(\) => linkCtl\.abort\(\), linkTtfbMs\)/, 'timer uses resolved value');
console.log('source wiring OK');

// Behavior: resolve the same expression the code uses.
const resolve = (env, ttfb) => Math.max(15_000, Number(env.MAXPOOL_LINK_TTFB_MS) || ttfb);
assert.equal(resolve({}, 120_000), 120_000, 'default = direct-path TTFB (120s)');
assert.equal(resolve({ MAXPOOL_LINK_TTFB_MS: '20000' }, 120_000), 20_000, 'env override honored');
assert.equal(resolve({ MAXPOOL_LINK_TTFB_MS: '2000' }, 120_000), 15_000, 'floor 15s — never below old guard');
assert.equal(resolve({ MAXPOOL_LINK_TTFB_MS: 'abc' }, 90_000), 90_000, 'garbage env falls back to UPSTREAM_TTFB_MS');
console.log('resolution behavior OK');
