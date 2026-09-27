#!/usr/bin/env python3
"""Normalize recorded model ids in Claude Code transcripts.

WHY: the CLI restores a resumed session's model by replaying the LAST assistant
message's `message.model` verbatim (`O(e,o)` in the 2.1.x binary). Two consequences:
  * an id the current build doesn't know (glm-5.3, served via the maxpool proxy)
    -> "Session model glm-5.3 could not be restored" + a cost-estimate warning
  * a superseded-but-known id (claude-opus-5) -> silently restores the OLDER model
    even when the session was started on claude-opus-5-5

Scope is deliberately narrow: only the fields the CLI reads as a model identity.
Chat CONTENT that merely mentions a model string is never touched.

Safety: skips files modified within --skip-recent-hours (live sessions), writes
via a temp file + atomic rename, and backs up every file it changes.
"""
import argparse, json, os, shutil, sys, time
from pathlib import Path

# Fields the CLI treats as a model identity (measured by walking every JSON path
# in the corpus whose leaf value was a known model id).
MODEL_PATHS = (
    ("message", "model"),
    ("advisorModel",),
    ("toolUseResult", "resolvedModel"),
    ("attachment", "identity", "modelId"),
    ("fallbackModel",),
)

DEFAULT_MAP = {
    "glm-5.3": "claude-opus-5-5",
    "glm-5-turbo": "claude-opus-5-5",
    "claude-opus-5": "claude-opus-5-5",
}


def rewrite_obj(obj, mapping, counter):
    """Rewrite known model-identity fields in place. Returns True if changed."""
    changed = False
    for path in MODEL_PATHS:
        cur = obj
        for key in path[:-1]:
            if not isinstance(cur, dict):
                cur = None
                break
            cur = cur.get(key)
        if not isinstance(cur, dict):
            continue
        leaf = path[-1]
        val = cur.get(leaf)
        if isinstance(val, str) and val in mapping:
            cur[leaf] = mapping[val]
            counter[(".".join(path), val)] += 1
            changed = True
    # message.usage.iterations[].model + message.content[].to.model are rare but real
    msg = obj.get("message")
    if isinstance(msg, dict):
        usage = msg.get("usage")
        if isinstance(usage, dict):
            for it in usage.get("iterations") or []:
                if isinstance(it, dict) and it.get("model") in mapping:
                    counter[("message.usage.iterations[].model", it["model"])] += 1
                    it["model"] = mapping[it["model"]]
                    changed = True
        for blk in msg.get("content") or []:
            if isinstance(blk, dict):
                to = blk.get("to")
                if isinstance(to, dict) and to.get("model") in mapping:
                    counter[("message.content[].to.model", to["model"])] += 1
                    to["model"] = mapping[to["model"]]
                    changed = True
    return changed


def process(path, mapping, counter, apply, backup_root):
    """Stream one .jsonl; rewrite only lines that actually contain a mapped id."""
    hits = 0
    out_lines = []
    with open(path, "r") as f:
        for line in f:
            if not any(f'"{k}"' in line for k in mapping):
                out_lines.append(line)
                continue
            stripped = line.strip()
            if not stripped:
                out_lines.append(line)
                continue
            try:
                obj = json.loads(stripped)
            except Exception:
                # Never drop a line we cannot parse — carry it through verbatim.
                out_lines.append(line)
                continue
            if rewrite_obj(obj, mapping, counter):
                hits += 1
                out_lines.append(json.dumps(obj, ensure_ascii=False) + "\n")
            else:
                out_lines.append(line)
    if hits and apply:
        rel = os.path.relpath(path, os.path.expanduser("~/.claude/projects"))
        bak = Path(backup_root) / rel
        bak.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, bak)
        tmp = str(path) + ".normalize.tmp"
        with open(tmp, "w") as f:
            f.writelines(out_lines)
        shutil.copystat(path, tmp)
        os.replace(tmp, path)
    return hits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--skip-recent-hours", type=float, default=3.0,
                    help="leave files modified this recently alone (live sessions)")
    ap.add_argument("--root", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--backup-root", default=None)
    ap.add_argument("--only-unknown", action="store_true",
                    help="map only ids the CLI cannot resolve (glm-*), leaving opus-5 intact")
    args = ap.parse_args()

    mapping = dict(DEFAULT_MAP)
    if args.only_unknown:
        mapping.pop("claude-opus-5", None)

    backup_root = args.backup_root or os.path.expanduser(
        "~/.claude/backups/transcript-model-normalize-" + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    cut = time.time() - args.skip_recent_hours * 3600

    import collections
    counter = collections.Counter()
    files_changed = skipped = scanned = 0
    for path in sorted(Path(args.root).glob("*/*.jsonl")):
        scanned += 1
        if path.stat().st_mtime > cut:
            skipped += 1
            continue
        if process(path, mapping, counter, args.apply, backup_root):
            files_changed += 1

    mode = "APPLIED" if args.apply else "DRY RUN"
    print(f"[{mode}] scanned={scanned} skipped_recent={skipped} files_with_hits={files_changed}")
    for (field, old), n in sorted(counter.items(), key=lambda kv: -kv[1]):
        print(f"  {n:8d}  {field:38s} {old} -> {mapping[old]}")
    if args.apply and files_changed:
        print(f"backup: {backup_root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
