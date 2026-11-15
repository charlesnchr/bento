# Voice call bench

Scripted calls against the real model, scored from what happened. A simulated user speaks
synthesized clips into the call's microphone on a script that reacts to the call, scripted fake
agents stand in for Hermes and T3, and every event and command is logged with its time.

Everything runs on Vertex (`vertex.ts`): the Live model the call talks to, Gemini TTS for the
user's voice, and a text model for the judge. Nothing here can reach the public Gemini API.

```sh
npm run build                                           # the bench runs dist/voice-core.js
node eval/run.ts eval/scenarios/single-task.json        # one call, printed as it happens
node eval/metrics.ts eval/runs/<run>                    # its timeline, metrics and checks
node eval/suite.ts --name baseline --repeat 3 --judge   # every scenario, 4 calls at a time
node eval/report.ts eval/runs/baseline eval/runs/mine   # two suites side by side
eval/keep.sh eval/runs/mine mine                        # keep its report and logs in eval/results
```

A call is real time, so a scenario takes as long as the conversation it scripts. `--bundle` runs
another build of the core (`dist/versions/<hash>.js` keeps every build), and `--config` overrides
the call's config, so two variants can run on the same scripts.

## A scenario

```json
{
  "name": "result-during-dialogue",
  "about": "What the call tests and what good looks like. The judge reads this.",
  "config": { "standbyAfter": 0 },
  "agents": [
    { "id": "trains", "match": "train|edinburgh", "after": 16,
      "progress": [[3, "Using web_search"]],
      "result": "The first train leaves at 06:15.",
      "facts": ["6[:. ]?15|six[- ]fifteen"],
      "followUps": [{ "id": "trains-book", "match": "book|yes", "after": 4, "result": "Booked.", "facts": ["booked"] }] }
  ],
  "steps": [
    { "say": "Ask Hermes when the first train to Edinburgh leaves tomorrow.", "id": "ask" },
    { "until": "dispatch:trains", "timeout": 15 },
    { "say": "While that runs, what is a Kalman filter?", "id": "q1" },
    { "until": "quiet:8", "timeout": 60 }
  ],
  "checks": [{ "dispatch": "trains", "count": 1 }, { "voiced": "trains", "within": 30 }],
  "judge": ["Was the result said once?"],
  "max": 150
}
```

`config` is merged over the bench's defaults (`BASE_CONFIG` in `run.ts`: Vertex, the web preset,
standby after 30 s) and is the core's `CallConfig`.

### Agents

A request the core hands to an agent is matched against each script's `match` (a
case-insensitive regex on the user's words as the agent received them; `agent: "t3"` limits it
to the coding agent). The script answers `after` seconds with `result` (or fails with `error`),
with `progress` lines on the way. `followUps` answer later requests in the same task. `steer:
"refuse"` turns a steer down; `steeredResult` is the result once a steer was taken. `facts` are
regexes that must all appear in what the model says for the result to count as voiced: write
them for how a number is spoken as well as written. A request no script matches is answered
"Done" after 3 s and counted as a stray dispatch, so give every request the script makes a
matching agent.

### Steps

| Step | Meaning |
|---|---|
| `{"say": "…"}` | The user says it. Options: `id`, `voice` (Gemini TTS voice, default Puck), `style` (a delivery prompt), `gain`, `ambient`, `when`, `gap`, `patience`, `block`, `wake`. |
| `{"wait": 3}` | Seconds. |
| `{"until": "cond", "timeout": 30}` | Waits for a condition; a timeout is logged and the script goes on. |
| `{"event": {"type": "interrupt"}}` | A host event for the core: `interrupt`, `mute`, `unmute`, `resume`, `wake`, `say` (typed), `ask`, `steer`, `cancelTask`, `cancelAll`. |
| `{"mark": "name"}` | A note in the log. |

`when` says when the user starts speaking:

- `"turn"` (default): once the model has answered or handed off what was said last (or `patience`
  seconds passed, default 8) and has been silent for `gap` seconds (default 1.2). This is a user
  taking their turn properly, so the model starting to speak as they do is its collision.
- `"now"`: at once, over whatever is playing.
- `{"speaking": 1.5}`: once the model has been speaking for that long (a barge-in).
- `{"after": "result:trains", "delay": 0.3}`: after a condition.

`ambient: true` marks speech that is not for the assistant (a TV, the user talking to someone
else): voice Kore and gain 0.35 unless set. `block: false` lets the next step start while the clip
plays. `wake: true` fires the host's wake word 0.7 s into the clip (a number sets the time).

