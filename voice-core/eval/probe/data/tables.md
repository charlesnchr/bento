## STT

| Route | Clip | n | Final median s | p90 | First text after end of speech (median) | WER | WER normalised | Names right |
|---|---|---|---|---|---|---|---|---|
| rt-vx-3.5-transcribe-live-smart | q3 | 8 | 0.29 | 0.32 | 0.293 | 0.000 | 0.000 | 8/8 |
| rt-vx-3.5-transcribe-live | q3 | 8 | 0.30 | 0.32 | 0.298 | 0.000 | 0.000 | 8/8 |
| az-speech-fast | q3 | 8 | 0.54 | 0.62 |  | 0.071 | 0.071 | 8/8 |
| rt-az-gpt-realtime-whisper | q3 | 8 | 0.55 | 0.59 | 0.0 | 0.143 | 0.143 | 8/8 |
| vx-3.5-transcribe | q3 | 8 | 0.61 | 0.75 |  | 0.000 | 0.000 | 8/8 |
| az-4o-transcribe | q3 | 8 | 0.61 | 0.68 |  | 0.000 | 0.000 | 8/8 |
| az-gpt-transcribe-stream | q3 | 8 | 0.63 | 0.74 | 0.556 | 0.018 | 0.018 | 8/8 |
| rt-az-gpt-live-transcribe | q3 | 8 | 0.65 | 0.69 | 0.0 | 0.000 | 0.000 | 8/8 |
| az-4o-mini-transcribe | q3 | 8 | 0.73 | 0.91 |  | 0.018 | 0.018 | 8/8 |
| az-whisper | q3 | 8 | 0.83 | 0.87 |  | 0.000 | 0.000 | 8/8 |
| az-gpt-transcribe | q3 | 8 | 0.86 | 1.01 |  | 0.018 | 0.018 | 8/8 |
| vx-3.5-flash-lite-prompt | q3 | 8 | 0.96 | 1.31 |  | 0.000 | 0.000 | 8/8 |
| rt-az-gpt-transcribe | q3 | 8 | 1.22 | 1.53 | 1.151 | 0.143 | 0.143 | 8/8 |
| vx-3.8-flash-prompt | q3 | 8 | 1.67 | 2.46 |  | 0.000 | 0.000 | 8/8 |
| rt-vx-3.5-transcribe-live-smart | q10 | 8 | 0.35 | 0.40 | 0.355 | 0.103 | 0.000 | 8/8 |
| rt-vx-3.5-transcribe-live | q10 | 8 | 0.36 | 0.38 | 0.358 | 0.138 | 0.034 | 8/8 |
| rt-az-gpt-realtime-whisper | q10 | 8 | 0.55 | 0.59 | 0.0 | 0.034 | 0.017 | 8/8 |
| rt-az-gpt-live-transcribe | q10 | 8 | 0.65 | 0.72 | 0.0 | 0.073 | 0.004 | 4/8 |
| az-speech-fast | q10 | 8 | 0.75 | 0.82 |  | 0.086 | 0.000 | 8/8 |
| vx-3.5-transcribe | q10 | 8 | 0.81 | 0.91 |  | 0.120 | 0.034 | 8/8 |
| az-4o-transcribe | q10 | 8 | 0.93 | 1.13 |  | 0.043 | 0.000 | 7/8 |
| vx-3.5-flash-lite-prompt | q10 | 8 | 0.93 | 1.10 |  | 0.142 | 0.022 | 6/8 |
| az-4o-mini-transcribe | q10 | 8 | 0.96 | 1.14 |  | 0.043 | 0.000 | 7/8 |
| az-whisper | q10 | 8 | 0.99 | 1.23 |  | 0.138 | 0.000 | 0/8 |
| az-gpt-transcribe-stream | q10 | 8 | 1.03 | 1.12 | 0.747 | 0.034 | 0.000 | 8/8 |
| rt-az-gpt-transcribe | q10 | 8 | 1.05 | 1.54 | 0.78 | 0.034 | 0.000 | 8/8 |
| az-gpt-transcribe | q10 | 8 | 1.22 | 1.43 |  | 0.034 | 0.000 | 8/8 |
| vx-3.8-flash-prompt | q10 | 0 | failed: 'candidates' | | | | | |

## S2S latency (end of question audio to first audible reply audio)

| Route | n | Median s | p90 | Min | Max | Socket setup median s |
|---|---|---|---|---|---|---|
| gpt-live-1 | 16 | 0.92 | 1.40 | 0.60 | 2.56 | 1.04 |
| gemini-3.8-live | 16 | 1.28 | 1.34 | 1.26 | 1.38 | 1.01 |
| gemini-live-2.5-flash-native-audio | 16 | 1.33 | 1.46 | 1.17 | 1.59 | 1.05 |
| gpt-realtime-2.1-mini | 16 | 1.57 | 2.24 | 1.25 | 2.63 | 0.89 |
| gpt-realtime-2.1 | 16 | 1.44 | 2.33 | 1.09 | 3.00 | 0.88 |
