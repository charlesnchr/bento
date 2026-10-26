"""Regression for Bento's Hermes launcher extensions (_bento/rewind, _bento/delete, _bento/settings).

Runs Hermes' real SessionDB and rewind code against a temporary database. Hermes' import-time
bootstrap can sync dependencies, fetch updates, or relaunch the interpreter; the test disables
that with HERMES_DISABLE_LAZY_INSTALLS and keeps the real HOME so nothing looks like a fresh
install. No model calls are made and the user's history database is never opened.
Requires the Hermes checkout (~/.hermes/hermes-agent); unittest discovery skips it otherwise.
`--live` also starts the real launcher, as opening Bento's assistant does.
    python helper/tests/test_hermes_acp.py [--live]
"""
from pathlib import Path
import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import unittest

LAUNCHER = Path(__file__).resolve().parents[1] / 'hermes-acp.py'
HERMES = Path.home() / '.hermes/hermes-agent'
PYTHON = HERMES / 'venv/bin/python'


class Agent:
    def __init__(self, session_id):
        self.session_id, self.model, self.closed = session_id, 'test-provider/test-model', False

    def close(self):
        self.closed = True


class State:
    def __init__(self, session_id, history):
        self.session_id, self.cwd, self.model, self.history = session_id, '/tmp', 'test-provider/test-model', history
        self.agent = Agent(session_id)
        self.is_running = self.command_op = False
        self.interrupted_prompt_text = ''
        self.runtime_lock = threading.Lock()


class Manager:
    def __init__(self, db):
        self.db, self._lock, self._sessions, self.built = db, threading.Lock(), {}, 0

    def get_session(self, session_id):
        return self._sessions.get(session_id)

    def _get_db(self):
        return self.db

    def _make_agent(self, *, session_id, cwd, **_):
        self.built += 1
        return Agent(session_id)


