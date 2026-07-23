# 2026-07-23 — TUI UX batch + update reminder — DESIGNS (pre-mortem input)

Ground-truth read against `origin/main` == HEAD (55433d9 + uncommitted publish.yml fix). All items are TUI/UX from user feedback on v1.5.37. Files: `src/tui.js`, `src/index.js`, `src/updater.js` (existing, reused).

## U1 — Update reminder (warn users a new maxpool is available)
**Current state:** `maybeCheckForUpdate` runs ONCE at cold startup (index.js:1062-1068) → sets `accountManager.versionInfo = {current, latest, hasUpdate, checkedAt}`. The TUI header already shows a subtle `↑ vLATEST` (tui.js:967) when `hasUpdate`. Gaps: (a) startup-only — a long-lived session never notices a version published later; (b) the indicator is too subtle to "remind".
**Fix:**
1. **Periodic re-check** (index.js, in the same cold-start block, guarded by `!viaTakeover && !isReloadWorker`): `setInterval` (default 6h, env `MAXPOOL_UPDATE_CHECK_INTERVAL_MS`, unref'd, `clearInterval` on shutdown) re-running `maybeCheckForUpdate` → refreshes `versionInfo`. Notify (TUI log) ONLY when `latest` changes vs the last-notified (dedup wrapper) so it isn't spammy.
2. **Prominent banner** (tui.js `_render`): when `hasUpdate && latest`, push a dedicated yellow line right under the header divider: `↑ Update available: v<cur> → v<latest> · run: npm i -g maxpool (then press r)`. Keep the header showing the running `v<cur>`; move the nudge into the banner (drop the cramped header `↑ v` suffix so there's one clear reminder, not two).
Network-safe + opt-out already handled by `maybeCheckForUpdate` (`config.updateCheck === false`).

## A1 — Disabled status more visible
tui.js:1150 `case 'disabled': status = gray('disabled')` is too faint. Make it `red('✕ disabled')` and dim the account NAME on a disabled row (so the whole row reads "off"). Keep the status column width (STATUS_W=13 fits "✕ disabled").

## A2 — Consolidate the on/off toggle (one place)
`t` → `_startSelection('toggle')` is bound in BOTH `_keyNormal` (tui.js:438) and `_keyAccounts` (467) — the SAME enable/disable. Consolidate to the Accounts submenu (the home for all account mutations: login/key/rename/enable-disable/delete). Remove the top-level `t` handler + drop `t On/off` from the normal footer (tui.js:1313). Nothing else depends on the top-level binding.

## A3 — Cross-provider fallback (`f`) visibility
`f` IS wired (`_keyRouting`:485 → `_cycleCrossProviderPolicy` → `setCrossProviderFallbackPolicy` mutates + saves + logs). The change renders in the HEADER "Routing" line (far from the routing footer where the user presses `f`), and the `_addLog` confirmation is buried. Fix: (1) the routing footer shows the CURRENT policy inline so cycling visibly updates at the keypress: `f Cross-provider: <policy> ↻`; (2) accept `F` as well as `f` (bind both). No functional change to the cycle.

## A4 — Add-account (browser login) flood buries the prompt
`_doLogin` (tui.js:656) `this.stop()`s the TUI, then uses a raw `readline` prompt (`Name this NEW account […]`, line 672) on stdout — but the console-log mirror keeps teeing routing logs to stdout, burying the prompt (the "header missing / hung" report). Fix: wrap the interactive section in `setConsoleStdoutSuppressed(true)` … `false` (import from `event-log.js`; already used in index.js:700/1026). Logs still go to the event-log FILE; only the stdout flood is paused so the prompt is clean. Re-enable in `finally` so it's restored on any error/exit path.

## A7 — Widen the "Account" column ~30%
NAME_W 12 → 16 (fits fuller emails). Pure-function offsets shift: Provider 17→21, Status 27→31, Quota 41→45; update `tui-quota-render.test.js` assertions + the offset comment + the `bw` fixed-span constants (57→61 / 46→50). Truncation at NAME_W still applies to over-long names.

## A5 — new Claude account at bottom until restart — ALREADY FIXED (v1.5.38)
`_displayOrder()` (v1.5.38) sorts by provider on EVERY render, so a mid-session-added Claude account re-sorts into the Claude group live, no restart. No code change; verify + tell the user to update from 1.5.37.

## A6 — move account up/down — DEFERRED (offer)
Since `_displayOrder()` now groups by provider and routing is score-based (not list-order), list position is cosmetic-only; manual within-group reorder is a low-value nice-to-have that adds a persisted custom-order dimension conflicting with the provider sort. Deferred; offer to add if the user still wants manual within-group ordering.

## Also: release-notes CI fix (own-every-failure)
`publish.yml` checkout was shallow → `git describe --tags` empty → empty GitHub Release notes. Added `fetch-depth: 0` + `fetch-tags: true`. Backfilled v1.5.38 notes. Takes effect next release.
