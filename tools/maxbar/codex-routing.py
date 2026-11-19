"""Set Codex's user model provider using its own config writer."""

import http.client
import json
import os
from pathlib import Path
import select
import shutil
import subprocess
import sys
import tempfile
import time


PROVIDER = 'maxbar_pool'
MODELS_PATH = '/maxpool/codex/v1/models'
CODEX_BUNDLES = (
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
)


class RoutingError(Exception):
    pass


class CodexConfig:
    def __init__(self, executable, home):
        self.executable = executable
        self.home = home
        self.buffer = b''
        self.request_id = 0

    def __enter__(self):
        try:
            self.process = subprocess.Popen(
                [self.executable, 'app-server'], cwd=self.home,
                env={**os.environ, 'CODEX_HOME': str(self.home)},
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
        except OSError as error:
            raise RoutingError('Could not start the Codex configuration service') from error
        try:
            self.call('initialize', {'clientInfo': {'name': 'maxbar', 'version': '1'}})
            self.send({'method': 'initialized'})
            return self
        except BaseException:
            self.__exit__()
            raise

    def __exit__(self, *args):
        self.process.terminate()
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait()
        self.process.stdin.close()
        self.process.stdout.close()

    def send(self, message):
        try:
            self.process.stdin.write(json.dumps(message).encode() + b'\n')
            self.process.stdin.flush()
        except OSError as error:
            raise RoutingError('Codex configuration service closed unexpectedly') from error

    def call(self, method, params):
        self.request_id += 1
        self.send({'id': self.request_id, 'method': method, 'params': params})
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            while b'\n' in self.buffer:
                line, self.buffer = self.buffer.split(b'\n', 1)
                result = json.loads(line)
                if result.get('id') != self.request_id:
                    continue
                if 'error' in result:
                    raise RoutingError('Codex rejected the configuration operation; check config.toml and retry')
                return result['result']
            seconds = max(0, deadline - time.monotonic())
            if not select.select([self.process.stdout], [], [], seconds)[0]:
                break
            data = os.read(self.process.stdout.fileno(), 65_536)
            if not data:
                raise RoutingError('Codex configuration service could not read config.toml')
            self.buffer += data
        raise RoutingError('Codex configuration service timed out')

    def read(self):
        result = self.call('config/read', {'includeLayers': True})
        user = next((layer for layer in result['layers'] or [] if layer['name']['type'] == 'user'), None)
        if not user:
            raise RoutingError('Codex did not report its user configuration')
        return user

    def write(self, user, provider, definition):
        def edit(key, value):
            return {'keyPath': key, 'value': value, 'mergeStrategy': 'replace'}

        self.call('config/batchWrite', {
            'edits': [edit('model_provider', provider), edit('model_providers.' + PROVIDER, definition)],
            'filePath': user['name']['file'], 'expectedVersion': user['version'], 'reloadUserConfig': True,
        })


def codex_executable():
    candidates = (os.getenv('MAXBAR_CODEX_EXECUTABLE'), *CODEX_BUNDLES, shutil.which('codex'))
    for path in candidates:
        if path and os.access(path, os.X_OK):
            return path
    raise RoutingError('Install or update Codex to enable the routing switch')


def pool_config_path():
    explicit = os.getenv('MAXPOOL_CONFIG') or os.getenv('TEAMCLAUDE_CONFIG')
    if explicit:
        return Path(explicit).expanduser().resolve()
    folder = Path(os.getenv('XDG_CONFIG_HOME') or Path.home() / '.config').expanduser()
    current = folder / 'maxpool.json'
    legacy = folder / 'teamclaude.json'
    return (legacy if not current.exists() and legacy.exists() else current).resolve()


def pool_provider():
    path = pool_config_path()
    try:
        proxy = json.loads(path.read_text())['proxy']
        host = proxy.get('host', '127.0.0.1')
        port = proxy.get('port', 3456)
        token = proxy['apiKey']
        if host not in ('127.0.0.1', 'localhost', '::1') or type(port) is not int or not 0 < port <= 65535:
            raise ValueError
        if not isinstance(token, str) or not token or any(not 33 <= ord(char) <= 126 for char in token):
            raise ValueError
    except (OSError, ValueError, TypeError, KeyError, AttributeError) as error:
        raise RoutingError('An authenticated loopback MaxPool listener is required') from error
    connection = http.client.HTTPConnection(host, port, timeout=2)
    try:
        connection.request('GET', MODELS_PATH, headers={'Authorization': 'Bearer ' + token})
        reply = connection.getresponse()
        if reply.status != 200:
            raise RoutingError('MaxPool Codex route is unavailable; start MaxPool and check account access')
        models = json.loads(reply.read(2_000_000)).get('models')
        if not isinstance(models, list) or not models:
            raise RoutingError('MaxPool has no available local Codex models')
    except (OSError, ValueError, TypeError, AttributeError, http.client.HTTPException) as error:
        raise RoutingError('MaxPool Codex route is unavailable on this Mac') from error
    finally:
        connection.close()
    url_host = '[' + host + ']' if ':' in host else host
    catalog = 'http://' + url_host + ':' + str(port) + MODELS_PATH
    return {
        'name': 'MaxPool', 'base_url': catalog[:-len('/models')], 'model_catalog_url': catalog,
        'wire_api': 'responses', 'supports_websockets': False,
        'supports_standalone_web_search': True,
        'capabilities': {'external_web_access': True},
        'auth': {
            'command': '/usr/bin/plutil',
            'args': ['-extract', 'proxy.apiKey', 'raw', '-o', '-', str(path)],
        },
    }


def save_state(path, state):
    with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, delete=False) as file:
        temporary = Path(file.name)
        try:
            json.dump(state, file)
            file.flush()
            os.fsync(file.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def route(action, home):
    if not home.exists() and action != 'pool':
        return 'Direct'
    home.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_path = home / 'maxbar-codex-routing.json'
    try:
        state = json.loads(state_path.read_text()) if state_path.exists() else {}
    except (OSError, ValueError) as error:
        raise RoutingError('Could not read Maxbar routing recovery settings') from error
    with CodexConfig(codex_executable(), home) as client:
        user = client.read()
        cfg = user['config']
        provider = cfg.get('model_provider')
        definition = cfg.get('model_providers', {}).get(PROVIDER)
        owned = definition is not None and state.get('definition') == definition
        is_pool = provider == PROVIDER and owned
        if provider == PROVIDER and not owned:
            raise RoutingError('The active Maxbar provider settings were changed outside Maxbar')
        if action == 'status':
            return 'Pool' if is_pool else 'Direct'
        if action == 'direct':
            if not is_pool:
                return 'Direct'
            client.write(user, state.get('previousProvider'), None)
            state_path.unlink(missing_ok=True)
            return 'Direct'
        if is_pool:
            return 'Pool'
        if definition is not None and not owned:
            raise RoutingError('A different Codex provider already uses the Maxbar provider name')
        settings = client.call('modelProvider/list', {})
        if settings.get('canChangeDefault') is False:
            raise RoutingError('Codex provider selection is managed by policy')
        next_definition = pool_provider()
        save_state(state_path, {'previousProvider': provider, 'definition': next_definition})
        client.write(user, PROVIDER, next_definition)
        return 'Pool'


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ('status', 'pool', 'direct'):
        raise RoutingError('Choose status, pool, or direct')
    home = Path(os.getenv('CODEX_HOME') or Path.home() / '.codex').expanduser().resolve()
    print(route(sys.argv[1], home))


if __name__ == '__main__':
    try:
        main()
    except RoutingError as error:
        sys.exit(str(error))
    except (OSError, ValueError, TypeError, KeyError):
        sys.exit('Could not read or update Codex routing settings')
