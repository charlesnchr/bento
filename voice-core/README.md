# Voice core

The voice call logic, written once and run by every surface: Bento on Android and macOS, the
Echo bridge (home-assistant/live-bridge) and a web page for trying changes. It's a port of
Android's `AssistantCall` and its helpers: the Gemini Live protocol, which turn a function call
answers, Hermes tasks and follow-ups, when a result may go in, standby and coming back, the
goAway rotation, dead-microphone recovery and the recap. The Echo's policies are settings
(`mic.whileSpeaking`, `mic.gainDb`, `hostTools`, `hangUpAfter`).

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
                                  ◄──   status / transcript / task
```

`src/types.ts` defines both directions. Every event carries the host's time, so a recorded call
replays to the same commands on any engine.

| Surface | Engine | Host code |
|---|---|---|
| Web (`dev/server.mjs`) | the browser's | `web/` |
| Android | QuickJS (Zipline) | `android/core/.../voicecore/VoiceCore.kt` |
| macOS | JavaScriptCore | `Sources/VoiceCore/SharedCore/SharedCallCore.swift` |
| Echo bridge | QuickJS (`quickjs` on PyPI) | `hosts/python/voice_core.py` |
| Scripts | Node | `dev/talk.ts` |

The ABI is strings in and strings out: `VoiceCore.create(configJson, t)` and
`VoiceCore.push(id, eventJson)`. A host is about 100 lines plus its audio and socket code.

## Try it

The dev server runs as a user service on homelab. Open **https://voice.charlesnchr.com** (Cloudflare
Access, Google sign-in, Charles only) or, on the tailnet, https://homelab.tailbf93d.ts.net:8770.

1. Press Call and talk. Work goes to Hermes and code changes to a coding agent in T3 while the
   conversation goes on; each task gets a card with its live progress.
2. The controls:
   - Say "stop" (or "Woodhouse, stop", "that's enough", "quiet") to cut a reply short: the model
     stays quiet until you speak again. The stop button and Esc do the same.
   - Say "goodbye" or "hang up" to end the call.
   - Mute with M or the microphone button; with Settings → Start muted, hold Space to talk.
   - Type to the call (Enter), or pick "New Hermes task" / "New coding task" to start one without
     saying it.
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
node dev/talk.ts question.wav [@2.5:talk_over.wav] [next.wav] [--preset echo] [--hermes] [--out reply.wav]
```

It says the WAVs into a real call through the same relay and prints the conversation, with how
long each reply took to start. Hermes is faked unless `--hermes` is given; `--coding` gives the call
the T3 coding agent. Echo test clips are in `home-assistant/live-bridge/testdata/`; make more with
`node dev/tts.mjs out.wav "Words to say"` (Gemini TTS on GSK Vertex).

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
request, not to merge or deploy.

The model route is GSK Vertex through the GSK SOCKS route (`VERTEX_*` in `~/.hermes/.env`).
`VOICE_CORE_ROUTE=gemini` with `GEMINI_API_KEY` set uses the public Gemini API, which is billed
to the personal key. Hermes is the API server in `~/.hermes/.env`. Approval requests are denied,
as on the Echo. Credentials stay on the server.

```sh
systemctl --user restart voice-core-dev     # after changing dev/server.mjs
journalctl --user -u voice-core-dev -f
tailscale serve --https=8770 off            # take it off the tailnet (needs sudo here)
```

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
the diff. Commit `dist/voice-core.js` with the change, since the Mac and the Echo use the built
file without Node.

Things that differ between the Gemini API and Vertex are in the core. For example, Vertex has no
`willContinue`, so with `api: "vertex"` a task's "started" answer closes its call and the
result goes in as a turn.

## Not done yet

- The web page is the only surface that uses the core for real calls. The other engines run it
  and pass conformance; the next step is to wire each call screen's I/O to it behind a setting, Android first (its
  `AssistantCall` is what this ports). After that the Mac (it gains multiple tasks, earcons,
  standby and hang-up), then the Echo (`woodhouse_live.py`'s Gemini route).
- Captions (Android's second transcription socket) aren't ported.
- Only Gemini Live. GPT-Live and Grok, which the Echo and the Mac also use, would be provider
  adapters next to the Gemini one in `call.ts`.
- Loading the dev server's build from Android and the Mac at call start (a debug setting) is
  designed for but not wired.
- The web page's audio was tested with a recorded clip in place of the microphone, not with a
  person talking.
