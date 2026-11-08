"""The voice core in Python, through QuickJS: for the Echo bridge (home-assistant/live-bridge).

    core = VoiceCore.load()                      # dist/voice-core.js next to this checkout
    core = VoiceCore.load("http://homelab:8770/voice-core.js")   # the dev server's latest build
    call = core.call({"platform": "Echo", "device": "speaker"}, t=time.monotonic())
    for command in call.commands: ...           # create's commands
    for command in call.push({"t": time.monotonic(), "type": "tick"}): ...

A host owns the sockets, microphone, speaker and tools, and does what the commands say; see
voice-core/src/types.ts for both directions. One QuickJS context per VoiceCore, used from one
thread (QuickJS isn't thread-safe): keep the calls on the event loop's thread.
"""

from __future__ import annotations

import json
import urllib.request
from pathlib import Path

import quickjs

BUNDLE = Path(__file__).resolve().parents[2] / "dist" / "voice-core.js"


class VoiceCore:
    def __init__(self, source: str):
        self._context = quickjs.Context()
        self._context.eval(source)
        self.version: str = self._context.eval("VoiceCore.version")
        self._create = self._context.eval("(c, t) => VoiceCore.create(c, t)")
        self._push = self._context.eval("(id, e) => VoiceCore.push(id, e)")
        self._trace = self._context.eval("(id) => VoiceCore.trace(id)")
        self._dispose = self._context.eval("(id) => VoiceCore.dispose(id)")

    @classmethod
    def load(cls, where: str | Path | None = None) -> VoiceCore:
        """The bundle from a file, or a URL (the dev server's, to try a change without a deploy)."""
        if where is None:
            where = BUNDLE
        if isinstance(where, str) and where.startswith(("http://", "https://")):
            with urllib.request.urlopen(where, timeout=10) as response:
                return cls(response.read().decode())
        return cls(Path(where).read_text())

    def call(self, config: dict, t: float) -> Call:
        created = json.loads(self._create(json.dumps(config), t))
        return Call(self, created["id"], created["commands"])

    def create_raw(self, config_json: str, t: float) -> str:
        return self._create(config_json, t)

    def push_raw(self, call_id: int, event_json: str) -> str:
        return self._push(call_id, event_json)


class Call:
    def __init__(self, core: VoiceCore, call_id: int, commands: list[dict]):
        self.core, self.id, self.commands = core, call_id, commands

    def push(self, event: dict) -> list[dict]:
        return json.loads(self.core._push(self.id, json.dumps(event)))

    def trace(self) -> dict | None:
        """What the trace kept since the last call (config "trace": true): a recording to replay."""
        return json.loads(self.core._trace(self.id))

    def close(self) -> None:
        self.core._dispose(self.id)
