// One private, config-specific directory per armed run. An admission claims one
// numbered slot before any forwarding. mkdir is exclusive across overlapping workers
// during a seamless reload. A crashed or aborted admission stays charged.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readlink, rename, rm, symlink, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { getConfigPath } from './config.js';

const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const usage = 'maxpool session-cap arm <terminal-uuid> <0..100> [--caller NAME] | status|disarm <terminal-uuid> [--caller NAME]';

function pointer(root, session, caller) {
  const owner = createHash('sha256').update(JSON.stringify(caller ?? null)).digest('hex');
  return join(root, owner + '-' + session.toLowerCase());
}

async function current(link) {
  try {
    const run = await readlink(link);
    const match = /^run-(\d+)-[A-Za-z0-9]+$/.exec(run);
    if (!match) throw new Error('Invalid session cap record');
    return { name: run, limit: Number(match[1]) };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function snapshot(root, run) {
  if (!run) return { armed: false };
  const entries = await readdir(join(root, run.name));
  const admitted = entries.filter(name => name.startsWith('used-')).length;
  return { armed: true, limit: run.limit, admitted, remaining: run.limit - admitted, blocked: entries.includes('blocked') };
}

export function sessionCapRoot() {
  return getConfigPath() + '.session-caps';
}

export async function admitSessionRequest(root, session, caller) {
  if (!uuid.test(session)) return true;
  const run = await current(pointer(root, session, caller));
  if (!run) return true;
  const dir = join(root, run.name);
  const usage = await snapshot(root, run);
  for (let i = usage.admitted; i < run.limit; i++) {
    try {
      await mkdir(join(dir, 'used-' + i), { mode: 0o700 });
      return true;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // Another worker claimed this slot after the directory read.
    }
  }
  try {
    await mkdir(join(dir, 'blocked'), { mode: 0o700 });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
  return false;
}

export async function sessionCapCommand(args, root = sessionCapRoot()) {
  const [action, session] = args;
  const rest = args.slice(action === 'arm' ? 3 : 2);
  const caller = rest.length === 2 && rest[0] === '--caller' && rest[1] ? rest[1] : null;
  if (!uuid.test(session) || (rest.length && !caller)) throw new Error(usage);
  const link = pointer(root, session, caller);
  if (action === 'status') return snapshot(root, await current(link));
  if (action === 'arm') {
    const count = args[2];
    if (!/^(?:0|[1-9]\d?|100)$/.test(count)) throw new Error(usage);
    const limit = Number(count);
    await mkdir(root, { mode: 0o700, recursive: true });
    const dir = await mkdtemp(join(root, 'run-' + limit + '-'));
    try {
      // Publish only the fully prepared run; arming twice must never refill it.
      await symlink(basename(dir), link);
    } catch (err) {
      await rm(dir, { recursive: true, force: true });
      if (err.code === 'EEXIST') throw new Error('Session cap already armed; disarm it first');
      throw err;
    }
    return { armed: true, limit, admitted: 0, remaining: limit, blocked: false };
  }
  if (action === 'disarm') {
    const retired = join(root, 'retired-' + randomUUID());
    try {
      await rename(link, retired);
    } catch (err) {
      if (err.code === 'ENOENT') return { armed: false };
      throw err;
    }
    const run = await current(retired);
    await rm(join(root, run.name), { recursive: true, force: true });
    await unlink(retired);
    return { armed: false };
  }
  throw new Error(usage);
}
