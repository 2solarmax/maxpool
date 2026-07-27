# Maxpool

Multi-account proxy for [Claude Code](https://claude.ai/claude-code) that spreads your work across several Claude accounts with adaptive, rate-aware load balancing.

Sits transparently between Claude Code and the Anthropic API, managing multiple Claude Max (or API key) accounts. Instead of waiting until one account hits a wall, it continuously balances requests by how much quota each account has *and* how soon that quota resets — so an account about to refresh gets used, and one burning through its budget early gets spared.

![Maxpool TUI](screenshots/maxpool.png)

## ⚠️ Read this first: account risk and Anthropic's terms

This tool sits in a **contested gray area** of Anthropic's terms. Using it could put your Claude accounts at risk. Please read before installing.

- **Not blessed by Anthropic.** This is an independent project. Anthropic has not approved multi-account proxying, and nothing here is covered by an official "this is allowed" statement.
- **The terms can be read to prohibit it.** Anthropic's Consumer Terms (Section 3, automated access) and its February 2026 rule that subscription OAuth tokens are "only authorized for use with Claude Code" can reasonably be read to cover a proxy that selects and injects tokens across accounts. It is genuinely ambiguous, and the ambiguity is not in your favor.
- **Multiplexing is a detectable pattern.** Many accounts fronted by one machine, with parallel sessions and fast token rotation, looks like the anomaly Anthropic's automated systems flag, regardless of intent. People have lost accounts to pattern detection, and a clawback can hit all your pooled accounts at once.
- **Owned accounts only. No spoofing.** Only use accounts you personally own and pay for. Never share accounts across people (that is the clear violation), and never add IP/residential proxies, fingerprint spoofing, or MITM. Those are the documented ban triggers, and this fork deliberately leaves them out. PRs adding them will be rejected.
- **You are accepting the risk.** If you use this, you may lose accounts you pay for. This notice protects honesty, not your account.
- **Do your own research. This is not legal advice.** The terms have moved several times in 2026. Check the current terms yourself before relying on it.

If you want certainty, ask Anthropic support directly, or use **API-key accounts** (the sanctioned path for tooling) instead of subscription OAuth.

## Features

- **Rate-aware load balancing** — ranks accounts by remaining quota ÷ time-to-reset, not raw usage %, so a near-reset account with quota left is drained (use-it-or-lose-it) and one burning fast early in its window is spared; sequential traffic rotates across accounts instead of funnelling onto one
- **Interactive account & routing management** — add/import/enable-disable accounts and switch between automatic load balancing and a preferred (manual) account, all from the TUI
- **Quota-aware routing** — avoids accounts when session (5h) or weekly (7d) quota reaches the configured threshold (default 90%)
- **Session affinity** — optional session headers keep one Claude Code session on the same account until that account becomes unavailable
- **Fast failover on 429/overload** — parks the affected account and retries another account before response bytes are sent
- **Provider fallback profile** — optional `all` profile can use Claude accounts first, then GLM, then Kimi via local custom headers
- **Provider telemetry** — GLM/Kimi rows show active requests, completed/failed counts, last status/latency, and standard rate-limit headers when providers return them
- **Rolling load view** — each row shows current in-flight load plus request counts/average latency over the last 15 minutes and 1 hour
- **Interactive TUI** — real-time dashboard with color-coded quota bars, reset countdowns, activity log, and keyboard controls
- **Graceful drain on restart** — restart/quit/Ctrl-C stops new requests and waits for active streams to finish before exiting or relaunching
- **OAuth token management** — automatically refreshes tokens nearing expiry and persists them to config; client token refreshes pass through untouched
- **Hot-sync accounts** — add accounts via `import` or `login` while the server is running; the server auto-syncs config and **s** can sync immediately
- **Account deduplication** — detects duplicate accounts by UUID and keeps the most recent
- **Request logging** — optional full request/response logging for debugging
- **Zero dependencies** — uses only Node.js built-in modules

## Quick Start

Requires Node.js 18+.

```bash
# Install
npm install -g maxpool

# Add your first account (opens browser for OAuth)
maxpool login

# Add a second account
maxpool login

# Start the proxy
maxpool server

# In another terminal, run Claude Code through the proxy
maxpool run
```

## Recommended setup

The cleanest way to use maxpool day-to-day: **keep your normal `claude` login untouched, and add a separate alias that routes through the pool.** Then plain `claude` still uses your default single account, and `ccmax` (call it whatever you like) spreads work across all your accounts.

1. **Install and add your accounts** (see [Adding Accounts](#adding-accounts)):
   ```bash
   npm install -g maxpool
   maxpool login        # repeat for each account (browser) — or `maxpool import`
   ```
2. **Start the proxy** and leave it running (it shows a live dashboard):
   ```bash
   maxpool
   ```
3. **Add an alias** to your `~/.zshrc` (or `~/.bashrc`):
   ```bash
   # Run Claude Code through the maxpool proxy.
   # Your plain `claude` stays on its own separate login.
   ccmax() {
     local url
     url="$(maxpool env | sed -n 's/^export ANTHROPIC_BASE_URL=//p')"
     ( unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
       ANTHROPIC_BASE_URL="$url" \
       ANTHROPIC_CUSTOM_HEADERS="x-maxpool-session: $(uuidgen)" \
       claude "$@" )
   }
   ```
   Reload with `source ~/.zshrc` (or just open a new terminal).
4. **Use it:**
   ```bash
   ccmax            # Claude Code, load-balanced across all your accounts
   claude           # unchanged — still your normal single-account login
   ```

Why this approach:

- **Your normal `claude` stays separate.** maxpool keeps its own account tokens in its config; your everyday Claude Code login (in the OS keychain) is never touched. Use `ccmax` when you want the pool, `claude` when you don't.
- **Session affinity.** The `x-maxpool-session` header pins each terminal to one account (with automatic failover), so a single task doesn't bounce between accounts mid-stream.
- **No key needed locally.** The proxy listens on `127.0.0.1` and accepts local clients without an API key, so the alias stays short.
- **Composes with your other aliases.** If you already use aliases for other providers (GLM, Kimi, …), `ccmax` slots right in alongside them.

> Prefer zero config? `maxpool run` launches Claude Code through the proxy for you — the alias above is the same idea, just composable with your own setup. Most people end up making an alias.

## Adding Accounts

### OAuth Login (recommended)

The easiest way to add accounts — opens your browser for authentication:

```bash
maxpool login
```

Uses the same OAuth flow as Claude Code. Auto-detects the account email and subscription tier. Logging in with the same account again updates its credentials.

You can add accounts while the server is running — press **s** in the TUI to sync immediately, or wait for automatic sync.

> **Note on adding accounts:** OAuth login adds whatever account you're currently signed into at claude.ai — there's no account picker. To add a *different* account, sign into that account at claude.ai first (or use a logged-out / incognito browser window), then run `maxpool login`. (Importing the Claude Code CLI's own local login was removed — it shares a single-use credential the CLI keeps rotating, which broke the pooled copy. Use browser login so maxpool holds its own independent grant.)

### API Key

For Anthropic API key accounts (billed via Console):

```bash
maxpool login --api
```

## Usage

### Start the proxy server

```bash
maxpool server
```

When running from a TTY, shows an interactive TUI with:
- Account table with session/weekly quota progress bars and reset countdowns
- Real-time activity log with request tracking
- Keyboard shortcuts (see below)

Falls back to plain log output when not a TTY (e.g. running as a service).

#### TUI Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `a` | Open account management |
| `m` | Choose automatic routing or a preferred account |
| `s` | Sync accounts and credentials from config now |
| `r` | Restart server after draining active requests |
| `q` | Stop server after draining active requests |

State-changing actions show what will happen and require `y` or `n`. In selection mode, use `j`/`k` or arrow keys to navigate, `Enter` to choose, and `Esc` to go back.

The Accounts menu (`a`) lets you add and manage accounts without leaving the TUI:

| Key | Action |
|-----|--------|
| `l` | Log in via browser — add an account, then name it |
| `k` | Add an Anthropic API key account |
| `n` | Rename the selected account |
| `t` | Enable or disable the selected account |
| `d` | Permanently delete an idle account |

Disabling keeps credentials in config but prevents new requests from using the account. Deletion is blocked while that account has active requests. The currently-active account is marked with a green `►`.

Routing modes:

- **Automatic** spreads requests across healthy accounts using live load, quota pressure, and recent errors.
- **Manual preference** sends subsequent requests, including the next request from existing idle sessions, to the selected Claude account whenever it is healthy. Maxpool still fails over automatically when necessary and returns to the preferred account after recovery.

Routing changes do not move requests already in flight.

### Run Claude Code through the proxy

```bash
maxpool run
```

Or manually set the environment:

```bash
eval "$(maxpool env)"
claude
```

`maxpool env` exports only `ANTHROPIC_BASE_URL` by default so Claude Code can keep using your claude.ai subscription login without showing an `ANTHROPIC_API_KEY` auth conflict warning. Use `maxpool env --with-key` only for non-local clients that need to authenticate to the proxy.

The proxy also understands an optional internal header profile:

- default/absent `x-maxpool-profile`: Claude accounts only
- `x-maxpool-profile: all`: Claude accounts first, then lower-priority provider fallbacks

Provider fallback credentials can be supplied per Claude Code process with `ANTHROPIC_CUSTOM_HEADERS`. Maxpool strips all `x-maxpool-*` headers before forwarding upstream.

`x-maxpool-session: <id>` enables session affinity. With this header, the first request for a Claude Code process is routed by the adaptive load balancer, then later requests from the same process keep using that home account while it remains available. If the home account is rate-limited, exhausted, in cooldown, or removed, the session temporarily uses another eligible route. When the home account becomes available again, the session returns to it. For the `all` profile, a Claude session that had to spill onto GLM/Kimi moves back to Claude once a Claude account frees up — **as long as it produced no provider-format tool calls while there**.

**Cross-provider fallback + compatibility (`all` profile).** Claude, GLM (z.ai), and Kimi (Moonshot) interoperate for ordinary sessions — a regular tool-use id (`call_`/`tool_`) passes Anthropic's loose validation, so a Kimi or GLM session that used no server tools runs on Claude (its *thinking* blocks are rejected, but Maxpool strips them automatically — see self-heal below) and a Claude session spills onto GLM/Kimi when Claude is unavailable. `scheduler.crossProviderFallbackPolicy` controls it, cyclable live in the TUI Routing menu (`m` → `f`): `never` (default) = **Claude sessions never spill onto a provider** (note: this governs the Claude→provider direction only — it is NOT a same-family pin), `when-exhausted` = cross only once the home family is exhausted, `always` = providers peer with Claude.

The one hard incompatibility Maxpool guards is a **`server_tool_use` id** that isn't `srvtoolu_` — Anthropic 400s that on replay (e.g. a `cc glm` session that used a server tool, resumed under `cc all`). Maxpool predicts that case ahead (pins the session to GLM/Kimi) and, for anything it can't predict (a rejected thinking signature), **self-heals**: the 400 is pre-stream, so Maxpool latches the session provider-only and transparently retries on GLM/Kimi — the client never sees the error. (Note: Claude Code may warn a resumed `glm-*` model "could not be restored" and fall back to `claude-opus-4-8`; that's a client-side message — routing is unaffected.)

Provider rows do not use Claude Max session/week bars unless the provider returns compatible quota headers. For GLM/Kimi, Maxpool always tracks operational telemetry (`Act`, `OK`, `Fail`, `Last`) and also parses common `x-ratelimit-*` / `ratelimit-*` headers if present.

When GLM/Kimi return 429 without standard retry headers, Maxpool also parses provider-specific JSON error bodies. Z.AI `next_flush_time` / weekly-monthly exhausted messages and Kimi “try again after N seconds” rate-limit messages are converted into provider cooldowns and queue wake-up timing.

Every account/provider row also includes load telemetry: `Load current/weight`, `15m <requests> <avg latency>`, and `1h <requests>`. This is based on completed requests retained in memory for the last hour, plus current in-flight requests.

### Restart behavior

When you confirm Restart, confirm Stop, press Ctrl-C, or send SIGTERM, Maxpool enters draining shutdown:

1. The proxy stops accepting new requests.
2. Existing in-flight streams keep running.
3. The process exits when active requests finish.
4. If you selected Restart, Maxpool starts a fresh `maxpool server` process in the same terminal.
5. Press Ctrl-C again to force exit.

Idle Claude Code sessions are not tied to the server process. If the server is restarted while a Claude Code session is idle, its next request reconnects to the new server. If the server is forced closed while a stream is actively running, that stream can still fail because the TCP connection disappears.

### Other commands

```bash
maxpool accounts          # List accounts with subscription tier and token status
maxpool accounts -v       # Also show token expiry times
maxpool status            # Show live proxy status (requires running server)
maxpool remove <name>     # Remove an account
maxpool rename <name|#> <new>  # Rename an account (by name or list number)
maxpool api <path>        # Call an API endpoint with account credentials
maxpool help              # Show all commands
```

### Request logging

Log full request/response details to a directory (one file per request):

```bash
maxpool server --log-to /tmp/requests
```

Request logging includes prompt and response bodies. Use it only for short debugging windows and delete logs afterwards.

## Configuration

Config is stored at `~/.config/maxpool.json` (or `$XDG_CONFIG_HOME/maxpool.json`). A random proxy API key is generated on first use.

Override the config path with `TEAMCLAUDE_CONFIG`:

```bash
TEAMCLAUDE_CONFIG=./my-config.json maxpool server
```

### Config format

```json
{
  "proxy": {
    "host": "127.0.0.1",
    "port": 3456,
    "apiKey": "tc-auto-generated-key"
  },
  "upstream": "https://api.anthropic.com",
  "updateCheck": true,
  "autoUpdate": false,
  "switchThreshold": 0.90,
  "scheduler": {
    "mode": "adaptive-least-loaded",
    "safetyMaxActivePerAccount": 50,
    "safetyMaxGlobalActive": 150,
    "cooldownMs": 30000,
    "maxCooldownMs": 900000,
    "weeklySoftThreshold": 0.65,
    "weeklyReserveThreshold": 0.85,
    "weeklyCriticalThreshold": 0.95,
    "weeklyExhaustedThreshold": 0.999,
    "weeklyBurnDebtWeight": 0.6
  },
  "retry": {
    "maxAttemptsPerRequest": 0,
    "maxRetryBufferBytes": 10485760
  },
  "queue": {
    "enabled": true,
    "maxWaitMs": 86400000,
    "autoMaxWaitMs": null,
    "capacityMaxWaitMs": 900000,
    "weeklyMaxWaitMs": 86400000,
    "nonStreamMaxWaitMs": 300000,
    "maxConcurrentQueued": 64,
    "maxQueuedBytes": 1073741824,
    "maxQueuedBodyBytes": 268435456,
    "pollMs": 1000
  },
  "shutdown": {
    "drainTimeoutMs": 15000
  },
  "accounts": [
    {
      "name": "user@example.com",
      "type": "oauth",
      "accountUuid": "...",
      "accessToken": "sk-ant-oat01-...",
      "refreshToken": "sk-ant-ort01-...",
      "expiresAt": 1774384968427
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `proxy.host` | Local interface the proxy listens on; defaults to `127.0.0.1` |
| `proxy.port` | Local port the proxy listens on |
| `proxy.apiKey` | API key clients use for status/admin requests |
| `upstream` | Upstream API base URL |
| `updateCheck` | Check npm for a newer maxpool on startup and notify; defaults to `true` |
| `autoUpdate` | Install new versions automatically (applied on next restart, never interrupting sessions); defaults to `false` |
| `switchThreshold` | Quota utilization (0–1) at which an account is avoided (5h *and* weekly); default `0.90`. Raise toward `0.97` to use more before rotating |
| `scheduler.weeklySoftThreshold` / `weeklyReserveThreshold` / `weeklyCriticalThreshold` / `weeklyExhaustedThreshold` | Weekly (7d) quota tiers (0–1) controlling how aggressively an account is de-prioritised as its weekly usage climbs |
| `scheduler.safetyMaxActivePerAccount` | Emergency circuit breaker, not a normal capacity cap |
| `scheduler.safetyMaxGlobalActive` | Emergency global circuit breaker |
| `retry.maxAttemptsPerRequest` | Retry attempts before returning an error; `0` means one pass over accounts |
| `retry.maxRetryBufferBytes` | Maximum buffered request body eligible for cross-account retry |
| `queue.enabled` | Hold requests instead of returning 429 when every eligible route is temporarily unavailable |
| `queue.maxWaitMs` | Hard maximum time a request can wait in the proxy queue before returning an error; defaults to 24h for long-running agent loops |
| `queue.autoMaxWaitMs` | Optional shorter auto-queue cap. Set to `null` or omit it to use `queue.maxWaitMs`; set a number for interactive sessions where you prefer fast errors |
| `queue.capacityMaxWaitMs` | Separate cap for repeated upstream 5xx/overload failures; defaults to 15m so broken providers do not park requests for 24h |
| `queue.maxQueuedBodyBytes` | Maximum request body Maxpool will hold in memory while waiting for capacity before the request has been sent upstream; defaults to 256 MiB |
| `queue.weeklyMaxWaitMs` | How long to hold a request when every account is at its weekly (7d) cap. Defaults to 24h — but the early-exit gates on each account's REAL reset time, so it only waits when a reset genuinely lands inside the window and errors honestly otherwise. (Was `0` = fail-fast, which killed sessions the instant all accounts hit their weekly cap.) |
| `queue.nonStreamMaxWaitMs` | Max hold for non-streaming requests; defaults to 5m. They have no SSE keepalive, so a longer hold would die on the client timeout anyway |
| `queue.maxConcurrentQueued` | Backpressure: max requests held waiting at once; defaults to 64. Beyond it, new waiters get a clear "queue full" error instead of growing the heap |
| `queue.maxQueuedBytes` | Backpressure: max aggregate buffered request-body bytes across all held requests; defaults to 1 GiB |
| `queue.pollMs` | How often queued requests check for a recovered account/provider |
| `queue.heartbeatMs` | SSE heartbeat interval for queued streaming requests; defaults to 10s so Claude Code keeps the queued connection alive |
| `shutdown.drainTimeoutMs` | Maximum time quit/Ctrl-C waits for active requests before exiting |

Weekly Claude quota is treated as long-horizon budget, not the same as the 5-hour session cap:

- `normal`: accepts new and sticky sessions.
- `soft`: remains available, but new sessions prefer cooler accounts.
- `reserve`: existing sticky sessions can continue; new sessions use other Claude accounts when possible.
- `critical`: avoided unless no healthier eligible route exists. This can be raw weekly usage or reset-aware pace pressure.
- `exhausted`: unavailable until weekly reset or upstream recovery.

The weekly usage bar shows raw upstream utilization and reset timing. Reset-aware burn rate is a separate pace signal used for routing pressure; it can mark an account as `Pace critical`, but only raw near-exhaustion or upstream rejection can show/block as `Wk exhausted`.

## How It Works

1. Claude Code connects to the local proxy instead of `api.anthropic.com`
2. The proxy selects the least-loaded healthy account and forwards requests with that account's credentials
3. If the client sends `x-maxpool-session`, the session is pinned to that account while it stays available
4. OAuth tokens expiring within 5 minutes are automatically refreshed and persisted to config
5. Rate limit headers from the API (`anthropic-ratelimit-unified-*`) track session (5h) and weekly (7d) quota utilization
6. 5-hour quota controls immediate availability; weekly quota controls new-session admission and preservation; weekly `critical` is last-resort, while weekly `exhausted` is blocked
7. Account quota 429s cool down only that account and fail over before response bytes are sent
8. Anthropic's server-side 429 and 529 responses first fail over across every eligible Claude account; only a request-wide set of matching failures with no concurrent Claude success promotes to the shared circuit breaker. One real request probes recovery after `retry-after`, then queued work resumes automatically
9. Queued streaming requests receive SSE heartbeats, preventing Claude Code's client timeout from abandoning temporary waits
10. Transient network errors (connection reset, timeout) fail over before the stream starts; if every eligible route has a network failure, the proxy returns `503 connection_unavailable` instead of a quota error
11. In the `all` profile only, if all Claude accounts are unavailable, provider fallbacks are tried by priority: GLM before Kimi
12. If all eligible accounts/providers are temporarily unavailable for a temporary reason (5h/session limit, provider cooldown, short 429), the proxy queues the request and retries when one recovers
13. Repeated upstream 5xx/overload failures use the shorter `capacityMaxWaitMs` cap, not the long quota wait
14. Weekly (7d) exhaustion is held and retried like a 5h cap, up to `weeklyMaxWaitMs`, but only when an account's real reset lands inside the window; if the soonest reset is beyond it (or unknown), it returns 429 promptly with an honest message naming the soonest reset rather than spinning. Non-retryable 4xx errors still fail fast
15. Temporary OAuth refresh failures cool the account down and queue/fail over; invalid refresh credentials disable only that account and require login
16. In an interactive terminal, the server runs under a foreground supervisor so confirmed Restart (`r`) can drain and restart without detaching the replacement TUI
17. When Restart is confirmed, new upstream admission pauses immediately. Existing upstream requests finish, queued requests cannot deadlock restart, and their sockets close during relaunch so Claude Code reconnects automatically
18. Client token refresh requests (`/v1/oauth/token`) are relayed to upstream untouched — the proxy and client manage their own token lifecycles independently

## FAQ

**Does this touch my normal Claude Code login?**
No. maxpool stores its own account tokens in its config file. Your everyday `claude` login lives in the OS keychain and is never modified. Run `ccmax` for the pool, `claude` for your normal login.

**How do I add another account?**
`maxpool login` (browser — adds any account), or in the TUI press `a` then `l`. To add the account you're currently logged into Claude Code with, use `maxpool import` (or `a` then `i`).

**Can I rename an account?**
Yes — `maxpool rename <name|number> <new-name>`, or in the TUI press `a` then `n`.

**An account stopped being used before it hit 100% — why?**
maxpool stops routing to an account at `switchThreshold` (default 90%) of its 5-hour or weekly window, leaving a safety margin so it's never hard rate-limited. Raise it in your config (toward 0.97) to use more before rotating.

**One account shows empty quota bars but it's serving requests — is it broken?**
No. The bars show how *full* an account is toward its limit, so an empty bar means lots of headroom (good). Actual activity is in the `15m`/`1h` request-count columns.

**Will updates apply automatically?**
Set `"autoUpdate": true` in your config and maxpool installs new versions itself (applied on the next restart; running sessions are never interrupted). Otherwise `npm i -g maxpool` updates it.

**Where do my tokens go?**
They're stored locally in your config (file mode `0600`) and sent only to Anthropic — or, in the optional `all` profile, to GLM/Kimi if you supply those. Nothing else leaves your machine. Zero third-party dependencies.

**How do I stop it?**
Press `q` in the TUI (or Ctrl-C). It drains briefly, then exits.

## Credits

maxpool is a fork of [KarpelesLab/teamclaude](https://github.com/KarpelesLab/teamclaude)
by Mark Karpelès, substantially extended with rate-aware (use-it-or-lose-it)
load balancing, interactive account & routing management, atomic credential
storage, and resilient upstream-error handling. Thanks to the original authors.

## License

MIT — see [LICENSE](LICENSE). Copyright © 2026 KarpelesLab and Max Krasnykh.
