# TeamClaude

Multi-account Claude proxy with automatic quota-based rotation for [Claude Code](https://claude.ai/claude-code).

Sits transparently between Claude Code and the Anthropic API, managing multiple Claude Max (or API key) accounts and automatically switching when one approaches its session or weekly quota limit.

![TeamClaude TUI](screenshots/teamclaude.png)

## Features

- **Quota-aware routing** — avoids accounts when session (5h) or weekly (7d) quota reaches the configured threshold (default 90%)
- **Adaptive load balancing** — spreads concurrent Claude Code streams across healthy accounts using live in-flight load, request size, quota pressure, and recent errors
- **Session affinity** — optional session headers keep one Claude Code session on the same account until that account becomes unavailable
- **Fast failover on 429/overload** — parks the affected account and retries another account before response bytes are sent
- **Provider fallback profile** — optional `all` profile can use Claude accounts first, then GLM, then Kimi via local custom headers
- **Provider telemetry** — GLM/Kimi rows show active requests, completed/failed counts, last status/latency, and standard rate-limit headers when providers return them
- **Rolling load view** — each row shows current in-flight load plus request counts/average latency over the last 15 minutes and 1 hour
- **Interactive TUI** — real-time dashboard with color-coded quota bars, reset countdowns, activity log, and keyboard controls
- **Graceful drain on restart** — restart/quit/Ctrl-C stops new requests and waits for active streams to finish before exiting or relaunching
- **OAuth token management** — automatically refreshes tokens nearing expiry and persists them to config; client token refreshes pass through untouched
- **Hot-reload accounts** — add accounts via `import` or `login` while the server is running; the server auto-syncs config and **R** can reload immediately
- **Account deduplication** — detects duplicate accounts by UUID and keeps the most recent
- **Request logging** — optional full request/response logging for debugging
- **Zero dependencies** — uses only Node.js built-in modules

## Quick Start

Requires Node.js 18+.

```bash
# Install
npm install -g @karpeleslab/teamclaude

# Add your first account (opens browser for OAuth)
teamclaude login

# Add a second account
teamclaude login

# Start the proxy
teamclaude server

# In another terminal, run Claude Code through the proxy
teamclaude run
```

You can also import existing Claude Code credentials instead of logging in:

```bash
claude /login           # Log into an account in Claude Code
teamclaude import       # Import its credentials
```

## Adding Accounts

### OAuth Login (recommended)

The easiest way to add accounts — opens your browser for authentication:

```bash
teamclaude login
```

Uses the same OAuth flow as Claude Code. Auto-detects the account email and subscription tier. Logging in with the same account again updates its credentials.

You can add accounts while the server is running — press **R** in the TUI to reload.

### Import from Claude Code

If you already have Claude Code set up, you can import its credentials directly:

```bash
claude /login           # Log into an account in Claude Code
teamclaude import       # Import its credentials
```

Re-importing the same account updates its credentials. You can also import from a custom path:

```bash
teamclaude import --from /path/to/credentials.json
```

### API Key

For Anthropic API key accounts (billed via Console):

```bash
teamclaude login --api
```

## Usage

### Start the proxy server

```bash
teamclaude server
```

When running from a TTY, shows an interactive TUI with:
- Account table with session/weekly quota progress bars and reset countdowns
- Real-time activity log with request tracking
- Keyboard shortcuts (see below)

Falls back to plain log output when not a TTY (e.g. running as a service).

#### TUI Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `s` | Switch active account |
| `a` | Add account (import or API key) |
| `r` | Remove an account |
| `R` | Reload accounts from config |
| `x` | Restart server after draining active requests |
| `q` | Quit |

In selection mode, use `j`/`k` or arrow keys to navigate, `Enter` to confirm, `Esc` to cancel.

### Run Claude Code through the proxy

```bash
teamclaude run
```

Or manually set the environment:

```bash
eval "$(teamclaude env)"
claude
```

`teamclaude env` exports only `ANTHROPIC_BASE_URL` by default so Claude Code can keep using your claude.ai subscription login without showing an `ANTHROPIC_API_KEY` auth conflict warning. Use `teamclaude env --with-key` only for non-local clients that need to authenticate to the proxy.

The proxy also understands an optional internal header profile:

- default/absent `x-teamclaude-profile`: Claude accounts only
- `x-teamclaude-profile: all`: Claude accounts first, then lower-priority provider fallbacks

Provider fallback credentials can be supplied per Claude Code process with `ANTHROPIC_CUSTOM_HEADERS`. TeamClaude strips all `x-teamclaude-*` headers before forwarding upstream.

`x-teamclaude-session: <id>` enables session affinity. With this header, the first request for a Claude Code process is routed by the adaptive load balancer, then later requests from the same process keep using that home account while it remains available. If the home account is rate-limited, exhausted, in cooldown, or removed, the session temporarily uses another eligible route. When the home account becomes available again, the session returns to it. For the `all` profile, fallback priority still wins: a session that had to use GLM or Kimi can move back to Claude when a Claude account becomes available again.

Provider rows do not use Claude Max session/week bars unless the provider returns compatible quota headers. For GLM/Kimi, TeamClaude always tracks operational telemetry (`Act`, `OK`, `Fail`, `Last`) and also parses common `x-ratelimit-*` / `ratelimit-*` headers if present.

When GLM/Kimi return 429 without standard retry headers, TeamClaude also parses provider-specific JSON error bodies. Z.AI `next_flush_time` / weekly-monthly exhausted messages and Kimi “try again after N seconds” rate-limit messages are converted into provider cooldowns and queue wake-up timing.

Every account/provider row also includes load telemetry: `Load current/weight`, `15m <requests> <avg latency>`, and `1h <requests>`. This is based on completed requests retained in memory for the last hour, plus current in-flight requests.

### Restart behavior

When you press `x`, `q`, Ctrl-C, or send SIGTERM, TeamClaude enters draining shutdown:

1. The proxy stops accepting new requests.
2. Existing in-flight streams keep running.
3. The process exits when active requests finish.
4. If you pressed `x`, TeamClaude starts a fresh `teamclaude server` process in the same terminal.
5. Press Ctrl-C again to force exit.

Idle Claude Code sessions are not tied to the server process. If the server is restarted while a Claude Code session is idle, its next request reconnects to the new server. If the server is forced closed while a stream is actively running, that stream can still fail because the TCP connection disappears.

### Other commands

```bash
teamclaude accounts          # List accounts with subscription tier and token status
teamclaude accounts -v       # Also show token expiry times
teamclaude status            # Show live proxy status (requires running server)
teamclaude remove <name>     # Remove an account
teamclaude api <path>        # Call an API endpoint with account credentials
teamclaude help              # Show all commands
```

### Request logging

Log full request/response details to a directory (one file per request):

```bash
teamclaude server --log-to /tmp/requests
```

Request logging includes prompt and response bodies. Use it only for short debugging windows and delete logs afterwards.

## Configuration

Config is stored at `~/.config/teamclaude.json` (or `$XDG_CONFIG_HOME/teamclaude.json`). A random proxy API key is generated on first use.

Override the config path with `TEAMCLAUDE_CONFIG`:

```bash
TEAMCLAUDE_CONFIG=./my-config.json teamclaude server
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
    "weeklyExhaustedThreshold": 0.985,
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
    "maxQueuedBodyBytes": 268435456,
    "weeklyMaxWaitMs": 0,
    "pollMs": 1000
  },
  "shutdown": {
    "drainTimeoutMs": 600000
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
| `switchThreshold` | Quota utilization (0–1) at which an account is avoided |
| `scheduler.safetyMaxActivePerAccount` | Emergency circuit breaker, not a normal capacity cap |
| `scheduler.safetyMaxGlobalActive` | Emergency global circuit breaker |
| `retry.maxAttemptsPerRequest` | Retry attempts before returning an error; `0` means one pass over accounts |
| `retry.maxRetryBufferBytes` | Maximum buffered request body eligible for cross-account retry |
| `queue.enabled` | Hold requests instead of returning 429 when every eligible route is temporarily unavailable |
| `queue.maxWaitMs` | Hard maximum time a request can wait in the proxy queue before returning an error; defaults to 24h for long-running agent loops |
| `queue.autoMaxWaitMs` | Optional shorter auto-queue cap. Set to `null` or omit it to use `queue.maxWaitMs`; set a number for interactive sessions where you prefer fast errors |
| `queue.capacityMaxWaitMs` | Separate cap for repeated upstream 5xx/overload failures; defaults to 15m so broken providers do not park requests for 24h |
| `queue.maxQueuedBodyBytes` | Maximum request body TeamClaude will hold in memory while waiting for capacity before the request has been sent upstream; defaults to 256 MiB |
| `queue.weeklyMaxWaitMs` | Optional cap for weekly-limit waits. Defaults to `0`, so weekly exhaustion fails fast instead of parking requests for days |
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
3. If the client sends `x-teamclaude-session`, the session is pinned to that account while it stays available
4. OAuth tokens expiring within 5 minutes are automatically refreshed and persisted to config
5. Rate limit headers from the API (`anthropic-ratelimit-unified-*`) track session (5h) and weekly (7d) quota utilization
6. 5-hour quota controls immediate availability; weekly quota controls new-session admission and preservation; weekly `critical` is last-resort, while weekly `exhausted` is blocked
7. Account quota 429s cool down only that account and fail over before response bytes are sent
8. Anthropic's temporary server-side 429 opens a shared circuit breaker without penalizing accounts; one real request probes recovery after `retry-after`, then queued work resumes automatically
9. Queued streaming requests receive SSE heartbeats, preventing Claude Code's client timeout from abandoning temporary waits
10. Transient network errors (connection reset, timeout) fail over before the stream starts; if every eligible route has a network failure, the proxy returns `503 connection_unavailable` instead of a quota error
11. In the `all` profile only, if all Claude accounts are unavailable, provider fallbacks are tried by priority: GLM before Kimi
12. If all eligible accounts/providers are temporarily unavailable for a temporary reason (5h/session limit, provider cooldown, short 429), the proxy queues the request and retries when one recovers
13. Repeated upstream 5xx/overload failures use the shorter `capacityMaxWaitMs` cap, not the long quota wait
14. Weekly exhaustion and non-retryable 4xx errors fail fast by default; if the queue wait expires, returns 429 with the soonest retry time
15. Temporary OAuth refresh failures cool the account down and queue/fail over; invalid refresh credentials disable only that account and require login
16. In an interactive terminal, the server runs under a foreground supervisor so `x` can drain and restart without detaching the replacement TUI
17. If requests are active, `x` marks restart pending and keeps accepting traffic until the active count reaches zero, avoiding a long connection-refused drain window
18. Client token refresh requests (`/v1/oauth/token`) are relayed to upstream untouched — the proxy and client manage their own token lifecycles independently

## License

MIT
