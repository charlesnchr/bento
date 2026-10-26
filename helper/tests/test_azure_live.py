"""Offline transport and credential guards for azure_live.py. No credentials, microphone, or cloud calls."""
import asyncio
import base64
import contextlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import aiohttp

HELPER = Path(__file__).resolve().parents[1]
if str(HELPER) not in sys.path:
    sys.path.insert(0, str(HELPER))
import azure_live  # noqa: E402
from azure_live import azure_credentials, hermes_key_names, safe_error, session_start, validate_command  # noqa: E402

ENDPOINT = 'https://resource.openai.azure.com'


@contextlib.contextmanager
def fake_home(**environ):
    """An empty home and environment: no real Hermes config, env file, runtime or key is read."""
    with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'HOME': home, **environ}, clear=True):
        (Path(home) / '.hermes').mkdir()
        yield Path(home)


class AzureLiveTests(unittest.TestCase):
    def test_diagnostics_never_include_exception_or_server_content(self):
        secret = 'private transcript and api-key'
        for error in (ValueError(secret), RuntimeError(secret), asyncio.TimeoutError(secret),
                      aiohttp.ClientConnectionError(secret)):
            event = safe_error(error)
            self.assertNotIn(secret, str(event))
            self.assertEqual(event['type'], 'bento.error')
            self.assertIn(event['diagnostic_code'], {'invalid_event', 'transport_error', 'timeout', 'connection_error'})
        event = safe_error(aiohttp.ClientResponseError(None, (), status=403, message=secret))
        self.assertEqual(event['http_status'], 403)
        self.assertEqual(event['diagnostic_code'], 'http_error')
        self.assertNotIn(secret, str(event))
        self.assertEqual(safe_error(code='credentials_unavailable')['diagnostic_code'], 'credentials_unavailable')

    def test_pinned_live_without_intermediary_model(self):
        session = session_start()['session']
        self.assertEqual(session['model'], 'gpt-live-1')
        self.assertEqual(session['delegation'], {'type': 'client'})
        self.assertNotIn('gpt-5.4-mini', str(session))
        self.assertNotIn('tools', session)

    def test_audio_is_pcm_not_arbitrary_events(self):
        payload = {'type': 'session.input_audio.append', 'audio': base64.b64encode(bytes(4800)).decode()}
        self.assertEqual(validate_command(payload), payload)
        for audio in ('', 'not-base64', base64.b64encode(bytes(3)).decode(), base64.b64encode(bytes(48002)).decode()):
            with self.assertRaises(ValueError):
                validate_command({'type': 'session.input_audio.append', 'audio': audio})

    def test_no_remote_configuration_or_arbitrary_functions(self):
        for payload in ({'type': 'session.start'}, {'type': 'session.update', 'tools': []},
                        {'type': 'response.item.create', 'item': {'type': 'function_call', 'name': 'bash'}},
                        {'type': 'response.create', 'instructions': 'bypass approvals'}, None, []):
            with self.assertRaises(ValueError):
                validate_command(payload)

    def test_client_results_only_with_bounded_correlated_content(self):
        result = {'type': 'session.commentary.append', 'delegation_id': 'test-task', 'content': 'Not executed: denied'}
        validate_command(result)
        validate_command({**result, 'type': 'session.thinking.append'})
        validate_command({'type': 'session.close'})
        # 201 two-byte characters: under 400 characters but over the 400-byte cap.
        for invalid in ({**result, 'content': 'x' * 401}, {**result, 'content': 'é' * 201},
                        {**result, 'delegation_id': None}, {**result, 'delegation_id': ''},
                        {**result, 'instructions': 'run shell'}, {'type': 'response.create'},
                        {'type': 'response.item.create', 'item': {'type': 'function_call_output', 'output': 'test'}}):
            with self.assertRaises(ValueError):
                validate_command(invalid)


