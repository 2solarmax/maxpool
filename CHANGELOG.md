# Changelog

All notable changes to maxpool are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.5.39] - 2026-07-23

### Added

- Update reminder + visible disabled + cross-provider footer + wider name + login-flood fix

### Documentation

- Note restart drain-count semantics; open-issues #46

### Fixed

- Live 'Restarting — draining N…' feedback on R→Yes (no more frozen screen) + dedup teardown

## [1.5.38] - 2026-07-23

### Changed

- Build release notes from commit log, not PRs
- Generate in-repo CHANGELOG.md from commits via git-cliff
- Add project-context + self-updating memory harness
- Address code-review nits — extract+test grace callback, warmup-pull hot-path short-circuit, doc refresh

### Documentation

- Mark release-hygiene + builder harness shipped; npm 2FA done

### Fixed

- Streaming idle-timeout keep-alive + TUI provider column/order + warmup-pull for mid-session-added accounts

## [1.5.37] - 2026-07-23

### Changed

- Auto-create a GitHub Release per version tag (best-practice release notes)

### Fixed

- Cap count_tokens queue wait low so it fast-fails instead of hanging past the client idle window

## [1.5.36] - 2026-07-22

### Fixed

- Disable Nagle on client sockets to smooth SSE streaming
- Provider 403 → recoverable cooldown, not a permanent disable

## [1.5.35] - 2026-07-20

### Added

- Provider-routing visibility — session-tagged log lines + overflow indicator

## [1.5.34] - 2026-07-20

### Fixed

- Active ► marks accounts SERVING now in automatic mode, not last-routed

## [1.5.33] - 2026-07-20

### Changed

- Npm Trusted Publishing via GitHub Actions (OIDC, no token)

### Fixed

- Stale marker honors response-header freshness; label the footer legend

## [1.5.32] - 2026-07-19

### Fixed

- De-burst OAuth usage probes so weekly quota actually refreshes
- Let long streams survive reload; expose on/off toggle; drop dead-account probe echo

## [1.5.31] - 2026-07-15

### Fixed

- Activity header shows "N in-flight · M sessions" (was "N active", misread as sessions)

## [1.5.30] - 2026-07-15

### Fixed

- Keep image requests off Kimi (Moonshot 400s on images GLM/Anthropic accept)

## [1.5.29] - 2026-07-14

### Fixed

- Reauth-persist confirm log, header footer, idle-keyed reaper, reload-rollback self-heal

## [1.5.28] - 2026-07-13

### Added

- Zero-downtime TUI reload — no more ECONNREFUSED on r/reload

### Fixed

- Bound the client backpressure await → stop the phantom "N active" leak

## [1.5.27] - 2026-07-13

### Fixed

- Persist fresh re-auth token to disk (was dead on next restart) + aligned column header

## [1.5.26] - 2026-07-12

### Fixed

- Persist rotated refresh token before serving on it + fingerprint audit trail

## [1.5.25] - 2026-07-11

### Changed

- Make the browser-login flow clearly show re-auth vs add-new

## [1.5.24] - 2026-07-11

### Fixed

- Stop the 60s retry storm on a dead (invalid_grant) refresh token

## [1.5.23] - 2026-07-11

### Fixed

- In-flight lease LEAK (106 phantom active) + Kimi coding-plan quota

## [1.5.22] - 2026-07-10

### Fixed

- Align provider rows with OAuth + honest quota placeholders; de-flake reload test

## [1.5.21] - 2026-07-10

### Fixed

- Persist runtime fallback providers so glm/kimi survive a restart

## [1.5.20] - 2026-07-09

### Fixed

- Clear a healed network blip's lastError so it stops showing as a phantom Err

## [1.5.19] - 2026-07-09

### Fixed

- Use computed `fam` in incompat-session message (kills no-unused-vars)

## [1.5.18] - 2026-07-09

### Fixed

- Rebalance a bound session off a near-cap weekly account (reserve band)

## [1.5.17] - 2026-07-08

### Fixed

