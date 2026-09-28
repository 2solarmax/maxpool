#!/usr/bin/env python3
"""Normalize recorded model ids in Claude Code transcripts to FAMILY ALIASES.

THE BUG
-------
Claude Code restores a resumed session's model by replaying the LAST assistant
message's `message.model` verbatim (`O(e,o)` in the 2.1.x binary). So:
  * an id the build doesn't know (glm-5.3, served via the maxpool proxy)
    -> "Session model glm-5.3 could not be restored (...) - using X instead."
  * a superseded-but-known id (claude-opus-5) -> silently restores the OLDER
    model, even for a session that was started on the newest Opus.

WHY A CONCRETE PIN, NOT A FAMILY ALIAS
-------------------------------------
The CLI does accept family aliases (`opus`, `opus[1m]`, ...) and resolves them
to the newest model at runtime -- but for a 1M session the alias LOSES the 1M
window. `O()` re-appends the [1m] suffix only when the last model ATTACHMENT's
base id matches the restored model's base id, and an alias attachment
("opus[1m]") fails that match (verified empirically: alias-pair fixture resumed
and wrote a BARE claude-opus-5-5 attachment -- 200k, silent; concrete-pair
fixture preserved claude-opus-5-5[1m]). So: pinned concrete ids, re-run this
sweep when a new Opus ships (it is idempotent and takes ~4 minutes).
Aliases are used ONLY in display-only fields where the CLI never re-derives
the context window from them.

THE [1m] VARIANT MATTERS
-----------------------
`O()` re-appends the 1M-context suffix only when the last model ATTACHMENT's
base id matches the restored model's base id. Mapping `claude-opus-5[1m]` to a
bare id therefore silently downgrades a 1M session to 200k. Suffixed ids map to
suffixed aliases so the pairing survives.

SCOPE
-----
Only fields the CLI reads as a model identity. Chat CONTENT that merely
mentions a model string is never touched. Walks the store RECURSIVELY --
subagent and workflow transcripts live in nested dirs and outnumber top-level
session files ~30:1.

SAFETY
------
Dry run by default; skips files modified within --skip-recent-hours (live
sessions); backs up every file it changes; writes via temp file + atomic
rename; carries unparseable lines through verbatim; idempotent (alias targets
are never themselves mapping keys).
"""
import argparse, collections, json, os, shutil, sys, time
from pathlib import Path

# Model-identity field paths, measured by walking every JSON path in the store
# whose leaf value was a known model id.
SIMPLE_PATHS = (
    ("message", "model"),
    ("advisorModel",),
    ("originalModel",),
    ("fallbackModel",),
    ("toolUseResult", "resolvedModel"),
    ("attachment", "identity", "modelId"),
    ("attachment", "model"),
    # `type:"progress"` rows wrap a whole nested assistant message.
    ("data", "message", "message", "model"),
)

# Concrete ids -> concrete target. Update TARGET when a new Opus ships, then
# re-run (idempotent). [1m] variants are generated suffix-to-suffix so the
# 1M-context pairing survives.
def detect_latest_opus(default="claude-opus-5-5"):
    """Ask the INSTALLED CLI binary which Opus is newest, so this tool does not
    need a manual edit when the next one ships. Falls back to `default` if the
    binary cannot be read (the caller can always pass --target)."""
    import glob, re, subprocess
    versions = sorted(glob.glob(os.path.expanduser(
        "~/.local/share/claude/versions/*")), key=os.path.getmtime)
    if not versions:
        return default
    try:
        out = subprocess.run(["strings", "-a", versions[-1]],
                             capture_output=True, text=True, timeout=180).stdout
    except Exception:
        return default
    found = set(re.findall(r"claude-opus-(\d+)-(\d+)(?![\d-])", out))
    if not found:
        return default
    major, minor = max((int(a), int(b)) for a, b in found)
    return f"claude-opus-{major}-{minor}"


