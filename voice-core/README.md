# Voice core

The voice call logic, written once and run by every surface: Bento on Android and macOS, the
Echo bridge (home-assistant/live-bridge) and a web page for trying changes. It's a port of
Android's `AssistantCall` and its helpers: the Gemini Live protocol, which turn a function call
answers, Hermes tasks and follow-ups, when a result may go in, standby and coming back, the
goAway rotation, dead-microphone recovery and the recap. The Echo's policies are settings
(`mic.whileSpeaking`, `mic.gainDb`, `hostTools`, `hangUpAfter`).

The same logic runs a typed chat (`medium: "text"`, see "Typed chat" below): a text model in
place of Gemini Live, and the same main thread that hands work to Hermes as tasks.

## How it fits together

The core is sans-IO TypeScript built into one script, `dist/voice-core.js`. It never touches a
socket, a microphone or a clock. A host gives it events and carries out the commands it returns:

```
host                                   core (dist/voice-core.js)
  socket opened / frame / closed  ──►
  microphone frame (16 kHz PCM16) ──►   decides everything:
  tick (every 100 ms)             ──►   what to send, when a result goes in,
  tool result                     ──►   what to play, when to stand by or hang up
                                  ◄──   ws.connect / ws.send / ws.close
                                  ◄──   play / flush / cue / mic.start
                                  ◄──   tool.call (Hermes or a host tool)
                                  ◄──   status / transcript / caption / task
```

`src/types.ts` defines both directions. Every event carries the host's time, so a recorded call
replays to the same commands on any engine.

| Surface | Engine | Host code |
|---|---|---|
| Web (`dev/server.mjs`) | the browser's | `web/` |
| Android | QuickJS (Zipline) | `android/core/.../assistant/live/CoreCall.kt` for calls and `CoreChat.kt` for typed chat (the engine: `voicecore/VoiceCore.kt`) |
| macOS | JavaScriptCore | `Sources/VoiceCore/SharedCore/SharedCallCore.swift` |
| Echo bridge | QuickJS (`quickjs` on PyPI) | `hosts/python/voice_core.py` |
| Scripts | Node | `dev/talk.ts` (a spoken call), `dev/chat.ts` (a typed chat) |

The ABI is strings in and strings out: `VoiceCore.create(configJson, t)` and
`VoiceCore.push(id, eventJson)`. A host is about 100 lines plus its audio and socket code.

## Try it

The dev server runs as a user service on homelab. Open **https://voice.charlesnchr.com** (Cloudflare
Access, Google sign-in, Charles only) or, on the tailnet, https://homelab.tailbf93d.ts.net:8770.

1. Press Call and talk. Work goes to Hermes and code changes to a coding agent in T3 while the
   conversation goes on; each task gets a card with its live progress. Tasks that are finished
   or cancelled, and earlier calls' coding agents that are done, fold away under Finished.
