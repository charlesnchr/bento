# Kept results

What the bench measured on 15 November 2026, and how to run it again. Every suite is the 28
scenarios `../scenarios` held then (the suites of 22 November, further down, have a 29th), with
`gemini-3.8-live` on Vertex (us-central1) as the call's model, user clips from
`gemini-3.8-flash-tts`, headlines written by `gemini-3.1-flash-lite` and spoken by Chirp 3 HD,
and `gemini-4-hydrogen` as the judge.

Each folder holds `report.txt` (what `report.ts` prints: a row per scenario and every failed
check) and `runs.tar.gz` (each call's `log.jsonl`, the `scenario.json` it ran and the judge's
`judge.json`). A log's first line names the build and the config of its call. Seven scenarios'
`facts` patterns were corrected in review (a number said another way, a question without its
mark, "terrain" read as rain), and the kept `scenario.json` files carry the corrected patterns:
their scripts and checks are as they ran.

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
| Score, 0 to 100 | 81.3 | 87.7 | 91.1 |
| Turn collisions | 4.3 | 0.0 | 0.0 |
| Lost results | 1.0 | 0.3 | 0.0 |
| Repeated results | 1.7 | 0.3 | 0.0 |
| Checks passed, of 187 | 166.0 | 172.3 | 176.7 |
| Reply latency | 0.84 s | 0.82 s | 0.81 s |
| Result to speech | 1.5 s | 2.8 s | 3.5 s |
| Headline preparation | | 1.1 s | 1.3 s |
| Words the assistant said | 1491 | 1293 | 1287 |
| Judge, 0 to 10 | 7.7 | 7.9 | 8.3 |

`final` is one pass of the build with the last fixes: 91.0, no collisions, headlines in 1.4 s.

Two runs of one build differed by about 2 points overall, and a scenario's mean moves by up to 15
between runs of the same build, so read smaller differences as noise. No significance test was
run.

## In the evening, on a slow network

From about 19:45 the route to Google passed about 60 KB/s (2 MB took 29.6 s), where one call's
model audio alone needs about 64 KB/s. Headline speech took 5 s and more instead of 1.1 s.

| | `final-slow-network` | `slow-network-wait-8` | `slow-network-wait-3` |
|---|---|---|---|
| Calls | 56 | 28 | 28 |
| Score | 80.6 | 73.5 | 82.8 |
| Turn collisions | 0.5 | 2.0 | 5.0 |
| Lost results | 4.5 | 8.0 | 3.0 |
| Result to speech | 10.4 s | 12.1 s | 4.5 s |
| Headline preparation, of those that came back | 5.1 s | 7.6 s | 8.5 s |

These measure the network more than the build. They show what the design costs when the headline
is slow: a result waits for it, and scripts that end 6 s after the last sound end before it is
spoken, which counts as lost. The last two ran side by side, four calls each at a time: giving
the headline 3 s instead of 8 before the model tells the result itself scored 82.8 against 73.5
(one pass each, so within noise for any one scenario). At 3 s nearly every result went to the
model, which is the baseline's behaviour 3 s later, collisions included. On the normal network 1
of 292 headlines took longer than 3 s.

The default `announce.briefWait` has been 3 s since. The builds after `21c057956950` (that
default, and the fixes from review) have not had a suite on a normal network.

## Hand-offs named in words, 22 November 2026

A call that day made three requests in a row while the earlier ones ran. Each hand-off got a
tone and no words, a request to look at the user's T3 Code sessions was answered from the call's
own task list, and an earlier task's result was told straight after the third request, in place
of any word about it. `../scenarios/parallel-threads.json` scripts that call, which makes 29
scenarios. `handOff: "named"` (see `../../README.md`) is the fix, with a sentence in the
instruction on what `list_tasks` covers.

