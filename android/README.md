# Bento for Android

The phone side of Bento: Notes and Todo, synced live with your Macs through the same
`bento-sync` server, home-screen widgets for both, and dictation and meeting notes through
your own Gemini API key. Kotlin and Jetpack Compose (Glance for the widgets), Android 12+.

## Layout

```
android/
  core/   pure Kotlin/JVM, unit tested without a device
    json/       JSONValue (the Mac's opaque meta/fields, Apple-compatible canonical JSON)
    sync/       CollectionSync (an engine as the transport sees it) and SyncConnection
                (WebSocket with reconnect, REST polling fallback, one-shot REST sync)
    notes/      TextMerge, MarkdownParser/Commands, Note, the Notes SyncEngine (heads,
                three-way merge, conflicted copies): a line-by-line port of Sources/Notes
    fielddoc/   field-clock documents and their engine (Todo and voice collections)
    todo/       TodoDoc accessors, queries, quick-add and date parsers, TodoActions
    voicesync/  the `voice` collection: dictionary entries, instructions, modes
    assistant/  the Hermes API client (sessions, streamed turns), the chat transcript, Markdown
                for reading, and live/: voice calls on Gemini Live that hand requests to Hermes
    voice/      Gemini transcription (batch + live), cleanup, validation, voice edits,
                history and crash recovery, meetings
  app/    the Android app
    settings/   Prefs, SecretStore (Android Keystore), Pairing (bento://pair QR links)
    sync/       SyncHub: live while Bento is in use, WorkManager in the background
    voice/      DictationController, AudioCapture, VoiceService (microphone FGS),
                BentoAccessibilityService + DictationOverlay (bubble, held Volume Down,
                text insertion), CaptureActivity + Quick Settings tile
    keyboard/   the voice-first keyboard (InputMethodService)
    assistant/  AssistantController (chat and calls), the call's audio (echo-cancelled, speaker or headset)
    widget/     Glance widgets: notes, one note, tasks, capture
    update/     self-update from GitHub releases tagged android-v*
    ui/         Compose screens
```

The sync protocol is `docs/SYNC_PROTOCOL.md`. Everything that decides how documents merge
lives in `core` and mirrors the Swift code, so a Mac and the phone merging the same two
versions get the same text; `core`'s tests include vectors generated from the Swift code.

## Build

Needs JDK 17+ and the Android SDK (platform `android-37.2`, build-tools 36+). On a machine
without Android Studio, `~/android-toolchain/env.sh` scopes `JAVA_HOME`, `ANDROID_HOME` and
Gradle to one command (the setup is the `android-cli-toolchain` skill):

```sh
cd android
~/android-toolchain/env.sh gradle :core:test             # unit + sync tests (starts server/target/release/bento-sync when built)
~/android-toolchain/env.sh gradle :app:assembleDebug     # app/build/outputs/apk/debug/app-debug.apk
~/android-toolchain/env.sh adb install -r app/build/outputs/apk/debug/app-debug.apk
```

`./gradlew` works too where Gradle can be downloaded. The core sync tests run against the
real server when it's built (`cd server && cargo build --release`) and are skipped otherwise.
The Gemini end-to-end tests run when `GEMINI_API_KEY` is set.

## Release

```sh
scripts/release-android.sh 0.1.0            # from a clean main that matches origin
scripts/release-android.sh 0.1.0 --dry-run  # build and sign into dist/ only
```

