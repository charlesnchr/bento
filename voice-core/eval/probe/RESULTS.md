# Voice model routes on Azure and Vertex: inventory and latency

Measured 2026-11-15 from homelab (Linux, London). Scripts and rerun steps are in [README.md](README.md);
raw runs are in `data/*.jsonl`. Sample audio (`out/`) and the clips (`clips/`) are not kept in the repository: `make_clips.py` and the benchmarks write them again.

## Scope, routes and caveats

- Billing. Only company-paid routes were called: an Azure OpenAI resource, an Azure AI Speech resource (East US 2), and Vertex AI with Cloud Text-to-Speech in one Google Cloud project, reached through a relay. No personal Gemini, OpenAI, Anthropic, xAI or OpenRouter key was read. Bento's MAI-Transcribe route through OpenRouter was skipped for that reason. The Azure Speech resource's billing account could not be confirmed from the management plane; nothing in the bench or the core uses it.
- Inventory method. The Azure management plane was not available, so deployments come from the data-plane list `GET /openai/deployments?api-version=2023-03-15-preview`, and Vertex from the publisher-model list. Every row marked "works" below was also called.
- Network path. Vertex and Cloud TTS go through a relay. Azure is direct. Warm round trip of a cheap authenticated GET, median of 10 runs (`net_baseline.py`): Cloud TTS 0.17 s, Vertex model metadata 0.32 s (global) and 0.36 s (us-central1), Azure OpenAI 0.16 s, Azure Speech 0.21 s. Direct TCP connect: Google 0.05 s, Azure 0.10 to 0.11 s. The relay adds tens of milliseconds, not seconds. All Vertex numbers below include it.
- Warm connections. HTTP routes reuse one connection and get one unmeasured warm-up call. Websocket numbers exclude socket setup, which is reported separately (0.8 to 1.3 s).

## 1. Inventory

### Realtime speech-to-speech

| Cloud | Model / deployment | Endpoint shape | Status |
|---|---|---|---|
| Azure OpenAI | `gpt-live-1` (model gpt-live-1-2026-09-10) | `wss://<resource>.openai.azure.com/openai/v1/live/sessions`, `session.start` | works |
| Azure OpenAI | `gpt-realtime-2.1`, `gpt-realtime-2.1-mini` | `wss://…/openai/v1/realtime?model=<deployment>`, GA event model | works |
| Azure OpenAI | `gpt-realtime`, `gpt-realtime-1.5`, `gpt-realtime-2`, `gpt-realtime-translate` | same | deployed, not measured |
| Azure OpenAI | `gpt-4o-realtime-preview` | | deployment state `failed` |
| Azure Speech | `gpt-4o-realtime-preview`, `gpt-4o-mini-realtime-preview` | | deployed, not measured (old) |
| Vertex us-central1 | `gemini-3.8-live` | `wss://us-central1-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent` | works (no global endpoint) |
| Vertex us-central1 | `gemini-live-2.5-flash-native-audio` | same | works |
| Vertex | `gemini-3.5-live-translate-preview`, `gemini-omni-1.2-flash`, `gemini-omni-1.1-flash-preview` | | listed, not tried |

### Text-to-speech

