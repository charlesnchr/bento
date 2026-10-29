# Working on Bento

Bento is a macOS menu-bar app (Swift, `Sources/`) with a Rust sync server (`server/`), an
Android app (`android/`) and a Python Vertex helper (`helper/`). README.md covers features
and setup; SPEC.md and QA.md go deeper.

## macOS: build, install, iterate

- `scripts/build.sh --install` builds a signed release, replaces the installed app and
  relaunches it. Without `--install` it only builds `dist/Bento.app`. Check that the build
  number it prints changed.
- The signing identity is stable (`scripts/config.sh`), so macOS keeps the microphone,
  Accessibility and Screen Recording grants across installs. Don't iterate with `--adhoc`:
  it resets them.
- Installing quits the running app, ending any dictation or voice call in progress. Ask
  before installing while the user is using it.
- Tests run one target at a time: `scripts/test VoiceCoreTests`, `scripts/test VoiceTests`,
  `scripts/test LauncherTests` and so on (Swift Testing, a scratch dir per target). Don't
  edit sources while a test build runs: it fails with "modified during the build".
- The loop: edit, test the target, `scripts/build.sh --install`, let the user try it,
  commit locally. Ask before pushing or opening a PR.

## Seeing and driving the UI

- GUI tests share the user's screen, mouse and keyboard, and other agents may be running.
  Wrap them in `scripts/e2e/session start <who>` and `end <who>`: it waits for the user to
  be idle, takes `scripts/gui-lock` and stops if the user touches anything.
- To check a SwiftUI layout without clicking, render the view offscreen from a temporary
  test (an `NSHostingView` written to a PNG with `cacheDisplay`), look at it, then delete
  the test.
- `screencapture -o -l <windowID>` captures one window; window IDs come from
  `CGWindowListCopyWindowInfo`.
- The dictation and assistant harness: `swift build --product DevVoice && .build/debug/DevVoice`
  (its own state in `/tmp/bento-dev/voice`), driven with `scripts/voice-dev <command>`. The
  installed app only accepts these commands when started with `BENTO_DEV` set.

## Off macOS

The Swift app only builds on macOS. Elsewhere:

- Server: `cd server && cargo test`; `scripts/deploy-server.sh` tests, builds and deploys it.
- Android: see android/README.md (`~/android-toolchain/env.sh gradle :app:assembleDebug`).
- Helper: see helper/tests/README.md.