TARGET = detect_latest_opus()
BASE_MAP = {
    "glm-5.3": TARGET,
    "glm-5.2": TARGET,
    "glm-5.1": TARGET,
    "glm-5-turbo": TARGET,
    "claude-opus-5": TARGET,
}


def build_map(_unused=None):
    """Concrete -> concrete, with the 1M-context variants paired suffix-to-suffix."""
    mapping = {}
    for old, new in BASE_MAP.items():
        mapping[old] = new
        mapping[f"{old}[1m]"] = f"{new}[1m]"
    return mapping


def _rewrite_leaf(container, key, mapping, counter, label):
    val = container.get(key)
    if isinstance(val, str) and val in mapping:
        container[key] = mapping[val]
        counter[(label, val)] += 1
        return True
    return False


def rewrite_obj(obj, mapping, counter):
    """Rewrite model-identity fields in place. Returns True if anything changed."""
    changed = False
    for path in SIMPLE_PATHS:
        cur = obj
        for key in path[:-1]:
            if not isinstance(cur, dict):
                cur = None
                break
            cur = cur.get(key)
        if isinstance(cur, dict):
            changed |= _rewrite_leaf(cur, path[-1], mapping, counter, ".".join(path))

    # List-valued shapes, in both the top-level and progress-wrapped positions.
    for msg in (obj.get("message"),
                (obj.get("data") or {}).get("message", {}).get("message")
                if isinstance(obj.get("data"), dict) else None):
        if not isinstance(msg, dict):
            continue
        usage = msg.get("usage")
        if isinstance(usage, dict):
            for it in usage.get("iterations") or []:
                if isinstance(it, dict):
                    changed |= _rewrite_leaf(it, "model", mapping, counter,
                                             "message.usage.iterations[].model")
        for blk in msg.get("content") or []:
            if isinstance(blk, dict) and isinstance(blk.get("to"), dict):
                changed |= _rewrite_leaf(blk["to"], "model", mapping, counter,
                                         "message.content[].to.model")
    return changed


def process(path, mapping, counter, apply, backup_root, root):
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
                out_lines.append(line)   # never drop a line we cannot parse
                continue
            if rewrite_obj(obj, mapping, counter):
                hits += 1
                out_lines.append(json.dumps(obj, ensure_ascii=False) + "\n")
            else:
                out_lines.append(line)
    if hits and apply:
        bak = Path(backup_root) / os.path.relpath(path, root)
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
    ap.add_argument("--target", default=None,
                    help="override the auto-detected newest Opus id")
    ap.add_argument("--only-unknown", action="store_true",
                    help="map only ids the CLI cannot resolve (glm-*)")
    args = ap.parse_args()

    if args.target:
        for k in list(BASE_MAP):
            BASE_MAP[k] = args.target
    mapping = build_map()
    print(f"target model: {args.target or TARGET}"
          f"{'' if args.target else ' (auto-detected from the installed CLI)'}")
    if args.only_unknown:
        mapping = {k: v for k, v in mapping.items() if k.startswith("glm-")}

    backup_root = args.backup_root or os.path.expanduser(
        "~/.claude/backups/transcript-model-normalize-"
        + time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()))
    cut = time.time() - args.skip_recent_hours * 3600

    counter = collections.Counter()
    files_changed = skipped = scanned = 0
    for path in sorted(Path(args.root).rglob("*.jsonl")):
        scanned += 1
        try:
            if path.stat().st_mtime > cut:
                skipped += 1
                continue
            if process(str(path), mapping, counter, args.apply, backup_root, args.root):
                files_changed += 1
        except FileNotFoundError:
            continue

    mode = "APPLIED" if args.apply else "DRY RUN"
    print(f"[{mode}] scanned={scanned} skipped_recent={skipped} files_with_hits={files_changed}")
    for (field, old), n in sorted(counter.items(), key=lambda kv: -kv[1]):
        print(f"  {n:8d}  {field:38s} {old} -> {mapping[old]}")
    if args.apply and files_changed:
        print(f"backup: {backup_root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