- Provider Ses/Wk bars, real Fable %, sticky reactive-429, staleness marker

## [1.5.16] - 2026-07-08

### Fixed

- Narrow cross-provider pinning — Kimi/GLM sessions CAN use Claude (react-and-heal)

## [1.5.15] - 2026-07-08

### Added

- Cross-provider session pinning — a GLM/Kimi session never routes to Claude (fixes the srvtoolu_ 400 on cc-all resume)

## [1.5.14] - 2026-07-05

### Fixed

- A per-model (Fable) rejection blocked the WHOLE account (display + routing)

## [1.5.13] - 2026-07-04

### Fixed

- Interactive `r` restart hung blank — supervisor respawned worker with a dead socket

## [1.5.12] - 2026-07-04

### Fixed

- Per-model (Fable) weekly-cap awareness — balance a capped model to headroom accounts instead of failing

## [1.5.11] - 2026-07-04

### Fixed

- HOLD streaming requests through temporary throttles instead of failing them; TUI shows rejected accounts as blocked

## [1.5.10] - 2026-07-03

### Changed

- Revert-to-issuer thinking-signature fail-safe + flip flag ON
- End-to-end proof restart-with-in-flight completes bounded + comes back

## [1.5.9] - 2026-07-02

### Added

- Pace-based rebalance trigger + flag for cross-account thinking migration

## [1.5.8] - 2026-07-02

### Fixed

- Bound the pre-restart drain so 'r' can't hang forever

## [1.5.7] - 2026-07-02

### Documentation

- Record #12 macOS sleep-guard — overnight terminated→503 was Maintenance Sleep (v1.5.6)

### Fixed

- Probe on by default + never prefer blind accounts

## [1.5.6] - 2026-07-01

### Added

- Keep macOS awake while serving so overnight streams survive Maintenance Sleep

### Documentation

- Record #11 persistent event log + connectivity watcher (v1.5.5)

## [1.5.5] - 2026-06-30

### Added

- Persistent rotating event log so incidents are investigable

### Documentation

- Record #10 terminal-close orphan + TUI-on-reload fix (v1.5.4)

## [1.5.4] - 2026-06-29

### Documentation

- Record #9 network-outage auto-recovery fix (v1.5.3)

### Fixed

- Clean shutdown on terminal close + restore TUI on interactive reload

## [1.5.3] - 2026-06-29

### Fixed

- Network-class failures use a short fixed cooldown → auto-recover after an outage

## [1.5.2] - 2026-06-27

### Documentation

- Record #7 signed-thinking FIFO-queue error-kill fix (v1.5.1)
- Close #1 Phase 3 — premise didn't survive a code read (global pause is veto-gated, not single-429)

### Fixed

- Hold a thinking session through a network blip instead of error-killing it

## [1.5.1] - 2026-06-27

### Documentation

- Mark #3 import-removal DONE (was stale; shipped in b6353fa)

### Fixed

- Hold a signed-thinking session behind the FIFO queue, never error-kill it

## [1.5.0] - 2026-06-27

### Added

- Near-zero-downtime reload via supervisor-owns-socket + single-writer baton

### Changed

- Cover baton, single-writer, gen guard, drain, rollback, TTY, storm
- Partial blocker/major fixes from code review — INCOMPLETE, DO NOT SHIP
- B2 asserts the no-parent-swallow invariant (no hang + every served response worker-stamped), not a brittle 200/200 throughput count that flaked under concurrent-subprocess contention
- Run files serially (--test-concurrency=1) so subprocess-heavy reload tests don't contend
- Per-file process isolation + fail-fast caps so the reload suite doesn't wedge under resource pressure
- Guard the child exit-wait so cleanup cannot hang forever
- Extract M4 (state-generation) into its own file for a fresh process
- Drop the SIGUSR2 self-kill from M4 (it terminated the supervisor)

### Documentation