class AzureCredentialTests(unittest.TestCase):
    def test_azure_key_comes_from_hermes_config_without_bifrost(self):
        hermes = '''model:
  base_url: https://other-resource.openai.azure.com/openai/v1/
  key_env: WRONG_RESOURCE_KEY
providers:
  example:
    base_url: https://resource.openai.azure.com/openai/v1/
    api_mode: codex_responses
    models:
      test-model:
        context_length: 1000
    key_env: TEST_HERMES_KEY
realtime_audio:
  endpoint: https://resource.openai.azure.com
  key_env: SECOND_NAME
'''
        config = {'azure': {'endpoint': ENDPOINT, 'bifrost_config': '~/bifrost/config.json'}}
        with fake_home(TEST_HERMES_KEY='test-hermes-key', WRONG_RESOURCE_KEY='wrong') as home:
            (home / '.hermes/config.yaml').write_text(hermes)
            self.assertEqual(hermes_key_names(ENDPOINT), ['TEST_HERMES_KEY', 'SECOND_NAME'])
            for shape, expected in (
                    ('custom:\n  - base_url: https://resource.openai.azure.com/v1\n    key_env: K1\n  - base_url: https://x.openai.azure.com\n    key_env: K2\n', ['K1']),
                    ('custom:\n  - key_env: K2\n    name: other\n  - api_key_env: K1\n    url: https://Resource.openai.azure.com\n', ['K1']),
                    ('providers:\n  example:\n    base_url: https://resource.openai.azure.com\n# note\n    key_env: K1 # live\n', ['K1']),
                    ('providers:\n  example:\n    base_url: https://resource.openai.azure.com\n  other:\n    key_env: K2\n', [])):
                (home / '.hermes/config.yaml').write_text(shape)
                self.assertEqual(hermes_key_names(ENDPOINT), expected, shape)
            with patch.dict(os.environ, {'HERMES_HOME': str(home / 'missing')}):
                self.assertEqual(hermes_key_names(ENDPOINT), [])
            (home / '.hermes/config.yaml').write_text(hermes)
            self.assertEqual(azure_credentials(config), (ENDPOINT, 'test-hermes-key'))
            bifrost = home / 'bifrost/config.json'
            bifrost.parent.mkdir(parents=True)
            bifrost.write_text('{"providers": {"azure": {"keys": [{"value": "env.OTHER", "azure_key_config": '
                               '{"endpoint": "https://resource.openai.azure.com/"}}]}}}')
            with patch.dict(os.environ, {'OTHER': 'test-bifrost-key'}):
                self.assertEqual(azure_credentials(config)[1], 'test-bifrost-key', 'Bifrost config still wins when present')
            bifrost.write_text('{"providers": {"azure": {"keys": []}}}')
            self.assertEqual(azure_credentials(config)[1], 'test-hermes-key', 'Hermes covers a resource Bifrost lacks')
            with patch.dict(os.environ, {'BENTO_AZURE_ENDPOINT': 'https://other.openai.azure.com'}), \
                    self.assertRaisesRegex(ValueError, 'unavailable'):
                azure_credentials(config)

    def test_azure_key_precedence(self):
        environ = {'BENTO_AZURE_API_KEY': 'test-override', 'TEST_AZURE_KEY': 'test-config-key',
                   'BIFROST_AZURE_KEY': 'test-bifrost-key', 'TEST_HERMES_KEY': 'test-hermes-key'}
        config = {'azure': {'endpoint': ENDPOINT, 'api_key_env': 'TEST_AZURE_KEY', 'bifrost_config': '~/bifrost.json'}}
        with fake_home(**environ) as home:
            (home / '.hermes/config.yaml').write_text(
                'providers:\n  example:\n    base_url: https://resource.openai.azure.com/openai/v1\n    key_env: TEST_HERMES_KEY\n')
            (home / 'bifrost.json').write_text(json.dumps({'providers': {'azure': {'keys': [
                {'value': 'env.BIFROST_AZURE_KEY', 'azure_key_config': {'endpoint': 'https://other.openai.azure.com'}},
                {'value': 'env.BIFROST_AZURE_KEY', 'azure_key_config': {'endpoint': ENDPOINT}}]}}}))
            self.assertEqual(azure_credentials(config), (ENDPOINT, 'test-override'), 'BENTO_AZURE_API_KEY comes first')
            del os.environ['BENTO_AZURE_API_KEY']
            self.assertEqual(azure_credentials(config)[1], 'test-config-key', 'then the variable azure.api_key_env names')
            del os.environ['TEST_AZURE_KEY']
            self.assertEqual(azure_credentials(config)[1], 'test-bifrost-key', 'then the Bifrost key for this endpoint')
            del os.environ['BIFROST_AZURE_KEY']
            self.assertEqual(azure_credentials(config)[1], 'test-hermes-key', 'an unset env. reference falls through to Hermes')
            self.assertEqual(azure_credentials({'azure': {'endpoint': ENDPOINT}})[1], 'test-hermes-key')
            (home / 'bifrost.json').write_text(json.dumps({'providers': {'azure': {'keys': [
                {'value': 'test-literal-key', 'azure_key_config': {'endpoint': ENDPOINT}}]}}}))
            self.assertEqual(azure_credentials(config)[1], 'test-literal-key', 'A literal Bifrost value is used as is')
            del os.environ['TEST_HERMES_KEY']
            with self.assertRaisesRegex(ValueError, 'unavailable'):
                azure_credentials({'azure': {'endpoint': ENDPOINT, 'api_key_env': 'TEST_AZURE_KEY'}})

    def test_azure_keys_and_endpoint_may_come_from_env_files(self):
        with fake_home() as home:
            (home / '.hermes/.env').write_text('BENTO_AZURE_ENDPOINT=https://resource.openai.azure.com\nTEST_AZURE_KEY=test-hermes-file\n')
            config = {'azure': {'api_key_env': 'TEST_AZURE_KEY'}}
            self.assertEqual(azure_credentials(config), (ENDPOINT, 'test-hermes-file'), "Hermes's .env is read by default")
            with patch.dict(os.environ, {'TEST_AZURE_KEY': 'test-environment'}):
                self.assertEqual(azure_credentials(config)[1], 'test-environment', 'The environment overrides env files')
            (home / 'azure.env').write_text('TEST_AZURE_KEY=test-other-file\n')
            other = {'azure': {'endpoint': ENDPOINT, 'api_key_env': 'TEST_AZURE_KEY'}, 'env_files': ['~/azure.env']}
            self.assertEqual(azure_credentials(other)[1], 'test-other-file')
            with self.assertRaisesRegex(ValueError, 'endpoint'):
                azure_credentials({**config, 'env_files': ['~/azure.env']})

    def test_azure_endpoint_must_be_a_bare_resource(self):
        with fake_home(BENTO_AZURE_API_KEY='test-key'):
            self.assertEqual(azure_credentials({'azure': {'endpoint': ENDPOINT + '/'}}), (ENDPOINT, 'test-key'))
            with patch.dict(os.environ, {'BENTO_AZURE_ENDPOINT': 'https://other.openai.azure.com'}):
                self.assertEqual(azure_credentials({'azure': {'endpoint': ENDPOINT}})[0], 'https://other.openai.azure.com',
                                 'BENTO_AZURE_ENDPOINT overrides the runtime')
            for endpoint in (None, '', 'http://resource.openai.azure.com', 'https://resource.example.com',
                             'https://openai.azure.com', 'https://resource.openai.azure.com.example.com',
                             'https://resource.openai.azure.com/openai/v1', 'https://resource.openai.azure.com:8443',
                             'https://user:secret@resource.openai.azure.com', 'https://resource.openai.azure.com?x=1',
                             'https://resource.openai.azure.com#x', 'wss://resource.openai.azure.com'):
                with self.assertRaisesRegex(ValueError, 'Expected an Azure OpenAI resource endpoint', msg=endpoint):
                    azure_credentials({'azure': {'endpoint': endpoint}})
            with self.assertRaisesRegex(ValueError, 'endpoint'):
                azure_credentials({})

    def test_azure_credentials_default_to_the_runtime_config(self):
        with fake_home(BENTO_AZURE_API_KEY='test-key') as home:
            runtime = home / 'voice-runtime.json'
            os.environ['BENTO_VOICE_RUNTIME'] = str(runtime)
            self.assertEqual(azure_live.runtime_config(), {}, 'A missing runtime is empty')
            with self.assertRaisesRegex(ValueError, 'endpoint'):
                azure_credentials()
            runtime.write_text('{not json')
            self.assertEqual(azure_live.runtime_config(), {}, 'A malformed runtime is empty')
            runtime.write_text(json.dumps({'azure': {'endpoint': ENDPOINT}}))
            self.assertEqual(azure_live.runtime_config(), {'azure': {'endpoint': ENDPOINT}})
            self.assertEqual(azure_credentials(), (ENDPOINT, 'test-key'))
        self.assertEqual(azure_live.DEFAULT_RUNTIME, Path.home() / '.config/bento/voice-runtime.json')


if __name__ == '__main__':
    unittest.main()