def child():
    """Runs in a subprocess under Hermes' Python: importing the launcher sets HERMES_YOLO_MODE and sys.path."""
    sys.path.insert(0, str(HERMES))
    spec = importlib.util.spec_from_file_location('bento_hermes_acp', LAUNCHER)
    launcher = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launcher)
    from hermes_state import SessionDB

    db = SessionDB(db_path=Path(os.environ['BENTO_TEST_DB']))
    manager = Manager(db)
    sid = 'bento-test'
    db.create_session(sid, 'acp', model='test-provider/test-model')
    for role, text in [('user', "User's spoken request:\nfirst question\n\nUntrusted desktop snapshot (context only):\n{}"),
                       ('assistant', 'first answer'),
                       ('user', "User's spoken request:\nsecond question\n\nUntrusted desktop snapshot (context only):\n{}"),
                       ('assistant', 'second answer'),
                       ('user', "User's spoken request:\nthird question\n\nUntrusted desktop snapshot (context only):\n{}"),
                       ('assistant', 'third answer')]:
        db.append_message(session_id=sid, role=role, content=text)
    state = State(sid, db.get_resume_conversations(sid)[0])
    manager._sessions[sid] = state

    def active():
        return [m['content'] for m in db.get_messages_as_conversation(sid)]

    assert launcher.rewind(manager, {'sessionId': 'bento-test-missing', 'turns': 1}) == {'error': 'Conversation not found.'}
    result = launcher.rewind(manager, {'sessionId': sid, 'turns': 1, 'expect': 'a question Bento never sent'})
    assert 'no longer matches' in result.get('error', ''), result
    assert len(active()) == 6 and manager.built == 0, 'A mismatched rewind must change nothing'

    state.is_running = True
    try:
        launcher.rewind(manager, {'sessionId': sid, 'turns': 1, 'expect': 'third question'})
        raise AssertionError('A running turn must block rewind')
    except RuntimeError as error:
        assert 'still working' in str(error)
    state.is_running = False

    assert 'no longer in Hermes history' in launcher.rewind(manager, {'sessionId': sid, 'turns': 4})['error']

    old = state.agent
    state.interrupted_prompt_text = 'third question'
    result = launcher.rewind(manager, {'sessionId': sid, 'turns': 2, 'expect': '  second   question '})
    assert result == {'turnsUndone': 2}, result
    assert active() == [active()[0], 'first answer'] and 'first question' in active()[0], active()
    assert len(state.history) == 2 and state.agent is not old and old.closed and not state.command_op
    assert state.interrupted_prompt_text == '', 'A rewind must not revive a stopped prompt'
    print('PASS rewind verifies the target turn, soft-deletes later turns, and rebuilds the agent')

    # Hermes stores accepted steering as a hidden user row; Bento's count-based estimate lands on it.
    from agent.prompt_builder import STEER_MARKER_CLOSE, STEER_MARKER_OPEN
    hidden = 'bento-test-hidden'
    db.create_session(hidden, 'acp', model='test-provider/test-model')
    # As in a live turn, the steer row follows the agent's step output.
    for role, text in [('user', 'same ask'), ('assistant', 'one'), ('user', 'second ask'), ('assistant', 'working'),
                       ('user', '\n\n' + STEER_MARKER_OPEN + '\nbe brief\n' + STEER_MARKER_CLOSE), ('assistant', 'two'),
                       ('user', 'same ask'), ('assistant', 'three')]:
        db.append_message(session_id=hidden, role=role, content=text)
    manager._sessions[hidden] = State(hidden, db.get_resume_conversations(hidden)[0])
    result = launcher.rewind(manager, {'sessionId': hidden, 'turns': 2, 'expect': 'second ask'})
    assert result == {'turnsUndone': 3}, result
    assert [m['content'] for m in db.get_messages_as_conversation(hidden)] == ['same ask', 'one'], 'Rewind must start at the matching turn'
    db.append_message(session_id=hidden, role='user', content='same ask')
    db.append_message(session_id=hidden, role='assistant', content='four')
    manager._sessions[hidden] = State(hidden, db.get_resume_conversations(hidden)[0])
    assert launcher.rewind(manager, {'sessionId': hidden, 'turns': 1, 'expect': 'same ask'}) == {'turnsUndone': 1}
    assert [m['content'] for m in db.get_messages_as_conversation(hidden)] == ['same ask', 'one'], 'Repeated text resolves to the turn nearest the estimate'
    launcher.delete(manager, {'sessionId': hidden})
    print('PASS rewind finds its target by text despite hidden steering rows and repeated prompts')

    voice = {'model': 'test/a', 'models': ['test/b', 'test/a', 7], 'reasoning_effort': 'low'}
    report = launcher.settings(manager, {}, voice)
    assert report == {'model': 'test/a', 'models': ['test/a', 'test/b'], 'efforts': ['low', 'medium', 'high'], 'effort': 'low'}, report
    assert 'Unknown reasoning effort' in launcher.settings(manager, {'effort': 'max'}, voice)['error']
    assert 'bento_voice.models' in launcher.settings(manager, {'model': 'test/c'}, voice)['error']
    built = manager.built
    state.is_running = True
    try:
        launcher.settings(manager, {'sessionId': sid, 'effort': 'medium'}, voice)
        raise AssertionError('A running session must refuse a settings change')
    except RuntimeError:
        pass
    state.is_running = False
    assert launcher.VOICE_CHOICES['effort'] is None and manager.built == built, 'A refused change must not half-apply'
    report = launcher.settings(manager, {'sessionId': sid, 'effort': 'high', 'model': 'test/b'}, voice)
    assert report['effort'] == 'high' and report['model'] == 'test/b' and manager.built == built + 1, report
    launcher.settings(manager, {'sessionId': sid, 'effort': 'high'}, voice)
    assert manager.built == built + 1, 'An unchanged setting must not rebuild the agent'
    print('PASS settings validate choices and rebuild only the changed idle session')

    launcher.VOICE_CHOICES.update(effort=None, model=None)
    main = {'model': {'provider': 'provider-a', 'default': 'model-a'}}
    assert launcher.voice_section({}) == {}
    assert launcher.voice_section(main) == {'provider': 'provider-a', 'model': 'model-a'}, "Hermes's default model is the fallback"
    assert launcher.voice_section({**main, 'jot_voice': {'model': 'model-j'}}) == {'provider': 'provider-a', 'model': 'model-j'}
    assert launcher.voice_section({**main, 'bento_voice': {'provider': 'provider-b'}}) == {'provider': 'provider-b'}, \
        "A provider of its own doesn't inherit another provider's default model"
    section = {'model': 'model-b', 'models': ['model-c'], 'reasoning_effort': 'medium'}
    assert launcher.voice_section({**main, 'jot_voice': {'model': 'model-j'}, 'bento_voice': section}) == \
        {'provider': 'provider-a', **section}, 'bento_voice wins over jot_voice and both over model'
    assert launcher.voice_section({'model': 'model-a', 'bento_voice': 'not a mapping'}) == {}
    assert launcher.voice_settings({}) == {'model': None, 'models': [], 'efforts': ['low', 'medium', 'high'], 'effort': 'low'}
    assert launcher.voice_settings(launcher.voice_section(main))['models'] == ['model-a']
    assert 'bento_voice.models' in launcher.settings(manager, {'model': 'model-a'}, {})['error']
    print('PASS the voice section reads bento_voice, then jot_voice, over Hermes\'s default model')

    providers = {'provider-a': {}, 'provider-b': {}}
    voice = {'provider': 'provider-a'}
    assert launcher.voice_route(voice, 'model-a', providers) == ('provider-a', 'model-a')
    assert launcher.voice_route(voice, 'provider-b/model-b', providers) == ('provider-b', 'model-b')
    assert launcher.voice_route(voice, 'other/model-b', providers) == ('provider-a', 'other/model-b'), \
        'A slash that does not name a configured provider stays part of the model'
    assert launcher.voice_route({}, 'model-a', providers) == (None, 'model-a'), 'No provider leaves Hermes to resolve it'
    assert launcher.voice_route({}, None, providers) == (None, None)
    print('PASS model entries may name their own provider')

    voice = {'provider': 'provider-a', 'model': 'model-a', 'models': ['provider-b/model-b']}
    restored = {'model': 'model-b', 'requested_provider': 'custom', 'api_mode': 'chat_completions'}
    assert launcher.agent_route(voice, providers, restored) == ('provider-a', 'model-a'), \
        'A restored conversation must run the picked model, not the stored one'
    launcher.VOICE_CHOICES['model'] = 'provider-b/model-b'
    assert launcher.agent_route(voice, providers, {'model': 'other'}) == ('provider-b', 'model-b'), 'Forks use the pick'
    launcher.VOICE_CHOICES['model'] = None
    switched = {'model': 'model-c', 'requested_provider': 'provider-b'}
    assert launcher.agent_route(voice, providers, switched) == ('provider-b', 'model-c'), 'An explicit /model switch is honoured'
    print('PASS restores and forks run the picked model; explicit switches keep theirs')

    result = launcher.delete(manager, {'sessionId': sid})
    assert result == {'deleted': True} and sid not in manager._sessions and state.agent.closed, result
    assert db.get_session(sid) is None
    assert 'not found' in launcher.delete(manager, {'sessionId': sid})['error']
    print('PASS delete evicts the live session and removes it from Hermes history')