| Folder | Calls | Build | Config over the bench's defaults |
|---|---|---|---|
| `threads-before` | 3 | `ba4140d296a2` (`17f89bd`) | none; `parallel-threads` only |
| `threads-tone` | 3 | `ba3988e08df4` | `{"handOff":"tone"}`; `parallel-threads` only |
| `threads-named` | 3 | `ba3988e08df4` | `{"handOff":"named"}`; `parallel-threads` only |
| `hand-off-tone` | 58 | `df8ea5ceca0e` | `{"handOff":"tone"}` |
| `hand-off-always` | 58 | `df8ea5ceca0e` | `{"handOff":"spoken"}` |
| `hand-off-named` | 58 | `ba3988e08df4` | `{"handOff":"named"}` |

`ba3988e08df4` is the build this change commits, and the bench's defaults now carry
`handOff: "named"`. `df8ea5ceca0e` was an earlier build of the same change and is not in the
history: its "spoken" setting asked for words after every hand-off, and with "tone" it sends
what the committed build sends. The 58-call suites are every scenario twice.

The call's own scenario, three calls each, scored with its final checks:

| | `threads-before` | `threads-tone` | `threads-named` |
|---|---|---|---|
| Score, 0 to 100 | 40 | 67 | 97 |
| Checks passed, of 14 | 11.0 | 12.0 | 14.0 |
| Judge, 0 to 10 | 4.0 | 6.7 | 9.3 |
| The T3 Code sessions request went to Hermes | 0 of 3 | 3 of 3 | 3 of 3 |
| The coding request was confirmed before the earlier result | 0 of 3 | 0 of 3 | 3 of 3 |

Across all the builds of this change the T3 Code sessions request went to Hermes in 14 of 15
calls and to the coding agent in one; it never went to `list_tasks` again.

Every scenario, two calls each. Counts are summed over the scenarios' means.

| | `hand-off-tone` | `hand-off-always` | `hand-off-named` |
|---|---|---|---|
| Score | 80.9 | 76.4 | 81.1 |
| Turn collisions | 4.0 | 6.5 | 3.0 |
| Lost results | 0.5 | 2.5 | 2.0 |
| Checks passed, of 201 | 177.5 | 176.0 | 179.5 |
| Words the assistant said | 1626 | 1957 | 1696 |
| Judge | 7.8 | 7.1 | 7.7 |

Words after every hand-off were tried first and dropped. With one task in the call they tell
the user what the tone already has, and they start about 2 s after the user stops, which is
where a user who paused to think carries on (`rambling-request`: the model was cut off 0.9 s
into "Hermes is looking into booking that haircut"). "named" keeps the tone alone for a call's
only task, so those scenarios send the model what "tone" sends. Where tasks overlap it scored
higher: `parallel-threads` 34 to 98, `result-during-user-speech` 68 to 100, `burst-three` 62
to 92, `multitask-interrupt` 70 to 88. With two calls a scenario these are within the 15 points
one scenario moves between runs, apart from `parallel-threads`.

The lost results under "named" are not hand-offs gone wrong. In `steer-running` the result was
said and transcribed as "one hundred fortyTwo pounds", which its pattern misses; in
`noisy-request` the script ended as the result went in after a long stretch of television; in
`question-while-busy` and `names-fidelity` the model told the result without the number its
pattern looks for ("over two hundred old files" for 214). `correction` fell from 92 to 55 because the model started a new task for "no, I meant
Tesco" in both calls, as it did in one of the two "tone" calls: that is what `supervise` is for,
and the web page does not set it.

The older scenarios' word limits and `noSpeech` checks were written for silent hand-offs, so
they count against any confirmation, including a wanted one.

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

A result counts as said when the assistant's words match its `facts`. A headline is scored on the
host's own text; what the model says is scored on the transcript of its speech, which paraphrases
more. That favours the headline wherever a pattern is too narrow, so read a "lost" in the
baseline's report against the words quoted beside it.

## Latency probes

`../probe` holds the measurements the design rests on: time to first audio for each TTS route,
transcription latency and accuracy, the text models that write a headline, and the speech
models' reply latency, with scripts, raw runs and `RESULTS.md`.
