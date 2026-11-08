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

The dev server runs as a user service on homelab and is on the tailnet at
https://homelab.tailbf93d.ts.net:8770 (HTTPS, so the browser allows the microphone).

1. Open the page, pick a surface preset (web, android, macos, echo) and press Call.
2. Edit anything in `src/`. The server rebuilds within a second, and the next call runs the new
   build. The header shows the core's version, a hash of the bundle.
3. Every call is kept as a trace in `traces/`. The Replay tab runs any trace or scenario through
   the latest build and through the build that recorded it, and marks where they differ: the same
   words and the same model answers, with your change.

Without a microphone:

```sh
node dev/talk.ts question.wav [@2.5:talk_over.wav] [next.wav] [--preset echo] [--hermes] [--out reply.wav]
```

It says the WAVs into a real call through the same relay and prints the conversation. Hermes is
faked unless `--hermes` is given. Echo test clips are in `home-assistant/live-bridge/testdata/`.

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

- No surface uses the core for real calls yet. The engines run it and pass conformance; the next
  step is to wire each call screen's I/O to it behind a setting, Android first (its
  `AssistantCall` is what this ports). After that the Mac (it gains multiple tasks, earcons,
  standby and hang-up), then the Echo (`woodhouse_live.py`'s Gemini route).
- Captions (Android's second transcription socket) aren't ported.
- Only Gemini Live. GPT-Live and Grok, which the Echo and the Mac also use, would be provider
  adapters next to the Gemini one in `call.ts`.
- Loading the dev server's build from Android and the Mac at call start (a debug setting) is
  designed for but not wired.
- The web page's audio was tested with a recorded clip in place of the microphone, not with a
  person talking.
