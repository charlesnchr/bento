"""STT latency and name accuracy on the clips from make_clips.py.

  .venv/bin/python stt_bench.py --list
  .venv/bin/python stt_bench.py --routes az-gpt-transcribe,vx-live-3.5-transcribe-live --n 4

Batch routes upload the whole 16 kHz WAV and time request start -> final transcript (upload of a
100-300 KB body is included). Streaming routes send 24/16 kHz PCM paced at real time in 100 ms chunks,
then end the turn, and time end of audio -> final transcript (also first partial). No vocabulary hints
are given to any route, so name errors are comparable. --n runs per clip per voice (2 voices).
Raw runs: data/stt_runs.jsonl; summary: data/stt_summary.json.
"""
import argparse
import asyncio
import base64
import io
import json
import time

import aiohttp
import requests

from common import (CLIPS, PROXY, VERTEX_PROJECT, append_jsonl, azure, azure_speech, google_session, google_token,
                    name_hits, save, secret, summary, wer)

META = json.loads((CLIPS / "clips.json").read_text())
_az = requests.Session(); _az.trust_env = False
_g = google_session()


def wav_bytes(key, rate):
    return (CLIPS / f"{key}_{rate}.wav").read_bytes()


def pcm_bytes(key, rate):
    return wav_bytes(key, rate)[44:]


# ------------------------------------------------------------------ batch: Azure OpenAI

def az_transcriptions(deployment, stream=False):
    ep, key = azure()

    def run(clip):
        t0 = time.perf_counter(); first = None
        data = {"model": deployment, "response_format": "json"}
        if stream:
            data["stream"] = "true"
        resp = _az.post(f"{ep}/openai/deployments/{deployment}/audio/transcriptions?api-version=2025-04-01-preview",
                        headers={"api-key": key}, files={"file": ("clip.wav", wav_bytes(clip, "16k"), "audio/wav")},
                        data=data, timeout=60, stream=stream)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        if not stream:
            return {"final": time.perf_counter() - t0, "text": resp.json()["text"]}
        text = ""
        for line in resp.iter_lines():
            if not line.startswith(b"data:") or line[5:].strip() == b"[DONE]":
                continue
            ev = json.loads(line[5:])
            if ev.get("type") == "transcript.text.delta" and first is None:
                first = time.perf_counter() - t0
            if ev.get("type") == "transcript.text.done":
                text = ev["text"]
        return {"final": time.perf_counter() - t0, "first": first, "text": text}
    return run


# ------------------------------------------------------------------ batch: Azure AI Speech fast transcription