Conditions, joined with `&`: `quiet:N` (nobody audible for N seconds), `dispatch:<id>`,
`result:<id>`, `reply` (the model answered the last utterance and finished), `status:<status>`,
`said:<regex>` (the model's words since the step began), `agents-done`, `speaking`.

### Checks

Each is pass or fail. `after` and `before` name user utterances by `id` and limit the check to
what happened from the end of one to the start of the other.

| Check | Passes when |
|---|---|
| `{"said": "regex"}`, `{"notSaid": "regex"}` | the model's words in the window match (or don't) |
| `{"noSpeech": true}` | the model said nothing in the window |
| `{"maxModelWords": 40}` | the model said at most that many words in the window |
| `{"dispatch": "id", "count": 1}` | that many new tasks started for the agent script |
| `{"followUp": "id", "match": "regex"}` | a follow-up or steer with those words reached that task |
| `{"steer": "id", "match": "regex"}` | a steer reached the running task |
| `{"cancel": "id"}`, `{"notCancelled": "id"}` | that task's run was (not) cancelled |
| `{"request": "id", "contains": ["word"]}` | the agent received those words |
| `{"status": "standby"}` | the call reached that status |
| `{"voiced": "id", "within": 20}` | the result's facts were said, within so many seconds |
| `{"dispatch": "?", "count": 0}` | no task started that no script expected |
| `{"dispatch": "id", "within": 4}` | each such task started within so many seconds of the utterance before it |
| `{"request": "id", "lacks": ["word"], "project": "Bento"}` | none of those words reached the agent; every such task had that project |
| `{"yields": "u3", "within": 1}` | the sound playing when the user cut in with that utterance stopped within so many seconds (from the wake word, if the clip has one) |
| `{"connected": "id", "max": 40}` | at most so many seconds on a model socket between that task's start and its result |
| `{"anyOf": [check, …]}` | any of its checks passes |

`after` and `before` also take `start:<utterance>`, `result:<agent>`, `dispatch:<agent>` and
`mark:<name>`. A scenario's `retold: "<utterance>"` names the point where the user asks to hear
results again ("what did I miss?"): results said after it count as voiced if nothing said them
earlier, and never as repeats.

Things that went wrong while the scenarios were written:

- Facts must match only their own result. "7:45" or "Copenhagen" in two results scores a false
  repeat, and a loose pattern like `sent|message` matches another task's. A result that asks a
  question needs a question cue among its facts.
- Ambient clips need `"when": "now"`: with the default a television waits for the model to stop.
- `style` does nothing: a delivery prompt in front of the text gets read aloud by the TTS model.
- With `standbyAfter` at 30, a scripted silence of 30 s or more changes the scenario.
- `replyLatency` leaves out a request that was handed off before the model's first sound: that
  sound is the result, not a reply.

When the call is dormant (attention "window"), the simulated user's clips trip the wake word 0.3 s
in, as a user who sees the light is off would say it first. The clip does not contain the word, and
ambient clips never trip it: the bench tests what the core does with a wake word, not how well a
detector hears one.

## Metrics

`metrics.ts` computes these from the log, with the script's own clip times as ground truth for
when the user spoke.

| Metric | Definition |
|---|---|
| `replyLatency` | end of a user utterance to the model's first sound, for each that got a spoken reply |
| `dispatchLatency` | end of a request to its agent starting |
| `turnCollisions` | user utterances during which the model began to speak (from 0.25 s before the user started). With `when: "turn"` the user waited for silence, so the model spoke unprompted. |
| `overlapSeconds` | seconds the user and the model were audible at once |
| `announcements` | for each result with `facts`: seconds from the result to the stretch of speech that said them (`delay`), how many stretches said them (`times`), and starts cut off before the facts (`aborted`) |
| `briefSeconds` | where the core tells results itself: seconds each headline took to come back, text and speech. The report's `brief s` is their median; above 2 s the network or the speech service was slow, and the run says more about that than about the build |
| `lostResults`, `repeatedResults` | results never said, and extra times one was said |
| `unscriptedDispatches` | requests an agent got that no script expected |
| `ambientSpeechSeconds`, `ambientToolCalls` | the model's speech and tool calls while only ambient speech was audible (plus 3 s) |
| `requestRecall` | of the words the user said in a request, the share the agent received |
| `modelWords`, `modelSpeechSeconds` | how much the model said |
| `connectedSeconds`, `standbySeconds` | time on a model socket (the billed time), and in standby |

The score is 100 less penalties: 25 per lost result, 10 per repeat, 10 per turn collision, 15 per
stray dispatch, 15 per failed check, 10 per 5 s of speech at ambient audio and 15 per tool call
there, 10 per second of median reply latency over 1.2 s, 5 per result said more than 30 s late,
5 per script timeout. `judge.ts` has a text model grade the readable timeline (flow, brevity,
accuracy, supervision, overall, 0 to 10) and answer the scenario's `judge` questions. Its grades
are reported beside the score, never in it. Two judge calls on one run differ by about a point,
so read judge differences smaller than that as noise.

A model call is not deterministic: run a scenario at least three times before comparing two
builds, and compare the means.

## Kept results

`results/` holds the suites behind the numbers in `results/README.md`, with what each ran and how
to run it again. `eval/keep.sh eval/runs/<suite> <name>` keeps a suite there: its report, and each
call's log, scenario and verdict (not its trace, which holds the audio). `probe/` holds the latency
probes of the speech, TTS, STT and text models the design rests on, with their raw runs.
