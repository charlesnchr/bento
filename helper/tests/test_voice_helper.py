"""Unit tests for voice-helper.py. No credentials, microphone or cloud calls."""
import asyncio
import contextlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

from aiohttp.test_utils import TestClient, TestServer

HELPER = Path(__file__).resolve().parents[1]
if str(HELPER) not in sys.path:
    # voice-helper.py imports azure_live from its own directory.
    sys.path.insert(0, str(HELPER))
import azure_live  # noqa: E402,F401  (patched below as 'azure_live.azure_credentials')

spec = importlib.util.spec_from_file_location('voice_helper', HELPER / 'voice-helper.py')
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)

GATEWAY_MODEL = 'test-gateway-model'
TEXT_BODY = {'contents': [{'parts': [{'text': 'clean me'}]}]}
AUDIO_BODY = {'contents': [{'parts': [{'inlineData': {'mimeType': 'audio/flac', 'data': 'AQ=='}}]}]}


@contextlib.contextmanager
def fake_home(**environ):
    """An empty home and environment, so no real env file or key is read."""
    with tempfile.TemporaryDirectory() as home, patch.dict(os.environ, {'HOME': home, **environ}, clear=True):
        yield Path(home)


class Credentials:
    valid = False
    token = None
    calls = 0
    def refresh(self, request):
        self.calls += 1
        self.valid = True
        self.token = 'test-only-token'


class Response:
    status = 200
    headers = {}
    result = None
    async def __aenter__(self): return self
    async def __aexit__(self, *args): pass
    async def json(self): return self.result


class Session:
    def __init__(self, response):
        self.response = response
    def post(self, url, **kwargs):
        self.url, self.kwargs = url, kwargs
        return self.response


