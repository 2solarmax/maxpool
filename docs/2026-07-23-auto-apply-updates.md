# 2026-07-23 — Auto-apply updates (fully-automatic, seamless self-reload) — DESIGN (pre-mortem input)

**User decision:** "fully automatic" — maxpool should DOWNLOAD *and* APPLY new versions itself, via the seamless zero-downtime reload (sessions survive). Files: `src/updater.js`, `src/index.js`. New config flag `autoApply` (opt-in, default false — auto-restart stays opt-in for everyone else; set true in the user's config).

## Current state (v1.5.39)
- Periodic timer (index.js, unconditional worker body, 6h) → `maybeCheckForUpdate(config, autoNotify, onVersionInfo)`. With `autoUpdate:true` (the user has it) this already runs `selfUpdate()` = `npm i -g maxpool@latest` → downloads the new version to disk. It does NOT reload, so the running process stays old until a manual `r`.
- The reload is triggered by `restartController.requestRestart()` (same path the TUI `r`→onRestart uses).
- **Reload-storm guard STAYS:** the startup check is reload-guarded (`!viaTakeover && !isReloadWorker`) so a reload worker never self-installs — this prevents TWO concurrent `npm i -g` (global-package corruption). Auto-apply does NOT touch this; the self-install only ever runs in the single primary worker (startup one-shot + periodic timer), never during a reload overlap.

## The version-tracking trap
`getCurrentVersion()` reads `../package.json` FROM DISK. After `selfUpdate()` rewrites the global package, that file is the NEW version — but the RUNNING code is still old. So post-install, `getCurrentVersion()` != the running version. hasUpdate (and any loop guard) must key on the **running** version, captured ONCE before any self-install.

## Design
**updater.js:**
1. Cache the running version once: module-level `let _bootVersion`; on first `maybeCheckForUpdate`, `_bootVersion = await getCurrentVersion()` (== running, since no self-install has happened yet). Use `_bootVersion` as `current` for hasUpdate — so the banner stays accurate after a background self-install, until the reload.
2. `maybeCheckForUpdate` RETURNS a result: `{ hasUpdate, applied:false, selfUpdated, installedVersion }`.
3. After a successful `selfUpdate()`, re-read `getCurrentVersion()` FRESH (disk, post-install) as `installed`; set `selfUpdated=true` ONLY if `compareVersions(installed, _bootVersion) > 0` (the install actually ADVANCED past the running version). This is the loop guard: a broken install (npm "ok" but version unchanged) → `selfUpdated=false` → no reload → no loop (just a retry-next-check notice).

**index.js (both the startup one-shot AND the periodic timer):**
4. `const r = await maybeCheckForUpdate(config, notify, onVersionInfo);` then: `if (r?.selfUpdated && config?.autoApply) restartController?.requestRestart();` with a log "Applying update — reloading…". The seamless reload spawns a new worker that loads the freshly-installed on-disk version; the existing "⟳ Restarting — draining N…" banner shows during the drain, so the user sees it self-updating.

## Loop safety (the critical property)
- Happy path: periodic → selfUpdate installs vNext to disk → `installed(vNext) > running(vCur)` → reload → new worker boots as vNext → its `_bootVersion=vNext`, next check `latest==vNext` → hasUpdate false → no self-install, no reload. **Terminates.**
- The reloaded worker is a reload worker (`viaTakeover`) → the reload-guard skips ITS startup check entirely → no self-install on the just-applied worker. No double-apply.
- Broken install (version never advances) → `selfUpdated=false` → no reload → notice only. No reload loop (worst case: a 6h-cadence "didn't advance" notice).
- Concurrent install: unchanged — self-install only in the single primary worker; the reload-guard still bars the reload worker. No two `npm i -g` at once.

## Config / rollout
- `autoApply` opt-in (default false in code). Set `autoApply:true` in the user's config now (harmless on 1.5.39; active once on 1.5.40).
- Transition: 1.5.39 auto-downloads 1.5.40 → user presses `r` ONCE to land on 1.5.40 (which has the auto-apply code) → from then on, fully automatic (downloads + self-applies).

## Startup auto-apply UX
On a cold start where you're behind: startup check → self-install → auto-apply reload → new worker (reload-guarded, no re-check) runs the new version. One brief self-reload at launch; the user opted into fully-automatic. Acceptable + desired.
