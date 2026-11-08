"""QuickJS answers every recorded scenario exactly as Node did (voice-core/scenarios).

    cd voice-core/hosts/python && .venv/bin/python -m pytest -q
"""

import json
from pathlib import Path

import pytest

from voice_core import VoiceCore

SCENARIOS = Path(__file__).resolve().parents[2] / "scenarios"
NAMES = sorted(p.stem for p in SCENARIOS.glob("*.json") if not p.name.endswith(".golden.json"))


@pytest.mark.parametrize("name", NAMES)
def test_scenario_matches_golden(name):
    recording = json.loads((SCENARIOS / f"{name}.json").read_text())
    golden = (SCENARIOS / f"{name}.golden.json").read_text().rstrip("\n").split("\n")
    core = VoiceCore.load()
    answers = [core.create_raw(json.dumps(recording["config"]), recording["start"])]
    call_id = json.loads(answers[0])["id"]
    for event in recording["events"]:
        answers.append(core.push_raw(call_id, json.dumps(event)))
    assert len(answers) == len(golden)
    for i, (got, want) in enumerate(zip(answers, golden)):
        assert got == want, f"{name}: answer {i} differs"


def test_a_call_through_the_wrapper():
    core = VoiceCore.load()
    call = core.call({"today": "2026-11-08"}, 0.0)
    assert [c["type"] for c in call.commands] == ["status", "ws.connect"]
    sent = call.push({"t": 0.1, "type": "ws.open", "sid": 1})
    assert json.loads(sent[0]["data"])["setup"]["model"] == "models/gemini-3.8-live"
    assert len(core.version) == 12
