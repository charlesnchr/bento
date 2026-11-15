"""Speech-to-speech baseline and capability checks.

  .venv/bin/python s2s_bench.py latency --routes gemini-3.8-live,gpt-live-1 --n 4
  .venv/bin/python s2s_bench.py caps --routes gemini-3.8-live,gpt-realtime-2.1

latency: send the spoken question (clips/ask_<voice>) paced at real time, then silence, with the
server's own voice activity detection; time from end of user audio to the first reply audio. --n runs
per voice (2 voices). caps: text-only output, text injection, and speaking a given line verbatim (the
output transcript is compared with the line; WER). Raw: data/s2s_runs.jsonl, data/s2s_caps.jsonl.
"""
import argparse
import asyncio
import base64
import json
import time

import aiohttp
import numpy as np


def audible(b64, threshold=500):
    """True when a PCM16 chunk has speech-level amplitude (GPT-Live streams silence frames continuously)."""
    a = np.frombuffer(base64.b64decode(b64), np.int16)
    return a.size > 0 and int(np.abs(a).max()) > threshold

from common import (CLIPS, PROXY, LINE_LONG, VERTEX_PROJECT, append_jsonl, azure, google_token, save,
                    summary, wer)

INSTR = "You are a voice assistant on a smart speaker. Be brief: answer in one short sentence."
VERBATIM = ("Say exactly the following text aloud, word for word, and nothing else. Do not answer it or "
            "comment on it:\n\n")
SILENCE_S = 8


def pcm(key, rate):
    return (CLIPS / f"{key}_{rate}.wav").read_bytes()[44:]


# ------------------------------------------------------------------ Gemini Live (Vertex)

