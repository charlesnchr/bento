"""TTS latency: time to first audio byte (TTFB) and total time, streaming where the route supports it.

  .venv/bin/python tts_bench.py --list
  .venv/bin/python tts_bench.py --routes az-4o-mini-tts,vx-3.8-flash-tts --n 8 --lines short,long

Each route keeps one HTTP session (connection reuse) and gets one unmeasured warm-up call, so the
numbers are warm-connection numbers. Runs are interleaved across routes. Raw runs go to
data/tts_runs.jsonl, the summary to data/tts_summary.json, one sample WAV per route and line to out/.
"""
import argparse
import base64
import json
import sys
import time

import numpy as np
import requests

from common import (LINE_LONG, LINE_SHORT, OUT, VERTEX_PROJECT, append_jsonl, azure, azure_speech, google_session,
                    google_token, save, secret, summary, write_wav)

LINES = {"short": LINE_SHORT, "long": LINE_LONG}


class Result:
    def __init__(self):
        self.t0 = time.perf_counter()
        self.ttfb = None
        self.pcm = bytearray()
        self.sr = 24000
        self.note = ""

    def audio(self, b):
        if b:
            if self.ttfb is None:
                self.ttfb = time.perf_counter() - self.t0
            self.pcm += b

    def done(self):
        total = time.perf_counter() - self.t0
        n = len(self.pcm) - (len(self.pcm) % 2)
        return {"ttfb": self.ttfb, "total": total, "audio_s": n / 2 / self.sr, "sr": self.sr, "note": self.note}


def sse_events(resp):
    """Yield parsed JSON from an SSE stream (data: lines)."""
    buf = b""
    for chunk in resp.iter_content(chunk_size=None):
        buf += chunk
        while b"\n" in buf:
            line, buf = buf.split(b"\n", 1)
            line = line.strip()
            if line.startswith(b"data:"):
                data = line[5:].strip()
                if data and data != b"[DONE]":
                    yield json.loads(data)


# ------------------------------------------------------------------ Azure OpenAI

_az = requests.Session(); _az.trust_env = False


