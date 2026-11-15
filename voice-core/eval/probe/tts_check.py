"""Did each TTS route say the line? Transcribes the sample WAVs tts_bench.py saved (out/tts_<route>_<line>.wav)
with Azure gpt-4o-transcribe and reports WER against the input text.

  .venv/bin/python tts_check.py
"""
import json

import requests

from common import LINE_LONG, LINE_SHORT, OUT, azure, save, wer

ep, key = azure()
s = requests.Session(); s.trust_env = False
res = {}
for p in sorted(OUT.glob("tts_*_*.wav")):
    route, line = p.stem[4:].rsplit("_", 1)
    ref = LINE_LONG if line == "long" else LINE_SHORT
    r = s.post(f"{ep}/openai/deployments/gpt-4o-transcribe/audio/transcriptions?api-version=2025-04-01-preview",
               headers={"api-key": key}, files={"file": (p.name, p.read_bytes(), "audio/wav")},
               data={"model": "gpt-4o-transcribe"}, timeout=60)
    text = r.json().get("text", "") if r.ok else f"HTTP {r.status_code}"
    res[f"{route}|{line}"] = {"wer": round(wer(ref, text), 3), "heard": text}
    print(f"{route:42s} {line:5s} wer={res[f'{route}|{line}']['wer']:.3f} {text[:90]}")
save("tts_check.json", res)
