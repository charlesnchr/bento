"""Spoken test clips for the STT and speech-to-speech probes, made with two TTS voices from different
vendors (Google Chirp 3 HD and Azure Speech neural) so no STT model only hears its own vendor's voice.

  .venv/bin/python make_clips.py

Writes clips/<name>_<voice>_24k.wav and _16k.wav plus clips/clips.json (reference text, duration).
"""
import json
import sys

import numpy as np

from common import CLIPS, resample, write_wav

sys.argv = sys.argv[:1]
import tts_bench as t  # noqa: E402

CLIP_TEXT = {
    # about 3 s
    "q3": "Woodhouse, ask Hermes to rebuild Bento tonight.",
    # about 10 s
    "q10": ("Woodhouse, tell Hermes to check whether the Bento sync server deployed cleanly, then summarise "
            "the failing tests and send the summary to my phone before the four o'clock meeting."),
    # the speech-to-speech question
    "ask": "Woodhouse, what is the capital city of Denmark?",
}
VOICES = {
    "chirp": lambda: t.vx_chirp_rest("en-GB-Chirp3-HD-Charon"),
    "azneural": lambda: t.az_speech_service("en-GB-RyanNeural"),
}

meta = {}
for vname, mk in VOICES.items():
    run = mk()
    for cname, text in CLIP_TEXT.items():
        r, _ = run(text)
        pcm = np.frombuffer(bytes(r.pcm[:len(r.pcm) // 2 * 2]), np.int16)
        # trim leading/trailing near-silence so "end of audio" is end of speech (keep 50 ms)
        idx = np.where(np.abs(pcm) > 300)[0]
        if len(idx):
            pcm = pcm[max(0, idx[0] - 1200): idx[-1] + 1200]
        write_wav(CLIPS / f"{cname}_{vname}_24k.wav", pcm, 24000)
        write_wav(CLIPS / f"{cname}_{vname}_16k.wav", resample(pcm, 24000, 16000), 16000)
        meta[f"{cname}_{vname}"] = {"text": text, "seconds": round(len(pcm) / 24000, 2), "voice": vname, "clip": cname}
        print(cname, vname, meta[f"{cname}_{vname}"]["seconds"], "s")
(CLIPS / "clips.json").write_text(json.dumps(meta, indent=1))