| Cloud | Model / voice | Endpoint shape | Status |
|---|---|---|---|
| Azure OpenAI | `gpt-4o-mini-tts` (voice cedar) | `POST /openai/deployments/gpt-4o-mini-tts/audio/speech`, `response_format=pcm`, `stream_format=audio` | works, streams output |
| Azure OpenAI | `gpt-audio-1.5` | chat completions, `modalities: [text, audio]`, `stream: true` | works, but the audio arrives in one burst at the end |
| Azure Speech (Speech, East US 2) | MAI voices `en-GB-Harry:MAI-Voice-2.1-Flash` and `en-GB-Harry:MAI-Voice-2.1` (also MAI-Voice-2 / 2-Flash in en-US) | `POST https://<resource>.cognitiveservices.azure.com/tts/cognitiveservices/v1`, SSML, `raw-24khz-16bit-mono-pcm` | works (Preview voices) |
| Azure Speech | Dragon HD `en-GB-Ollie:DragonHDLatestNeural`, neural `en-GB-RyanNeural` (1,029 voices in all) | same | works |
| Vertex global | `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts`, `gemini-2.5-flash-tts`, `gemini-2.5-pro-tts` | `…/locations/global/publishers/google/models/<m>:streamGenerateContent?alt=sse`, `responseModalities: [AUDIO]` | works, streams (40 to 134 chunks per line) |
| Vertex us-central1 | `gemini-3.1-flash-tts-preview` | same, us-central1 | works |
| Cloud TTS | Chirp 3 HD `en-GB-Chirp3-HD-Charon` | REST `texttospeech.googleapis.com/v1/text:synthesize`; gRPC `StreamingSynthesize` | works, both |
| Cloud TTS | `gemini-2.5-flash-tts` and `gemini-2.5-flash-lite-preview-tts` through `StreamingSynthesize` | gRPC, `model_name` | works; the 3.8 TTS models return 400 "Streaming for this Gemini-TTS model is currently not supported" |

### Speech-to-text

| Cloud | Model | Endpoint shape | Status |
|---|---|---|---|
| Azure OpenAI | `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, `whisper` (also `gpt-4o-transcribe-2`) | `POST /openai/deployments/<d>/audio/transcriptions` (`stream=true` gives SSE deltas) | works |
| Azure OpenAI | `gpt-live-transcribe`, `gpt-realtime-whisper`, `gpt-transcribe` as realtime | `wss://…/openai/v1/realtime?intent=transcription`, `session.update {type: transcription, turn_detection: null}`, append, `input_audio_buffer.commit` | works |
| Azure Speech | Speech fast transcription (default model) | `POST /speechtotext/transcriptions:transcribe?api-version=2024-11-15` | works |
| Azure Speech | MAI-Transcribe-2 / 1.5 (`enhancedMode.model`) | same | fails: 400 "Enhanced mode with model is currently not supported yet" (likely region) |
| Vertex global | `gemini-3.5-transcribe` | `generateContent` with `audioTranscriptionConfig {wordTimestamp: true}` | works |
| Vertex global | `gemini-3.5-transcribe-live` | Live websocket v1beta1 (global), manual activity start/end, `responseModalities: [TEXT]` | works, interim and final |
| Vertex global | `gemini-3.5-flash-lite`, `gemini-3.8-flash` with a transcribe prompt | `generateContent` | works; 3.8 Flash safety-blocks the 9 s clip (see failures) |
| Cloud Speech-to-Text v2 | `chirp_3`, `chirp_2` | `…/locations/{us,global}/recognizers/_:recognize` | fails: 403 `speech.recognizers.recognize` denied for the service account (IAM) |

### Fast text models (measured)

Azure OpenAI: `gpt-5.4-nano`, `gpt-5.4-mini`, `gpt-4.1-nano`, `gpt-4.1-mini`, `gpt-5-nano`, `gpt-6-luna` (`/openai/v1/chat/completions`). Vertex global: `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`, `gemini-2.5-flash-lite`, `gemini-3.8-flash`. Also deployed but not measured: `gpt-4o-mini`, `gpt-4.1`, `gpt-5-mini`, `gpt-5.6-luna`, and Vertex `gemini-3.6-flash`, `gemini-3.7-flash`, `gemini-3-flash-preview`, `gemini-2.5-flash`.

## 2. TTS latency

Short line: 12 words. Long line: 45 words. n=8 per cell, warm connection. TTFB is time to the first audio byte. RTF is total time divided by audio duration.

