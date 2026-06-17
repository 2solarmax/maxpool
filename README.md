# TeamClaude

Multi-account Claude proxy with automatic quota-based rotation for [Claude Code](https://claude.ai/claude-code).

Sits transparently between Claude Code and the Anthropic API, managing multiple Claude Max (or API key) accounts and automatically switching when one approaches its session or weekly quota limit.

![TeamClaude TUI](screenshots/teamclaude.png)

## Features

- **Quota-aware routing** — avoids accounts when session (5h) or weekly (7d) quota reaches the configured threshold (default 90%)
- **Adaptive load balancing** — spreads concurrent Claude Code streams across healthy accounts using live in-flight load, request size, quota pressure, and recent errors
- **Fast failover on 429/overload** — parks the affected account and retries another account before response bytes are sent
- **Interactive TUI** — real-time dashboard with color-coded quota bars, reset countdowns, activity log, and keyboard controls
- **OAuth token management** — automatically refreshes tokens nearing expiry and persists them to config; client token refreshes pass through untouched
- **Hot-reload accounts** — add accounts via `import` or `login` while the server is running, press **R** to pick them up
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
| `q` | Quit |

In selection mode, use `j`/`k` or arrow keys to navigate, `Enter` to confirm, `Esc` to cancel.

### Run Claude Code through the proxy

```bash
teamclaude run
```

Or manually set the environment:

```bash
eval $(teamclaude env)
claude
```

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
    "maxCooldownMs": 900000
  },
  "retry": {
    "maxAttemptsPerRequest": 0,
    "maxRetryBufferBytes": 10485760
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

## How It Works

1. Claude Code connects to the local proxy instead of `api.anthropic.com`
2. The proxy selects the least-loaded healthy account and forwards requests with that account's credentials
3. OAuth tokens expiring within 5 minutes are automatically refreshed and persisted to config
4. Rate limit headers from the API (`anthropic-ratelimit-unified-*`) track session (5h) and weekly (7d) quota utilization
5. When usage reaches the threshold, the account is avoided until quota resets
6. On 429 responses, the proxy respects `retry-after`, cools down that account, and fails over before response bytes are sent
7. Transient network errors (connection reset, timeout) fail over before the stream starts; after response bytes are sent, the client sees the broken stream and handles retry
8. If all accounts are exhausted, returns 429 with the soonest reset time
9. Client token refresh requests (`/v1/oauth/token`) are relayed to upstream untouched — the proxy and client manage their own token lifecycles independently

## License

MIT