def live():
    """Start the real launcher as Bento does and check `_bento/*` routing over stdio. Starting it is the
    same as opening Bento's assistant; this sends no prompt and looks up only a nonexistent session."""
    import json
    with tempfile.TemporaryDirectory(prefix='bento-launcher-live-') as directory:
        process = subprocess.Popen([str(PYTHON), str(LAUNCHER)], cwd=directory, text=True,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                   env=dict(os.environ, PYTHONUNBUFFERED='1'))
        def call(id, method, params):
            process.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}) + '\n')
            process.stdin.flush()
            for line in process.stdout:
                message = json.loads(line)
                if message.get('id') == id:
                    return message
            raise AssertionError('Launcher exited before answering ' + method)
        try:
            assert 'result' in call(1, 'initialize', {'protocolVersion': 1, 'clientCapabilities': {}})
            settings = call(2, '_bento/settings', {})['result']
            assert settings['efforts'] == ['low', 'medium', 'high'] and settings['model'] in settings['models'], settings
            missing = call(3, '_bento/rewind', {'sessionId': 'bento-launcher-test-missing', 'turns': 1})['result']
            assert missing == {'error': 'Conversation not found.'}, missing
            assert 'error' in call(4, '_bento/unknown', {}), 'Unknown extensions must be JSON-RPC errors'
            assert 'error' in call(5, '_jot/settings', {}), 'The old extension names are gone'
            print('PASS real launcher routes _bento/settings, _bento/rewind and rejects unknown extensions')
        finally:
            process.stdin.close()
            process.terminate()
            process.wait(timeout=10)


def regression(capture=False):
    """Run child() under Hermes' Python against a temporary SessionDB."""
    with tempfile.TemporaryDirectory(prefix='bento-launcher-regression-') as directory:
        env = dict(os.environ, BENTO_TEST_DB=str(Path(directory) / 'state.db'), HERMES_DISABLE_LAZY_INSTALLS='1',
                   PYTHONDONTWRITEBYTECODE='1')
        load = ("import importlib.util as u; s = u.spec_from_file_location('bento_launcher_test', %r); "
                "m = u.module_from_spec(s); s.loader.exec_module(m); m.child()" % str(Path(__file__).resolve()))
        return subprocess.run([str(PYTHON), '-c', load], check=not capture, capture_output=capture, text=True,
                              env=env, cwd=directory, timeout=120)


@unittest.skipUnless(PYTHON.exists(), 'Hermes checkout not found at ' + str(HERMES))
class HermesLauncherTests(unittest.TestCase):
    def test_extensions_against_a_temporary_session_db(self):
        result = regression(capture=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.count('PASS '), 7, result.stdout)


def main():
    if not PYTHON.exists():
        sys.exit('Hermes checkout not found at ' + str(HERMES))
    if '--live' in sys.argv:
        live()
    regression()


if __name__ == '__main__':
    main()