| Route | Line | TTFB median s | TTFB p90 | Total median s | Total p90 | Audio s | RTF | Text in incrementally? |
|---|---|---|---|---|---|---|---|---|
| az-speech-neural (RyanNeural) | short | 0.16 | 0.18 | 0.25 | 0.54 | 4.8 | 0.05 | not over REST; SDK websocket text streaming exists (not measured) |
| vx-chirp3hd-stream (gRPC) | short | 0.21 | 0.22 | 0.72 | 0.82 | 4.7 | 0.15 | yes |
| vx-chirp3hd-stream-chunked (sentence by sentence) | short | 0.21 | 0.26 | 0.63 | 0.70 | 4.5 | 0.14 | yes |
| az-speech-dragonhd | short | 0.22 | 0.23 | 1.02 | 1.10 | 4.5 | 0.23 | as neural |
| az-speech-mai-2.1-flash | short | 0.33 | 0.42 | 0.44 | 1.06 | 4.9 | 0.09 | as neural |
| az-4o-mini-tts | short | 0.33 | 0.35 | 0.95 | 1.00 | 4.7 | 0.20 | no |
| vx-3.8-flash-lite-tts | short | 0.41 | 0.56 | 1.17 | 1.41 | 4.2 | 0.28 | no |
| vx-3.8-flash-tts | short | 0.64 | 0.76 | 1.68 | 1.89 | 4.3 | 0.39 | no |
| vx-cloudtts-2.5-flash-tts-stream-chunked | short | 0.65 | 0.69 | 3.78 | 6.08 | 6.3 | 0.60 | yes |
| vx-2.5-flash-tts | short | 0.78 | 0.94 | 2.85 | 4.77 | 5.6 | 0.51 | no |
| vx-3.1-flash-tts-preview | short | 0.79 | 0.88 | 2.23 | 2.41 | 5.1 | 0.44 | no |
| vx-chirp3hd-rest (not streaming) | short | 0.84 | 1.30 | 0.84 | 1.30 | 4.5 | 0.19 | no |
| az-speech-mai-2.1 | short | 0.85 | 0.90 | 1.05 | 1.27 | 4.4 | 0.24 | as neural |
| vx-2.5-pro-tts | short | 1.19 | 1.30 | 4.93 | 6.87 | 5.8 | 0.85 | no |
| az-gpt-audio-1.5 | short | 1.46 | 1.55 | 1.50 | 1.58 | 4.2 | 0.35 | no |
| vx-chirp3hd-stream-chunked | long | 0.18 | 0.24 | 1.82 | 2.25 | 14.1 | 0.13 | yes |
| az-speech-neural | long | 0.19 | 0.30 | 0.65 | 2.99 | 16.8 | 0.04 | |
| vx-chirp3hd-stream | long | 0.20 | 0.27 | 1.87 | 2.80 | 14.2 | 0.13 | yes |
| az-speech-dragonhd | long | 0.22 | 0.23 | 3.09 | 4.82 | 16.0 | 0.19 | |
| az-4o-mini-tts | long | 0.33 | 0.43 | 2.15 | 2.20 | 14.8 | 0.15 | n=7, one 60 s read timeout |
| az-speech-mai-2.1-flash | long | 0.34 | 0.35 | 0.74 | 1.61 | 15.8 | 0.05 | |
| vx-3.8-flash-lite-tts | long | 0.39 | 0.49 | 2.85 | 3.25 | 15.6 | 0.18 | |
| vx-cloudtts-2.5-flash-tts-stream-chunked | long | 0.71 | 0.73 | 8.13 | 33.4 | 20.1 | 0.41 | |
| vx-2.5-flash-tts | long | 0.73 | 0.79 | 7.72 | 10.1 | 17.9 | 0.43 | |
| vx-3.8-flash-tts | long | 0.74 | 0.81 | 4.15 | 5.14 | 15.2 | 0.27 | |
| vx-3.1-flash-tts-preview | long | 0.81 | 1.14 | 4.66 | 5.19 | 15.9 | 0.29 | |
| az-speech-mai-2.1 | long | 0.91 | 1.17 | 1.35 | 3.50 | 15.7 | 0.09 | |
| vx-2.5-pro-tts | long | 1.20 | 1.39 | 16.4 | 19.8 | 21.3 | 0.77 | |
| vx-chirp3hd-rest | long | 2.05 | 2.88 | 2.05 | 2.88 | 14.5 | 0.14 | |
| az-gpt-audio-1.5 | long | 3.46 | 3.97 | 3.58 | 6.80 | 15.3 | 0.23 | |

