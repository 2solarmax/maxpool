#!/usr/bin/env node
// One-time migration: rewrite provider model ids in Claude Code transcripts so session
// restore stops warning "Session model glm-5.3 could not be restored".
//
// WHY (2026-09-12, reproduced): Claude Code reads the session model from the restored
// transcript's messages (`Vre(messages, …)` in the 2.1.269 binary); a provider id
// (glm-5.3 etc.) is not in its catalog, so every resume of a pre-fix conversation warns
// and falls back. The proxy-side echo fixes (v1.19.1/v1.19.2) stopped NEW contamination
// (no provider id in any transcript since 2026-08-27) but cannot repair history.
//
// The replacement is the model the CLI falls back to anyway — so behaviour is identical,
// minus the warning. Line-scoped regex, not JSON re-serialization: transcripts are
// JSONL and must keep every other byte intact.
import { readdirSync, readFileSync, writeFileSync, statSync, renameSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const FLAGS = new Set(argv.filter(a => a.startsWith('--')));
const ROOT = argv.find(a => !a.startsWith('--')) || join(process.env.HOME, '.claude', 'projects');
// Provider id prefix -> the id Claude Code substitutes on restore (matches the CLI's
// own fallback so nothing observable changes except the warning disappearing).
const REPLACEMENT = 'claude-opus-5';
const PATTERNS = [/"model":"glm-[\w.]+"/g, /"model":"kimi-[\w.]+"/g];
const DRY = FLAGS.has('--dry-run');
const BACKUP = FLAGS.has('--backup');

let files = 0, changed = 0, total = 0;
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!e.name.endsWith('.jsonl')) continue;
    files++;
    const src = readFileSync(p, 'utf8');
    let hits = 0;
    let out = src;
    for (const re of PATTERNS) out = out.replace(re, () => { hits++; return `"model":"${REPLACEMENT}"`; });
    if (!hits) continue;
    changed++; total += hits;
    if (!DRY) {
      if (BACKUP) writeFileSync(p + '.pre-glm-migration', src);
      writeFileSync(p, out);
    }
  }
}
walk(ROOT);
console.log(`${DRY ? '[dry-run] ' : ''}scanned ${files} transcripts, rewrote ${changed} (${total} model ids)${BACKUP && !DRY ? ', .pre-glm-migration sidecars kept' : ''}`);
