"""Authenticated loopback bridge for Bento's dictation, meetings and voice calls.

Bento talks to Vertex AI (and, for some models, Azure, OpenRouter or a local
gateway) through this helper so the app never holds cloud credentials. Google
auth owns token refresh. See helper/README.md for setup.
"""
import asyncio
import argparse
import base64
import hmac
import json
import os
from pathlib import Path
import ssl
from urllib.parse import urlsplit

import aiohttp
from aiohttp import web
import google.auth
from google.auth.transport.requests import Request

MODEL = 'gemini-3.5-transcribe-preview'
LIVE_MODEL = 'gemini-3.5-transcribe-live-preview'
CLEANUP_MODEL = 'gemini-3.5-flash-lite'
EDITING_MODEL = 'gemini-3.8-flash'
GPT_MODEL = 'gpt-transcribe'
LUNA_MODEL = 'gpt-6-luna'
MAI_MODEL = 'mai-transcribe-2'
OPENROUTER_TRANSCRIBE = 'https://openrouter.ai/api/v1/audio/transcriptions'
# Assistant voice calls. 3.8 Live has no global endpoint; us-central1 is its documented regional host.
CONVERSATION_MODEL = 'gemini-3.8-live'
CONVERSATION_LOCATION = 'us-central1'
CONVERSATION_TOOL = 'ask_hermes'
# A stalled upgrade must not hold the one call slot; the app gives up after 25 s.
CONVERSATION_CONNECT_TIMEOUT = 20


AUDIO_EXTENSIONS = {'audio/flac': 'flac', 'audio/wav': 'wav', 'audio/x-wav': 'wav'}


def inline_audio(parts, body):
    """The one recording and dictionary terms of a transcription request, validated before credentials."""
    if len(parts) != 1 or set(parts[0]) not in ({'inlineData'}, {'inline_data'}):
        raise web.HTTPBadRequest(text='Expected one inline audio recording')
    inline = parts[0].get('inlineData', parts[0].get('inline_data'))
    if not isinstance(inline, dict):
        raise web.HTTPBadRequest(text='Expected inline audio data')
    mime = inline.get('mimeType', inline.get('mime_type'))
    if mime not in AUDIO_EXTENSIONS:
        raise web.HTTPBadRequest(text='Expected FLAC or WAV audio')
    try:
        audio = base64.b64decode(inline['data'], validate=True)
    except (ValueError, KeyError, TypeError):
        raise web.HTTPBadRequest(text='Invalid inline audio')
    if not audio or len(audio) > 16 * 1024 * 1024:
        raise web.HTTPBadRequest(text='Audio is empty or too large')
    generation = body.get('generationConfig', {})
    if not isinstance(generation, dict) or not isinstance(generation.get('audioTranscriptionConfig', {}), dict):
        raise web.HTTPBadRequest(text='Invalid transcription config')
    vocabulary = generation.get('audioTranscriptionConfig', {}).get('customVocabulary', [])
    if not isinstance(vocabulary, list) or any(not isinstance(term, str) for term in vocabulary):
        raise web.HTTPBadRequest(text='Invalid vocabulary')
    return audio, mime, vocabulary


# The call setup, shared with the app, which sends it itself when calls go to the Gemini API with
# the user's key. The synthetic probe heard "Hermes" as "Holmes", hence its vocabulary hints.
CONVERSATION_SETUP = Path(__file__).with_name('gemini_live_setup.json')


def conversation_setup(resource, resume=None):
    """The whole call setup lives in gemini_live_setup.json, as GPT-Live's lives in azure_live.py:
    Bento sends only audio and results. A resumed call (/conversation/resume, azure_live.resume_context)
    adds a fixed line to the instructions; its transcript follows as a user turn (conversation_recap).
    Read on use, so a missing file fails the call, not the helper."""
    setup = {**json.loads(CONVERSATION_SETUP.read_text()), 'model': resource}
    if resume:
        setup['systemInstruction']['parts'][0]['text'] += resume['instruction']
    return setup