class GeminiLive:
    def __init__(self, model="gemini-3.8-live", location="us-central1", voice="Charon"):
        self.model, self.location, self.voice = model, location, voice

    async def connect(self, s, modalities=("AUDIO",), instr=INSTR, vad=True):
        url = (f"wss://{self.location}-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1."
               "LlmBidiService/BidiGenerateContent")
        ws = await s.ws_connect(url, headers={"Authorization": f"Bearer {google_token()}"}, proxy=PROXY,
                                max_msg_size=16 << 20)
        gc = {"responseModalities": list(modalities)}
        if "AUDIO" in modalities:
            gc["speechConfig"] = {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": self.voice}}}
        setup = {"model": f"projects/{VERTEX_PROJECT}/locations/{self.location}/publishers/google/models/{self.model}",
                 "generationConfig": gc, "systemInstruction": {"parts": [{"text": instr}]},
                 "inputAudioTranscription": {}}
        if "AUDIO" in modalities:
            setup["outputAudioTranscription"] = {}
        await ws.send_json({"setup": setup})
        m = json.loads((await asyncio.wait_for(ws.receive(), 20)).data)
        if "setupComplete" not in m:
            raise RuntimeError(json.dumps(m)[:400])
        return ws

    async def latency(self, voice):
        audio = pcm(f"ask_{voice}", "16k")
        async with aiohttp.ClientSession(trust_env=False) as s:
            t = time.perf_counter()
            ws = await self.connect(s)
            setup_s = time.perf_counter() - t
            st = {"first_audio": None, "out": "", "in": "", "done": False}

            async def recv():
                async for msg in ws:
                    if msg.type not in (aiohttp.WSMsgType.TEXT, aiohttp.WSMsgType.BINARY):
                        break
                    m = json.loads(msg.data); sc = m.get("serverContent") or {}
                    for p in (sc.get("modelTurn") or {}).get("parts", []):
                        if "inlineData" in p:
                            st.setdefault("first_frame", time.perf_counter())
                            if st["first_audio"] is None and audible(p["inlineData"]["data"]):
                                st["first_audio"] = time.perf_counter()
                    st["out"] += (sc.get("outputTranscription") or {}).get("text", "")
                    st["in"] += (sc.get("inputTranscription") or {}).get("text", "")
                    if sc.get("turnComplete"):
                        st["done"] = True
                        return
            rt = asyncio.create_task(recv())
            full = audio + bytes(16000 * 2 * SILENCE_S)
            step = 3200; start = time.perf_counter(); t_end = None
            for i in range(0, len(full), step):
                if st["first_audio"]:
                    break
                await ws.send_json({"realtimeInput": {"audio": {"data": base64.b64encode(full[i:i + step]).decode(),
                                                                "mimeType": "audio/pcm;rate=16000"}}})
                if t_end is None and i + step >= len(audio):
                    t_end = start + len(audio) / 32000
                await asyncio.sleep(max(0, start + (i + step) / 32000 - time.perf_counter()))
            try:
                await asyncio.wait_for(rt, 15)
            except asyncio.TimeoutError:
                rt.cancel()
            await ws.close()
            fa = st["first_audio"]
            return {"latency": (fa - t_end) if fa else None, "setup": setup_s, "heard": st["in"].strip(),
                    "first_frame_rel_end": (st["first_frame"] - t_end) if st.get("first_frame") else None,
                    "reply": st["out"].strip()}

    async def caps(self):
        out = {}
        async with aiohttp.ClientSession(trust_env=False) as s:
            # 1. text-only output
            try:
                ws = await self.connect(s, modalities=("TEXT",))
                await ws.send_json({"clientContent": {"turns": [{"role": "user", "parts": [{"text": "Say hello in three words."}]}], "turnComplete": True}})
                text = ""
                while True:
                    m = json.loads((await asyncio.wait_for(ws.receive(), 20)).data)
                    sc = m.get("serverContent") or {}
                    text += "".join(p.get("text", "") for p in (sc.get("modelTurn") or {}).get("parts", []))
                    if sc.get("turnComplete") or "error" in m:
                        break
                await ws.close()
                out["text_only"] = {"ok": bool(text), "text": text[:200]}
            except Exception as e:  # noqa
                out["text_only"] = {"ok": False, "error": str(e)[:300]}
            # 2/3. injected text, spoken verbatim (system instruction and per-turn instruction)
            for label, instr, turn in [("verbatim_turn", INSTR, VERBATIM + LINE_LONG),
                                       ("verbatim_system", "You are a text-to-speech voice. Read every user message aloud exactly as written, word for word. Never answer, add or change anything.", LINE_LONG)]:
                runs = []
                for _ in range(3):
                    try:
                        ws = await self.connect(s, instr=instr)
                        t0 = time.perf_counter(); first = None; tr = ""; audio_b = 0
                        await ws.send_json({"clientContent": {"turns": [{"role": "user", "parts": [{"text": turn}]}], "turnComplete": True}})
                        while True:
                            m = json.loads((await asyncio.wait_for(ws.receive(), 30)).data)
                            sc = m.get("serverContent") or {}
                            for p in (sc.get("modelTurn") or {}).get("parts", []):
                                if "inlineData" in p:
                                    first = first or time.perf_counter() - t0
                                    audio_b += len(base64.b64decode(p["inlineData"]["data"]))
                            tr += (sc.get("outputTranscription") or {}).get("text", "")
                            if sc.get("turnComplete") or "error" in m:
                                break
                        await ws.close()
                        runs.append({"first_audio": first, "total": time.perf_counter() - t0, "audio_s": audio_b / 48000,
                                     "wer": round(wer(LINE_LONG, tr), 3), "transcript": tr.strip()})
                    except Exception as e:  # noqa
                        runs.append({"error": str(e)[:300]})
                out[label] = runs
        return out


# ------------------------------------------------------------------ GPT-Live (Azure, /openai/v1/live/sessions)

class GptLive:
    def __init__(self, model="gpt-live-1", voice="cedar"):
        self.model, self.voice = model, voice
        self.ep, self.key = azure()

    async def connect(self, s, session_extra=None, instr=INSTR):
        ws = await s.ws_connect(self.ep.replace("https:", "wss:") + "/openai/v1/live/sessions",
                                headers={"api-key": self.key}, heartbeat=20, max_msg_size=16 << 20)
        sess = {"model": self.model, "audio": {"output": {"voice": self.voice}}, "instructions": instr}
        sess.update(session_extra or {})
        await ws.send_json({"type": "session.start", "session": sess})
        m = json.loads((await asyncio.wait_for(ws.receive(), 20)).data)
        if m.get("type") != "session.started":
            raise RuntimeError(json.dumps(m)[:400])
        return ws, m

    async def latency(self, voice):
        audio = pcm(f"ask_{voice}", "24k")
        async with aiohttp.ClientSession(trust_env=False) as s:
            t = time.perf_counter()
            ws, _ = await self.connect(s)
            setup_s = time.perf_counter() - t
            st = {"first_audio": None, "out": "", "in": ""}

            async def recv():
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        break
                    m = json.loads(msg.data); ty = m.get("type")
                    if ty == "session.output_audio.delta":
                        st.setdefault("first_frame", time.perf_counter())
                        if st["first_audio"] is None and audible(m["delta"]):
                            st["first_audio"] = time.perf_counter()
                    if ty == "session.output_transcript.delta":
                        st["out"] += m.get("delta", "")
                    if ty == "session.input_transcript.delta":
                        st["in"] += m.get("delta", "")
                    if ty in ("session.closed", "error"):
                        if ty == "error":
                            st["error"] = json.dumps(m)[:300]
                        return
            rt = asyncio.create_task(recv())
            full = audio + bytes(24000 * 2 * SILENCE_S)
            step = 4800; start = time.perf_counter(); t_end = start + len(audio) / 48000
            for i in range(0, len(full), step):
                if st["first_audio"] and time.perf_counter() - st["first_audio"] > 3:
                    break
                await ws.send_json({"type": "session.input_audio.append", "audio": base64.b64encode(full[i:i + step]).decode()})
                await asyncio.sleep(max(0, start + (i + step) / 48000 - time.perf_counter()))
            await ws.send_json({"type": "session.close"})
            try:
                await asyncio.wait_for(rt, 10)
            except asyncio.TimeoutError:
                rt.cancel()
            await ws.close()
            fa = st["first_audio"]
            return {"latency": (fa - t_end) if fa else None, "setup": setup_s, "heard": st["in"].strip(),
                    "first_frame_rel_end": (st["first_frame"] - t_end) if st.get("first_frame") else None,
                    "reply": st["out"].strip(), "error": st.get("error")}

    async def caps(self):
        out = {}
        async with aiohttp.ClientSession(trust_env=False) as s:
            # text-only output: try a few plausible session shapes and record what the server says
            tries = []
            for extra in [{"output_modalities": ["text"]}, {"audio": {"output": None}}, {"modalities": ["text"]}]:
                try:
                    ws, m = await self.connect(s, session_extra=extra)
                    tries.append({"session": extra, "started": True, "session_echo": json.dumps(m)[:300]})
                    await ws.close()
                except Exception as e:  # noqa
                    tries.append({"session": extra, "started": False, "error": str(e)[:300]})
            out["text_only_attempts"] = tries
            # text injection: try candidate event types
            inj = []
            for ev in [{"type": "session.input_text.append", "text": "Say hello."},
                       {"type": "session.input_text", "text": "Say hello."},
                       {"type": "conversation.item.create", "item": {"type": "message", "role": "user", "content": [{"type": "input_text", "text": "Say hello."}]}},
                       {"type": "session.thinking.append", "content": "The user asked you to say hello now."}]:
                try:
                    ws, _ = await self.connect(s)
                    await ws.send_json(ev)
                    got = []
                    try:
                        while len(got) < 6:
                            m = json.loads((await asyncio.wait_for(ws.receive(), 6)).data)
                            got.append(m.get("type") + (": " + json.dumps(m.get("error"))[:200] if m.get("type") == "error" else ""))
                            if m.get("type") in ("error", "session.closed"):
                                break
                    except (asyncio.TimeoutError, TypeError):
                        pass
                    await ws.close()
                    inj.append({"event": ev["type"], "server": got})
                except Exception as e:  # noqa
                    inj.append({"event": ev["type"], "error": str(e)[:300]})
            out["text_injection_attempts"] = inj
            # verbatim via instructions + a short spoken cue (the only input GPT-Live takes is audio)
            runs = []
            cue = pcm("q3_chirp", "24k")
            for _ in range(3):
                try:
                    instr = ("You are a text-to-speech voice. Whenever the user speaks, reply by reading this text aloud "
                             "exactly, word for word, and nothing else: \"" + LINE_LONG + "\"")
                    ws, _ = await self.connect(s, instr=instr)
                    tr, first, t_end = "", None, None
                    full = cue + bytes(24000 * 2 * 20); start = time.perf_counter(); t_end = start + len(cue) / 48000
                    done = False

                    async def recv():
                        nonlocal tr, first, done
                        async for msg in ws:
                            m = json.loads(msg.data); ty = m.get("type")
                            if ty == "session.output_audio.delta" and first is None:
                                first = time.perf_counter() - t_end
                            if ty == "session.output_transcript.delta":
                                tr += m.get("delta", "")
                            if ty in ("session.closed", "error"):
                                return
                    rt = asyncio.create_task(recv())
                    last_len, quiet_since = 0, None
                    for i in range(0, len(full), 4800):
                        await ws.send_json({"type": "session.input_audio.append", "audio": base64.b64encode(full[i:i + 4800]).decode()})
                        await asyncio.sleep(max(0, start + (i + 4800) / 48000 - time.perf_counter()))
                        if len(tr) != last_len:
                            last_len, quiet_since = len(tr), time.perf_counter()
                        if quiet_since and time.perf_counter() - quiet_since > 3:
                            break
                    await ws.send_json({"type": "session.close"})
                    try:
                        await asyncio.wait_for(rt, 5)
                    except asyncio.TimeoutError:
                        rt.cancel()
                    await ws.close()
                    runs.append({"first_audio_after_cue": first, "wer": round(wer(LINE_LONG, tr), 3), "transcript": tr.strip()})
                except Exception as e:  # noqa
                    runs.append({"error": str(e)[:300]})
            out["verbatim_via_instructions"] = runs
        return out


# ------------------------------------------------------------------ GPT Realtime (Azure, /openai/v1/realtime)

class GptRealtime:
    def __init__(self, deployment, voice="cedar"):
        self.dep, self.voice = deployment, voice
        self.ep, self.key = azure()

    async def connect(self, s, modalities=("audio",), instr=INSTR, vad=True):
        ws = await s.ws_connect(self.ep.replace("https:", "wss:") + f"/openai/v1/realtime?model={self.dep}",
                                headers={"api-key": self.key}, heartbeat=20, max_msg_size=16 << 20)
        sess = {"type": "realtime", "instructions": instr, "output_modalities": list(modalities),
                "audio": {"input": {"format": {"type": "audio/pcm", "rate": 24000},
                                    "turn_detection": {"type": "server_vad", "silence_duration_ms": 500} if vad else None,
                                    "transcription": {"model": "gpt-4o-mini-transcribe"}},
                          "output": {"format": {"type": "audio/pcm", "rate": 24000}, "voice": self.voice}}}
        await ws.send_json({"type": "session.update", "session": sess})
        while True:
            m = json.loads((await asyncio.wait_for(ws.receive(), 20)).data)
            if m["type"] == "session.updated":
                return ws
            if m["type"] == "error":
                raise RuntimeError(json.dumps(m)[:400])

    async def latency(self, voice):
        audio = pcm(f"ask_{voice}", "24k")
        async with aiohttp.ClientSession(trust_env=False) as s:
            t = time.perf_counter()
            ws = await self.connect(s)
            setup_s = time.perf_counter() - t
            st = {"first_audio": None, "out": "", "in": "", "speech_stopped": None}

            async def recv():
                async for msg in ws:
                    if msg.type != aiohttp.WSMsgType.TEXT:
                        break
                    m = json.loads(msg.data); ty = m.get("type")
                    if ty == "response.output_audio.delta":
                        st.setdefault("first_frame", time.perf_counter())
                        if st["first_audio"] is None and audible(m["delta"]):
                            st["first_audio"] = time.perf_counter()
                    if ty == "input_audio_buffer.speech_stopped":
                        st["speech_stopped"] = time.perf_counter()
                    if ty == "response.output_audio_transcript.delta":
                        st["out"] += m.get("delta", "")
                    if ty == "conversation.item.input_audio_transcription.completed":
                        st["in"] = m.get("transcript", "")
                    if ty == "response.done":
                        return
                    if ty == "error":
                        st["error"] = json.dumps(m)[:300]; return
            rt = asyncio.create_task(recv())
            full = audio + bytes(24000 * 2 * SILENCE_S)
            step = 4800; start = time.perf_counter(); t_end = start + len(audio) / 48000
            for i in range(0, len(full), step):
                if st["first_audio"] or rt.done():
                    break
                await ws.send_json({"type": "input_audio_buffer.append", "audio": base64.b64encode(full[i:i + step]).decode()})
                await asyncio.sleep(max(0, start + (i + step) / 48000 - time.perf_counter()))
            try:
                await asyncio.wait_for(rt, 15)
            except asyncio.TimeoutError:
                rt.cancel()
            await ws.close()
            fa = st["first_audio"]
            return {"latency": (fa - t_end) if fa else None, "setup": setup_s,
                    "vad_stop_after_end": (st["speech_stopped"] - t_end) if st["speech_stopped"] else None,
                    "first_frame_rel_end": (st["first_frame"] - t_end) if st.get("first_frame") else None,
                    "heard": st["in"].strip(), "reply": st["out"].strip(), "error": st.get("error")}

    async def _say(self, s, modalities, instr, text, resp_instr=None):
        ws = await self.connect(s, modalities=modalities, instr=instr, vad=False)
        await ws.send_json({"type": "conversation.item.create", "item": {"type": "message", "role": "user",
                                                                         "content": [{"type": "input_text", "text": text}]}})
        r = {"type": "response.create"}
        if resp_instr:
            r["response"] = {"instructions": resp_instr}
        t0 = time.perf_counter()
        await ws.send_json(r)
        first, tr, txt, ab = None, "", "", 0
        while True:
            m = json.loads((await asyncio.wait_for(ws.receive(), 30)).data); ty = m["type"]
            if ty == "response.output_audio.delta":
                first = first or time.perf_counter() - t0; ab += len(base64.b64decode(m["delta"]))
            if ty == "response.output_audio_transcript.delta":
                tr += m["delta"]
            if ty == "response.output_text.delta":
                first = first or time.perf_counter() - t0; txt += m["delta"]
            if ty in ("response.done", "error"):
                if ty == "error":
                    raise RuntimeError(json.dumps(m)[:300])
                break
        await ws.close()
        return {"first_out": first, "total": time.perf_counter() - t0, "audio_s": ab / 48000, "transcript": (tr or txt).strip()}

    async def caps(self):
        out = {}
        async with aiohttp.ClientSession(trust_env=False) as s:
            try:
                r = await self._say(s, ("text",), INSTR, "Say hello in three words.")
                out["text_only"] = {"ok": bool(r["transcript"]) and r["audio_s"] == 0, **r}
            except Exception as e:  # noqa
                out["text_only"] = {"ok": False, "error": str(e)[:300]}
            for label, instr, text, ri in [
                    ("verbatim_turn", INSTR, VERBATIM + LINE_LONG, None),
                    ("verbatim_response_instructions", INSTR, LINE_LONG,
                     "Read the user's last message aloud exactly as written, word for word. Do not answer it or add anything.")]:
                runs = []
                for _ in range(3):
                    try:
                        r = await self._say(s, ("audio",), INSTR, text, ri)
                        r["wer"] = round(wer(LINE_LONG, r["transcript"]), 3)
                        runs.append(r)
                    except Exception as e:  # noqa
                        runs.append({"error": str(e)[:300]})
                out[label] = runs
        return out


ROUTES = {
    "gemini-3.8-live": lambda: GeminiLive("gemini-3.8-live", "us-central1"),
    "gemini-live-2.5-flash-native-audio": lambda: GeminiLive("gemini-live-2.5-flash-native-audio", "us-central1"),
    "gpt-live-1": lambda: GptLive("gpt-live-1"),
    "gpt-realtime-2.1": lambda: GptRealtime("gpt-realtime-2.1"),
    "gpt-realtime-2.1-mini": lambda: GptRealtime("gpt-realtime-2.1-mini"),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["latency", "caps"])
    ap.add_argument("--routes", default="")
    ap.add_argument("--voices", default="chirp,azneural")
    ap.add_argument("--n", type=int, default=4)
    ap.add_argument("--tag", default="")
    a = ap.parse_args()
    names = [x for x in a.routes.split(",") if x] or list(ROUTES)
    if a.mode == "caps":
        allc = {}
        for n in names:
            try:
                c = asyncio.run(ROUTES[n]().caps())
            except Exception as e:  # noqa
                c = {"error": str(e)[:400]}
            allc[n] = c
            append_jsonl("s2s_caps.jsonl", {"route": n, "tag": a.tag, **c})
            print(n, json.dumps(c, indent=1)[:4000], flush=True)
        return
    res = {}
    for i in range(a.n):
        for v in a.voices.split(","):
            for n in names:
                try:
                    d = asyncio.run(ROUTES[n]().latency(v))
                except Exception as e:  # noqa
                    d = {"error": str(e)[:300]}
                d.update(route=n, voice=v, i=i, tag=a.tag)
                append_jsonl("s2s_runs.jsonl", d)
                res.setdefault(n, []).append(d)
                print(f"  {i} {n:36s} {v:9s} latency={d.get('latency') and round(d['latency'], 3)} setup={d.get('setup') and round(d['setup'], 2)} "
                      f"heard='{d.get('heard', '')[:50]}' reply='{d.get('reply', '')[:60]}' {d.get('error') or ''}", flush=True)
    out = {n: {"latency": summary([d.get("latency") for d in ds]), "setup": summary([d.get("setup") for d in ds]),
               "errors": sum(1 for d in ds if d.get("latency") is None)} for n, ds in res.items()}
    prev = {}
    try:
        prev = json.load(open("data/s2s_summary.json"))
    except Exception:  # noqa
        pass
    prev.update(out)
    save("s2s_summary.json", prev)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
