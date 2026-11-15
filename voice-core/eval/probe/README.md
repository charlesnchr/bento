# Voice route probes

Latency and capability probes for realtime voice, TTS, STT and fast text models: an Azure OpenAI
resource, an Azure AI Speech resource and Vertex AI with Cloud Text-to-Speech. They gave the
numbers the call's design rests on (which TTS speaks a result, which model writes its headline,
whether a cascade would answer sooner than the speech model). Results are in
[RESULTS.md](RESULTS.md), raw runs as JSONL under `data/`.

No personal key is read: `common.secret()` refuses the personal Gemini, OpenAI, Anthropic and xAI
variables. Keys are read inside the process from `~/.hermes/.env` (then `~/dotfiles/.zshrc_local`)
and never printed.

## Setup

```sh
cd voice-core/eval/probe
uv venv .venv --python 3.12
uv pip install --python .venv/bin/python aiohttp websockets google-auth requests python-dotenv numpy pysocks google-cloud-texttospeech
```

Which resources to call is a setting, not in the repository. Put these in the environment, in
`local.env` here (ignored by git) or in `~/.config/bento/voice-probe.env`:

| Setting | Meaning |
|---|---|
| `VOICE_PROBE_AZURE_ENDPOINT` | the Azure OpenAI resource, `https://<resource>.openai.azure.com` |
| `VOICE_PROBE_AZURE_KEY_NAME` | the name of the variable holding its key (default `AZURE_OPENAI_API_KEY`) |
| `VOICE_PROBE_SPEECH_ENDPOINT` | the Azure AI Speech resource, `https://<resource>.cognitiveservices.azure.com` |
| `VOICE_PROBE_SPEECH_KEY_NAME` | the name of the variable holding its key (default `AZURE_SPEECH_KEY`) |
| `VOICE_PROBE_PROXY` | an HTTP CONNECT proxy for Google, when Vertex is not reachable directly |

Vertex uses `VERTEX_CREDENTIALS_PATH` and `VERTEX_PROJECT_ID` from `~/.hermes/.env`, as the bench does.

## Scripts, in the order they were run

| Script | What it does | Rerun |
|---|---|---|
| `net_baseline.py` | Warm round trip of a cheap authenticated GET per host, and direct TCP connect times | `.venv/bin/python net_baseline.py` |
| `tts_bench.py` | TTS time to first audio byte and total time, streaming where supported, per route and line | `.venv/bin/python tts_bench.py --list`; `... --routes a,b --n 8 --lines short,long` |
| `make_clips.py` | 3 s, 9 s and question clips in two voices (Chirp 3 HD and Azure neural) | `.venv/bin/python make_clips.py` |
| `stt_bench.py` | STT final-transcript latency (batch upload and real-time streaming), WER, name accuracy | `.venv/bin/python stt_bench.py --list`; `... --routes a,b --n 4` (n per voice) |
| `llm_bench.py` | Spoken-summary prompt (~300-word agent result): time to first token and total | `.venv/bin/python llm_bench.py --n 8` |
| `s2s_bench.py latency` | Speech-to-speech: end of user audio to first reply audio, server VAD | `.venv/bin/python s2s_bench.py latency --n 4` (n per voice) |
| `s2s_bench.py caps` | Text-only output, text injection, speaking a given line verbatim (WER of output transcript) | `.venv/bin/python s2s_bench.py caps` |
| `gpt_live_inject.py` | GPT-Live: speaking client-supplied text via client delegation and Responses delegation | `.venv/bin/python gpt_live_inject.py 3` |
| `tts_check.py` | Re-transcribes the saved TTS samples with gpt-4o-transcribe: did each route say the line, and the names | `.venv/bin/python tts_check.py` |
| `summarise.py` | Builds the STT (with normalised WER) and speech-to-speech tables from the raw runs | `.venv/bin/python summarise.py` |

Each benchmark appends raw runs to `data/<name>_runs.jsonl` and merges its summary (median, p90, n)
into `data/<name>_summary.json`. Delete the summary file first for a clean run.

## Method notes

- Warm connections: each HTTP route keeps one session and gets one unmeasured warm-up call, so TTFB
  excludes TLS setup. Websocket routes open a new socket per run; setup time is reported separately.
- Runs are interleaved across routes so a slow minute affects all of them.
- Streaming STT sends audio paced at real time in 100 ms chunks and times from the moment the last
  audio chunk is due (end of speech) to the final transcript. Batch STT times request start to
  response, including the upload of a 100 to 300 KB WAV.
- Speech-to-speech uses each server's own voice activity detection: the question, then silence, timed
  from end of question audio to the first audible reply chunk (peak above 500). GPT-Live streams silent
  output frames from session start, so the first chunk is meaningless there. Raw runs tagged `full`
  for gpt-live-1 timed that silent frame and are excluded.
- Clips are trimmed to the speech with about 50 ms of padding.
- Spend: short lines, at most 8 measured runs per cell (plus one warm-up).