class HelperTests(unittest.IsolatedAsyncioTestCase):
    def test_model_constants(self):
        self.assertEqual(helper.CLEANUP_MODEL, 'gemini-3.5-flash-lite')
        self.assertEqual(helper.EDITING_MODEL, 'gemini-3.8-flash')
        self.assertEqual(helper.MODEL, 'gemini-3.5-transcribe-preview')
        self.assertEqual(helper.LIVE_MODEL, 'gemini-3.5-transcribe-live-preview')
        self.assertEqual(helper.GPT_MODEL, 'gpt-transcribe')
        self.assertEqual(helper.LUNA_MODEL, 'gpt-6-luna')
        self.assertEqual(helper.MAI_MODEL, 'mai-transcribe-2')

    async def asyncSetUp(self):
        self.config = {'project': 'example-project', 'bifrost_key': 'test-only-secret',
                       'gateway': {'models': [GATEWAY_MODEL], 'key_env': ['TEST_GATEWAY_KEY']}}
        self.credentials = Credentials()
        self.client = TestClient(TestServer(helper.make_app(self.config, self.credentials)))
        await self.client.start_server()
        self.headers = {'Host': '127.0.0.1:8767', 'x-goog-api-key': 'test-only-secret'}

    async def asyncTearDown(self):
        await self.client.close()

    async def test_auth_and_origin(self):
        response = await self.client.get('/health', headers={'Host': '127.0.0.1:8767'})
        self.assertEqual(response.status, 401)
        response = await self.client.get('/health', headers={**self.headers, 'x-goog-api-key': 'wrong'})
        self.assertEqual(response.status, 401)
        response = await self.client.get('/health', headers={**self.headers, 'Origin': 'https://example.com'})
        self.assertEqual(response.status, 403)
        for host in ('localhost:8767', '127.0.0.1:8768', 'example.com'):
            response = await self.client.get('/health', headers={**self.headers, 'Host': host})
            self.assertEqual(response.status, 403, host)
        response = await self.client.get('/health', headers=self.headers)
        self.assertEqual(response.status, 200)

    async def test_host_check_follows_the_configured_port(self):
        self.assertEqual(helper.listen_port({}), 8767)
        self.assertEqual(helper.listen_port({'bifrost_base_url': 'http://127.0.0.1:9100'}), 9100)
        client = TestClient(TestServer(helper.make_app({**self.config, 'bifrost_base_url': 'http://127.0.0.1:9100'},
                                                       self.credentials)))
        await client.start_server()
        try:
            response = await client.get('/health', headers={**self.headers, 'Host': '127.0.0.1:9100'})
            self.assertEqual(response.status, 200)
            response = await client.get('/health', headers=self.headers)
            self.assertEqual(response.status, 403, 'The default port is refused once another is configured')
        finally:
            await client.close()

    async def test_restricted_models_and_content(self):
        response = await self.client.post('/v1beta/models/unapproved:generateContent', headers=self.headers, json={})
        self.assertEqual(response.status, 403)
        response = await self.client.post('/v1beta/models/' + helper.MODEL + ':generateContent', headers=self.headers,
            json={'contents': [{'parts': [{'fileData': {'fileUri': 'gs://example-bucket/file'}}]}]})
        self.assertEqual(response.status, 400)
        self.assertEqual(self.credentials.calls, 0)

    async def test_cleanup_and_editing_models_share_the_inline_content_guard(self):
        for model in (helper.CLEANUP_MODEL, helper.EDITING_MODEL, helper.GPT_MODEL, helper.LUNA_MODEL,
                      helper.MAI_MODEL, GATEWAY_MODEL):
            response = await self.client.post('/v1beta/models/' + model + ':generateContent', headers=self.headers,
                json={'contents': [{'parts': [{'fileData': {'fileUri': 'gs://example-bucket/file'}}]}]})
            self.assertEqual(response.status, 400, 'Enabled model must still reject external file content')
        self.assertEqual(self.credentials.calls, 0)

    async def test_azure_input_is_validated_before_credentials(self):
        cases = [(helper.GPT_MODEL, {'text': 'not audio'}),
                 (helper.GPT_MODEL, {'inlineData': {'mimeType': 'audio/flac', 'data': 'invalid!'}}),
                 (helper.LUNA_MODEL, {'inlineData': {'mimeType': 'audio/flac', 'data': 'AQ=='}})]
        with patch('azure_live.azure_credentials', side_effect=AssertionError('Must not access credentials')):
            for model, part in cases:
                response = await self.client.post('/v1beta/models/' + model + ':generateContent',
                    headers=self.headers, json={'contents': [{'parts': [part]}]})
                self.assertEqual(response.status, 400)
        self.assertEqual(self.credentials.calls, 0)

    async def test_azure_malformed_containers_do_not_reach_credentials(self):
        bodies = [{'contents': None}, {'contents': [None]}, {'contents': [{'parts': None}]},
                  {'contents': [{'parts': [{'inlineData': None}]}]},
                  {'contents': [{'parts': [{'inlineData': {'mimeType': 'audio/flac', 'data': 'AQ=='}}]}],
                   'generationConfig': None}]
        with patch('azure_live.azure_credentials', side_effect=AssertionError('Must not access credentials')):
            for body in bodies:
                response = await self.client.post('/v1beta/models/gpt-transcribe:generateContent',
                    headers=self.headers, json=body)
                self.assertEqual(response.status, 400)

    async def test_waiting_azure_requests_leave_gemini_slots_available(self):
        bridge = helper.VertexBridge(self.config, self.credentials)
        await bridge.azure_slots.acquire()
        ready = asyncio.Event()
        def credentials(config=None):
            ready.set()
            return 'https://resource.openai.azure.com', 'test-key'
        with patch('azure_live.azure_credentials', side_effect=credentials):
            tasks = [asyncio.create_task(bridge.azure_generate(helper.LUNA_MODEL, TEXT_BODY)) for _ in range(4)]
            try:
                await asyncio.wait_for(ready.wait(), 1)
                await asyncio.wait_for(bridge.slots.acquire(), .1)
                bridge.slots.release()
            finally:
                for task in tasks: task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                bridge.azure_slots.release()

    async def test_azure_routes_and_safe_response_envelope(self):
        bridge = helper.VertexBridge(self.config, self.credentials)
        response = Response()
        bridge.session = Session(response)
        with patch('azure_live.azure_credentials', return_value=('https://resource.openai.azure.com', 'test-key')) as credentials:
            response.result = {'text': 'Raw transcript.'}
            result = await bridge.azure_generate(helper.GPT_MODEL, {'contents': [{'parts': [
                {'inlineData': {'mimeType': 'audio/flac', 'data': 'AQ=='}}]}]})
            credentials.assert_called_with(self.config)
            self.assertEqual(json.loads(result.body)['candidates'][0]['content']['parts'][0]['text'], 'Raw transcript.')
            self.assertTrue(bridge.session.url.startswith('https://resource.openai.azure.com/openai/deployments/gpt-transcribe/audio/transcriptions?'))
            self.assertEqual(bridge.session.kwargs['headers'], {'api-key': 'test-key'})
            response.result = {'choices': [{'finish_reason': 'stop', 'message': {'content': 'Clean transcript.'}}]}
            result = await bridge.azure_generate(helper.LUNA_MODEL, TEXT_BODY)
            credentials.assert_called_with(self.config)
            self.assertEqual(bridge.session.url, 'https://resource.openai.azure.com/openai/v1/chat/completions')
            self.assertEqual(bridge.session.kwargs['json']['model'], 'gpt-6-luna')
            self.assertEqual(bridge.session.kwargs['json']['reasoning_effort'], 'none')
            self.assertEqual(json.loads(result.body)['modelVersion'], 'gpt-6-luna')
            await bridge.azure_generate(helper.LUNA_MODEL, {'contents': [{'parts': [{'text': 'x' * 600100}]}]})
            self.assertEqual(len(bridge.session.kwargs['json']['messages'][0]['content']), 600100)
            response.status = 429
            response.headers = {'Retry-After': '5'}
            result = await bridge.azure_generate(helper.LUNA_MODEL, TEXT_BODY)
            self.assertEqual(result.status, 429)
            self.assertEqual(result.headers['Retry-After'], '5')
            self.assertNotIn(b'test-key', result.body)
            response.status = 200
            response.result = {'choices': [{'finish_reason': 'length', 'message': {'content': 'partial'}}]}
            with self.assertRaises(helper.web.HTTPBadGateway):
                await bridge.azure_generate(helper.LUNA_MODEL, TEXT_BODY)

    async def test_mai_input_is_validated_before_credentials(self):
        with patch.object(helper, 'openrouter_key', side_effect=AssertionError('Must not access credentials')):
            for part in ({'text': 'not audio'}, {'inlineData': {'mimeType': 'audio/ogg', 'data': 'AQ=='}}):
                response = await self.client.post('/v1beta/models/mai-transcribe-2:generateContent',
                    headers=self.headers, json={'contents': [{'parts': [part]}]})
                self.assertEqual(response.status, 400)

    async def test_mai_routes_to_openrouter_with_dictionary_phrases(self):
        bridge = helper.VertexBridge(self.config, self.credentials)
        response = Response()
        bridge.session = Session(response)
        response.result = {'text': 'Raw transcript.', 'usage': {'seconds': 1}}
        body = {'contents': [{'parts': [{'inlineData': {'mimeType': 'audio/flac', 'data': 'AQ=='}}]}],
                'generationConfig': {'audioTranscriptionConfig': {'customVocabulary': ['Hermes', 'Bento']}}}
        with patch.object(helper, 'openrouter_key', return_value='test-key') as key:
            result = await bridge.openrouter_generate(body)
            key.assert_called_with(self.config)
            self.assertEqual(bridge.session.url, 'https://openrouter.ai/api/v1/audio/transcriptions')
            sent = bridge.session.kwargs['json']
            self.assertEqual(sent['model'], 'microsoft/mai-transcribe-2')
            self.assertEqual(sent['input_audio'], {'data': 'AQ==', 'format': 'flac'})
            self.assertEqual(sent['provider']['options']['azure']['phraseList']['phrases'], ['Hermes', 'Bento'])
            self.assertEqual(bridge.session.kwargs['headers'], {'Authorization': 'Bearer test-key'})
            self.assertIsNotNone(bridge.session.kwargs['ssl'])
            self.assertEqual(json.loads(result.body)['modelVersion'], 'mai-transcribe-2')
            self.assertEqual(json.loads(result.body)['candidates'][0]['content']['parts'][0]['text'], 'Raw transcript.')
            del body['generationConfig']
            await bridge.openrouter_generate(body)
            self.assertNotIn('provider', bridge.session.kwargs['json'])
            response.status = 401
            result = await bridge.openrouter_generate(body)
            self.assertEqual(result.status, 401)
            self.assertNotIn(b'test-key', result.body)

    async def test_gateway_input_is_validated_before_credentials(self):
        with patch.object(helper, 'gateway_key', side_effect=AssertionError('Must not access credentials')):
            for part in ({'inlineData': {'mimeType': 'audio/flac', 'data': 'AQ=='}}, {'text': ' '}):
                response = await self.client.post('/v1beta/models/' + GATEWAY_MODEL + ':generateContent',
                    headers=self.headers, json={'contents': [{'parts': [part]}]})
                self.assertEqual(response.status, 400)

    async def test_gateway_models_come_only_from_config(self):
        self.assertEqual(helper.gateway_config({}), {'url': 'http://127.0.0.1:4000', 'models': [],
                                                     'key_env': ['BENTO_GATEWAY_API_KEY', 'LITELLM_API_KEY']})
        self.assertEqual(helper.gateway_config({'gateway': {'url': 'http://127.0.0.1:4100/', 'models': (GATEWAY_MODEL,),
                                                            'key_env': ('TEST_GATEWAY_KEY',)}}),
                         {'url': 'http://127.0.0.1:4100', 'models': [GATEWAY_MODEL], 'key_env': ['TEST_GATEWAY_KEY']})
        with patch.object(helper.VertexBridge, 'gateway_generate', autospec=True,
                          return_value=helper.web.json_response({'routed': True})) as relay:
            response = await self.client.post('/v1beta/models/' + GATEWAY_MODEL + ':generateContent',
                                              headers=self.headers, json=TEXT_BODY)
            self.assertEqual(response.status, 200)
            self.assertEqual(relay.call_args.args[1:], (GATEWAY_MODEL, TEXT_BODY))
            unconfigured = {key: value for key, value in self.config.items() if key != 'gateway'}
            client = TestClient(TestServer(helper.make_app(unconfigured, self.credentials)))
            await client.start_server()
            try:
                response = await client.post('/v1beta/models/' + GATEWAY_MODEL + ':generateContent',
                                             headers=self.headers, json=TEXT_BODY)
                self.assertEqual(response.status, 403, 'A gateway model is enabled only when configured')
            finally:
                await client.close()
            self.assertEqual(relay.call_count, 1)

    async def test_gateway_routes_to_the_gateway_with_a_safe_envelope(self):
        bridge = helper.VertexBridge(self.config, self.credentials)
        response = Response()
        bridge.session = Session(response)
        response.result = {'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': 'Clean transcript.'}]}
        with patch.object(helper, 'gateway_key', return_value='test-key') as key:
            result = await bridge.gateway_generate(GATEWAY_MODEL, TEXT_BODY)
            key.assert_called_with(self.config)
            self.assertEqual(bridge.session.url, 'http://127.0.0.1:4000/v1/messages')
            self.assertEqual(bridge.session.kwargs['json']['model'], GATEWAY_MODEL)
            self.assertEqual(bridge.session.kwargs['json']['messages'], [{'role': 'user', 'content': 'clean me'}])
            self.assertEqual(bridge.session.kwargs['headers']['x-api-key'], 'test-key')
            self.assertEqual(bridge.session.kwargs['headers']['anthropic-version'], '2023-06-01')
            self.assertEqual(json.loads(result.body)['modelVersion'], GATEWAY_MODEL)
            self.assertEqual(json.loads(result.body)['candidates'][0]['content']['parts'][0]['text'], 'Clean transcript.')
            response.status = 401
            result = await bridge.gateway_generate(GATEWAY_MODEL, TEXT_BODY)
            self.assertEqual(result.status, 401)
            self.assertNotIn(b'test-key', result.body)
            response.status = 200
            response.result = {'stop_reason': 'max_tokens', 'content': [{'type': 'text', 'text': 'partial'}]}
            with self.assertRaises(helper.web.HTTPBadGateway):
                await bridge.gateway_generate(GATEWAY_MODEL, TEXT_BODY)
            # The gateway URL comes from the runtime config.
            bridge = helper.VertexBridge({**self.config, 'gateway': {**self.config['gateway'], 'url': 'http://127.0.0.1:4100/'}},
                                         self.credentials)
            bridge.session = Session(response)
            response.result = {'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': 'Clean transcript.'}]}
            await bridge.gateway_generate(GATEWAY_MODEL, TEXT_BODY)
            self.assertEqual(bridge.session.url, 'http://127.0.0.1:4100/v1/messages')

    def test_gateway_key_follows_the_configured_key_env_order(self):
        config = {'gateway': {'models': [GATEWAY_MODEL], 'key_env': ['TEST_GATEWAY_KEY', 'LITELLM_API_KEY']}}
        with fake_home() as home:
            (home / '.hermes').mkdir()
            (home / '.hermes/.env').write_text('LITELLM_API_KEY=test-plain\nTEST_GATEWAY_KEY=test-preferred\n')
            self.assertEqual(helper.gateway_key(config), 'test-preferred', 'The first configured name wins, not file order')
            reordered = {'gateway': {'key_env': ['LITELLM_API_KEY', 'TEST_GATEWAY_KEY']}}
            self.assertEqual(helper.gateway_key(reordered), 'test-plain')
            self.assertEqual(helper.gateway_key({}), 'test-plain', 'Defaults fall back to LITELLM_API_KEY')
            with patch.dict(os.environ, {'BENTO_GATEWAY_API_KEY': 'test-override'}):
                self.assertEqual(helper.gateway_key({}), 'test-override', 'BENTO_GATEWAY_API_KEY is the default first choice')
            with patch.dict(os.environ, {'TEST_GATEWAY_KEY': 'test-environment'}):
                self.assertEqual(helper.gateway_key(config), 'test-environment', 'The environment overrides env files')
            (home / '.hermes/.env').write_text('TEST_GATEWAY_KEY=\n')
            for unset in (config, {}):
                with self.assertRaises(ValueError):
                    helper.gateway_key(unset)

    def test_openrouter_key_comes_from_hermes_env(self):
        with fake_home() as home:
            (home / '.hermes').mkdir()
            (home / '.hermes/.env').write_text('OPENROUTER_API_KEY=test-hermes-key\n')
            self.assertEqual(helper.openrouter_key(), 'test-hermes-key')
            self.assertEqual(helper.openrouter_key(self.config), 'test-hermes-key')
            with patch.dict(os.environ, {'BENTO_OPENROUTER_API_KEY': 'test-override'}):
                self.assertEqual(helper.openrouter_key(), 'test-override')
            (home / 'other.env').write_text('OPENROUTER_API_KEY=test-other-key\n')
            self.assertEqual(helper.openrouter_key({'env_files': ['~/other.env']}), 'test-other-key')
            (home / '.hermes/.env').write_text('')
            with self.assertRaises(ValueError):
                helper.openrouter_key()

    def test_env_files_come_from_config(self):
        with fake_home() as home:
            (home / '.hermes').mkdir()
            (home / '.hermes/.env').write_text('TEST_NAME=test-hermes\n')
            self.assertEqual(helper.hermes_env()['TEST_NAME'], 'test-hermes', "Hermes's .env is the default")
            self.assertEqual(helper.hermes_env({})['TEST_NAME'], 'test-hermes')
            (home / 'a.env').write_text('TEST_NAME=test-a\nTEST_ONLY_A=test-a\n')
            (home / 'b.env').write_text('TEST_NAME=test-b\n')
            env = helper.hermes_env({'env_files': [str(home / 'a.env'), '~/b.env', '~/missing.env']})
            self.assertEqual((env['TEST_NAME'], env['TEST_ONLY_A']), ('test-b', 'test-a'), 'Later files override earlier ones')
            self.assertNotIn('TEST_NAME', helper.hermes_env({'env_files': []}), 'Configured files replace the default')
            with patch.dict(os.environ, {'TEST_NAME': 'test-environment'}):
                self.assertEqual(helper.hermes_env({'env_files': ['~/b.env']})['TEST_NAME'], 'test-environment')

    async def test_upstream_proxy_comes_only_from_config(self):
        for config, proxy in ((self.config, None), ({**self.config, 'proxy': 'http://127.0.0.1:13128'}, 'http://127.0.0.1:13128')):
            with patch.object(helper.aiohttp, 'ClientSession', wraps=helper.aiohttp.ClientSession) as session:
                client = TestClient(TestServer(helper.make_app(config, self.credentials)))
                await client.start_server()
                await client.close()
            self.assertNotIn('proxy', session.call_args.kwargs, 'The proxy is per request, not session-wide')
            self.assertFalse(session.call_args.kwargs['trust_env'])
            self.assertEqual(helper.VertexBridge(config, self.credentials).proxy, proxy)

    async def test_proxy_reaches_cloud_calls_but_not_the_local_gateway(self):
        config = {**self.config, 'proxy': 'http://127.0.0.1:13128'}
        bridge = helper.VertexBridge(config, self.credentials)
        response = Response()
        response.result = {'stop_reason': 'end_turn', 'content': [{'type': 'text', 'text': 'ok'}]}
        bridge.session = Session(response)
        with patch.object(helper, 'gateway_key', return_value='test-key'):
            await bridge.gateway_generate(GATEWAY_MODEL, TEXT_BODY)
        self.assertIsNone(bridge.session.kwargs.get('proxy'), 'The gateway runs on this Mac')
        response.result = {'text': 'transcript'}
        with patch('azure_live.azure_credentials', return_value=('https://resource.openai.azure.com', 'test-key')):
            await bridge.azure_generate(helper.GPT_MODEL, AUDIO_BODY)
        self.assertEqual(bridge.session.kwargs.get('proxy'), 'http://127.0.0.1:13128')

    async def test_refresh_is_serialized_and_reused(self):
        bridge = helper.VertexBridge(self.config, self.credentials)
        await asyncio.gather(*(bridge.headers() for _ in range(10)))
        self.assertEqual(self.credentials.calls, 1)
        self.credentials.valid = False
        await bridge.headers()
        self.assertEqual(self.credentials.calls, 2)

    def test_conversation_setup_is_owned_by_the_helper(self):
        self.assertEqual(helper.CONVERSATION_MODEL, 'gemini-3.8-live')
        self.assertEqual(helper.CONVERSATION_LOCATION, 'us-central1')
        bridge = helper.VertexBridge(self.config, self.credentials)
        resource = bridge.resource(helper.CONVERSATION_MODEL, helper.CONVERSATION_LOCATION)
        self.assertEqual(resource, 'projects/example-project/locations/us-central1/publishers/google/models/gemini-3.8-live')
        self.assertEqual(bridge.resource(helper.MODEL), 'projects/example-project/locations/global/publishers/google/models/' + helper.MODEL)
        setup = helper.conversation_setup(resource)
        self.assertEqual(setup['model'], resource)
        self.assertEqual(setup['generationConfig']['responseModalities'], ['AUDIO'])
        self.assertEqual(setup['generationConfig']['speechConfig']['voiceConfig']['prebuiltVoiceConfig']['voiceName'], 'Charon')
        self.assertEqual(setup['tools'], [{'functionDeclarations': [{'name': 'ask_hermes', 'description': setup['tools'][0]['functionDeclarations'][0]['description']}]}],
                         'One argument-free function; no search, code execution or URL tools')
        self.assertEqual(setup['inputAudioTranscription']['customVocabulary'], ['Hermes', 'Bento'])
        self.assertEqual(setup['outputAudioTranscription'], {})
        self.assertIn('ask_hermes', setup['systemInstruction']['parts'][0]['text'])
        self.assertEqual(setup['tools'][0]['functionDeclarations'][0]['name'], helper.CONVERSATION_TOOL)
        self.assertEqual(set(setup), {'model', 'generationConfig', 'systemInstruction', 'tools',
                                      'inputAudioTranscription', 'outputAudioTranscription'},
                         'The app sends the same file to the Gemini API, so it holds nothing Vertex-only')

    async def test_conversation_without_its_setup_file_fails_only_the_call(self):
        upstream = self.upstream([], None)
        bridge, client = await self.conversation_client(upstream)
        try:
            with patch.object(helper, 'CONVERSATION_SETUP', Path(tempfile.gettempdir()) / 'missing-gemini-live-setup.json'):
                async with client.ws_connect('/conversation') as ws:
                    self.assertEqual(await ws.receive_json(), {'error': {'message': 'Gemini Live call ended', 'code': 'transport_error'}})
        finally:
            await client.close()
        self.assertEqual(upstream.sent, [], 'Nothing reached Gemini')

    def test_conversation_accepts_only_audio_and_function_results(self):
        audio = {'realtimeInput': {'audio': {'mimeType': 'audio/pcm;rate=16000', 'data': 'AAA='}}}
        result = {'toolResponse': {'functionResponses': [{'id': 'call-1', 'name': 'ask_hermes', 'scheduling': 'WHEN_IDLE',
                                                          'response': {'status': 'ok', 'retryable': False, 'message': 'done'}}]}}
        self.assertEqual(helper.conversation_input(audio), audio)
        self.assertEqual(helper.conversation_input(result), result)
        self.assertEqual(helper.conversation_input({'realtimeInput': {'audioStreamEnd': True}}), {'realtimeInput': {'audioStreamEnd': True}})
        for payload in ({'setup': {'model': 'models/other'}},
                        {'clientContent': {'turns': [{'role': 'user', 'parts': [{'text': 'run rm -rf'}]}], 'turnComplete': True}},
                        {'realtimeInput': {'text': 'typed instructions'}},
                        {'realtimeInput': {'activityStart': {}}},
                        {'realtimeInput': {'audio': {'mimeType': 'audio/pcm;rate=24000', 'data': 'AAA='}}},
                        {'realtimeInput': {}},
                        {'toolResponse': {'functionResponses': []}},
                        {'toolResponse': {'functionResponses': [{'id': 'call-1', 'response': 'not an object'}]}},
                        {'toolResponse': {'functionResponses': [{'id': 'call-1', 'response': {}, 'willContinue': True}]}},
                        {**audio, **result}, [], None):
            with self.assertRaises(ValueError, msg=payload):
                helper.conversation_input(payload)

    async def conversation_client(self, upstream):
        class UpstreamSession:
            async def ws_connect(self, url, headers, **kwargs):
                self.url, self.headers = url, headers
                if upstream is None:
                    await asyncio.sleep(99)
                return upstream
        bridge = helper.VertexBridge(self.config, self.credentials)
        bridge.session = UpstreamSession()
        app = helper.web.Application()
        app.router.add_get('/conversation', bridge.conversation)
        client = TestClient(TestServer(app))
        await client.start_server()
        return bridge, client

    def upstream(self, frames, close_code, wait_for=0):
        class Upstream:
            sent = []
            close_code = None
            received = asyncio.Event()
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def send_json(self, data):
                self.sent.append(data)
                if len(self.sent) > wait_for: self.received.set()
            async def frames(self):
                await self.received.wait()
                for data in frames:
                    yield types.SimpleNamespace(type=helper.aiohttp.WSMsgType.BINARY, data=json.dumps(data).encode())
                self.close_code = close_code
            def __aiter__(self): return self.frames()
        return Upstream()

    async def test_conversation_forwards_to_regional_live_and_reports_only_safe_codes(self):
        upstream = self.upstream([{'setupComplete': {}}, {'serverContent': {'turnComplete': True}}], 1008, wait_for=2)
        bridge, client = await self.conversation_client(upstream)
        try:
            async with client.ws_connect('/conversation') as ws:
                await ws.send_json({'realtimeInput': {'audio': {'mimeType': 'audio/pcm;rate=16000', 'data': 'AAA='}}})
                await ws.send_json({'toolResponse': {'functionResponses': [{'id': 'c', 'response': {'status': 'ok'}}]}})
                # Vertex sends JSON in binary frames; they're forwarded as they came.
                self.assertEqual(json.loads((await ws.receive()).data), {'setupComplete': {}})
                self.assertEqual(json.loads((await ws.receive()).data), {'serverContent': {'turnComplete': True}})
                self.assertEqual(await ws.receive_json(), {'error': {'message': 'Gemini Live call ended',
                                                                     'code': 'upstream_closed', 'closeCode': 1008}})
        finally:
            await client.close()
        self.assertEqual(bridge.session.url, 'wss://us-central1-aiplatform.googleapis.com'
                                             '/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent')
        self.assertEqual(bridge.session.headers, {'Authorization': 'Bearer test-only-token'})
        self.assertEqual(upstream.sent[0]['setup']['model'],
                         'projects/example-project/locations/us-central1/publishers/google/models/gemini-3.8-live')
        self.assertEqual([next(iter(m)) for m in upstream.sent[1:]], ['realtimeInput', 'toolResponse'])

    async def test_conversation_drops_disallowed_client_messages(self):
        upstream = self.upstream([], None, wait_for=99)
        bridge, client = await self.conversation_client(upstream)
        try:
            async with client.ws_connect('/conversation') as ws:
                await ws.send_json({'clientContent': {'turns': [], 'turnComplete': True}})
                self.assertEqual(await ws.receive_json(), {'error': {'message': 'Gemini Live call ended', 'code': 'invalid_message'}})
        finally:
            await client.close()
        self.assertEqual(len(upstream.sent), 1, 'Only the setup reached Gemini')

    async def test_conversation_allows_one_call_without_touching_credentials(self):
        bridge, client = await self.conversation_client(self.upstream([], None))
        await bridge.conversation_slot.acquire()
        try:
            async with client.ws_connect('/conversation') as ws:
                self.assertEqual(await ws.receive_json(), {'error': {'message': 'Gemini Live call ended', 'code': 'busy'}})
        finally:
            bridge.conversation_slot.release()
            await client.close()
        self.assertEqual(self.credentials.calls, 0)
        self.assertEqual(bridge.slots._value, 4, 'A call never takes a dictation or meeting slot')

    async def test_conversation_close_after_go_away_is_not_a_send_failure(self):
        class Upstream:
            sent = []
            close_code = None
            closing = asyncio.Event()
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def send_json(self, data):
                if 'setup' in data:
                    self.sent.append(data); return
                # Gemini is closing at its time limit; the close frame is not read yet.
                self.closing.set()
                raise helper.aiohttp.ClientConnectionResetError('Cannot write to closing transport')
            async def frames(self):
                await self.closing.wait()
                await asyncio.sleep(.2)
                self.close_code = 1000
                return
                yield
            def __aiter__(self): return self.frames()
        bridge, client = await self.conversation_client(Upstream())
        try:
            async with client.ws_connect('/conversation') as ws:
                await ws.send_json({'realtimeInput': {'audio': {'mimeType': 'audio/pcm;rate=16000', 'data': 'AAA='}}})
                self.assertEqual(await ws.receive_json(), {'error': {'message': 'Gemini Live call ended',
                                                                     'code': 'upstream_closed', 'closeCode': 1000}})
        finally:
            await client.close()

    async def test_conversation_stalled_upgrade_releases_the_slot(self):
        original = helper.CONVERSATION_CONNECT_TIMEOUT
        helper.CONVERSATION_CONNECT_TIMEOUT = .2
        bridge, client = await self.conversation_client(None)
        try:
            async with client.ws_connect('/conversation') as ws:
                self.assertEqual(await ws.receive_json(), {'error': {'message': 'Gemini Live call ended', 'code': 'timeout'}})
        finally:
            helper.CONVERSATION_CONNECT_TIMEOUT = original
            await client.close()
        self.assertFalse(bridge.conversation_slot.locked())

    async def test_conversation_route_requires_the_helper_key(self):
        response = await self.client.get('/conversation', headers={'Host': '127.0.0.1:8767'})
        self.assertEqual(response.status, 401)
        response = await self.client.get('/conversation', headers={**self.headers, 'Origin': 'https://example.com'})
        self.assertEqual(response.status, 403)

    async def test_websocket_rejects_unapproved_model(self):
        async with self.client.ws_connect('/live', headers=self.headers) as ws:
            await ws.send_json({'setup': {'model': 'models/unapproved'}})
            response = await ws.receive_json()
            self.assertIn('error', response)
        self.assertEqual(self.credentials.calls, 0)


if __name__ == '__main__':
    unittest.main()
