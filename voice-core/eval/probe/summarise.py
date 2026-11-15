"""Builds the tables in RESULTS.md from data/*.jsonl (normalised STT WER, combined S2S runs).

  .venv/bin/python summarise.py > data/tables.md
"""
import json
import re

from common import CLIPS, summary, wer

META = json.loads((CLIPS / "clips.json").read_text())


def norm(t):
    t = t.lower()
    for a, b in [("summarize", "summarise"), ("4:00", "four o'clock"), ("4 o'clock", "four o'clock"),
                 ("bentosync", "bento sync"), ("wodehouse", "woodhouse")]:
        t = t.replace(a, b)
    return t


def rows(path, tag):
    return [json.loads(l) for l in open(path) if f'"tag": "{tag}"' in l]


print("## STT\n")
print("| Route | Clip | n | Final median s | p90 | First text after end of speech (median) | WER | WER normalised | Names right |")
print("|---|---|---|---|---|---|---|---|---|")
stt = rows("data/stt_runs.jsonl", "full")
keys = sorted({(r["route"], r["clip"]) for r in stt if "clip" in r}, key=lambda k: (k[1], k[0]))
table = []
for route, clip in keys:
    ok = [r for r in stt if r["route"] == route and r.get("clip") == clip and "text" in r]
    err = [r for r in stt if r["route"] == route and r.get("clip") == clip and "error" in r]
    if not ok:
        table.append((99, f"| {route} | {clip} | 0 | failed: {err[0]['error'][:60]} | | | | | |")); continue
    f = summary([r["final"] for r in ok])
    first = summary([r.get("first_after_end") if r.get("first_after_end") is not None else r.get("first") for r in ok])
    w = sum(r["wer"] for r in ok) / len(ok)
    wn = sum(wer(norm(META[f"{clip}_{r['voice']}"]["text"]), norm(r["text"])) for r in ok) / len(ok)
    names = sum(all(r["names"].values()) for r in ok)
    table.append((f["median"], f"| {route} | {clip} | {len(ok)} | {f['median']:.2f} | {f['p90']:.2f} | {first.get('median', '')} | {w:.3f} | {wn:.3f} | {names}/{len(ok)} |"))
for clip in ("q3", "q10"):
    for _, line in sorted(t for t in table if f"| {clip} |" in t[1]):
        print(line)

print("\n## S2S latency (end of question audio to first audible reply audio)\n")
s2s = rows("data/s2s_runs.jsonl", "full") + rows("data/s2s_runs.jsonl", "full-audible") + rows("data/s2s_runs.jsonl", "full-audible2")
print("| Route | n | Median s | p90 | Min | Max | Socket setup median s |")
print("|---|---|---|---|---|---|---|")
for route in ["gpt-live-1", "gemini-3.8-live", "gemini-live-2.5-flash-native-audio", "gpt-realtime-2.1-mini", "gpt-realtime-2.1"]:
    # gpt-live-1 'full' runs timed the first (silent) frame, so only the audible runs count for it
    rs = [r for r in s2s if r["route"] == route and r.get("latency") is not None and not (route == "gpt-live-1" and r["tag"] == "full")]
    l = summary([r["latency"] for r in rs]); st = summary([r["setup"] for r in rs])
    print(f"| {route} | {l['n']} | {l['median']:.2f} | {l['p90']:.2f} | {l['min']:.2f} | {l['max']:.2f} | {st['median']:.2f} |")