Every route generates faster than real time, so after the first byte none of them should starve playback. TTFB does not grow with text length on the streaming routes.

Did each route say the line? One sample per route and line, re-transcribed with gpt-4o-transcribe (`tts_check.py`, `data/tts_check.json`): every route spoke the line with WER 0 to 0.08. The differences were in "Hermes":

- Dragon HD said "Amens" / "Aemenz".
- MAI-Voice-2.1 (both variants) and 2.5-pro-tts gave the French "Hermès".
- 3.8-flash-lite-tts said "Ermes" once.
- 3.1-flash-tts-preview said "Wodehouse".

These are single samples and only a proxy for pronunciation. SSML `<phoneme>` or lexicons can fix the Azure Speech voices.

## 3. STT latency

Clips: "Woodhouse, ask Hermes to rebuild Bento tonight." (q3, 3.0 to 3.1 s) and a 30-word instruction naming Hermes, Bento and Woodhouse (q10, 8.7 to 9.3 s). Each clip comes in two voices (Chirp 3 HD and Azure neural), 4 runs per voice, so n=8. No vocabulary hints were given.

- Batch routes (`az-*`, `vx-*`): request start to final transcript, including the upload.
- Streaming routes (`rt-*`): audio paced at real time, timed from end of speech to the final transcript.
- Normalised WER maps "summarize"→"summarise", "4:00"/"4 o'clock"→"four o'clock" and "BentoSync"→"bento sync".
- "Names right": Hermes, Bento and Woodhouse all present as words. "BentoSync" counts as missing Bento, which is the cause of whisper's 0/8 and gpt-live-transcribe's 4/8 on q10.

| Route | Clip | n | Final median s | p90 | WER | WER normalised | Names right |
|---|---|---|---|---|---|---|---|
| rt-vx-3.5-transcribe-live-smart | q3 | 8 | 0.29 | 0.32 | 0.000 | 0.000 | 8/8 |
| rt-vx-3.5-transcribe-live (verbatim) | q3 | 8 | 0.30 | 0.32 | 0.000 | 0.000 | 8/8 |
| az-speech-fast | q3 | 8 | 0.54 | 0.62 | 0.071 | 0.071 | 8/8 |
| rt-az-gpt-realtime-whisper | q3 | 8 | 0.55 | 0.59 | 0.143 | 0.143 | 8/8 |
| vx-3.5-transcribe | q3 | 8 | 0.61 | 0.75 | 0.000 | 0.000 | 8/8 |
| az-4o-transcribe | q3 | 8 | 0.61 | 0.68 | 0.000 | 0.000 | 8/8 |
| az-gpt-transcribe-stream (first delta 0.56) | q3 | 8 | 0.63 | 0.74 | 0.018 | 0.018 | 8/8 |
| rt-az-gpt-live-transcribe | q3 | 8 | 0.65 | 0.69 | 0.000 | 0.000 | 8/8 |
| az-4o-mini-transcribe | q3 | 8 | 0.73 | 0.91 | 0.018 | 0.018 | 8/8 |
| az-whisper | q3 | 8 | 0.83 | 0.87 | 0.000 | 0.000 | 8/8 |
| az-gpt-transcribe | q3 | 8 | 0.86 | 1.01 | 0.018 | 0.018 | 8/8 |
| vx-3.5-flash-lite-prompt | q3 | 8 | 0.96 | 1.31 | 0.000 | 0.000 | 8/8 |
| rt-az-gpt-transcribe | q3 | 8 | 1.22 | 1.53 | 0.143 | 0.143 | 8/8 |
| vx-3.8-flash-prompt | q3 | 8 | 1.67 | 2.46 | 0.000 | 0.000 | 8/8 |
| rt-vx-3.5-transcribe-live-smart | q10 | 8 | 0.35 | 0.40 | 0.103 | 0.000 | 8/8 |
| rt-vx-3.5-transcribe-live (verbatim) | q10 | 8 | 0.36 | 0.38 | 0.138 | 0.034 | 8/8 |
| rt-az-gpt-realtime-whisper | q10 | 8 | 0.55 | 0.59 | 0.034 | 0.017 | 8/8 |
| rt-az-gpt-live-transcribe | q10 | 8 | 0.65 | 0.72 | 0.073 | 0.004 | 4/8 |
| az-speech-fast | q10 | 8 | 0.75 | 0.82 | 0.086 | 0.000 | 8/8 |
| vx-3.5-transcribe | q10 | 8 | 0.81 | 0.91 | 0.120 | 0.034 | 8/8 |
| az-4o-transcribe | q10 | 8 | 0.93 | 1.13 | 0.043 | 0.000 | 7/8 |
| vx-3.5-flash-lite-prompt | q10 | 8 | 0.93 | 1.10 | 0.142 | 0.022 | 6/8 |
| az-4o-mini-transcribe | q10 | 8 | 0.96 | 1.14 | 0.043 | 0.000 | 7/8 |
| az-whisper | q10 | 8 | 0.99 | 1.23 | 0.138 | 0.000 | 0/8 |
| az-gpt-transcribe-stream (first delta 0.75) | q10 | 8 | 1.03 | 1.12 | 0.034 | 0.000 | 8/8 |
| rt-az-gpt-transcribe | q10 | 8 | 1.05 | 1.54 | 0.034 | 0.000 | 8/8 |
| az-gpt-transcribe | q10 | 8 | 1.22 | 1.43 | 0.034 | 0.000 | 8/8 |
| vx-3.8-flash-prompt | q10 | 0 | failed | | | | |

