// PUBLIC-REPO KEY GUARD (2026-10-27). This repo is public on GitHub. On
// 2026-08-10 a test pasted a REAL z.ai key as a "pasted key" fixture (commit
// 7b40cde); an outside holder burned that account's quota and every reset card
// for 2.5 months before anyone noticed. The suite now fails on any credential-
// shaped literal in tracked files. Fixtures use the obvious fakes below.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PATTERNS = [
  ['z.ai API key', /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g],
  ['Anthropic key/token', /\bsk-ant-(?:api|oat|ort)\d{2}-[A-Za-z0-9_-]{20,}/g],
  ['Kimi coding key', /\bsk-kimi-[A-Za-z0-9]{24,}/g],
  ['OpenAI key', /\bsk-(?:proj-)?[A-Za-z0-9]{40,}/g],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
];
// Obvious fakes a fixture may use. Anything else matching a pattern fails.
const ALLOWED = new Set([
  '0123456789abcdef0123456789abcdef.FAKEtestKEY0000x',
]);
const isFake = (s) => ALLOWED.has(s) || /^0+\.|FAKE|fake|EXAMPLE|example|xxxx|XXXX|0123456789abcdef/.test(s);

test('no live credential literals in any tracked file', () => {
  const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
    .filter(f => !/\.(png|jpg|gif|ico|lock|tgz)$/.test(f) && !f.startsWith('node_modules/'));
  const hits = [];
  for (const f of files) {
    let src; try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const [kind, re] of PATTERNS) {
      for (const m of src.matchAll(re)) if (!isFake(m[0])) hits.push(`${f}: ${kind} (${m[0].slice(0, 8)}…)`);
    }
  }
  assert.deepEqual(hits, [], `credential-shaped literals found — use a FAKE fixture:\n${hits.join('\n')}`);
});

test('the guard actually catches a real-shaped key (canary)', () => {
  const sample = 'const k = "' + 'cfe7f0a84d9b4941' + '95f9785760889a7b.' + 'CzXESfxJjBx5N0QV' + '";';
  const re = PATTERNS[0][1];
  const m = [...sample.matchAll(re)].map(x => x[0]).filter(x => !isFake(x));
  assert.equal(m.length, 1);
});