It tests, builds and signs the APK with the keystore in
`~/.config/bento/android-signing.properties` (outside the repo; every release must use the
same key, or phones can't update in place), tags `android-v0.1.0` and uploads
`Bento-0.1.0.apk` to a GitHub release marked not-latest, so the Mac's releases keep the
"Latest" badge and the Homebrew updater is unaffected. Phones find it when Bento opens or
with their daily check, and ask **Update Bento?**.

Updates go through `PackageInstaller` sessions. The first one asks Android to allow installs
from Bento. After that, Bento holds `UPDATE_PACKAGES_WITHOUT_USER_ACTION`, so Android 12+ can
install its own updates without the installer's confirmation screen; Bento then posts "Bento
x.y.z is installed". The update that first brings this permission still asks once, since the
version doing the installing doesn't have it yet. Play Protect still checks every APK, and
for one it hasn't seen before it may offer to scan it or send it to Google, the first install
from a browser or file manager especially. No app code removes that. A Play-distributed build
is known to Play Protect from the start. Android developer verification registers the
developer and package rather than exempting an APK from scanning. Since 30 September 2026 it
covers installs from participating stores in Brazil, Indonesia, Singapore and Thailand; Google
plans to extend it to all apps on certified phones in 2027, after which an unregistered Bento
installs only through Android's advanced install flow or `adb`.

## Setting up a phone

1. Install the APK from the latest `android-v*` release (allow installs from your browser
   or file manager once).
2. On the Mac: Bento Settings → Notes → **Pair Android Phone…**, then in Bento on the phone
   **Scan pairing code** (Voice tab or Settings). The code carries the server, the sync
   token and, if you tick it, the Gemini API key.
3. Voice tab → follow the checklist: microphone, **Accessibility → Bento dictation** (for
   the bubble and the held Volume Down), and **Allow background activity** (ColorOS
   otherwise stops live sync and the accessibility service). Android 13+ greys out the
   accessibility switch for an APK opened from a browser or file manager ("restricted
   settings"; signing doesn't matter). Tap the greyed entry once and close the notice ("App
   was denied access" on 15+, "Restricted setting" before), then App info → ⋮ → **Allow
   restricted settings**, then turn the switch on. The checklist detects each step and walks
   through it. Updates through Bento keep it (its session install doesn't add the
   restriction, nor does `adb install`); on Android 13/14, opening a newer APK from a file
   manager brings the restriction back.
4. Optional: add the widgets, the **Capture thought** Quick Settings tile, the Bento
   keyboard, or turn on **Separate icons** and point the Snap Key at **Bento Dictate**.

## Hermes

The Assistant tab talks to Hermes's API server (the gateway's `api_server` platform), the
same one Open WebUI-style clients use: each conversation is a Hermes session, a message is
`POST /api/sessions/{id}/chat/stream`, and Stop closes the stream (Hermes interrupts the
agent) and calls `POST /v1/runs/{run}/stop`. Serve it only on your tailnet: bind
`API_SERVER_HOST` to the machine's Tailscale address, or to loopback behind
`tailscale serve`, never a public interface or tunnel. The phone needs the address and
`API_SERVER_KEY`, kept in the Keystore-backed store. The key rides on every request, so
plain http is accepted only for tailnet, LAN and loopback addresses; anything else must be
https. Enter them under Settings → Hermes, or scan a code made on Hermes's machine (Settings
→ Hermes → Scan Hermes code). Prefer scanning to opening the link: an opened link passes
through Android's activity manager, which can log it, key included.

```sh
scripts/hermes-phone-link    # on the Hermes machine: a QR code (with qrencode) or the link
```

Voice calls run on Gemini Live (`gemini-3.8-live`) over the Gemini API with the paired key,
with the Mac's call setup (`helper/gemini_live_setup.json`, phone wording) and its one
tool, `ask_hermes`: when the model calls it, Bento sends Hermes the user's own transcribed
words for that turn, shows Hermes's reply in the chat and returns it for Gemini to speak.
Gemini Live transcribes the user only once they stop speaking, so the audio it hears also
goes to `gemini-3.5-transcribe-live`, whose running guess shows in a faint bubble while
they talk. Gemini Live's transcript replaces the bubble and is the only one Hermes gets.
A call continues the conversation on screen (Gemini gets a recap, `helper/live_resume.json`),
runs in a microphone foreground service, uses the voice-call microphone with echo
cancellation and plays through a headset or the loudspeaker. Open mic or tap to talk is a
setting; speaking over Gemini interrupts it, Stop (in the call bar while Hermes works)
stops Hermes's request and the call goes on, End call (also in the notification) stops
everything, and so does a phone call. Hermes's approval prompts offer Allow once, Allow for
this request (Hermes scopes a streamed turn's approvals to its run) and Deny.
