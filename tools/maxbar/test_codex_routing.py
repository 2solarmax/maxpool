import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread, Timer
from urllib.parse import urlsplit
import unittest


class Catalog(BaseHTTPRequestHandler):
    authenticated = False
    served = []

    def do_GET(self):
        if urlsplit(self.path).path != '/maxpool/codex/v1/models':
            return self.send_error(404)
        type(self).authenticated = self.headers.get('Authorization') == 'Bearer pool-fixture'
        self.send_response(200 if type(self).authenticated else 401)
        self.end_headers()
        self.wfile.write(b'{"models":[{"slug":"gpt-6.2-sol"}]}')

    def do_POST(self):
        if urlsplit(self.path).path != '/maxpool/codex/v1/responses':
            return self.send_error(404)
        if self.headers.get('Authorization') != 'Bearer pool-fixture':
            return self.send_error(401)
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        type(self).served.append(request)
        item = {'type': 'message', 'id': 'msg_fixture', 'role': 'assistant', 'status': 'completed',
                'content': [{'type': 'output_text', 'text': 'MAXBAR_POOL_FIXTURE', 'annotations': []}]}
        reply = {'id': 'resp_fixture', 'model': request['model'], 'status': 'completed',
                 'output': [item], 'usage': {'input_tokens': 21, 'output_tokens': 5, 'total_tokens': 26}}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for event in (
            {'type': 'response.created', 'response': {**reply, 'status': 'in_progress', 'output': []}},
            {'type': 'response.output_item.added', 'output_index': 0, 'item': {**item, 'content': []}},
            {'type': 'response.output_text.delta', 'output_index': 0, 'content_index': 0,
             'item_id': item['id'], 'delta': 'MAXBAR_POOL_FIXTURE'},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'response': reply},
        ):
            self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())

    def log_message(self, *args):
        pass