Notes:

- Gemini 3.5 Transcribe Live returns interim text about 0.57 s after speech starts, and its final 0.29 to 0.36 s after the end of speech. It hears "sync" as "sink" (the remaining normalised error).
- The Azure realtime transcription models have finals 0.55 to 0.65 s after commit (`gpt-realtime-whisper`, `gpt-live-transcribe`). I did not measure their mid-speech partials, because the probe read events only after sending the audio.
- `rt-az-gpt-transcribe` (gpt-transcribe in a realtime session) is no faster than batch.
- The names were heard right almost everywhere on these clean TTS clips. Real microphones will be harder.

## 4. Text LLM: spoken one-sentence summary of a 300-word agent result

n=8, streaming, reasoning off: `reasoning_effort: none` for gpt-5.4 and gpt-6-luna, `minimal` for gpt-5-nano, `thinkingLevel: minimal` for Gemini Flash Lite, `low` for 3.8 Flash (its minimum), `thinkingBudget: 0` for 2.5.

| Route | TTFT median s | TTFT p90 | Total median s | Total p90 | Words (median) |
|---|---|---|---|---|---|
| vx-2.5-flash-lite | 0.39 | 0.43 | 0.58 | 0.71 | 21 |
| vx-3.5-flash-lite | 0.40 | 0.65 | 0.58 | 0.89 | 31 |
| vx-3.1-flash-lite | 0.46 | 0.54 | 0.66 | 0.74 | 30 |
| az-gpt-4.1-nano | 0.61 | 0.76 | 0.62 | 0.76 | 30 |
| az-gpt-5.4-mini | 0.65 | 0.81 | 0.72 | 0.86 | 28 |
| az-gpt-5.4-nano | 0.79 | 0.84 | 0.80 | 0.84 | 35 |
| az-gpt-6-luna | 0.95 | 1.18 | 1.00 | 1.27 | 31 |
| az-gpt-4.1-mini | 1.09 | 1.34 | 1.17 | 1.50 | 35 |
| az-gpt-5-nano | 0.97 | 1.17 | 1.19 | 1.36 | 35 |
| vx-3.8-flash | 1.30 | 3.81 | 1.67 | 3.86 | 28 |

On Azure, TTFT is within 0.1 s of total. The whole sentence arrives in one burst, most likely because the default content filter buffers short streamed outputs. Streaming does not help on Azure at this length. The Gemini models do stream, with the first token about 0.2 s before the end. The samples are in `data/llm_summary.json`. All were accurate one-sentence summaries. 2.5 Flash Lite ran short (21 words).

