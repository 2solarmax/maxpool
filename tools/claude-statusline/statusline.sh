#!/bin/sh
# Claude Code status line: working directory, served model and lane, effort, context, branch.

lookup_route() {
  command -v node >/dev/null 2>&1 || return 0
  node - "$1" 2>/dev/null <<'JS'
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const id = process.argv[2];
if (!/^[A-Za-z0-9_-]{1,512}$/.test(id)) process.exit(0);
const codex = /^msg_maxpool_codex_((?:[a-fA-F0-9]{2}){1,128})_/.exec(id);
const validModel = /^[A-Za-z0-9._:/-]{1,128}$/;
if (codex) {
  const model = Buffer.from(codex[1], 'hex').toString();
  if (validModel.test(model)) {
    process.stdout.write('codex|' + model);
    process.exit(0);
  }
}
const dir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
const current = path.join(dir, 'maxpool.json');
const file = process.env.MAXPOOL_CONFIG || process.env.TEAMCLAUDE_CONFIG
  || (fs.existsSync(current) ? current : path.join(dir, 'teamclaude.json'));
let proxy;
try {
  ({proxy} = JSON.parse(fs.readFileSync(file, 'utf8')));
} catch {
  process.exit(0);
}
if (!proxy || typeof proxy.apiKey !== 'string' || !proxy.apiKey) process.exit(0);
const port = Number(proxy.port || 3456);
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(0);
const req = http.get({
  hostname: '127.0.0.1', port, agent: false,
  path: '/maxpool/last-route?messageId=' + encodeURIComponent(id),
  headers: { 'x-api-key': proxy.apiKey },
}, res => {
  if (res.statusCode !== 200) { req.destroy(); return; }
  res.setEncoding('utf8');
  let body = '';
  res.on('data', chunk => {
    body += chunk;
    if (body.length > 2048) req.destroy();
  });
  res.on('end', () => {
    try {
      const {provider, model} = JSON.parse(body);
      if (['zai', 'kimi', 'codex', 'anthropic', 'claude'].includes(provider) && typeof model === 'string' && validModel.test(model)) {
        process.stdout.write(provider + '|' + model);
      }
    } catch { /* keep the legacy display */ }
  });
});
req.on('error', () => {});
const timer = setTimeout(() => req.destroy(), 250);
req.on('close', () => clearTimeout(timer));
JS
}

input=$(cat)

cwd=$(printf '%s' "$input" | jq -r '.cwd // .workspace.current_dir // ""')
case "$cwd" in
  "$HOME") short_cwd='~' ;;
  "$HOME"/*) short_cwd="~/${cwd#"$HOME"/}" ;;
  *) short_cwd=$cwd ;;
esac

model=$(printf '%s' "$input" | jq -r '.model.display_name // .model.id // "unknown"')
lane=''
transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty | strings')
if [ -z "$transcript" ]; then
  sid=$(printf '%s' "$input" | jq -r '.session_id // empty | strings')
  case "$sid" in
    ''|*[!A-Za-z0-9_-]*) ;;
    *)
      proj_dir=$(printf '%s' "$cwd" | sed 's#/#-#g')
      transcript="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/$proj_dir/$sid.jsonl"
      ;;
  esac
fi

if [ -n "$transcript" ] && [ -f "$transcript" ]; then
  mid=$(tail -c 200000 -- "$transcript" 2>/dev/null |
    jq -Rr 'fromjson? | select(.type == "assistant") | .message.id? // empty | strings' |
    tail -1)
  case "$mid" in
    msg_01*) lane=claude ;;
    '') ;;
    *)
      route=$(lookup_route "$mid")
      provider=${route%%|*}
      case "$provider" in
        codex) lane=openai ;;
        zai) lane=glm ;;
        kimi) lane=kimi ;;
        anthropic|claude) lane=claude ;;
        *) case "$mid" in
             msg_maxpool_codex_*) lane=openai ;;
             *) lane=glm ;;
           esac ;;
      esac
      if [ -n "$route" ] && [ "$lane" != claude ]; then model=${route#*|}; fi
      ;;
  esac
fi

effort=$(printf '%s' "$input" | jq -r '.effort.level // empty')
if [ -n "$effort" ]; then effort_str="effort:$effort"; else effort_str=''; fi

used=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // empty')
if [ -n "$used" ]; then ctx_str="ctx:$(printf '%.0f' "$used")%"; else ctx_str='ctx:--'; fi

branch=$(git -C "$cwd" --no-optional-locks branch --show-current 2>/dev/null)
if [ -n "$branch" ]; then branch_str="git:$branch"; else branch_str=''; fi

parts=''
append() {
  [ -n "$1" ] || return 0
  if [ -z "$parts" ]; then parts=$1; else parts="$parts  |  $1"; fi
}
append "$short_cwd"
append "$model"
append "$lane"
append "$effort_str"
append "$ctx_str"
append "$branch_str"
printf '%s\n' "$parts"