@unittest.skipUnless(shutil.which('codex'), 'Codex CLI is required')
class CodexRoutingTest(unittest.TestCase):
    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory()
        self.addCleanup(self.sandbox.cleanup)
        self.home = Path(self.sandbox.name)
        Catalog.authenticated = False
        Catalog.served = []
        self.config = self.home / 'config.toml'
        self.pool = self.home / 'pool.json'
        self.api = ThreadingHTTPServer(('127.0.0.1', 0), Catalog)
        Thread(target=self.api.serve_forever, daemon=True).start()
        self.addCleanup(self.api.server_close)
        self.addCleanup(self.api.shutdown)
        self.pool.write_text(json.dumps({'proxy': {'port': self.api.server_port, 'apiKey': 'pool-fixture'}}))
        self.env = {**os.environ, 'CODEX_HOME': str(self.home), 'MAXPOOL_CONFIG': str(self.pool),
                    'MAXBAR_CODEX_EXECUTABLE': shutil.which('codex')}
        self.helper = Path(__file__).with_name('codex-routing.py')

    def run_helper(self, command, succeeds=True):
        result = subprocess.run([sys.executable, str(self.helper), command], env=self.env,
                                capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode == 0, succeeds, result.stderr)
        self.assertNotIn('pool-fixture', result.stdout + result.stderr)
        return result.stdout.strip() if succeeds else result.stderr.strip()

    def test_switch_restores_user_provider_and_preserves_other_settings(self):
        self.config.write_text(
            '# user comment\nmodel = "gpt-6.2-sol"\nmodel_provider = "custom"\n'
            '[model_providers.custom]\nname = "Custom"\nbase_url = "https://example.com/v1"\n'
        )
        self.assertEqual(self.run_helper('status'), 'Direct')
        self.assertEqual(self.run_helper('pool'), 'Pool')
        self.assertEqual(self.run_helper('status'), 'Pool')
        self.assertTrue(Catalog.authenticated)
        self.assertIn('model_provider = "maxbar_pool"', self.config.read_text())
        self.assertIn('supports_standalone_web_search = true', self.config.read_text())
        self.assertIn('external_web_access = true', self.config.read_text())
        self.assertNotIn('pool-fixture', self.config.read_text())
        with self.config.open('a') as f:
            f.write('\n[features]\nexperimental_windows_sandbox = false\n')
        self.pool.unlink()
        self.assertEqual(self.run_helper('direct'), 'Direct')
        self.assertEqual(self.run_helper('status'), 'Direct')
        config = self.config.read_text()
        for value in ('# user comment', 'model = "gpt-6.2-sol"', 'model_provider = "custom"',
                      '[model_providers.custom]', '[features]'):
            self.assertIn(value, config)
        self.assertNotIn('maxbar_pool', config)

    def test_missing_user_provider_roundtrips_and_unreachable_pool_leaves_config(self):
        self.config.write_text('model = "gpt-6.2-sol"\n')
        self.assertEqual(self.run_helper('pool'), 'Pool')
        self.assertEqual(self.run_helper('direct'), 'Direct')
        self.assertNotIn('model_provider =', self.config.read_text())
        before = self.config.read_bytes()
        self.pool.unlink()
        self.assertIn('MaxPool', self.run_helper('pool', succeeds=False))
        self.assertEqual(self.config.read_bytes(), before)

    def test_foreign_provider_with_reserved_name_is_preserved(self):
        self.config.write_text('[model_providers.maxbar_pool]\nname = "Other"\nbase_url = "https://example.com/v1"\n')
        before = self.config.read_bytes()
        self.assertIn('already', self.run_helper('pool', succeeds=False))
        self.assertEqual(self.config.read_bytes(), before)

    def test_installed_cli_and_desktop_app_server_send_inference_to_pool(self):
        self.config.write_text('model = "gpt-6.2-sol"\n')
        self.assertEqual(self.run_helper('pool'), 'Pool')
        cli = subprocess.run([shutil.which('codex'), 'exec', '--skip-git-repo-check', '--ephemeral',
                              'Respond with the test marker.'], env=self.env, cwd=self.home,
                             capture_output=True, text=True, timeout=25)
        self.assertEqual(cli.returncode, 0, cli.stderr[-1800:])
        self.assertEqual(cli.stdout.strip(), 'MAXBAR_POOL_FIXTURE')
        with subprocess.Popen([shutil.which('codex'), 'app-server'], env=self.env, cwd=self.home,
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                              text=True) as desktop_backend:
            def send(frame):
                desktop_backend.stdin.write(json.dumps(frame) + '\n')
                desktop_backend.stdin.flush()

            def receive(match):
                return next(frame for frame in map(json.loads, desktop_backend.stdout) if match(frame))

            timeout = Timer(20, desktop_backend.kill)
            timeout.start()
            try:
                send({'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'codex_desktop', 'version': '1'}}})
                receive(lambda frame: frame.get('id') == 1)
                send({'method': 'initialized'})
                send({'id': 2, 'method': 'modelProvider/list', 'params': {}})
                providers = receive(lambda frame: frame.get('id') == 2)['result']
                self.assertEqual(providers['defaultProviderId'], 'maxbar_pool')
                send({'id': 3, 'method': 'thread/start', 'params': {'cwd': str(self.home), 'ephemeral': True}})
                thread = receive(lambda frame: frame.get('id') == 3)['result']['thread']
                send({'id': 4, 'method': 'turn/start', 'params': {'threadId': thread['id'],
                      'input': [{'type': 'text', 'text': 'Respond with the test marker.'}]}})
                completed = receive(lambda frame: frame.get('method') == 'turn/completed')
                self.assertEqual(completed['params']['turn']['status'], 'completed', completed)
            finally:
                timeout.cancel()
                desktop_backend.terminate()
                desktop_backend.wait(timeout=5)
        self.assertEqual([request['model'] for request in Catalog.served], ['gpt-6.2-sol', 'gpt-6.2-sol'])


if __name__ == '__main__':
    unittest.main()