2. The controls:
   - Say "stop" (or "Woodhouse, stop", "that's enough", "quiet") to cut a reply short: the model
     stays quiet until you speak again. The stop button and Esc do the same.
   - Say "goodbye" or "hang up" to end the call.
   - Mute with M or the microphone button; with Settings → Start muted, hold Space to talk.
   - Arm the local wake word loop with W, the wake button, or Settings → Wake word and signaling:
     a LiveKit WakeWord v2 ONNX model runs in a browser Web Worker (`web/wake.worker.ts`) behind
     an adaptive noise-floor gate (`web/wakeDetector.ts`, same gate as Android's `WakeDetector.kt`).
     Between calls it listens for the selected wake word and starts a call with the audio spoken
     immediately after it; inside a call it handles `wakeword` commands from `attention.mode: "window"`
     (dormant) and `mic.whileSpeaking: "wake"` (Echo-style barge-in). Settings lets you switch models
     (`pennyworth` from the repo plus any `.onnx` models in `VOICE_CORE_WAKE_DIR` or
     `~/workspace/home-assistant/wakeword/models/lkww`), adjust threshold live, and compare
     beginning/end signaling modes (`open`, `window`, and `echo`). Run `npm ci` in `voice-core/`
     after pulling so `onnxruntime-web` is installed for the worker build (if absent, the dev server
     starts with wake word disabled rather than failing).
   - Type to the call (Enter), or pick "New Hermes task" / "New coding task" to start one without
     saying it. With no call on, typing starts a chat instead (see "Typed chat"): the same main
     thread in text, with the same task cards. Call then ends the chat and carries its
     conversation on by voice, once the chat's tasks have finished.
   - A card's Follow up goes to that task. A running Hermes task or T3 thread takes it at once,
     in its current run (steering); otherwise it runs next, in the task's session. Cancel stops
     the agent (Hermes's run, or the T3 turn). Hanging up leaves T3 threads working.
3. The header shows the network round trip, how long replies take to start after you stop
   talking, and the browser's audio latency.
4. Edit anything in `src/`. The server rebuilds within a second, and the next call runs the new
   build. The Developer tab has the surface presets (web, android, macos, echo), the raw config
   and everything the core heard and did.
5. Every call is kept as a trace in `traces/`. The Replay tab runs any trace or scenario through
   the latest build and through the build that recorded it, and marks where they differ: the same
   words and the same model answers, with your change.

Without a microphone:

```sh
node dev/talk.ts question.wav [@2.5:talk_over.wav] [next.wav] [--preset echo] [--hermes] [--captions] [--out reply.wav]
```

It says the WAVs into a real call through the same relay and prints the conversation, with how
long each reply took to start. `--captions` turns captions on and prints each one as it comes. Hermes is faked unless `--hermes` is given; `--coding` gives the call
the T3 coding agent. Echo test clips are in `home-assistant/live-bridge/testdata/`; make more with
`node dev/tts.mjs out.wav "Words to say"` (Gemini TTS on GSK Vertex).

Typed, with no audio at all:

```sh
node dev/chat.ts "What's the weather in Copenhagen?" "@1:Also, what's 17 times 23?" "@wait:And the day after?" [--hermes] [--coding]
```

It types each message into a chat (`medium: "text"`) through the server's `/generate` and prints
the model's answers, the tasks and how long each of the model's turns took. A plain message waits
for the model's turn before it; `@<s>:` types it that many seconds after the one before (while
the model or a task is still working), and `@wait:` once every task has finished.

Through Cloudflare, with the Access service token kept for tests:

```sh
set -a; . ~/.local/share/voice-core/access.env; set +a
node dev/talk.ts question.wav --server https://voice.charlesnchr.com
```

Measured on 2026-11-09 from homelab, Vertex us-central1 (the only region that serves the Live model
to this project): replies start 0.75 to 0.9 s after the user stops talking, locally and through
Cloudflare alike.

The coding agent is T3 Code on this machine: `dev/t3.mjs` starts threads with the `t3` CLI (in a
new worktree on a `voice/…` branch when the project is a git repo), follows them up, and steers and
interrupts them over T3's WebSocket. A task is told to do the work itself and to open a pull
request, not to merge or deploy. A task goes to the project the model named. When it named none,
the user's words pick it: a project's title, or a top-level directory that only one project has
("the VoiceCore app" is Bento, for its `voice-core/`). Otherwise it starts in Scratchpad.

The model route is GSK Vertex through the GSK SOCKS route (`VERTEX_*` in `~/.hermes/.env`).
`VOICE_CORE_ROUTE=gemini` with `GEMINI_API_KEY` set uses the public Gemini API, which is billed
to the personal key. Hermes is the API server in `~/.hermes/.env`. Its turns run at low reasoning
effort (`model_options` on each request; `VOICE_CORE_HERMES_REASONING_EFFORT` sets another, and
empty leaves Hermes's own default): at the default, high, a Gmail lookup took 110 s and the call
stood by before its answer came. Approval requests are denied, as on the Echo. Credentials stay
on the server.

```sh
systemctl --user restart voice-core-dev     # after changing dev/server.mjs
journalctl --user -u voice-core-dev -f
tailscale serve --https=8770 off            # take it off the tailnet (needs sudo here)
```

## Captions: the user's words while they speak

Gemini Live sends a turn's transcript in one piece once the user has stopped. On Vertex on
2026-11-22, 8.8 s of speech came as one `inputTranscription` 0.84 s after it ended, with nothing
during it, and `inputAudioTranscription.mode` made no difference. Someone talking for ten seconds
sees nothing of it on screen until they stop.

With `captions` set in `CallConfig` (off by default; `{}` takes the defaults), the core sends the
audio the model hears to Gemini's transcription model (`gemini-3.5-transcribe-live`) over a second
socket, and shows its growing guess meanwhile. That is a port of Android's `LiveCaptions` and of
`AssistantCall`'s caption bookkeeping, in `src/captions.ts`. A host does two things:

- `ws.connect` with `purpose: "captions"` opens a socket to the transcription model named in
  `model`, with the host's own URL and credentials; its `ws.open`, `ws.message` and `ws.closed`
  events go to the core like the model socket's.
- `caption` carries the words for the screen. Each replaces the last, and `text: null` takes the
  caption down. A caption is never part of the conversation: the `transcript` that follows is.

The rest is the core's:

- The captioner hears frame for frame what the model is sent, so nothing is captioned that the
  model didn't hear (muted, standby, dormant, or silence over a reply where the policy says so).
- The model's transcript replaces a caption, and is all an agent gets. Where the two disagree
  about pauses, only the words the model hasn't transcribed yet are shown.
- A caption nothing replaces comes down `linger` seconds (4) after its utterance ended.
- The socket opens with the first audio, closes after `idle` seconds (20) without any, and is
  replaced at the next audio when the server rotates it. One that breaks waits 5 s; three in a row
  without a single caption and the call goes on without captions. Losing them never ends a call.

Measured on 2026-11-22 through the dev server on Vertex, seven scripted calls: the first caption
came 0.73 to 0.93 s after the speech began, with 4 to 11 updates an utterance. The dev server
relays the socket at `/live?for=captions` to the global endpoint (us-central1 doesn't serve the
model), and the web page has the setting "Show my words as I speak", on by default.

In two of three calls with one 8.8 s clip, the Live model's own transcript left out the last
clause ("and don't change anything else") that the caption had shown. The caption makes that
visible when it happens, since the transcript takes its place; the agent still gets the model's
transcript.

## Typed chat: the same call in text

With `medium: "text"` in `CallConfig` the core runs a typed chat. It is the same `Call`, so the
model is the same main thread: it answers what it knows, hands the rest to Hermes (or the coding
agent) with `ask_hermes`, and tasks, follow-ups (`continue_task`), an answer going to the task
that asked, `list_tasks`, `check_task`, `cancel_task`, steering and the screen's `ask` and `steer`
events all work as in a call. Nothing waits for a task: the user types on while Hermes works.

What differs is the model's side (`src/textLine.ts`). A text model (`text.model`,
`models/gemini-3.8-flash` by default, with `text.generation` as its `generationConfig`) is
reached by request and response in place of the Live socket:

- `llm.request` carries a `generateContent` body; the host posts it with its own URL and
  credentials (streaming or not) and answers with `llm.data` for each response or chunk, then
  `llm.end` (with `error` and `status` when it failed). `llm.cancel` drops a request. One is under
  way at a time.
- The user's messages come as `say`, whole and with their line breaks, up to 32,000 characters.
  One typed while the model is still answering waits for that turn to end, and a function call
  answers the message the model was sent, never a later one.
- `transcript` carries the model's words as they stream, `thinking` says when it is working on a
  turn, and `error` is a failure the chat survives (the model didn't answer: nothing was started).
- A hand-off is silent: the "started" answer ends the model's turn without a second request, and
  the `task` command is what the user sees. An answer that isn't silent (a refused call,
  `list_tasks`) makes the model go on.
- A result isn't told by the model. The host shows the reply it gave the core (`tool.result`),
  and the model gets a note of it for the user's questions. A question in the reply counts as
  asked at once, so a plain "yes" goes to that task.
- A note from Bento (a result, a cancellation) goes to the model inside `<bento_note>` tags. The
  API joins it to the user's next message as one turn, and unfenced the model took that message
  for the end of the note and wrote nothing: 4 of 6 follow-ups after a result got no answer on
  2026-11-22, and 8 of 8 were handed on once the note was fenced. An answer with no words and no
  call is a failure the user is told of (`error`), not a silent turn.
- No audio, sockets, earcons, captions, standby, hang-up timer or spoken commands. A host ticks
  while `thinking` is on (the request's timers); nothing else needs the clock.
- Hermes gets the message under its own wording (`typedMessage` in `src/setup.ts`): typed, not
  transcribed, and to be answered for reading, not for the ear.
- Of "Following the user's lead" below, a chat takes what isn't about speech. A message is whole,
  so the next one is never joined to it as a second breath, and the instruction says nothing of
  staying silent or of "stop" meaning stop talking (`LEAD_TYPED` in `src/call.ts`). `refers_back`
  works as in a call, and so does the check on `cancel_task`, judged by the message the model was
  answering: a typed "stop" alone is refused, the model asks, and a "yes" cancels.

The conversation goes back to the model with every request, its parts as they came (they carry
the thought signatures Gemini checks function calls against), trimmed from the oldest turn past
`text.historyChars`. `history` in the config is recapped as the first turn, as for a call.

A chat and a call are separate: each starts its own tasks, and a call that follows a chat gets
its conversation as a recap, not its tasks. Hosts end a chat before a call starts, which is why
they don't start a call while a chat's task is running.

Measured on 2026-11-22 through the dev server on Vertex (`gemini-3.8-flash`, thinking level
low), two scripted chats and eight turns: a turn of one request took 2.2 to 3.4 s, whether the
model answered or handed off, and the one that called `list_tasks` and then answered (two
requests) took 5.9 s. `gemini-3.5-flash-lite`
answered in about 1 s but put the user's request into `continue_task` in two of two probes, so it
isn't the default. `VOICE_CORE_TEXT_MODEL` picks the dev server's model.

## Who tells results, when the model listens, and closer supervision

Four settings in `CallConfig` (`src/types.ts`), all off by default, so a host that sets none
behaves as before. `eval/` measures them (see below).

**`handOff: "named"`**: the model says in a few words after each hand-off's tone what it started
and who has it ("Hermes is looking at your T3 sessions"), including for a call's sole task, unless
it already said so as it called. The core asks for that in the task's "started" answer and holds
results back until the model has said it (for `limits.settleMax` seconds if it says nothing), so a
result that was ready never takes the place of the answer to the user's newest request. A hand-off
the user talks straight over gets only its tone, and the next confirmation names it too. A
follow-up steered into a running task is confirmed the same way. The web page sets it; the default,
"tone", is Android's silent hand-off. It has been measured on Vertex only.

**`announce.by: "host"`**: the core tells the user each task's result itself, instead of handing
the full reply to the speech model to word and time. For each result it sends the host a `brief`
command; the host answers `brief.ready` with one spoken sentence and its audio (a fast text model
and TTS: `eval/brief.ts` is a reference, about 1 to 2 s with Gemini Flash Lite and Chirp 3 HD), or
`brief.failed`, after which the model tells that result the old way. It does the same when no
answer has come in `briefWait` seconds (3): a slow headline costs more than it saves. The core
plays the audio with an ordinary `play` (tagged `source: "announcer"`):

- at once when nobody has spoken for `engaged` seconds;
- in a conversation, `attach` seconds after the model's next reply ends, unless that reply asked
  the user something, or at a lull of `lull` seconds;
- never while the user is speaking or the model owes them a reply, and not while the microphone
  is loud, for up to `maxWait` seconds;
- after `limits.deliverMax` seconds without such a moment, at the next pause in the speech, and
  if it is spoken over then, the model tells it instead;
- several ready together one after another, a task's question last with nothing after it;
- in standby without reconnecting the model.

The user speaking over a brief stops it and it goes again later; saying "stop" drops it (it stays
available through `check_task`). The model gets a note of the words said and the full reply, so it
answers follow-up questions and doesn't repeat the result.

**`attention.mode: "window"`**: the model hears the microphone only for a while after something
that makes the user's next words likely to be for it: `afterWake` seconds after the call starts,
the `wake` event or `resume`; `window` after a spoken reply; `afterQuestion` after a question to
the user; `afterHandOff` after the tone of a silent hand-off; `afterAnnouncement` after a result
told unprompted. Speech that began inside a window is heard to its end. Otherwise the call is
`dormant`: nothing reaches the model, the host is asked to listen for its wake word (`wakeword`
on, as with `mic.whileSpeaking: "wake"`), the last `limits.wakePreRoll` seconds are kept and sent
on waking, loud sound no longer brings a call back from standby, and a dormant call may stand by
with nothing running. A host without a wake word detector should leave this on "open" or give the
user a button that sends `resume`.

**`supervise: true`**: the instruction says a correction or change of mind goes to the same task,
replies stay short and a status answer names each task's state or outcome; `list_tasks` and
`check_task` add how long a task has run, how long it has been quiet and each finished task's
outcome in a line; and a request said in two breaths (two turns with a pause the model let pass)
reaches its agent whole. It also follows the user's lead (next section). The web page sets it.

## Following the user's lead

Two calls on 2026-11-22 (traces `2026-11-22T19-34-17` and `19-58-50`) had the user and the call
talking past each other. What went wrong, and what the core does about each now:

- **A task started on half a sentence.** "I need a new change for the Bento app", a pause, and a
  coding task began before the user said what the change was. With `supervise`, the instruction
  tells the model to stay silent on a request that only says the user wants something. When it
  calls anyway and the user goes straight on (a new turn within `settleQuiet` of the call), the
  hand-off waits for them, up to 8 s: the agent gets both breaths as one request, the tone and
  the card come once they have finished, and a second call the model makes for the rest is
  answered silently.
- **The model said a cancelled task was still working.** On Vertex a task's "started" answer
  closes its call, so a cancel from the screen had no call to answer on. The model now gets a
  note of it.
- **"Stop it" cancelled a task.** Gemini transcribed it as "Stabit", which matched no stop phrase,
  so the model heard it and called `cancel_task` on six minutes of work the user never named.
  "stab it" and "stabit" are stop phrases now, and `cancel_task` is refused unless the user's
  latest words ask for a cancellation ("cancel", "never mind", "forget", "stop working on…") or
  name the task. A refused cancel goes through when the model calls again after the user's next
  turn, so it can ask and act on a "yes". A cancellation's answer names the call that resumes the
  task (`continue_task`), for "I didn't mean that".
- **The model paraphrased three times when asked for the exact quote.** After standby the recap
  holds 600 characters of each reply, and the model answered from that as if it were all of it.
  A reply the recap cuts now says so and names `check_task`, and with `supervise` the instruction
  sends a request for exact words, or to "ask that session again", to `check_task` and then to
  the task as a follow-up.
- **"Just use Hermes" got an argument.** The coding agent failed to start, the user said to use
  Hermes for "what I just said", and the model asked them to repeat it, then said code needs the
  coding agent. The coding instruction now says the user chooses the agent. With `supervise` the
  delegating tools take `refers_back: true` for a request that points at an earlier one: the
  agent still gets only the user's words, with the earlier conversation marked as where the
  request is instead of as reference only.
- **A result landing as the user asked for the next thing made two more mistakes** (seen in the
  scripted calls). The model told the result first and called for the request more than 8 s after
  it was said, which the protocol refused as stale, so the model asked the user to repeat it; and
  the result, marked to go again because the user had spoken first, was told twice. With
  `supervise`, a reply the model began in time and was still making counts as answering the
  request, and a result that reply told is not sent again (when `TaskNames.relays` recognises it,
  which needs three of the reply's distinctive words: a loose paraphrase still gets told twice).
- **A tool response named the wrong tool.** The answer to an `ask_coding_agent` call was named
  `ask_hermes`. Responses carry the name of the tool that was called.

`test/lead.test.ts` and the `following-the-lead` scenario hold these. The wording was tried in
scripted calls on Vertex with `dev/talk.ts` (one or two calls for each case: the two breaths, "use
Hermes for that", the exact quote after standby, "stop it" then "cancel that task"), not on the
bench in `eval/`.

## Measuring a change

`eval/` runs scripted calls against the real model and scores them: 29 scenarios of real use
(results landing mid-conversation, several tasks at once, corrections, status checks, a television
in the room, standby and coming back), a simulated user, scripted agents, metrics from the trace
and a judge. See `eval/README.md`. Run the suite on the build before and after a change, three
times each, before believing a difference.

## Change the logic

```sh
npm install
npm test             # unit tests (ported from Android's) and the conformance replays
npm run typecheck
npm run golden       # rebuild, then rewrite scenarios/*.golden.json
```

`scenarios/` holds scripted calls (`test/scenarios.ts`) and what the core answered to each
event. Every host replays them through its own engine and must answer byte for byte the same:

```sh
cd hosts/python && .venv/bin/python -m pytest -q                          # QuickJS (Python)
cd android && ~/android-toolchain/env.sh gradle :core:test --tests '*VoiceCoreConformanceTest'
scripts/test VoiceCoreTests                                               # JavaScriptCore (on a Mac)
```

When a change alters behaviour on purpose, `npm run golden` rewrites the expected answers. Read
the diff. Commit `dist/voice-core.js` with the change, since the Mac, the Echo and the Android
build (which copies it into the APK's assets) use the built file without Node.

The phone's host has tests of its own, against a scripted Gemini socket and, when the dev server
is named, in a real call spoken with its clips through the relay (GSK Vertex, not the phone's
Gemini key); a third runs the bundle from the APK on a device:

```sh
cd android
~/android-toolchain/env.sh gradle :core:test --tests '*CoreCallTest'
VOICE_CORE_RELAY=http://127.0.0.1:8770 ~/android-toolchain/env.sh gradle :core:test --tests '*CoreCallLiveTest'
ANDROID_SERIAL=emulator-5554 ~/android-toolchain/env.sh gradle :app:connectedDebugAndroidTest
```

Things that differ between the Gemini API and Vertex are in the core. For example, Vertex has no
`willContinue`, so with `api: "vertex"` a task's "started" answer closes its call and the
result goes in as a turn.

## Not done yet

- The web page and Bento on Android use the core for real calls. On the phone it is the default
  (`CoreCall`), with Settings → Hermes → Call engine to go back to the Kotlin `AssistantCall` this
  ports; once the core has proved itself there, `AssistantCall` and its tests can go. The Mac and
  the Echo run the core and pass conformance but don't call with it yet: next the Mac (it gains
  multiple tasks, earcons, standby and hang-up), then the Echo (`woodhouse_live.py`'s Gemini route).
- The phone doesn't use everything the web page does: no coding agent (T3 runs on homelab, not
  the phone), no typing to a call or to a task (typing with no call on is a chat), and a follow-up to a running Hermes task waits
  for its run to end, since the phone's Hermes client has no steer.
- Captions are in the core (`src/captions.ts`) for the web page and `dev/talk.ts`. The phone
  doesn't set `captions` yet: its host keeps its own (`LiveCaptions`, `CaptionTracker`), from the
  audio the core sends and Gemini's voice activity. The Mac and the Echo have none.
- A chat and a call don't share tasks: one main thread that moves between text and voice with its
  tasks (the core switching medium, as it already leaves and rejoins the model for standby) is the
  step after this. The Mac's assistant window doesn't use the typed chat.
- Only Gemini Live. GPT-Live and Grok, which the Echo and the Mac also use, would be provider
  adapters next to the Gemini one in `call.ts`.
- Loading the dev server's build from Android and the Mac at call start (a debug setting) is
  designed for but not wired.
- The web page's audio was tested with a recorded clip in place of the microphone, not with a
  person talking.