def conversation_recap(resume):
    """The earlier call's transcript as the first user turn, reference rather than instructions.
    turnComplete false: it joins the context without Gemini answering it."""
    return {'clientContent': {'turns': [{'role': 'user', 'parts': [{'text': resume['recap']}]}], 'turnComplete': False}}


def conversation_resume(payload):
    """A resumed call's first message: the earlier call's transcript, nothing else. Returns how the call
    is told about it (azure_live.resume_context)."""
    from azure_live import resume_context
    if not isinstance(payload, dict) or set(payload) != {'resume'} or not isinstance(payload['resume'], dict) \
            or set(payload['resume']) != {'recap'}:
        raise ValueError('Expected the resumed call')
    return resume_context(payload['resume']['recap'])


def conversation_input(payload):
    """Microphone audio, function results and, for a call back from standby, the reply to the request it
    waited on; nothing else reaches the call. The reply carries only Hermes's text: the helper words it
    (azure_live.standby_result) and sends it as a turn Gemini answers by speaking."""
    if not isinstance(payload, dict) or len(payload) != 1:
        raise ValueError('Expected one client message')
    if 'hermesResult' in payload:
        from azure_live import standby_result
        text = standby_result(payload['hermesResult'])
        return {'clientContent': {'turns': [{'role': 'user', 'parts': [{'text': text}]}], 'turnComplete': True}}
    if 'realtimeInput' in payload:
        realtime = payload['realtimeInput']
        if not isinstance(realtime, dict) or not realtime or set(realtime) - {'audio', 'audioStreamEnd'}:
            raise ValueError('Unsupported realtime input')
        audio = realtime.get('audio')
        if audio is not None and (not isinstance(audio, dict) or audio.get('mimeType') != 'audio/pcm;rate=16000'
                                  or not isinstance(audio.get('data'), str)):
            raise ValueError('Expected 16 kHz PCM audio')
    elif 'toolResponse' in payload:
        responses = payload['toolResponse'].get('functionResponses') if isinstance(payload['toolResponse'], dict) else None
        if (not isinstance(responses, list) or not responses or set(payload['toolResponse']) != {'functionResponses'}
                or any(not isinstance(item, dict) or set(item) - {'id', 'name', 'response', 'scheduling'}
                       or not isinstance(item.get('id'), str) or not isinstance(item.get('response'), dict)
                       for item in responses)):
            raise ValueError('Invalid function response')
    else:
        raise ValueError('Unsupported client message')
    return payload


DEFAULT_ENV_FILES = ['~/.hermes/.env']
DEFAULT_GATEWAY_KEY_ENV = ['BENTO_GATEWAY_API_KEY', 'LITELLM_API_KEY']


def hermes_env(config=None):
    """Keys the user's other tools already keep (by default Hermes's .env, then the
    environment); read on use, never copied into the app or its preferences."""
    from dotenv import dotenv_values
    env = {}
    for name in (config or {}).get('env_files', DEFAULT_ENV_FILES):
        path = Path(name).expanduser()
        if path.is_file():
            env.update(dotenv_values(path))
    env.update(os.environ)
    return env


def gateway_config(config):
    """The optional local gateway (an Anthropic-messages endpoint such as LiteLLM)
    for relayed cleanup models: {"url", "models", "key_env"} under "gateway"."""
    gateway = config.get('gateway') or {}
    return {'url': gateway.get('url', 'http://127.0.0.1:4000').rstrip('/'),
            'models': list(gateway.get('models', [])),
            'key_env': list(gateway.get('key_env', DEFAULT_GATEWAY_KEY_ENV))}


def gateway_key(config):
    # The first configured name that is set: where several are, list the one the gateway accepts first.
    env = hermes_env(config)
    value = next((env[name] for name in gateway_config(config)['key_env'] if env.get(name)), None)
    if not value:
        raise ValueError('Gateway credentials unavailable')
    return value


def transcript_prompt(body, name):
    parts = [part for content in body.get('contents', []) for part in content.get('parts', [])]
    if not parts or any(set(part) != {'text'} or not isinstance(part['text'], str) for part in parts):
        raise web.HTTPBadRequest(text=name + ' accepts transcript text only')
    prompt = '\n'.join(part['text'] for part in parts)
    # MeetingPrompts.summary allows 600k transcript characters plus its instructions.
    if not prompt.strip() or len(prompt) > 650000:
        raise web.HTTPBadRequest(text='Transcript is empty or too large')
    return prompt