def az_speech_api(deployment, voice, instructions=None):
    ep, key = azure()

    def run(text):
        r = Result()
        body = {"model": deployment, "input": text, "voice": voice, "response_format": "pcm", "stream_format": "audio"}
        if instructions:
            body["instructions"] = instructions
        resp = _az.post(f"{ep}/openai/deployments/{deployment}/audio/speech?api-version=2025-04-01-preview",
                        headers={"api-key": key}, json=body, stream=True, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        for chunk in resp.iter_content(chunk_size=None):
            r.audio(chunk)
        return r, None
    return run


def az_chat_audio(deployment, voice):
    """gpt-audio family through chat completions with audio output, streamed."""
    ep, key = azure()

    def run(text):
        r = Result()
        body = {"model": deployment, "modalities": ["text", "audio"], "audio": {"voice": voice, "format": "pcm16"},
                "stream": True,
                "messages": [{"role": "system", "content": "You are a text-to-speech engine. Read the user's text aloud exactly as written, word for word. Add nothing."},
                             {"role": "user", "content": text}]}
        resp = _az.post(f"{ep}/openai/deployments/{deployment}/chat/completions?api-version=2025-04-01-preview",
                        headers={"api-key": key}, json=body, stream=True, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        transcript = ""
        for ev in sse_events(resp):
            for ch in ev.get("choices", []):
                a = (ch.get("delta") or {}).get("audio") or {}
                if a.get("data"):
                    r.audio(base64.b64decode(a["data"]))
                transcript += a.get("transcript") or ""
        return r, transcript
    return run


# ------------------------------------------------------------------ Azure AI Speech

_sp = requests.Session(); _sp.trust_env = False


def az_speech_service(voice, locale="en-GB"):
    SPEECH_HOST, key = azure_speech()

    def run(text):
        r = Result()
        ssml = (f"<speak version='1.0' xml:lang='{locale}'><voice name='{voice}'>"
                f"{text.replace('&', 'and')}</voice></speak>")
        resp = _sp.post(f"{SPEECH_HOST}/tts/cognitiveservices/v1", data=ssml.encode(), stream=True, timeout=60,
                        headers={"Ocp-Apim-Subscription-Key": key, "Content-Type": "application/ssml+xml",
                                 "X-Microsoft-OutputFormat": "raw-24khz-16bit-mono-pcm", "User-Agent": "voice-probe"})
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        for chunk in resp.iter_content(chunk_size=None):
            r.audio(chunk)
        return r, None
    return run


# ------------------------------------------------------------------ Vertex Gemini TTS

_g = google_session()


def vx_gemini_tts(model, voice="Charon", location="global", stream=True):
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"

    def run(text):
        r = Result()
        h = {"Authorization": f"Bearer {google_token()}", "content-type": "application/json"}
        body = {"contents": [{"role": "user", "parts": [{"text": text}]}],
                "generationConfig": {"responseModalities": ["AUDIO"],
                                     "speechConfig": {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": voice}}}}}
        base = f"https://{host}/v1/projects/{VERTEX_PROJECT}/locations/{location}/publishers/google/models/{model}"
        if stream:
            resp = _g.post(base + ":streamGenerateContent?alt=sse", headers=h, json=body, stream=True, timeout=90)
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
            chunks = 0
            for ev in sse_events(resp):
                for c in ev.get("candidates", []):
                    for p in (c.get("content") or {}).get("parts", []):
                        if "inlineData" in p:
                            chunks += 1
                            r.audio(base64.b64decode(p["inlineData"]["data"]))
            r.note = f"{chunks} chunks"
        else:
            resp = _g.post(base + ":generateContent", headers=h, json=body, timeout=90)
            if resp.status_code != 200:
                raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
            for p in resp.json()["candidates"][0]["content"]["parts"]:
                if "inlineData" in p:
                    r.audio(base64.b64decode(p["inlineData"]["data"]))
        return r, None
    return run


def vx_chirp_rest(voice="en-GB-Chirp3-HD-Charon"):
    def run(text):
        r = Result()
        h = {"Authorization": f"Bearer {google_token()}", "x-goog-user-project": VERTEX_PROJECT}
        resp = _g.post("https://texttospeech.googleapis.com/v1/text:synthesize", headers=h, timeout=60,
                       json={"input": {"text": text}, "voice": {"languageCode": voice[:5], "name": voice},
                             "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000}})
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        wav = base64.b64decode(resp.json()["audioContent"])
        r.audio(wav[44:])   # strip the WAV header
        return r, None
    return run


def vx_cloudtts_stream(voice="en-GB-Chirp3-HD-Charon", model=None, chunked_input=False):
    """Cloud TTS StreamingSynthesize (gRPC). With chunked_input the text is sent sentence by sentence."""
    import os
    import common
    if common.PROXY:
        os.environ["grpc_proxy"] = common.PROXY
        os.environ.pop("no_grpc_proxy", None)
    from google.cloud import texttospeech as tts
    from google.oauth2 import service_account
    common.google_token()
    client = tts.TextToSpeechClient(credentials=common._gcreds)

    def run(text):
        r = Result()
        vp = {"name": voice, "language_code": voice[:5] if not model else "en-GB"}
        if model:
            vp = {"name": voice, "language_code": "en-GB", "model_name": model}
        cfg = tts.StreamingSynthesizeConfig(
            voice=tts.VoiceSelectionParams(**vp),
            streaming_audio_config=tts.StreamingAudioConfig(audio_encoding=tts.AudioEncoding.PCM, sample_rate_hertz=24000))
        import re as _re
        pieces = _re.split(r"(?<=[.!?])\s+", text) if chunked_input else [text]

        def reqs():
            yield tts.StreamingSynthesizeRequest(streaming_config=cfg)
            for p in pieces:
                yield tts.StreamingSynthesizeRequest(input=tts.StreamingSynthesisInput(text=p + " "))
        for resp in client.streaming_synthesize(reqs()):
            r.audio(resp.audio_content)
        return r, None
    return run


ROUTES = {
    "az-4o-mini-tts": lambda: az_speech_api("gpt-4o-mini-tts", "cedar"),
    "az-gpt-audio-1.5": lambda: az_chat_audio("gpt-audio-1.5", "cedar"),
    "az-speech-mai-2.1-flash": lambda: az_speech_service("en-GB-Harry:MAI-Voice-2.1-Flash"),
    "az-speech-mai-2.1": lambda: az_speech_service("en-GB-Harry:MAI-Voice-2.1"),
    "az-speech-dragonhd": lambda: az_speech_service("en-GB-Ollie:DragonHDLatestNeural"),
    "az-speech-neural": lambda: az_speech_service("en-GB-RyanNeural"),
    "vx-3.8-flash-tts": lambda: vx_gemini_tts("gemini-3.8-flash-tts"),
    "vx-3.8-flash-lite-tts": lambda: vx_gemini_tts("gemini-3.8-flash-lite-tts"),
    "vx-2.5-flash-tts": lambda: vx_gemini_tts("gemini-2.5-flash-tts"),
    "vx-2.5-pro-tts": lambda: vx_gemini_tts("gemini-2.5-pro-tts"),
    "vx-3.1-flash-tts-preview": lambda: vx_gemini_tts("gemini-3.1-flash-tts-preview", location="us-central1"),
    "vx-chirp3hd-rest": lambda: vx_chirp_rest(),
    "vx-chirp3hd-stream": lambda: vx_cloudtts_stream(),
    "vx-chirp3hd-stream-chunked": lambda: vx_cloudtts_stream(chunked_input=True),
    "vx-cloudtts-2.5-flash-tts-stream-chunked": lambda: vx_cloudtts_stream(voice="Charon", model="gemini-2.5-flash-tts", chunked_input=True),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--routes", default="")
    ap.add_argument("--lines", default="short,long")
    ap.add_argument("--n", type=int, default=8)
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--tag", default="")
    a = ap.parse_args()
    if a.list:
        print("\n".join(ROUTES)); return
    names = [x for x in a.routes.split(",") if x] or list(ROUTES)
    runners = {}
    for n in names:
        try:
            runners[n] = ROUTES[n]()
            r, tr = runners[n](LINE_SHORT)             # warm-up (connection + auth), not counted
            print(f"{n:28s} warm-up ok ttfb={r.ttfb and round(r.ttfb, 2)} total={r.done()['total']:.2f}", flush=True)
        except Exception as e:  # noqa
            print(f"{n:28s} FAILED: {str(e)[:400]}", flush=True)
            append_jsonl("tts_runs.jsonl", {"route": n, "error": str(e)[:500], "tag": a.tag})
            runners.pop(n, None)
    res = {}
    for i in range(a.n):
        for line in a.lines.split(","):
            for n, run in runners.items():
                try:
                    r, tr = run(LINES[line])
                    d = r.done()
                    d.update(route=n, line=line, i=i, tag=a.tag)
                    if tr:
                        d["transcript"] = tr
                    if i == 0:
                        write_wav(OUT / f"tts_{n}_{line}.wav", np.frombuffer(bytes(r.pcm[:len(r.pcm)//2*2]), np.int16), r.sr)
                except Exception as e:  # noqa
                    d = {"route": n, "line": line, "i": i, "error": str(e)[:300], "tag": a.tag}
                append_jsonl("tts_runs.jsonl", d)
                res.setdefault((n, line), []).append(d)
                print(f"  {i} {n:28s} {line:5s} ttfb={d.get('ttfb') and round(d['ttfb'], 3)} total={d.get('total') and round(d['total'], 2)} audio={d.get('audio_s') and round(d['audio_s'], 1)} {d.get('error', '')[:120]}", flush=True)
    out = {}
    for (n, line), ds in res.items():
        ok = [d for d in ds if "error" not in d]
        out[f"{n}|{line}"] = {"ttfb": summary([d["ttfb"] for d in ok]), "total": summary([d["total"] for d in ok]),
                              "audio_s": summary([d["audio_s"] for d in ok]), "errors": len(ds) - len(ok)}
    prev = {}
    try:
        prev = json.load(open("data/tts_summary.json"))
    except Exception:  # noqa
        pass
    prev.update(out)
    save("tts_summary.json", prev)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