## 5. Speech-to-speech baseline

Question: "Woodhouse, what is the capital city of Denmark?" (2.7 s, two voices). The question streams at real time, then silence, with each server's own voice activity detection. Timed from end of question audio to the first audible reply audio. Every reply was "Copenhagen".

| Route | n | Median s | p90 | Min | Max | Socket setup median s |
|---|---|---|---|---|---|---|
| gpt-live-1 | 16 | 0.92 | 1.40 | 0.60 | 2.56 | 1.04 |
| gemini-3.8-live | 16 | 1.28 | 1.34 | 1.26 | 1.38 | 1.01 |
| gemini-live-2.5-flash-native-audio | 16 | 1.33 | 1.46 | 1.17 | 1.59 | 1.05 |
| gpt-realtime-2.1 | 16 | 1.44 | 2.33 | 1.09 | 3.00 | 0.88 |
| gpt-realtime-2.1-mini | 16 | 1.57 | 2.24 | 1.25 | 2.63 | 0.89 |

Notes:

- These figures include end-of-speech detection. gpt-realtime's server VAD (`silence_duration_ms` 500) fired 0.59 to 0.61 s after the audio ended, so its model time is about 0.9 s.
- GPT-Live streams silent output frames continuously from session start. The first-frame time is meaningless for it, so its row uses the first audible chunk (peak above 500). The other routes send no leading silent chunks: audible onset and first frame agree to within 0.02 s.
- An earlier two-sentence question showed GPT-Live answering in the pause between the sentences. It is full duplex and does not wait for a turn end.

### Capabilities (`s2s_bench.py caps`, `gpt_live_inject.py`, 3 runs per check)

