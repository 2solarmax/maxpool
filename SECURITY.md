# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in maxpool, please report it privately
rather than opening a public issue.

- Use GitHub's [private vulnerability reporting](https://github.com/2solarmax/maxpool/security/advisories/new), or
- Open a minimal public issue asking for a private contact channel (without
  vulnerability details).

## Scope

maxpool is a **local** proxy. It stores Claude OAuth tokens and API keys in its
config file (`~/.config/maxpool.json`, mode `0600`) and listens on `127.0.0.1`
only. The most sensitive assets are those stored credentials.

Please report:

- Any path by which the config file's credentials could be read by another
  local user or leaked off the machine.
- Any way a non-localhost caller could route requests through your accounts.
- Any token/credential disclosure in logs or error output.

maxpool never sends your credentials anywhere except `api.anthropic.com` (or a
provider endpoint you explicitly configure).
