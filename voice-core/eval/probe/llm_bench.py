"""Fast text LLMs as the spoken summariser: time to first token (TTFT) and time to a ~30-word answer.

  .venv/bin/python llm_bench.py --list
  .venv/bin/python llm_bench.py --routes az-gpt-5.4-nano,vx-3.5-flash-lite --n 8

Streaming chat on both clouds, reasoning off or minimal. Azure: chat completions on the Azure OpenAI resource,
direct. Vertex: streamGenerateContent through the proxy. Raw: data/llm_runs.jsonl,
summary: data/llm_summary.json.
"""
import argparse
import json
import time

import requests

from common import VERTEX_PROJECT, append_jsonl, azure, google_session, google_token, save, summary, words

AGENT_RESULT = """I checked the Bento repository on the main branch and ran the full Swift test suite one target at a time.
VoiceCoreTests passed all 412 tests in 38 seconds. VoiceTests passed 287 of 289; the two failures are both in
AzureLiveProtocolTests, where testDelegationBindsToLatestUtterance and testEvictedHistoryRejectsPartialTask
expect the old 1000 millisecond gap between utterances, but commit 612d2cf changed the gap to 1200 milliseconds.
The behaviour change looks intentional, so I updated both tests to use the constant instead of a literal, and
they pass now. LauncherTests passed all 96 tests. I also rebuilt the release with scripts/build.sh; the build
number went from 1482 to 1483 and the app is signed with the stable identity, so microphone and Accessibility
permissions are kept. I did not install it, because you were in a voice call at the time and installing would
have ended it. On the server side, cargo test in server/ passed 154 tests, and the sync server on homelab has
been up for six days with no errors in the last 24 hours of logs. The Android debug build compiled cleanly with
gradle in 2 minutes 40 seconds, but there are 31 deprecation warnings about the old audio focus API that will
need attention before the next target SDK bump. I pushed nothing and opened no pull request. The changes are
committed locally on a branch called fix/azure-live-gap-tests, with one commit containing the two test updates.
Next steps, if you want them: install the new build when your call is over, push the branch and open a pull
request, and file a ticket for the Android deprecation warnings."""
PROMPT = ("Summarise this agent result in one spoken sentence of about 30 words, for a voice assistant to say "
          "aloud. Plain words, no lists, no markdown.\n\n" + AGENT_RESULT)
_az = requests.Session(); _az.trust_env = False
_g = google_session()


def az_chat(deployment, effort="none"):
    ep, key = azure()

    def run():
        t0 = time.perf_counter(); first = None; text = ""; usage = None
        body = {"model": deployment, "stream": True, "stream_options": {"include_usage": True},
                "messages": [{"role": "user", "content": PROMPT}], "max_completion_tokens": 400}
        if effort:
            body["reasoning_effort"] = effort
        resp = _az.post(f"{ep}/openai/v1/chat/completions", headers={"api-key": key}, json=body, stream=True, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        for line in resp.iter_lines():
            if not line.startswith(b"data:") or line[5:].strip() == b"[DONE]":
                continue
            ev = json.loads(line[5:])
            for ch in ev.get("choices", []):
                c = (ch.get("delta") or {}).get("content")
                if c:
                    if first is None:
                        first = time.perf_counter() - t0
                    text += c
            usage = ev.get("usage") or usage
        return {"ttft": first, "total": time.perf_counter() - t0, "text": text,
                "reasoning_tokens": ((usage or {}).get("completion_tokens_details") or {}).get("reasoning_tokens")}
    return run


def vx_chat(model, thinking, location="global"):
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"

    def run():
        t0 = time.perf_counter(); first = None; text = ""; usage = None
        gc = {"maxOutputTokens": 400, "thinkingConfig": thinking}
        body = {"contents": [{"role": "user", "parts": [{"text": PROMPT}]}], "generationConfig": gc}
        url = (f"https://{host}/v1/projects/{VERTEX_PROJECT}/locations/{location}/publishers/google/models/"
               f"{model}:streamGenerateContent?alt=sse")
        resp = _g.post(url, headers={"Authorization": f"Bearer {google_token()}"}, json=body, stream=True, timeout=60)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code} {resp.text[:300]}")
        for line in resp.iter_lines():
            if not line.startswith(b"data:"):
                continue
            ev = json.loads(line[5:])
            for c in ev.get("candidates", []):
                for p in (c.get("content") or {}).get("parts", []):
                    if p.get("text") and not p.get("thought"):
                        if first is None:
                            first = time.perf_counter() - t0
                        text += p["text"]
            usage = ev.get("usageMetadata") or usage
        return {"ttft": first, "total": time.perf_counter() - t0, "text": text,
                "reasoning_tokens": (usage or {}).get("thoughtsTokenCount")}
    return run