| | Text-only output | Inject text for the model to speak | Speak given text verbatim |
|---|---|---|---|
| gemini-3.8-live | No: setup with `responseModalities: [TEXT]` closes with 1007 "Unsupported modality for Vertex Live API" | Yes: `clientContent` turn with `turnComplete: true` | Yes. 45-word line: output-transcript WER 0 in 5 of 6 runs; the sixth (0.72) is the transcript dropping spaces, not misread words. First audio 0.57 to 0.84 s after the text is sent. Audio streams at about real time (total ≈ audio length). |
| gemini-live-2.5-flash-native-audio | No: 1007 "Text output is not supported for native audio output model" | not tested | not tested |
| gpt-realtime-2.1 | Yes: `output_modalities: [text]`, first text 0.70 s | Yes: `conversation.item.create` (`input_text`) and `response.create` | Yes, WER 0 in 6 of 6 runs, with the instruction in the turn or in `response.instructions`. First audio 0.67 to 1.67 s. A 14 s line is fully delivered in 3.3 to 4.5 s (faster than real time). |
| gpt-realtime-2.1-mini | Yes, first text 0.93 s | Yes | Yes, WER 0 in 6 of 6 runs. First audio 0.62 to 1.31 s, full line in 2.3 to 6.6 s. |
| gpt-live-1 | No: `output_modalities` and `modalities` are unknown parameters; `audio.output` must be an object | Only through delegation. Accepted client events: `session.start`, `session.update`, `session.input_audio.append`/`mute`/`unmute`, `session.instructions.append`, `session.thinking.append`, `session.commentary.append` (the last three need a `delegation_id`), `response.item.create`, `response.create` (both need Responses delegation), `session.close` | No. Client delegation (Bento's path, result sent with `session.commentary.append`): relayed paraphrased in 1 of 3 runs (WER 0.28); in the other 2 it answered from the spoken cue and ignored the text. Responses delegation (backend gpt-5.4-mini asked to repeat the text): always spoken, always paraphrased (WER 0.38 to 0.50), opening with filler ("Alright, I'm checking real quick"). First audible audio 0.81 to 1.10 s after `response.create`. Asking for verbatim reading in the instructions led to moderation stops ("The generation was stopped due to moderation") on two sessions. |

## 6. What a TTS-based or hybrid pipeline costs, from these numbers

Medians, warm connections, Vertex through the relay:

- Hermes result to speech, with summarising: LLM summary (Flash Lite TTFT 0.4 s, or the whole sentence in 0.6 s) plus streaming TTS TTFB (Chirp 3 HD 0.2 s, Azure neural 0.16 s, MAI-Voice-2.1-Flash 0.33 s, gpt-4o-mini-tts 0.33 s) gives about 0.6 to 0.9 s to first audio. Sending text sentence by sentence into Chirp 3 HD streaming keeps TTFB at 0.18 to 0.21 s.
- Hermes result to speech, without summarising (text already short): TTS alone, 0.16 to 0.35 s. Through Gemini 3.8 Live, injected verbatim text is 0.57 to 0.84 s. Through gpt-realtime-2.1-mini, 0.62 to 1.31 s.
- Full cascaded turn: streaming STT final 0.29 to 0.36 s (Gemini 3.5 Transcribe Live) or 0.55 to 0.65 s (Azure realtime transcription), plus LLM 0.4 to 0.6 s, plus TTS 0.2 to 0.33 s, gives about 0.9 to 1.3 s after end of speech. That assumes an explicit end of turn (push to talk or the hotkey). With server-style silence detection, add about 0.5 s. The speech-to-speech models measured 0.9 to 1.6 s including their own end-of-speech detection. A cascade is therefore roughly level with speech-to-speech on first audio, not clearly faster, and it adds a network hop per stage.

## 7. Failures and gaps

- Chirp 3 / Chirp 2 STT (Speech-to-Text v2): 403 `speech.recognizers.recognize` denied for the service account. This needs an IAM grant (`roles/speech.client` or similar). Chirp 3 HD TTS works on the same project.
- MAI-Transcribe-2 and 1.5 on the Azure Speech resource: 400 "Enhanced mode with model is currently not supported yet", with and without locales, on api-versions 2024-11-15 and 2025-10-15. Probably not offered in East US 2. Not tried: the MAI-Transcribe Streaming API.
- `gemini-3.8-flash` used as a transcriber: the 9 s dictation came back with `promptFeedback.blockReason: SAFETY` ("The prompt is blocked due to safety") in 8 of 8 runs. The 3 s clip was fine. Use `gemini-3.5-transcribe` instead.
- Gemini TTS 3.8 models through Cloud TTS `StreamingSynthesize`: 400, streaming not supported. Use Vertex `streamGenerateContent` (output streams; input does not).
- gpt-4o-mini-tts: one 60 s read timeout in 16 long-line runs.
- Azure management plane: not available from this host, so deployment SKUs are unknown (the data plane reports only `standard`).
- Not measured: Azure Speech websocket text-streaming TTS and realtime STT (both need the Speech SDK), the Gemini omni models, `gpt-realtime-1.5`/`gpt-realtime-2`, and STT partial timing on Azure realtime.

## 8. Recommendation

| Need | Azure | Vertex |
|---|---|---|
| TTS | Azure Speech neural or MAI-Voice-2.1-Flash (0.16 / 0.33 s TTFB, RTF ≤ 0.09); `gpt-4o-mini-tts` (0.33 s) if the voice should match GPT-Live's cedar. Dragon HD has the best TTFB among HD voices (0.22 s) but mispronounces Hermes. | Chirp 3 HD through gRPC `StreamingSynthesize` (0.18 to 0.21 s TTFB, accepts incremental text); `gemini-3.8-flash-lite-tts` (0.39 to 0.41 s) when Gemini's expressive voices matter. |
| STT | `gpt-realtime-whisper` or `gpt-live-transcribe` realtime (final 0.55 to 0.65 s); batch `gpt-4o-transcribe` (0.6 to 0.9 s) | `gemini-3.5-transcribe-live` (final 0.29 to 0.36 s, interim text during speech): the fastest STT measured |
| Summariser | `gpt-4.1-nano` or `gpt-5.4-mini` (whole sentence in 0.6 to 0.7 s; no useful streaming) | `gemini-3.5-flash-lite` with minimal thinking (TTFT 0.40 s, total 0.58 s) |
