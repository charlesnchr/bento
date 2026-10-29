# Bento

One small native macOS menu-bar app instead of eight: screenshots and annotation
(Shottr), window management with snapping and modifier-drag (Rectangle Pro),
app hotkeys (Raycast), optional auto-tiling (AeroSpace-lite), clipboard history
with images, Raycast-style floating notes and a Todoist-style todo list, both
synced in real time through a tiny Rust server, manually arranged menu bar
sections that Bento shows and hides, and dictation with meeting notes and a
voice assistant (Jot, Wispr Flow). A companion [Android app](#android) carries the
notes, todos, dictation and meeting notes to your phone.

Swift + AppKit/SwiftUI, macOS 14+. The only third-party code is in the voice
modules: MarkdownUI, FluidAudio (on-device Parakeet) and a vendored SwiftMath.
Idles at ~0 % CPU.

## What's in it

| Module | Replaces | Highlights | Default keys |
|---|---|---|---|
| Capture + Editor | Shottr | frozen-screen area capture with loupe, window/fullscreen/repeat/delayed, scrolling capture, OCR + QR, colour picker, ruler, pins; editor with editable annotations (arrow, text, shapes, blur/pixelate, smart erase, counter, spotlight, crop, ruler…), **Esc copies and closes**, ⌘S save, drag out, history with re-editing | ⌘⇧2 area, ⌘⇧1 fullscreen, ⌃⌥⌘O copy text |
| Windows | Rectangle Pro | every Rectangle action with cycling, gaps, snap areas, **⌘⌥-drag move / ⌘⌥⇧-drag resize**, displays, Spaces, layouts, launch positions, stash; imports your Rectangle (Pro) settings on first run | Rectangle's ⌃⌥ set (or your imported keys) |
| Tiling (off by default) | AeroSpace | auto-tiling manager you toggle on/off: tiles/master-stack/columns/rows/monocle, gaps, float rules, mouse swap/resize | ⌃⌥⌘T toggle, ⌃⌥⌘ H/J/K/L focus, ⌃⌥⌘⇧ H/J/K/L move |
| App Hotkeys | Raycast hotkeys | shortcut per app (toggle/focus/cycle windows), URL, file or shell command; pick apps from a grid of running apps or type to search installed ones, then type the shortcut | your own |
| Clipboard | Raycast/Alfred | text, rich text, images, files, links, colours; 30-day history, search incl. OCR of images, pins, paste/plain paste/⌘1–9 | ⌘⇧V |
| Notes | Raycast Notes | floating markdown notes, Raycast's shortcuts and look, browse/actions, collapsible headings, live sync via `bento-sync` that merges edits made on two Macs at once (the caret and scroll position stay put) | ⌃⌥N |
| Todo | Todoist | Inbox/Today/Upcoming, projects, labels, p1–p4, natural-language dates, quick-add syntax (`#project @label p1 tomorrow 5pm`), Todoist's single-key bindings (Q A E T Y L V X, G-chords, ⌘K, ?), undo, field-level merging live sync via `bento-sync` | ⌃⌘T window, ⌃⌥Space Quick Add |
| Menu Bar (off by default) | — | Visible, Hidden and Always Hidden sections; native manual Command-drag arrangement; chevron, shortcuts and optional hover/click/scroll reveal; automatic hiding; search and Bento Bar with Accessibility opening in place; per-item shortcuts and icon-change alerts; spacing and appearance | ⌃⌥⌘M show/hide, ⌃⌥⌘S search |
| Dictation (off by default) | Jot, Wispr Flow | hold or tap a key and talk, the text lands where the cursor is; Gemini Transcribe (batch or live), Parakeet on the Mac, GPT Transcribe, MAI-Transcribe-2 or two at once with a review pass; cleanup model, tone matching, custom instructions and a dictionary that sync with your other Macs and the Android app; crash-safe recordings, offline queue, retry with another model, searchable history; optional floating composer; voice editing of what you just dictated; Capture Thought to Note appends what you say to a chosen note as a timestamped, collapsible entry | fn, right ⌘/⌥/⌃ or ⌥F17 (hold or tap), ⌃⌥⇧R retry |
| Meetings (off by default) | Granola | records the mic plus system audio beside dictation; live transcript, tidied as it goes, gaps backfilled from the recording, summary with decisions and action items; a small capsule while recording; notes in Markdown | ⇧⌥F17 record/stop |
| Assistant (off by default) | — | chat window for Hermes over ACP: Markdown, equations, images, tool steps, plan, attachments, `/` commands and `@` context, queue and steer, edit/regenerate/branch, history; keep on top like picture in picture, over full-screen apps and on every Space; continuous voice calls through Azure GPT-Live or Gemini 3.8 Live with Hermes doing the work, resumed where they left off until New Chat | ⇧⌥F18 window, ⌥F18 call (voice editing and requests with calls off), ⌃⌥F18 dictate a request (hold or tap) |

**Keyboard Shortcuts (⌥/)**, also in the menu bar menu, lists every action by
module with its current shortcut. Type to filter by name, module or key (“left”
finds Left Half, “⌘⇧” every ⌘⇧ shortcut). ↩ runs the selected action in the app
you were in, ⌘, opens Settings, and each module has a link to its own settings.
⌘E changes the selected action's shortcut right in the list: type the new
combination, Esc to cancel, ⌫ to remove it. As in Settings, a combination
another action already has moves to this one. The search also finds installed
apps without a hotkey (with their icons): ⌘E adds the app to App Hotkeys and
records its shortcut the same way, and ⌘⌫ removes an app hotkey again. The
header shows whether Accessibility and Screen Recording are granted. A hint
points to it once after launch. ⌥/ types “÷” on a US layout, and on Danish, Nordic
and German layouts the same key is ⌥- (an en dash); if you need either
character, give the list another shortcut (earlier versions used ⌃⌥/, and a
shortcut you chose yourself is kept).

## Menu bar arrangement

In Settings → Menu Bar, choose **Arrange in Menu Bar**, then hold **⌘** and drag
items directly in the macOS menu bar. The solid separator bounds Hidden on its
left; the dashed separator bounds Always Hidden on its left. Keep the dashed
separator left of the solid one: items between them are Hidden, and items right
of the solid separator are Visible. **Done** (or leaving the Settings page)
reapplies the previous visibility and refreshes the item list. macOS remembers
positions; Bento never controls the pointer, posts clicks, or reorders items.

On crowded or notched displays, revealing a section may still leave items out
of view. Search and Bento Bar can list them, but cannot create more menu bar
space or relocate an item for a click. Opening uses a validated Accessibility
press after revealing the item in place; if unavailable, click or reposition
it manually, making space first if needed. Right-click the native item itself
for its context menu. Legacy saved layouts, profiles and `keepItemsInPlace`
remain readable for compatibility and have no effect on item positions.

## Install

```sh
brew install charlesnchr/tap/bento
open /opt/homebrew/opt/bento/Bento.app
```

Apple Silicon, macOS 14+. The app lives in the Homebrew prefix
(`/opt/homebrew/opt/bento/Bento.app`), so installing needs no admin rights and
works on managed Macs that allow apps from `/opt/homebrew`. On first launch
Bento adds a Finder alias at `~/Applications/Bento.app`. Spotlight may index
that alias as a file without offering Bento in application results, because
the app itself is inside the hidden `/opt` directory. Open the path above, or
run `open 'bento://settings'` after the first launch, to reach Settings. Then
grant **Accessibility** and **Screen Recording** from Settings → General: each
**Grant…** brings up the macOS prompt, whose **Open System Settings** button
lists Bento ready to switch on. Press **⌥/** any time for the list of
shortcuts.

Opening Bento normally shows Settings. For a quiet scripted launch, use
`open -g /opt/homebrew/opt/bento/Bento.app --args --background`. Launch at login
and the updater restart quietly.

Bento checks for a new release once a day. When there is one, **Install Bento
x.y.z and Restart** appears in its menu bar menu and under Settings → General →
Updates; it runs `brew upgrade` and restarts into the new version.
`brew upgrade` in a terminal works too: Bento then offers a restart, and the
next launch replaces the old instance anyway. Releases are all signed with the
same (self-signed) certificate, so the permission grants carry over. They aren't
notarized, but Homebrew doesn't quarantine formula downloads, so Gatekeeper
doesn't get in the way.

## Android

Bento for Android (`android/`, Android 12+) brings Notes, Todo, dictation and meeting
notes to the phone, synced live with your Macs through the same `bento-sync` server:

- **Notes**: the list (pinned first, fuzzy search, grid or list), a Markdown editor with
  the Mac's list continuation and checkbox toggling, and merges like the Mac's: edits made
  on the phone and a Mac at once both survive, and an open note takes remote text without
  moving the caret. Recently Deleted keeps notes 60 days.
- **Todo**: Inbox, Today, Upcoming, projects and labels; quick add with the same syntax
  (`Buy milk tomorrow 5pm #Errands @shop p1`, tokens highlighted as you type); swipe right
  to complete, left to reschedule; field-level merging like the Mac.
- **Widgets**: notes (like Google Keep's), one note with tappable checklists, tasks (like
  Todoist's, for any list or project) and a capture button.
- **Dictation** through your Gemini API key, as on the Mac (live transcript, cleanup, your
  synced dictionary and instructions, voice edits): a bubble beside the keyboard in any app,
  **hold Volume Down** over a text field (a short press still changes the volume), the
  voice-first **Bento keyboard**, a **Capture thought** Quick Settings tile (also on the
  lock screen), and separate launcher icons for hardware shortcut keys such as the Find X9
  Pro's Snap Key. Modes add their own instructions and switch while you talk.
- **Meetings** from the microphone (Android doesn't let apps record other apps' calls):
  live transcript, then a note with summary, decisions, action items and the transcript.
- **Hermes** (the Assistant tab): chat with your Hermes agent through its API server on your
  tailnet (Markdown, streaming, tool steps, approvals, a conversation history kept by
  Hermes), or call it: Gemini Live listens and talks through your Gemini API key and hands
  each request to Hermes in the same conversation. Set up under Settings → Hermes or with a
  `bento://hermes` code (`android/README.md`).

Install the APK from the latest `android-v*` [release](https://github.com/charlesnchr/bento/releases)
(allow installs from your browser once); the app checks for updates daily and installs them
from Settings → Updates. Then on the Mac choose **Pair Android Phone…** and scan the code
in Bento's Voice tab or Settings. The Voice tab's checklist walks through the microphone,
**Accessibility → Bento dictation** (for the bubble and the volume key; Android greys the
switch out for APKs opened from a browser or file manager until App info → ⋮ → **Allow
restricted settings**, and the checklist walks through it) and **Allow background activity**, which ColorOS and other
battery-strict Android versions need for live sync. Building and releasing:
`android/README.md`.

## Build from source

```sh
scripts/build.sh            # release build -> dist/Bento.app (signed)
scripts/build.sh --install  # + install and relaunch (see below)
```

`--install` replaces the Homebrew install in place when bento is installed with
brew (until the next `brew upgrade`), so each Mac has one Bento location;
otherwise it installs to `/Applications`, or `$BENTO_INSTALL_DIR` if set. It
removes the `dist` copy afterwards so Spotlight only finds the installed app.
Installed anywhere but `/Applications` or `~/Applications`, the app keeps the
`~/Applications/Bento.app` alias pointing at itself.

To keep Accessibility and Screen Recording grants across rebuilds, sign with a
persistent code-signing identity: set `BENTO_SIGN_IDENTITY` to its SHA-1 or
exact name (it needn't be trusted), either in the environment or in an untracked
`scripts/config.local.sh` (see `scripts/config.sh`). The designated requirement
then pins `com.charles.bento` plus the certificate's leaf hash. Grants are per
Mac, so each machine can use its own identity. Without an identity, or with
`--adhoc`, builds are signed ad hoc and grants reset on every build.

On first launch, grant **Accessibility** (window management, modifier-drag,
pasting, the dictation key, opening menu bar items through search/shortcuts) and **Screen Recording** (screenshots, menu bar
item names and images) from Settings → General. Dictation asks for the
**Microphone** the first time you use it, and meetings ask once for **System
Audio Recording** when they include what the Mac plays.

Dictation works out of the box with Parakeet v3, which runs on the Mac: with no
Gemini API key and no helper, it's the default, and Settings → Dictation, the
Dictation menu and your first dictation offer its one-time download (about
480 MB, into FluidAudio's cache in `~/Library/Application Support/FluidAudio/Models`).
Without a key nothing formats the text, so Parakeet's words go in as heard. Add
a Gemini API key (Settings → Dictation → Advanced) for Gemini Transcribe and the
cleanup model; Parakeet v3 and Ultra stay selectable beside it. Adding a key
switches the fallback back to Gemini unless you downloaded or picked Parakeet.
The key also carries Gemini 3.8 Live voice calls in the assistant. The other
transcription models, meeting notes through Vertex AI and Gemini Live calls on
Vertex go through a small local helper you run yourself: see `helper/README.md`.
Gemini Live always uses dictation's Google connection, the key or the helper,
never both; Azure GPT-Live is the alternative either way.

## Configuration

Everything lives in `~/.config/bento/config.json`, one section per module plus
`shortcuts` (action id → shortcut). The settings window edits the same file and
external edits apply live. Shortcut syntax: `ctrl+opt+cmd+left`, `cmd+shift+2`,
`hyper+t` (⌃⌥⌘⇧), `meh+n` (⌃⌥⇧); `""` unbinds. Key names follow the US layout
and mean a key's position: on a German or Nordic keyboard `opt+slash` is ⌥ plus
the key left of the right Shift (`-`), and the keyboard overview says so.

**Themes.** Settings → General → Appearance switches Bento's windows (Settings,
Keyboard Shortcuts, Clipboard, Todo, Notes, menu bar search, Capture History)
between:

- **Standard**: the native look.
- **Glass**: frosted glass that lets the desktop show through.
- **Tinted**: Glass washed with your accent colour.
- **Graphite**: near-black and high-contrast, dark even in light mode.
- **Paper**: warm off-white, light even in dark mode.

It's `general.theme` in the config (`"standard"`, `"glass"`, `"tinted"`,
`"graphite"`, `"paper"`). Configs that still say `"aero"`, from before Aero was
removed, get Tinted. With Reduce Transparency on, Glass and Tinted look like
Standard; Increase Contrast frosts them more.

Any action can be triggered from scripts, Karabiner, etc.:

```sh
open "bento://action/shot.area"
open "bento://action/windows.left-half"
open "bento://settings"
open "bento://settings/shortcuts/Left%20Half"    # the Shortcuts page, filtered
open "bento://action/bento.keyboard-overview"
```

Data (clipboard history, captures, notes and todo DBs, dictation recordings,
history and meetings under `Voice/`) is in `~/Library/Application Support/Bento/`. Sync is optional and off by default: it needs your own
`bento-sync` server (`server/README.md`), set under Settings → Notes and Todo, and its token in
`~/.config/bento/sync-token` (shared by Notes and Todo).

With Notes sync on, dictation's dictionary, custom instructions and the cleanup pass
switch sync too, with your other Macs and the Android app, while Dictation, Meetings or the
Assistant is on. Settings → Dictation → Sync dictionary and instructions turns it off, and
shows how it's going. The first sync merges what each Mac already had (entries by id,
settings one by one); if two devices added the same word, it shows up once.

**Pair Android Phone…** under Settings → Notes or Todo → Sync shows a QR code for the Bento
Android app: it carries the server, the token and the Mac's name, and the Gemini API key if
you tick Include Gemini API key. The code stays hidden until you click Show Code, since
anyone who scans it can read and edit your notes and tasks. Copy Link copies the same
`bento://pair` link instead (clipboard managers that honour concealed items, Bento's
included, don't record it).

## Development

```sh
swift build                                   # everything
swift build --scratch-path .build-x --product DevClipboard && .build-x/debug/DevClipboard
scripts/test ClipboardTests                   # Swift Testing (Command Line Tools-only wrapper)
scripts/perform clipboard.show                # trigger an action in a running dev harness
scripts/voice-dev assistant.send "Hello"      # drive DevVoice's assistant, print its state
```

Each module has a `Dev<Module>` harness that runs only that module, with config
and data isolated under `/tmp/bento-dev/<module>`. Layout and conventions:
`docs/SPEC.md`. Sync protocol (notes, todos, the dictation dictionary): `docs/SYNC_PROTOCOL.md`. Server:
`server/README.md`.

## Releasing

```sh
scripts/release.sh 0.2.0            # from a clean main that matches origin
scripts/release.sh 0.2.0 --dry-run  # build, sign and render the formula into dist/ only
```

It builds and signs `Bento.app` with `BENTO_SIGN_IDENTITY` (required: every
release must be signed with the same certificate, or updates would lose the
permission grants), tags `v0.2.0`, uploads `Bento-0.2.0.zip` to a GitHub
release, and publishes `packaging/bento.rb`, with the version and checksum
filled in, as `Formula/bento.rb` in
[charlesnchr/homebrew-tap](https://github.com/charlesnchr/homebrew-tap).
Installed copies find it with their next daily check.

The Android app has its own releases, tagged `android-vX.Y.Z` and marked not-latest so the
Mac's stay on top: `scripts/release-android.sh 0.1.0` (see `android/README.md`).
