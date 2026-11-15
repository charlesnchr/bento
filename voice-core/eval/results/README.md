# Kept results

What the bench measured on 15 November 2026, and how to run it again. Every suite is the 28
scenarios in `../scenarios`, with `gemini-3.8-live` on Vertex (us-central1) as the call's model,
user clips from `gemini-3.8-flash-tts`, headlines written by `gemini-3.1-flash-lite` and spoken by
Chirp 3 HD, and `gemini-4-hydrogen` as the judge.

Each folder holds `report.txt` (what `report.ts` prints: a row per scenario and every failed
check) and `runs.tar.gz` (each call's `log.jsonl`, the `scenario.json` it ran and the judge's
`judge.json`). A log's first line names the build and the config of its call.

## The suites

| Folder | Calls | Build | Commit | Config over the bench's defaults |
|---|---|---|---|---|
| `baseline` | 84 | `5da24a3a6418` | `47c4d73` | none: the model tells results, the microphone is always open |
| `announce` | 84 | `81a4675160c6` | `4c68bfb` | `{"announce":{"by":"host"},"supervise":true}` |
| `window` | 84 | `81a4675160c6` | `4c68bfb` | the same, and `"attention":{"mode":"window"}` |
| `final` | 28 | `21c057956950` | `617d06d` | as `window` |
| `final-slow-network` | 56 | `21c057956950` | `617d06d` | as `window` |
| `slow-network-wait-8` | 28 | `21c057956950` | `617d06d` | as `window` |
| `slow-network-wait-3` | 28 | `21c057956950` | `617d06d` | as `window`, and `"announce":{"briefWait":3}` |

A build is `voice-core/dist/voice-core.js` at its commit.

## In the afternoon, on a normal network

Three calls per scenario. Counts are summed over the scenarios' means; times are medians.

| | `baseline` | `announce` | `window` |
|---|---|---|---|
| Score, 0 to 100 | 79.8 | 87.8 | 89.6 |
| Turn collisions | 4.3 | 0.0 | 0.0 |
| Lost results | 2.0 | 0.3 | 0.7 |
| Repeated results | 2.0 | 0.7 | 0.3 |
| Checks passed, of 187 | 165.0 | 172.7 | 176.0 |
| Reply latency | 0.84 s | 0.82 s | 0.81 s |
| Result to speech | 1.5 s | 2.4 s | 2.4 s |
| Headline preparation | | 1.1 s | 1.3 s |
| Words the assistant said | 1491 | 1293 | 1287 |
| Judge, 0 to 10 | 7.7 | 7.9 | 8.3 |

`final` is one pass of the build with the last fixes: 88.9, no collisions, headlines in 1.4 s.

Two runs of one build differed by about 2 points overall, and a scenario's mean moves by up to 15
between runs of the same build, so read smaller differences as noise. No significance test was
run.

## In the evening, on a slow network

From about 19:45 the route to Google passed about 60 KB/s (2 MB took 29.6 s), where one call's
model audio alone needs about 64 KB/s. Headline speech took 5 s and more instead of 1.1 s.

| | `final-slow-network` | `slow-network-wait-8` | `slow-network-wait-3` |
|---|---|---|---|
| Calls | 56 | 28 | 28 |
| Score | 79.6 | 73.5 | 80.1 |
| Turn collisions | 0.5 | 2.0 | 5.0 |
| Lost results | 5.0 | 8.0 | 5.0 |
| Result to speech | 10.3 s | 13.1 s | 8.0 s |
| Headline preparation, of those that came back | 5.1 s | 7.6 s | 8.5 s |

These measure the network more than the build. They show what the design costs when the headline
is slow: a result waits for it, and scripts that end 6 s after the last sound end before it is
spoken, which counts as lost. The last two ran side by side, four calls each at a time: giving
the headline 3 s instead of 8 before the model tells the result itself scored 80.1 against 73.5
(one pass each, so within noise for any one scenario). At 3 s nearly every result went to the
model, which is the baseline's behaviour 3 s later, collisions included. On the normal network 1
of 292 headlines took longer than 3 s.

The default `announce.briefWait` is 3 s from build `9bc35b468e9d` on. That build differs from
`21c057956950` in that default only, and has not had a suite on a normal network.

## Run a suite again

Needs `VERTEX_CREDENTIALS_PATH` and `VERTEX_PROJECT_ID` in `~/.hermes/.env` and a SOCKS route to
Google (`VOICE_CORE_SOCKS`, default `socks5h://127.0.0.1:11080`).

```sh
cd voice-core && npm install
mkdir -p dist/versions
git show 47c4d73:voice-core/dist/voice-core.js > dist/versions/5da24a3a6418.js
git show 4c68bfb:voice-core/dist/voice-core.js > dist/versions/81a4675160c6.js

node eval/suite.ts --name baseline --repeat 3 --judge --bundle dist/versions/5da24a3a6418.js
node eval/suite.ts --name window --repeat 3 --judge --bundle dist/versions/81a4675160c6.js \
  --config '{"announce":{"by":"host"},"attention":{"mode":"window"},"supervise":true}'
node eval/report.ts eval/runs/baseline eval/runs/window
```

A suite of 84 calls takes about 20 minutes, four calls at a time. Check the report's `brief s`
column before believing a run: above 2 s, the network or the speech service was slow.

## Score the kept logs again

```sh
mkdir -p eval/runs && tar -xzf eval/results/baseline/runs.tar.gz -C eval/runs
node eval/report.ts eval/runs/baseline                  # the table in results/baseline/report.txt
node eval/metrics.ts eval/runs/baseline/burst-three-1   # one call: timeline, metrics, checks
```

## What a new run will not repeat

- The model's answers. A call is not deterministic, which is why a scenario runs three times.
- The user's clips. They are synthesized on the first run and cached in `eval/cache` (26 MB, not
  kept here). The same words synthesized again differ slightly in length.
- The judge's grades, by about a point.

The bench fires the wake word from the script, so it assumes a detector that never misses and
never fires on its own.

## Latency probes

`../probe` holds the measurements the design rests on: time to first audio for each TTS route,
transcription latency and accuracy, the text models that write a headline, and the speech
models' reply latency, with scripts, raw runs and `RESULTS.md`.