ROUTES = {
    "az-gpt-5.4-nano": lambda: az_chat("gpt-5.4-nano", "none"),
    "az-gpt-5.4-mini": lambda: az_chat("gpt-5.4-mini", "none"),
    "az-gpt-4.1-nano": lambda: az_chat("gpt-4.1-nano", None),
    "az-gpt-4.1-mini": lambda: az_chat("gpt-4.1-mini", None),
    "az-gpt-5-nano": lambda: az_chat("gpt-5-nano", "minimal"),
    "az-gpt-6-luna": lambda: az_chat("gpt-6-luna", "none"),
    "vx-3.5-flash-lite": lambda: vx_chat("gemini-3.5-flash-lite", {"thinkingLevel": "minimal"}),
    "vx-3.1-flash-lite": lambda: vx_chat("gemini-3.1-flash-lite", {"thinkingLevel": "minimal"}),
    "vx-3.8-flash": lambda: vx_chat("gemini-3.8-flash", {"thinkingLevel": "low"}),
    "vx-2.5-flash-lite": lambda: vx_chat("gemini-2.5-flash-lite", {"thinkingBudget": 0}),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--routes", default="")
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
            d = runners[n]()
            print(f"{n:22s} warm-up ok ttft={d['ttft'] and round(d['ttft'], 2)} total={d['total']:.2f} "
                  f"words={len(words(d['text']))} think={d['reasoning_tokens']} | {d['text'][:110]}", flush=True)
        except Exception as e:  # noqa
            print(f"{n:22s} FAILED: {str(e)[:300]}", flush=True)
            append_jsonl("llm_runs.jsonl", {"route": n, "error": str(e)[:500], "tag": a.tag})
            runners.pop(n, None)
    res = {}
    for i in range(a.n):
        for n, run in runners.items():
            try:
                d = run(); d.update(route=n, i=i, tag=a.tag, words=len(words(d["text"])))
            except Exception as e:  # noqa
                d = {"route": n, "i": i, "error": str(e)[:300], "tag": a.tag}
            append_jsonl("llm_runs.jsonl", d)
            res.setdefault(n, []).append(d)
            print(f"  {i} {n:22s} ttft={d.get('ttft') and round(d['ttft'], 3)} total={d.get('total') and round(d['total'], 2)} words={d.get('words')} {d.get('error', '')[:100]}", flush=True)
    out = {}
    for n, ds in res.items():
        ok = [d for d in ds if "error" not in d]
        out[n] = {"ttft": summary([d["ttft"] for d in ok]), "total": summary([d["total"] for d in ok]),
                  "words": summary([d["words"] for d in ok]), "errors": len(ds) - len(ok),
                  "sample": ok[0]["text"] if ok else None}
    prev = {}
    try:
        prev = json.load(open("data/llm_summary.json"))
    except Exception:  # noqa
        pass
    prev.update(out)
    save("llm_summary.json", prev)
    print(json.dumps({k: {x: v[x] for x in ("ttft", "total")} for k, v in out.items()}, indent=1))


if __name__ == "__main__":
    main()