def openrouter_key(config=None):
    # The key Hermes already uses; never copied into the bundle or prefs.
    env = hermes_env(config)
    value = env.get('BENTO_OPENROUTER_API_KEY') or env.get('OPENROUTER_API_KEY')
    if not value:
        raise ValueError('OpenRouter credentials unavailable')
    return value


class VertexBridge:
    def __init__(self, config, credentials):
        self.config = config
        self.credentials = credentials
        self.lock = asyncio.Lock()
        self.slots = asyncio.Semaphore(4)
        self.azure_slots = asyncio.Semaphore(1)
        # One voice call at a time, outside the four slots dictation and meetings share.
        self.conversation_slot = asyncio.Semaphore(1)
        self.session = None
        self.openrouter_tls = None
        # Optional upstream proxy (e.g. a Mac outside a VPC Service Controls perimeter), for the
        # cloud calls only: the local gateway is on this Mac and must be reached directly.
        self.proxy = config.get('proxy')

    async def headers(self):
        async with self.lock:
            if not self.credentials.valid:
                await asyncio.to_thread(self.credentials.refresh, Request())
            return {'Authorization': 'Bearer ' + self.credentials.token}

    def resource(self, model, location='global'):
        return f'projects/{self.config["project"]}/locations/{location}/publishers/google/models/{model}'

    async def generate(self, request):
        model = request.match_info['model']
        gateway_models = gateway_config(self.config)['models']
        if model not in (MODEL, CLEANUP_MODEL, EDITING_MODEL, GPT_MODEL, LUNA_MODEL, MAI_MODEL, *gateway_models):
            raise web.HTTPForbidden(text='Model is not enabled for Bento')
        try:
            body = await request.json()
        except (ValueError, UnicodeError):
            raise web.HTTPBadRequest(text='Invalid JSON')
        if not isinstance(body, dict) or set(body) - {'contents', 'generationConfig'}:
            raise web.HTTPBadRequest(text='Unsupported request fields')
        if not isinstance(body.get('contents'), list):
            raise web.HTTPBadRequest(text='Expected inline contents')
        # Bento sends inline audio/text only; never allow arbitrary GCS/file fetches.
        for content in body.get('contents', []):
            if not isinstance(content, dict) or not isinstance(content.get('parts'), list):
                raise web.HTTPBadRequest(text='Expected inline content parts')
            for part in content.get('parts', []):
                if not isinstance(part, dict) or set(part) - {'text', 'inlineData', 'inline_data'}:
                    raise web.HTTPBadRequest(text='Only inline content is supported')
        if model in (GPT_MODEL, LUNA_MODEL):
            return await self.azure_generate(model, body)
        if model == MAI_MODEL:
            return await self.openrouter_generate(body)
        if model in gateway_models:
            return await self.gateway_generate(model, body)
        url = 'https://aiplatform.googleapis.com/v1/' + self.resource(model) + ':generateContent'
        async with self.slots:
            async with self.session.post(url, headers=await self.headers(), json=body, allow_redirects=False,
                                         proxy=self.proxy) as response:
                data = await response.read()
                if 300 <= response.status < 400:
                    raise web.HTTPBadGateway(text='Upstream redirect refused')
                return web.Response(status=response.status, body=data, content_type='application/json')

    async def azure_generate(self, model, body):
        # Credentials remain in their existing provider store, never in app preferences.
        from azure_live import azure_credentials
        parts = [part for content in body.get('contents', []) for part in content.get('parts', [])]
        if model == GPT_MODEL:
            audio, mime, vocabulary = inline_audio(parts, body)
            form = aiohttp.FormData()
            form.add_field('file', audio, filename='dictation.' + AUDIO_EXTENSIONS[mime], content_type=mime)
            form.add_field('response_format', 'json')
            if vocabulary:
                form.add_field('prompt', 'Vocabulary: ' + ', '.join(vocabulary)[:2000])
            endpoint, key = azure_credentials(self.config)
            deployment = (self.config.get('azure') or {}).get('transcribe_deployment', GPT_MODEL)
            url = endpoint + f'/openai/deployments/{deployment}/audio/transcriptions?api-version=2025-04-01-preview'
            kwargs = {'data': form}
        else:
            prompt = transcript_prompt(body, 'Luna')
            endpoint, key = azure_credentials(self.config)
            url = endpoint + '/openai/v1/chat/completions'
            kwargs = {'json': {'model': LUNA_MODEL, 'messages': [{'role': 'user', 'content': prompt}],
                               'reasoning_effort': 'none', 'max_completion_tokens': 8192}}
        # Queued Azure calls must not consume every slot used by Gemini Live.
        async with self.azure_slots, self.slots:
            async with self.session.post(url, headers={'api-key': key}, allow_redirects=False, proxy=self.proxy,
                                         timeout=aiohttp.ClientTimeout(total=60, connect=10), **kwargs) as response:
                if response.status != 200:
                    status = response.status if 400 <= response.status <= 599 else 502
                    headers = {}
                    if status == 429 and response.headers.get('Retry-After', '').isdigit():
                        headers['Retry-After'] = response.headers['Retry-After']
                    return web.json_response({'error': {'message': 'Azure model request failed'}}, status=status, headers=headers)
                result = await response.json()
        if model == GPT_MODEL:
            text = result.get('text')
        else:
            choices = result.get('choices', [])
            if not choices or choices[0].get('finish_reason') != 'stop':
                raise web.HTTPBadGateway(text='Luna did not return a complete transcript')
            text = choices[0].get('message', {}).get('content')
        if not isinstance(text, str):
            raise web.HTTPBadGateway(text='Azure returned no transcript')
        # Keep the native client's existing deadlines, errors and validation gate.
        return web.json_response({'modelVersion': model, 'candidates': [{'finishReason': 'STOP',
            'content': {'parts': [{'text': text}]}}]})

    async def gateway_generate(self, model, body):
        prompt = transcript_prompt(body, model)
        request = {'model': model, 'max_tokens': 8192, 'messages': [{'role': 'user', 'content': prompt}]}
        url = gateway_config(self.config)['url'] + '/v1/messages'
        async with self.slots:
            async with self.session.post(url, headers={'x-api-key': gateway_key(self.config), 'anthropic-version': '2023-06-01'},
                                         json=request, allow_redirects=False,
                                         # Meeting summaries allow 120 s; dictation keeps its own short deadline.
                                         timeout=aiohttp.ClientTimeout(total=150, connect=5)) as response:
                if response.status != 200:
                    status = response.status if 400 <= response.status <= 599 else 502
                    headers = {}
                    if status == 429 and response.headers.get('Retry-After', '').isdigit():
                        headers['Retry-After'] = response.headers['Retry-After']
                    return web.json_response({'error': {'message': 'Gateway model request failed'}}, status=status, headers=headers)
                result = await response.json()
        if result.get('stop_reason') != 'end_turn':
            raise web.HTTPBadGateway(text='The gateway model did not return a complete transcript')
        text = ''.join(block.get('text', '') for block in result.get('content', []) if block.get('type') == 'text')
        return web.json_response({'modelVersion': model, 'candidates': [{'finishReason': 'STOP',
            'content': {'parts': [{'text': text}]}}]})

    async def openrouter_generate(self, body):
        parts = [part for content in body.get('contents', []) for part in content.get('parts', [])]
        audio, mime, vocabulary = inline_audio(parts, body)
        request = {'model': 'microsoft/' + MAI_MODEL,
                   'input_audio': {'data': base64.b64encode(audio).decode(), 'format': AUDIO_EXTENSIONS[mime]}}
        if vocabulary:
            # Azure keyword biasing; OpenRouter forwards provider options as-is.
            request['provider'] = {'options': {'azure': {'phraseList': {'phrases': vocabulary[:100]}}}}
        key = openrouter_key(self.config)
        if self.openrouter_tls is None:
            # A TLS-inspecting proxy may re-sign openrouter.ai; the macOS trust store has its root.
            import truststore
            self.openrouter_tls = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        async with self.azure_slots, self.slots:
            async with self.session.post(OPENROUTER_TRANSCRIBE, headers={'Authorization': 'Bearer ' + key}, proxy=self.proxy,
                                         json=request, ssl=self.openrouter_tls, allow_redirects=False,
                                         timeout=aiohttp.ClientTimeout(total=60, connect=10)) as response:
                if response.status != 200:
                    status = response.status if 400 <= response.status <= 599 else 502
                    headers = {}
                    if status == 429 and response.headers.get('Retry-After', '').isdigit():
                        headers['Retry-After'] = response.headers['Retry-After']
                    return web.json_response({'error': {'message': 'OpenRouter transcription failed'}}, status=status, headers=headers)
                result = await response.json()
        text = result.get('text')
        if not isinstance(text, str):
            raise web.HTTPBadGateway(text='OpenRouter returned no transcript')
        return web.json_response({'modelVersion': MAI_MODEL, 'candidates': [{'finishReason': 'STOP',
            'content': {'parts': [{'text': text}]}}]})

    async def live(self, request):
        async with self.slots:
            return await self.live_session(request)

    async def live_session(self, request):
        ws = web.WebSocketResponse(max_msg_size=2 * 1024 * 1024, heartbeat=20)
        await ws.prepare(request)
        try:
            first = await asyncio.wait_for(ws.receive(), 10)
            if first.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                raise ValueError('Expected setup')
            message = json.loads(first.data)
            setup = message.get('setup', {})
            if setup.get('model') not in ('models/' + LIVE_MODEL, self.resource(LIVE_MODEL)):
                raise ValueError('Live model is not enabled')
            if set(setup) - {'model', 'generationConfig', 'inputAudioTranscription', 'realtimeInputConfig'}:
                raise ValueError('Unsupported setup fields')
            setup['model'] = self.resource(LIVE_MODEL)
            url = 'wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent'
            async with self.session.ws_connect(url, headers=await self.headers(), max_msg_size=4 * 1024 * 1024, heartbeat=20,
                                               proxy=self.proxy) as upstream:
                await upstream.send_json({'setup': setup})
                async def send():
                    async for frame in ws:
                        if frame.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                            break
                        payload = json.loads(frame.data)
                        if set(payload) != {'realtimeInput'}:
                            raise ValueError('Only realtime audio input is supported')
                        realtime = payload['realtimeInput']
                        if set(realtime) - {'audio', 'audioStreamEnd', 'activityStart', 'activityEnd'}:
                            raise ValueError('Unsupported realtime input')
                        await upstream.send_json(payload)
                async def receive():
                    async for frame in upstream:
                        if frame.type == aiohttp.WSMsgType.TEXT:
                            await ws.send_str(frame.data)
                        elif frame.type == aiohttp.WSMsgType.BINARY:
                            await ws.send_bytes(frame.data)
                        else:
                            break
                tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
                try:
                    done, _ = await asyncio.wait(tasks, timeout=590, return_when=asyncio.FIRST_COMPLETED)
                    for task in done:
                        task.result()
                finally:
                    for task in tasks:
                        task.cancel()
                    await asyncio.gather(*tasks, return_exceptions=True)
        except Exception:
            if not ws.closed:
                await ws.send_json({'error': {'message': 'Vertex Live session failed; retry with batch transcription'}})
        finally:
            await ws.close()
        return ws

    async def conversation(self, request):
        ws = web.WebSocketResponse(max_msg_size=2 * 1024 * 1024, heartbeat=20)
        await ws.prepare(request)
        if self.conversation_slot.locked():
            await ws.send_json(conversation_error('busy'))
            await ws.close()
            return ws
        async with self.conversation_slot:
            await self.conversation_session(ws, resume=request.path.endswith('/resume'))
        return ws

    async def conversation_session(self, ws, resume=False):
        # Only fixed codes, an HTTP status and a WebSocket close code leave on failure; never upstream text.
        failure = {}
        try:
            context = None
            if resume:
                # Read before Vertex is contacted, so a bad first message costs nothing upstream.
                async with asyncio.timeout(CONVERSATION_CONNECT_TIMEOUT):
                    frame = await ws.receive()
                if frame.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                    raise ValueError('Expected the resumed call')
                context = conversation_resume(json.loads(frame.data))
            setup = conversation_setup(self.resource(CONVERSATION_MODEL, CONVERSATION_LOCATION), context)
            # Gemini takes nothing before setupComplete; the recap goes first after it, before any audio.
            seeded = asyncio.Event()
            if not context:
                seeded.set()
            url = (f'wss://{CONVERSATION_LOCATION}-aiplatform.googleapis.com'
                   '/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent')

            async def connect(handle=None):
                async with asyncio.timeout(CONVERSATION_CONNECT_TIMEOUT):
                    upstream = await self.session.ws_connect(url, headers=await self.headers(), proxy=self.proxy,
                                                             max_msg_size=4 * 1024 * 1024, heartbeat=20)
                try:
                    await upstream.send_json({'setup': {**setup, 'sessionResumption': {'handle': handle}} if handle else setup})
                    if handle:
                        # The resumed session already has the recap; it takes audio after its setupComplete.
                        async with asyncio.timeout(CONVERSATION_CONNECT_TIMEOUT):
                            async for frame in upstream:
                                if frame.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                                    break
                                if 'setupComplete' in json.loads(frame.data):
                                    return upstream
                        raise ConnectionError('Vertex closed the resumed session before setup')
                    return upstream
                except BaseException:
                    await upstream.close()
                    raise

            # Vertex closes a connection after about ten minutes, warning with goAway first. The call goes
            # on over a new upstream that resumes the session from its latest handle; the old one carries
            # audio until the new one is set up, and Bento hears the goAway only if that fails.
            link = {'upstream': await connect(), 'handle': None, 'rotation': None}

            async def rotate(go_away):
                try:
                    upstream = await connect(link['handle'])
                except Exception:
                    link['rotation'] = None
                    await (ws.send_str if isinstance(go_away, str) else ws.send_bytes)(go_away)
                    return
                old, link['upstream'], link['rotation'] = link['upstream'], upstream, None
                await old.close()

            async def moved(upstream):
                """Whether upstream has been replaced, once a rotation under way has finished."""
                if link['rotation']:
                    await asyncio.wait([link['rotation']])
                return link['upstream'] is not upstream

            async def send():
                async for frame in ws:
                    if frame.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                        break
                    message = conversation_input(json.loads(frame.data))
                    await seeded.wait()
                    upstream = link['upstream']
                    try:
                        await upstream.send_json(message)
                    except (aiohttp.ClientError, ConnectionError):
                        # The old upstream can close before its replacement is set up. Audio is dropped,
                        # since waiting would back Bento's microphone up; a result goes to the replacement.
                        if 'realtimeInput' in message and link['rotation']:
                            continue
                        if not await moved(upstream):
                            raise
                        await link['upstream'].send_json(message)

            async def receive():
                while True:
                    upstream = link['upstream']
                    async for frame in upstream:
                        if frame.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                            break
                        event = json.loads(frame.data)
                        if not isinstance(event, dict):
                            event = {}
                        if not seeded.is_set() and 'setupComplete' in event:
                            await upstream.send_json(conversation_recap(context))
                            seeded.set()
                        update = event.get('sessionResumptionUpdate')
                        if isinstance(update, dict) and update.get('resumable') and isinstance(update.get('newHandle'), str) \
                                and update['newHandle']:
                            link['handle'] = update['newHandle']
                        if 'goAway' in event and link['handle'] and not link['rotation']:
                            link['rotation'] = asyncio.create_task(rotate(frame.data))
                            continue
                        if frame.type == aiohttp.WSMsgType.TEXT:
                            await ws.send_str(frame.data)
                        else:
                            await ws.send_bytes(frame.data)
                    if not await moved(upstream):
                        return

            tasks = [asyncio.create_task(send()), asyncio.create_task(receive())]
            try:
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                if tasks[0] in done and isinstance(tasks[0].exception(), (aiohttp.ClientError, ConnectionError)):
                    # Audio can fail to write to a closing upstream before its close frame is read.
                    await asyncio.wait([tasks[1]], timeout=2)
                if tasks[1].done() and not tasks[1].cancelled() and tasks[1].exception() is None:
                    failure = {'code': 'upstream_closed', 'close_code': link['upstream'].close_code}
                else:
                    for task in done:
                        task.result()
            finally:
                for task in tasks + [link['rotation']]:
                    if task:
                        task.cancel()
                await asyncio.gather(*tasks, *[t for t in [link['rotation']] if t], return_exceptions=True)
                await link['upstream'].close()
        except aiohttp.WSServerHandshakeError as error:
            failure = {'code': 'http_error', 'http_status': error.status}
        except (ValueError, KeyError, TypeError, AttributeError):
            failure = {'code': 'invalid_message'}
        except (asyncio.TimeoutError, TimeoutError):
            failure = {'code': 'timeout'}
        except aiohttp.ClientError:
            failure = {'code': 'connection_error'}
        except Exception:
            failure = {'code': 'transport_error'}
        finally:
            if failure and not ws.closed:
                await ws.send_json(conversation_error(**failure))
            await ws.close()