- Mark #1 Phase 2 safe-point rebalancing DONE (shipped v1.4.0); herd-jitter tracked as Phase 3
- #6 re-integrated onto main (feat/reload-reintegrate, clean merge); 6 must-fixes + brick-safety council remain before ship
- #6 RE-ASSESSED — product done + brick-safety torture test PROVEN green; real blocker is integration-test contention flakiness, not missing must-fixes
- #6 deep-dive — brick-safety proven, suite made reliable, SIGUSR2 self-kill fixed; single residual = M4 state-generation advancement (product-vs-test call)

### Fixed

- Force the final quota flush on baton-release + graceful-shutdown (was a silent no-op)
- Forced final flush bypasses the cross-worker generation guard (review nit)

## [1.4.0] - 2026-06-27

### Added

- #1 safe-point session rebalancing — drain a bound session off a hot account onto fresh capacity

### Documentation

- Mark #5 TUI clarity DONE (shipped v1.3.1)

## [1.3.1] - 2026-06-27

### Added

- #5 clarity — throttled countdown + clearer 'Now' load label

### Fixed

- Bound throttled countdown to single-unit so multi-hour cooldowns don't shift the column

## [1.3.0] - 2026-06-27

### Added

- Remove the import mechanic — browser login only (issue #3)
- Hold the session indefinitely on rate-limit + raw-weekly routing consistency (issue #2)

### Documentation

- Log issue #6 (seamless/graceful version upgrade — draining restart + zero-downtime)
- #6 pre-mortem outcome — drop symmetric overlap (bricks accounts), adopt single-writer baton
- Mark #2 hold-session+routing DONE (shipped v1.3.0)

### Fixed

- Hold streaming sessions on weekly-critical; ghost-only eviction; routing on raw weekly state
- Surface SOON short-term recovery for weekly-critical accounts; real bug-A red-green
- Clear stale queueAdmitted on re-queue; min-merge weekly buckets; pin reapDead
- Re-hold session on post-resume failover; bounded weekly-critical hold; 3-way min-merge
- Terminal status before weekly-critical; clear queueAdmitted post-acquire; dead-code
- Release lease on client-disconnect; concurrency-cap holds finite; frame non-SSE resume; catch EPIPE ghost
- Focused-review follow-ups on c77c9ed (listener leak, concurrency-cap window, hardening)

## [1.2.0] - 2026-06-26

### Added

- Spread-to-stay-healthy — concurrency dominant, raw-weekly gate (issue #1 phase 1)

### Documentation

- Track open issues + core routing philosophy (spread-to-stay-healthy)
- Log issue #5 (TUI clarity — throttled countdown + Load label)

## [1.1.0] - 2026-06-26

### Added

- Wait-don't-error on rate limits; weekly caps queue too

## [1.0.7] - 2026-06-25

### Documentation

- Prominent account-risk + Anthropic ToS disclaimer

## [1.0.6] - 2026-06-25

### Documentation

- Recommended alias-based setup (keep normal claude separate) + FAQ

## [1.0.5] - 2026-06-25

### Added

- Active-account indicator in automatic mode + browser login + rename

## [1.0.4] - 2026-06-25

### Added

- TUI account+routing management, rate-based balancing, resilient errors
- Persist learned quota across restarts (state file)
- Opt-in background quota probe (zero message spend)
- Startup update check + opt-in auto-update + release.sh pipeline

### Changed

- Update screenshot with better example
- Add OAuth token capture and refresh proxy support
- Substitute current account's refresh token in intercepted token renewals
- Fix token capture overwriting wrong account on refresh
- Atomic config saves, account sync, and TUI improvements
- Fix one-shot commands not exiting due to fetch keep-alive
- Update screenshot with new progress bar showing time until reset
- Update README: promote OAuth login, document new features
- Fetch profile on TUI import, use spawnSync for run command
- Allow pasting authorization code during OAuth login
- Fix stale active requests in TUI when forwardRequest throws
- Wait and retry on 429 instead of switching accounts
- Fix stale active requests when client disconnects mid-stream
- Reload also refreshes credentials for existing accounts
- Fix imported tokens becoming unusable after re-import
- Fix removed accounts reappearing after saveConfig
- Normalize expires_at from seconds to milliseconds
- Auto-recover accounts from transient network errors
- Use exponential backoff for transient error recovery (1s–32s)
- Drop connection on transient network errors instead of retrying
- Fix token rotation bugs causing refresh tokens to be lost
- Update README to reflect current project state
- Clarify token refresh only happens when nearing expiry
- Add --json flag to import command for inline credential input
- Switch to account with soonest-expiring weekly limit
- Add package-lock.json to .gitignore
- Probe accounts with unknown weekly quota, then re-evaluate
- Reset display instantly when a quota window expires
- Start accounts in probing mode
- Switch on session reset to a sooner-expiring weekly account
- Add adaptive account load balancing
- Use localhost OAuth redirect
- Avoid Claude auth conflict in env output
- Add GLM and Kimi fallback profile
- Queue requests when all routes are unavailable
- Show provider fallback telemetry
- Parse provider rate limit error bodies
- Add rolling load telemetry view
- Add sticky session routing and graceful shutdown
- Add weekly-aware routing and network error handling
- Fix provider auth and quota telemetry
- Record provider rate limits in telemetry
- Protect signed thinking sessions from provider fallback
- Improve queueing for long-running agents
- Allow weekly critical accounts as last resort
- Fix weekly quota display and pacing
- Add native TUI server restart
- Harden TUI restart relaunch
- Queue large preflight requests
- Rebrand to maxpool + publishing prep

### Fixed

- Recover temporary OAuth refresh failures
- Keep restarted TUI attached to terminal
- Avoid listener gap during restart drain
- Self-heal shared Anthropic throttling
- Make overload recovery and restart deterministic
- Fail over before declaring Anthropic outage
- Complete honest no-route message + review findings
- Drop a restored quota utilization that has no reset window
- Identity-restore test needs a reset window now that bare utilization is dropped
- Fall back to macOS Keychain when ~/.claude/.credentials.json is absent
- Bound shutdown drain to 15s so q/Ctrl-C/SIGTERM quits under a flood
- Read legacy x-teamclaude-* headers as fallback for x-maxpool-*

## [1.0.1] - 2026-03-24

### Changed

- Initial implementation of TeamClaude multi-account proxy
- Add CLI with subcommands and auto-config
- Create FUNDING.yml
- Add TUI dashboard for server mode
- Fix ZlibError and auth conflict with Claude Code
- Revert auth to simple proxy key check, restore ANTHROPIC_API_KEY
- Add --log-to for full request/response logging
- Use underscore between date and time in log filenames
- Support unified rate limits (Claude Max session/weekly quotas)
- Fix OAuth endpoints for login and token refresh
- Add interactive login menu, use full OAuth scopes
- Only show login menu on TTY, default to OAuth otherwise
- Fix OAuth client_id, add state param, match Claude Code flow
- Fix token exchange: use form-urlencoded, not JSON
- Fix OAuth token endpoint to console.anthropic.com
- Fix OAuth token endpoint to console.anthropic.com/v1/oauth/token
- Fix token exchange: use JSON format, include state parameter
- Fix process hanging after successful OAuth login
- Add 'teamclaude api' command for testing API endpoints
- Auto-name accounts from profile, deduplicate by UUID
- Enhance 'teamclaude accounts' to show live profile info
- Auto-cleanup duplicates and update account info on 'accounts'
- Add 'teamclaude check' to probe quota for all accounts
- Fix check command: use Bearer auth for OAuth accounts
- Handle token refresh properly
- Coalesce concurrent token refreshes per account
- Remove check command and 401 refresh-retry
- Redirect to platform.claude.com success page after OAuth callback
- Add README with screenshot and usage documentation
- Clear quota data when reset timestamps expire
- Add eslint config for static analysis
- Track account source (import/login) in config
- Add -v flag to accounts command showing token expiry
- Don't switch accounts on 429 — pass through to client
- Show '(none available)' instead of '?' when all accounts exhausted
- Skip proxy auth for localhost, drop ANTHROPIC_API_KEY from run
