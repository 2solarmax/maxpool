"""Update the Claude settings for the Maxbar Pool/Direct toggle."""

import json
import os
import sys
import tempfile


path, mode, proxy, ca = sys.argv[1:5]
if os.path.exists(path):
    with open(path, encoding='utf-8') as file:
        raw = file.read()
    permissions = os.stat(path).st_mode & 0o777
else:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    raw, permissions = '{}\n', 0o600

settings = json.loads(raw)
env = settings.setdefault('env', {})
if mode == 'pool':
    env['HTTPS_PROXY'] = proxy
    env['NODE_EXTRA_CA_CERTS'] = ca
    env['MAXBAR_CLAUDE_POOL_PROFILE'] = 'all'
else:
    env.pop('HTTPS_PROXY', None)
    env.pop('NODE_EXTRA_CA_CERTS', None)
    env.pop('MAXBAR_CLAUDE_POOL_PROFILE', None)

updated = json.dumps(settings, indent=2, ensure_ascii=False) + ('\n' if raw.endswith('\n') else '')
fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path), prefix='.settings.json.')
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as file:
        file.write(updated)
    os.chmod(temporary, permissions)
    os.replace(temporary, path)
except BaseException:
    os.unlink(temporary)
    raise