def conversation_error(code, http_status=None, close_code=None):
    error = {'message': 'Gemini Live call ended', 'code': code}
    if isinstance(http_status, int) and 100 <= http_status <= 599:
        error['httpStatus'] = http_status
    if isinstance(close_code, int) and 1000 <= close_code <= 4999:
        error['closeCode'] = close_code
    return {'error': error}


DEFAULT_RUNTIME = Path.home() / '.config/bento/voice-runtime.json'


def listen_port(config):
    """The port of the loopback URL the app is configured to call."""
    return urlsplit(config.get('bifrost_base_url', 'http://127.0.0.1:8767')).port or 8767


def make_app(config, credentials):
    bridge = VertexBridge(config, credentials)
    host = f'127.0.0.1:{listen_port(config)}'
    @web.middleware
    async def authenticate(request, handler):
        if request.headers.get('Origin') or request.host != host:
            raise web.HTTPForbidden()
        supplied = request.headers.get('x-goog-api-key', '')
        if not hmac.compare_digest(supplied, config['bifrost_key']):
            raise web.HTTPUnauthorized()
        try:
            return await handler(request)
        except web.HTTPException:
            raise
        except Exception:
            return web.json_response({'error': {'message': 'Vertex helper request failed'}}, status=502)
    app = web.Application(middlewares=[authenticate], client_max_size=24 * 1024 * 1024)
    async def lifecycle(app):
        # Environment proxies stay ignored; the configured one is per request (VertexBridge.proxy).
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=600, connect=15), trust_env=False) as session:
            bridge.session = session
            yield
    app.cleanup_ctx.append(lifecycle)
    app.router.add_post('/v1beta/models/{model}:generateContent', bridge.generate)
    app.router.add_get('/live', bridge.live)
    app.router.add_get('/conversation', bridge.conversation)
    app.router.add_get('/conversation/resume', bridge.conversation)
    async def health(request):
        return web.json_response({'status': 'ok', 'transport': 'direct-vertex'})
    app.router.add_get('/health', health)
    return app


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', type=Path, default=Path(os.environ.get('BENTO_VOICE_RUNTIME', DEFAULT_RUNTIME)))
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    if config.get('transport') != 'direct' or config['location'] != 'global':
        raise RuntimeError('Direct Vertex global configuration required')
    base = urlsplit(config.get('bifrost_base_url', ''))
    if base.scheme != 'http' or base.hostname != '127.0.0.1' or not base.port:
        raise RuntimeError('bifrost_base_url must be http://127.0.0.1:<port>, the address the helper listens on')
    credentials, project = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    if project != config['project']:
        raise RuntimeError('ADC project does not match the voice runtime configuration')
    os.umask(0o077)
    web.run_app(make_app(config, credentials), host='127.0.0.1', port=listen_port(config), access_log=None, print=None)
