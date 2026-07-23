---
name: maxpool-builder
description: Pick up and maintain this repo's project memory. Invoke at the START of a work session to load full context (CLAUDE.md + docs/CONTEXT.md + unreleased commits), and to APPEND decisions/changes to docs/CONTEXT.md as they happen, and at WRAP-UP to leave the memory current for the next session. Use when the user says "catch up", "where were we", "log this decision", "update context", or "wrap up".
---

# Project-memory builder

Keeps a fresh Claude Code session productive on this repo by making the project
memory a living thing: read it in, keep it current, hand it off. The mechanics
below are **project-agnostic** — they operate on *this repo's* files, so this
skill is also the reusable seed for standing the same harness up in another repo
(see "Reuse in another project" at the end).

The two backing stores:
- **`CLAUDE.md`** — durable facts + hard invariants. Always loaded. Rarely changes.
- **`docs/CONTEXT.md`** — living state + append-only decision log. Changes often.

## START of a session — load context

A SessionStart hook already injects the memory head, but on any non-trivial task
confirm the full picture:

1. Read **`CLAUDE.md`** (facts + invariants you must not break).
2. Read **`docs/CONTEXT.md`** — the **Current focus** and the top few **Decisions**.
3. Check what changed but isn't released: `git log $(git describe --tags --abbrev=0)..HEAD --oneline`.
4. If anything in the code contradicts the memory, trust the code and fix the
   memory (a stale note is worse than none) — then note the correction.

State back, in one or two lines, where things stand before you start.

## DURING work — append as you go (the load-bearing habit)

The memory only works if it's written **the moment a decision is made or a change
ships**, in-thread — not saved for "the end," which gets skipped. After each:

- a **decision** (an approach chosen, a trade-off settled, a constraint accepted), or
- a **shipped change** (merged/released/deployed),

append a dated entry to the top of `docs/CONTEXT.md`'s **Decisions** section:

```markdown
### YYYY-MM-DD · #N — <short title>

**Context:** <why this came up>
**Decision:** <what was decided/done>
**Consequences:** <what it means going forward; files touched>
```

Rules: newest on top; numbers increase; never delete an entry — if something is
reversed, add a new one that says "supersedes #N". Keep **Current focus**
overwritten to reflect *now* (it's not a log — it's the single current state).

## WRAP-UP — leave it clean for the next session

Before ending a work session:

1. **Current focus** in `docs/CONTEXT.md` reflects reality (what's active/next).
2. Every decision and shipped change this session has a Decisions entry.
3. If `docs/CONTEXT.md` is past ~400 lines, move the oldest resolved decisions to
   `docs/CONTEXT-ARCHIVE.md` and leave a one-line pointer.
4. Commit the memory changes with the work (or on their own) so they persist.

## Guardrails

- Respect `CLAUDE.md`'s hard invariants (release pipeline, low-profile posture).
- Don't inline large files (e.g. `docs/open-issues.md`) into the memory — point
  to them.
- This skill runs **inline in the thread** (it is not a subagent); it edits the
  memory directly.

## Reuse in another project

To give another repo the same harness, this skill is the template:

1. Copy `.claude/skills/maxpool-builder/` into the other repo (rename the folder +
   the `name:` in frontmatter if you want a project-specific handle).
2. Copy `.claude/settings.json` + `.claude/hooks/session-start-context.sh`.
3. Create that repo's `CLAUDE.md` (its durable facts + invariants) and a seed
   `docs/CONTEXT.md` (empty Current focus + Decisions sections).
4. Ensure `.claude/settings.local.json` is gitignored (personal overrides) while
   `.claude/settings.json` is committed (shared).

The body above needs no edits — it already refers to "this repo." Only the two
memory files carry project specifics. Once a second project uses this, consider
promoting it to a Claude Code plugin so installs are one command (a plugin ships
its context as a skill — a plugin's own CLAUDE.md is not auto-loaded).