def az_fast(model=None, locale="en-GB"):
    SPEECH_HOST, key = azure_speech()

    def run(clip):
        t0 = time.perf_counter()
        definition = {"locales": [locale]}
        if model:
            definition = {"locales": ["en"], "enhancedMode": {"enabled": True, "model": model}}
        resp = _az.post(f"{SPEECH_HOST}/speechtotext/transcriptions:transcribe?api-version=2024-11-15",
                        headers={"Ocp-Apim-Subscription-Key": key},
                        files={"audio": ("clip.wav", wav_bytes(clip, "16k"), "audio/wav"),
                               "definition": (None, json.dumps(definition), "application/json")}, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        b = resp.json()
        text = " ".join(p["text"] for p in b.get("combinedPhrases", []))
        return {"final": time.perf_counter() - t0, "text": text}
    return run


# ------------------------------------------------------------------ batch: Vertex

def vx_generate(model, mode, location="global"):
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"

    def run(clip):
        t0 = time.perf_counter()
        audio = {"inlineData": {"mimeType": "audio/wav", "data": base64.b64encode(wav_bytes(clip, "16k")).decode()}}
        if mode == "transcribe":
            body = {"contents": [{"role": "user", "parts": [audio]}],
                    "generationConfig": {"temperature": 0, "audioTranscriptionConfig": {"wordTimestamp": True, "diarization": False}}}
        else:
            think = {"thinkingLevel": mode}
            body = {"contents": [{"role": "user", "parts": [audio, {"text": "Transcribe this audio verbatim. Output only the transcript."}]}],
                    "generationConfig": {"temperature": 0, "thinkingConfig": think}}
        url = f"https://{host}/v1/projects/{VERTEX_PROJECT}/locations/{location}/publishers/google/models/{model}:generateContent"
        resp = _g.post(url, headers={"Authorization": f"Bearer {google_token()}"}, json=body, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        parts = resp.json()["candidates"][0]["content"].get("parts", [])
        text = " ".join(p.get("text", "") for p in parts if not p.get("thought"))
        return {"final": time.perf_counter() - t0, "text": text.strip()}
    return run


def vx_chirp(model="chirp_3", location="us"):
    host = "speech.googleapis.com" if location == "global" else f"{location}-speech.googleapis.com"

    def run(clip):
        t0 = time.perf_counter()
        body = {"config": {"autoDecodingConfig": {}, "languageCodes": ["en-GB"] if model != "chirp_3" else ["en-US"], "model": model},
                "content": base64.b64encode(wav_bytes(clip, "16k")).decode()}
        url = f"https://{host}/v2/projects/{VERTEX_PROJECT}/locations/{location}/recognizers/_:recognize"
        resp = _g.post(url, headers={"Authorization": f"Bearer {google_token()}", "x-goog-user-project": VERTEX_PROJECT},
                       json=body, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        text = " ".join(r["alternatives"][0]["transcript"] for r in resp.json().get("results", []) if r.get("alternatives"))
        return {"final": time.perf_counter() - t0, "text": text.strip()}
    return run


# ------------------------------------------------------------------ streaming: Azure realtime transcription

def az_rt_transcribe(model, url_style="intent"):
    ep, key = azure()
    wss = ep.replace("https:", "wss:")
    url = f"{wss}/openai/v1/realtime?intent=transcription" if url_style == "intent" else f"{wss}/openai/v1/realtime?model={model}"

    async def arun(clip):
        pcm = pcm_bytes(clip, "24k")
        async with aiohttp.ClientSession(trust_env=False) as s:
            t_conn = time.perf_counter()
            async with s.ws_connect(url, headers={"api-key": key}, max_msg_size=8 << 20) as ws:
                await ws.send_json({"type": "session.update", "session": {"type": "transcription", "audio": {"input": {
                    "format": {"type": "audio/pcm", "rate": 24000}, "transcription": {"model": model}, "turn_detection": None}}}})
                # wait for session.updated (or error)
                while True:
                    m = json.loads((await asyncio.wait_for(ws.receive(), 15)).data)
                    if m["type"] in ("session.updated", "transcription_session.updated"):
                        break
                    if m["type"] == "error":
                        raise RuntimeError(json.dumps(m)[:300])
                setup = time.perf_counter() - t_conn
                step = 4800
                start = time.perf_counter()
                for i in range(0, len(pcm), step):
                    await ws.send_json({"type": "input_audio_buffer.append", "audio": base64.b64encode(pcm[i:i + step]).decode()})
                    target = start + (i + step) / 48000
                    await asyncio.sleep(max(0, target - time.perf_counter()))
                await ws.send_json({"type": "input_audio_buffer.commit"})
                t_end = time.perf_counter(); first = None; first_any = None
                while True:
                    msg = await asyncio.wait_for(ws.receive(), 20)
                    m = json.loads(msg.data); ty = m["type"]
                    if ty.endswith("input_audio_transcription.delta"):
                        now = time.perf_counter()
                        if first_any is None:
                            first_any = now - start
                        if first is None and now >= t_end:
                            first = now - t_end
                    if ty.endswith("input_audio_transcription.completed"):
                        return {"final": time.perf_counter() - t_end, "first_after_end": first,
                                "first_delta_from_audio_start": first_any, "setup": setup, "text": m.get("transcript", "")}
                    if ty == "error" or ty.endswith("failed"):
                        raise RuntimeError(json.dumps(m)[:300])

    return lambda clip: asyncio.run(arun(clip))


# ------------------------------------------------------------------ streaming: Vertex Live transcription

def vx_live_transcribe(model="gemini-3.5-transcribe-live", smart=False, location="global"):
    async def arun(clip):
        pcm = pcm_bytes(clip, "16k")
        host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
        url = f"wss://{host}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"
        res = f"projects/{VERTEX_PROJECT}/locations/{location}/publishers/google/models/{model}"
        async with aiohttp.ClientSession(trust_env=False) as s:
            t_conn = time.perf_counter()
            async with s.ws_connect(url, headers={"Authorization": f"Bearer {google_token()}"}, proxy=PROXY,
                                    max_msg_size=8 << 20) as ws:
                await ws.send_json({"setup": {"model": res, "generationConfig": {"responseModalities": ["TEXT"]},
                                              "inputAudioTranscription": {"mode": "SMART" if smart else "VERBATIM"},
                                              "realtimeInputConfig": {"automaticActivityDetection": {"disabled": True}}}})
                m = json.loads((await asyncio.wait_for(ws.receive(), 20)).data)
                if "setupComplete" not in m:
                    raise RuntimeError(json.dumps(m)[:300])
                setup = time.perf_counter() - t_conn
                finals, partial_first = [], None

                async def recv():
                    nonlocal partial_first
                    async for msg in ws:
                        if msg.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                            break
                        m = json.loads(msg.data)
                        sc = m.get("serverContent") or {}
                        if "interimInputTranscription" in sc and partial_first is None:
                            partial_first = time.perf_counter()
                        if "inputTranscription" in sc and (sc["inputTranscription"].get("text")):
                            finals.append((time.perf_counter(), sc["inputTranscription"]["text"]))
                        if "error" in m:
                            raise RuntimeError(json.dumps(m)[:300])
                rt = asyncio.create_task(recv())
                await ws.send_json({"realtimeInput": {"activityStart": {}}})
                start = time.perf_counter(); step = 3200
                for i in range(0, len(pcm), step):
                    await ws.send_json({"realtimeInput": {"audio": {"data": base64.b64encode(pcm[i:i + step]).decode(),
                                                                    "mimeType": "audio/pcm;rate=16000"}}})
                    await asyncio.sleep(max(0, start + (i + step) / 32000 - time.perf_counter()))
                await ws.send_json({"realtimeInput": {"activityEnd": {}}})
                t_end = time.perf_counter()
                # final = last final segment; stop after 1.5 s without a new one (max 15 s)
                while time.perf_counter() - t_end < 15:
                    await asyncio.sleep(0.05)
                    last = finals[-1][0] if finals else None
                    if last and last > t_end - 0.0 and time.perf_counter() - last > 1.5:
                        break
                    if last and last < t_end and time.perf_counter() - t_end > 3:
                        break
                rt.cancel()
                after = [t for t, _ in finals if t >= t_end]
                return {"final": (finals[-1][0] - t_end) if finals else None,
                        "first_after_end": (after[0] - t_end) if after else None,
                        "finals_before_end": sum(1 for t, _ in finals if t < t_end),
                        "partial_first_from_audio_start": (partial_first - start) if partial_first else None,
                        "setup": setup, "text": " ".join(x for _, x in finals).strip()}

    return lambda clip: asyncio.run(arun(clip))


ROUTES = {
    "az-gpt-transcribe": lambda: az_transcriptions("gpt-transcribe"),
    "az-gpt-transcribe-stream": lambda: az_transcriptions("gpt-transcribe", stream=True),
    "az-4o-transcribe": lambda: az_transcriptions("gpt-4o-transcribe"),
    "az-4o-mini-transcribe": lambda: az_transcriptions("gpt-4o-mini-transcribe"),
    "az-whisper": lambda: az_transcriptions("whisper"),
    "az-speech-fast": lambda: az_fast(),
    "az-speech-mai-transcribe-2": lambda: az_fast("MAI-Transcribe-2"),
    "vx-3.5-transcribe": lambda: vx_generate("gemini-3.5-transcribe", "transcribe"),
    "vx-3.5-flash-lite-prompt": lambda: vx_generate("gemini-3.5-flash-lite", "minimal"),
    "vx-3.8-flash-prompt": lambda: vx_generate("gemini-3.8-flash", "low"),
    "vx-chirp3": lambda: vx_chirp("chirp_3", "us"),
    "rt-az-gpt-live-transcribe": lambda: az_rt_transcribe("gpt-live-transcribe"),
    "rt-az-gpt-realtime-whisper": lambda: az_rt_transcribe("gpt-realtime-whisper"),
    "rt-az-gpt-transcribe": lambda: az_rt_transcribe("gpt-transcribe"),
    "rt-vx-3.5-transcribe-live": lambda: vx_live_transcribe("gemini-3.5-transcribe-live"),
    "rt-vx-3.5-transcribe-live-smart": lambda: vx_live_transcribe("gemini-3.5-transcribe-live", smart=True),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--routes", default="")
    ap.add_argument("--clips", default="q3,q10")
    ap.add_argument("--voices", default="chirp,azneural")
    ap.add_argument("--n", type=int, default=4)
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
            d = runners[n]("q3_chirp")
            print(f"{n:32s} warm-up ok final={d['final'] and round(d['final'], 2)} '{d['text'][:70]}'", flush=True)
        except Exception as e:  # noqa
            print(f"{n:32s} FAILED: {str(e)[:400]}", flush=True)
            append_jsonl("stt_runs.jsonl", {"route": n, "error": str(e)[:500], "tag": a.tag})
            runners.pop(n, None)
    res = {}
    for i in range(a.n):
        for clip in a.clips.split(","):
            for voice in a.voices.split(","):
                key = f"{clip}_{voice}"
                ref = META[key]["text"]
                for n, run in runners.items():
                    try:
                        d = run(key)
                        d.update(route=n, clip=clip, voice=voice, i=i, tag=a.tag, wer=round(wer(ref, d["text"]), 3),
                                 names=name_hits(d["text"]))
                    except Exception as e:  # noqa
                        d = {"route": n, "clip": clip, "voice": voice, "i": i, "error": str(e)[:300], "tag": a.tag}
                    append_jsonl("stt_runs.jsonl", d)
                    res.setdefault((n, clip), []).append(d)
                    print(f"  {i} {n:32s} {key:12s} final={d.get('final') and round(d['final'], 3)} wer={d.get('wer')} "
                          f"{'' if 'error' not in d else d['error'][:100]} {d.get('text', '')[:80]}", flush=True)
    out = {}
    for (n, clip), ds in res.items():
        ok = [d for d in ds if "error" not in d]
        names_ok = [all(v for k, v in d["names"].items() if k in META[f"{clip}_chirp"]["text"].lower()) for d in ok]
        out[f"{n}|{clip}"] = {"final": summary([d["final"] for d in ok]),
                              "first_after_end": summary([d.get("first_after_end") for d in ok]),
                              "first": summary([d.get("first") for d in ok]),
                              "wer_mean": round(sum(d["wer"] for d in ok) / len(ok), 3) if ok else None,
                              "names_all_right": f"{sum(names_ok)}/{len(ok)}", "errors": len(ds) - len(ok)}
    prev = {}
    try:
        prev = json.load(open("data/stt_summary.json"))
    except Exception:  # noqa
        pass
    prev.update(out)
    save("stt_summary.json", prev)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
