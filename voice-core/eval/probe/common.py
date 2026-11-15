"""Shared helpers for the voice latency probes.

Credentials are read inside this process from ~/.hermes/.env (then ~/dotfiles/.zshrc_local) and
never printed. Which Azure resources to call, the names of the variables holding their keys and
the proxy to Google are settings (see README.md): from the environment, then local.env beside this
file, then ~/.config/bento/voice-probe.env.
"""
import json
import os
import re
import statistics
import time
import wave
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
CLIPS = HERE / "clips"
DATA = HERE / "data"
for d in (OUT, CLIPS, DATA):
    d.mkdir(exist_ok=True)

_FORBIDDEN = {"GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "OPENAI_API_KEY",
              "ANTHROPIC_API_KEY", "XAI_API_KEY"}


def _env_file(path):
    out = {}
    try:
        text = Path(path).expanduser().read_text()
    except OSError:
        return out
    for line in text.splitlines():
        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip("\"'")
    return out


def secret(*names):
    """First non-empty value among names: environment, ~/.hermes/.env, ~/dotfiles/.zshrc_local."""
    for n in names:
        if n in _FORBIDDEN:
            raise ValueError(f"{n} bills personally; not used")
    sources = [os.environ, _env_file("~/.hermes/.env"), _env_file("~/dotfiles/.zshrc_local")]
    for n in names:
        for s in sources:
            v = s.get(n)
            if v and not v.startswith("$"):
                return v
    raise KeyError(f"none of {names} found")


def setting(name, default=None):
    """A probe setting (never a secret): the environment, local.env here, ~/.config/bento/voice-probe.env."""
    for s in (os.environ, _env_file(HERE / "local.env"), _env_file("~/.config/bento/voice-probe.env")):
        if s.get(name):
            return s[name]
    if default is None:
        raise KeyError(f"{name} is not set (see README.md)")
    return default


PROXY = setting("VOICE_PROBE_PROXY", "") or None      # HTTP CONNECT proxy to Google, if it needs one


def azure():
    """The Azure OpenAI resource: its endpoint and key."""
    return setting("VOICE_PROBE_AZURE_ENDPOINT").rstrip("/"), secret(setting("VOICE_PROBE_AZURE_KEY_NAME", "AZURE_OPENAI_API_KEY"))


def azure_speech():
    """The Azure AI Speech resource: its endpoint and key."""
    return setting("VOICE_PROBE_SPEECH_ENDPOINT").rstrip("/"), secret(setting("VOICE_PROBE_SPEECH_KEY_NAME", "AZURE_SPEECH_KEY"))


def hermes_env(name, default=None):
    return _env_file("~/.hermes/.env").get(name, default)


VERTEX_PROJECT = hermes_env("VERTEX_PROJECT_ID")
_gcreds = None


def google_token():
    """Access token for the service account in VERTEX_CREDENTIALS_PATH (cached, refreshed)."""
    global _gcreds
    import google.auth.transport.requests
    from google.oauth2 import service_account
    if _gcreds is None:
        path = os.path.expanduser(hermes_env("VERTEX_CREDENTIALS_PATH"))
        _gcreds = service_account.Credentials.from_service_account_file(
            path, scopes=["https://www.googleapis.com/auth/cloud-platform"])
    import datetime
    left = (_gcreds.expiry - datetime.datetime.utcnow()).total_seconds() if _gcreds.expiry else 0
    if not _gcreds.valid or left < 300:
        _gcreds.refresh(google.auth.transport.requests.Request())
    return _gcreds.token


def google_session():
    import requests
    s = requests.Session()
    s.trust_env = False
    if PROXY:
        s.proxies = {"https": PROXY}
    return s


# ---------------------------------------------------------------- audio

def read_wav(path):
    with wave.open(str(path)) as w:
        sr, ch, sw = w.getframerate(), w.getnchannels(), w.getsampwidth()
        a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1).astype(np.int16)
    assert sw == 2
    return a, sr


def write_wav(path, pcm, sr):
    pcm = np.asarray(pcm, dtype=np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())


def resample(pcm, sr_in, sr_out):
    if sr_in == sr_out:
        return np.asarray(pcm, dtype=np.int16)
    x = np.asarray(pcm, dtype=np.float32)
    n = int(round(len(x) * sr_out / sr_in))
    t = np.linspace(0, len(x) - 1, n)
    return np.interp(t, np.arange(len(x)), x).astype(np.int16)


def pcm_seconds(nbytes, sr):
    return nbytes / 2 / sr


# ---------------------------------------------------------------- stats

def pct(xs, p):
    xs = sorted(x for x in xs if x is not None)
    if not xs:
        return None
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def summary(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return {"n": 0}
    return {"n": len(xs), "median": round(statistics.median(xs), 3), "p90": round(pct(xs, 0.9), 3),
            "min": round(min(xs), 3), "max": round(max(xs), 3)}


def save(name, obj):
    p = DATA / name
    p.write_text(json.dumps(obj, indent=1, default=str))
    return p


def append_jsonl(name, obj):
    with open(DATA / name, "a") as f:
        f.write(json.dumps(obj, default=str) + "\n")


# ---------------------------------------------------------------- text

LINE_SHORT = "Hermes finished the Bento build, and Woodhouse says the tests all passed."
LINE_LONG = ("Hermes has finished checking your calendar for next week. You have three meetings on Tuesday, "
             "including the Bento design review at ten, and Thursday is completely free. Woodhouse suggests "
             "moving the dentist appointment to Thursday afternoon so Tuesday stays manageable.")


def words(text):
    return re.findall(r"[a-z0-9']+", text.lower())


def wer(ref, hyp):
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return d[len(h)] / max(1, len(r))


NAMES = ["hermes", "bento", "woodhouse"]


def name_hits(text):
    w = set(words(text))
    return {n: (n in w) for n in NAMES}
