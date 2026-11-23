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
- The loop on macOS: edit, test the target, `scripts/build.sh --install`, then ship via the PR workflow below.

## Shipping changes (never leave PRs open)

Never leave a Bento PR open as the finished state. Work is not done until the PR is reviewed by two independent agents, merged to `main`, and released or deployed for every surface it touched. This applies to every Bento task, including tasks dispatched from the voice app whose boilerplate prompt says not to merge, release, or start other agents.

1. Implement and verify locally (run the affected test targets, typechecks, and builds).
2. Commit, push the branch, and open a PR against `main` using Charles's personal GitHub account (`GH_ACCOUNT=personal`, repo `charlesnchr/bento`). Note that `origin/voice` exists on GitHub, so push `voice/...` branches to a hyphenated remote ref such as `voice-<slug>`.
3. Run a dual-agent review loop on the PR in parallel using `delegate_task` (`role: "review"`):
   - One Codex reviewer (latest GPT Sol model, e.g. `gpt-6.2-sol`)
   - One Claude reviewer (Claude Opus 5.5, `claude-opus-5-5`)
   Confirm provider IDs and model slugs with `orchestrator_capabilities` first. Address every material finding, re-run verification, push, and launch a new review round (new `delegate_task` calls with the original brief, prior findings, and responses) until both reviewers approve.
4. Merge the PR into `main` (squash or merge, and delete the feature branch).
5. Release or deploy what changed from updated `main`:
   - macOS (`Sources/`): `scripts/release.sh X.Y.Z` on a Mac (bump patch from latest `vX.Y.Z` tag).
   - Android (`android/` or `voice-core/dist/voice-core.js`): `scripts/release-android.sh X.Y.Z` (bump patch from latest `android-vX.Y.Z` tag).
   - Sync server (`server/`): `scripts/deploy-server.sh`.
   - Voice web surface (`voice-core/web/` or `voice-core/dev/`): fast-forward `~/workspace/bento-voice-core` to `origin/main` (and run `systemctl --user restart voice-core-dev` if `dev/` changed) so https://voice.charlesnchr.com serves the merged change.
   - If a surface cannot be released from the current host (for example, macOS builds on Linux), state that explicitly and complete every release/deploy step reachable from this host.

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

## The shared voice core

`voice-core/` is the voice call logic every surface runs (TypeScript, built to
`voice-core/dist/voice-core.js`, run by QuickJS on Android and JavaScriptCore on the Mac). See
voice-core/README.md: change it there, try it on the web surface, and keep `scenarios/` passing
on every engine. The web surface is https://voice.charlesnchr.com (the dev server on homelab, user
unit `voice-core-dev`, behind Cloudflare Access); `voice-core/dev/talk.ts` makes scripted calls.

## Off macOS

The Swift app only builds on macOS. Elsewhere:

- Server: `cd server && cargo test`; `scripts/deploy-server.sh` tests, builds and deploys it.
- Android: see android/README.md (`~/android-toolchain/env.sh gradle :app:assembleDebug`).
- Helper: see helper/tests/README.md.
