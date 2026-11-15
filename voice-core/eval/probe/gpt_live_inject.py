"""GPT-Live (gpt-live-1): can a client make it speak given text, and how faithfully?

  .venv/bin/python gpt_live_inject.py [runs]

A. client delegation (Bento's path): a spoken cue makes GPT-Live delegate; the client answers the
   delegation with session.commentary.append carrying the line (as Bento sends Hermes results).
   Timed from the commentary send to the first reply audio after it.
B. Responses delegation: no audio; response.item.create (a user message) + response.create drive the
   backend Responses model, and GPT-Live speaks the outcome. Timed from response.create to first audio.
Output transcript is compared with the line (WER). Raw: data/gpt_live_inject.jsonl.
"""
import asyncio
import base64
import json
import sys
import time

import aiohttp

from common import CLIPS, LINE_LONG, append_jsonl, azure, wer
from s2s_bench import audible

EP, KEY = azure()
INSTR_A = ("You are the voice of a home assistant. Be brief. Delegate requests about Hermes, builds and the user's "
           "data to the client. When the client returns a result, tell the user the result.")
INSTR_B = "You are the voice of a home assistant. Be brief. Tell the user what your backend replies."


async def session(s, sess):
    ws = await s.ws_connect(EP.replace("https:", "wss:") + "/openai/v1/live/sessions", headers={"api-key": KEY},
                            heartbeat=20, max_msg_size=16 << 20)
    await ws.send_json({"type": "session.start", "session": sess})
    m = json.loads((await asyncio.wait_for(ws.receive(), 20)).data)
    if m.get("type") != "session.started":
        raise RuntimeError(json.dumps(m)[:400])
    return ws


async def client_delegation():
    cue = (CLIPS / "q3_chirp_24k.wav").read_bytes()[44:]
    async with aiohttp.ClientSession(trust_env=False) as s:
        ws = await session(s, {"model": "gpt-live-1", "audio": {"output": {"voice": "cedar"}}, "instructions": INSTR_A,
                               "delegation": {"type": "client"}})
        st = {"did": None, "sent": None, "first": None, "tr_after": "", "tr_before": "", "types": []}

        async def recv():
            async for msg in ws:
                if msg.type != aiohttp.WSMsgType.TEXT:
                    st["types"].append(f"ws {msg.type} {msg.data} {msg.extra}")
                    return
                m = json.loads(msg.data); ty = m.get("type")
                if ty not in ("session.output_audio.delta", "session.output_transcript.delta", "session.input_transcript.delta"):
                    st["types"].append(ty + (": " + json.dumps(m.get("error"))[:200] if ty == "error" else ""))
                if ty == "session.delegation.created" and not st["did"]:
                    st["did"] = (m.get("delegation") or {}).get("id")
                if ty == "session.output_audio.delta" and st["sent"] and st["first"] is None and audible(m["delta"]):
                    st["first"] = time.perf_counter() - st["sent"]
                if ty == "session.output_transcript.delta":
                    st["tr_after" if st["sent"] else "tr_before"] += m.get("delta", "")
                if ty in ("session.closed", "error"):
                    return
        rt = asyncio.create_task(recv())
        full = cue + bytes(24000 * 2 * 30); start = time.perf_counter(); quiet = None; last = 0
        for i in range(0, len(full), 4800):
            if ws.closed or rt.done():
                break
            try:
                await ws.send_json({"type": "session.input_audio.append", "audio": base64.b64encode(full[i:i + 4800]).decode()})
            except Exception:  # noqa
                break
            await asyncio.sleep(max(0, start + (i + 4800) / 48000 - time.perf_counter()))
            if st["did"] and not st["sent"] and time.perf_counter() - start > len(cue) / 48000 + 0.5:
                st["sent"] = time.perf_counter()
                await ws.send_json({"type": "session.commentary.append", "delegation_id": st["did"], "content": LINE_LONG})
            if len(st["tr_after"]) != last:
                last, quiet = len(st["tr_after"]), time.perf_counter()
            if quiet and time.perf_counter() - quiet > 3:
                break
            if rt.done():
                break
        try:
            await ws.send_json({"type": "session.close"})
        except Exception:  # noqa  (the server already closed it)
            pass
        try:
            await asyncio.wait_for(rt, 5)
        except asyncio.TimeoutError:
            rt.cancel()
        return {"mode": "client_delegation", "delegated": bool(st["did"]), "first_audio_after_commentary": st["first"],
                "wer": round(wer(LINE_LONG, st["tr_after"]), 3) if st["sent"] else None,
                "said_before_result": st["tr_before"].strip(), "transcript": st["tr_after"].strip(),
                "events": sorted(set(st["types"]))[:20]}


async def responses_delegation():
    async with aiohttp.ClientSession(trust_env=False) as s:
        backend = {"model": "gpt-5.4-mini", "instructions": "Repeat the user's message back unchanged.",
                   "reasoning": {"effort": "none"}}
        ws = await session(s, {"model": "gpt-live-1", "audio": {"output": {"voice": "cedar"}}, "instructions": INSTR_B,
                               "delegation": {"type": "responses", "responses": backend}})
        await ws.send_json({"type": "response.item.create", "item": {"type": "message", "role": "user",
                                                                     "content": [{"type": "input_text", "text": LINE_LONG}]}})
        async def silence():
            t = time.perf_counter(); k = 0
            while not ws.closed:
                await ws.send_json({"type": "session.input_audio.append", "audio": base64.b64encode(bytes(4800)).decode()})
                k += 1
                await asyncio.sleep(max(0, t + k * 0.1 - time.perf_counter()))
        sil = asyncio.create_task(silence())
        await asyncio.sleep(0.5)
        t0 = time.perf_counter()
        await ws.send_json({"type": "response.create"})
        first, tr, types = None, "", []
        quiet = None
        try:
            while time.perf_counter() - t0 < 25:
                m = json.loads((await asyncio.wait_for(ws.receive(), 12 if not first else 4)).data); ty = m.get("type")
                if ty == "session.output_audio.delta":
                    if first is None and audible(m["delta"]):
                        first = time.perf_counter() - t0
                elif ty == "session.output_transcript.delta":
                    tr += m.get("delta", "")
                elif ty == "response.event":
                    types.append("response.event/" + str((m.get("event") or {}).get("type")))
                else:
                    types.append(ty + (": " + json.dumps(m.get("error"))[:250] if ty == "error" else ""))
                if ty in ("error", "session.closed"):
                    break
        except asyncio.TimeoutError:
            pass
        sil.cancel()
        await ws.close()
        return {"mode": "responses_delegation", "first_audio_after_response_create": first,
                "wer": round(wer(LINE_LONG, tr), 3), "transcript": tr.strip(), "events": sorted(set(types))[:20]}


if __name__ == "__main__":
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 3
    for f in (client_delegation, responses_delegation):
        for _ in range(n):
            try:
                d = asyncio.run(f())
            except Exception as e:  # noqa
                d = {"mode": f.__name__, "error": str(e)[:400]}
            append_jsonl("gpt_live_inject.jsonl", d)
            print(json.dumps(d)[:900], flush=True)
