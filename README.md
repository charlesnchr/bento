# Bento

One small native macOS menu-bar app instead of eight: screenshots and annotation
(Shottr), window management with snapping and modifier-drag (Rectangle Pro),
app hotkeys (Raycast), optional auto-tiling (AeroSpace-lite), clipboard history
with images, Raycast-style floating notes and a Todoist-style todo list, both
synced in real time through a tiny Rust server, manually arranged menu bar
sections that Bento shows and hides, and dictation with meeting notes and a
voice assistant (Jot, Wispr Flow).

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
| Notes | Raycast Notes | floating markdown notes, Raycast's shortcuts and look, browse/actions, collapsible `::: details` entries, live sync via `bento-sync` | ⌃⌥N |
| Todo | Todoist | Inbox/Today/Upcoming, projects, labels, p1–p4, natural-language dates, quick-add syntax (`#project @label p1 tomorrow 5pm`), Todoist's single-key bindings (Q A E T Y L V X, G-chords, ⌘K, ?), undo, field-level merging live sync via `bento-sync` | ⌃⌘T window, ⌃⌥Space Quick Add |
| Menu Bar (off by default) | — | Visible, Hidden and Always Hidden sections; native manual Command-drag arrangement; chevron, shortcuts and optional hover/click/scroll reveal; automatic hiding; search and Bento Bar with Accessibility opening in place; per-item shortcuts and icon-change alerts; spacing and appearance | ⌃⌥⌘M show/hide, ⌃⌥⌘S search |
| Dictation (off by default) | Jot, Wispr Flow | hold or tap a key and talk, the text lands where the cursor is; Gemini Transcribe (batch or live), Parakeet on the Mac, GPT Transcribe, MAI-Transcribe-2 or two at once with a review pass; cleanup model, tone matching, custom instructions, dictionary; crash-safe recordings, offline queue, retry with another model, searchable history; optional floating composer; voice editing of what you just dictated; Capture Thought to Note appends what you say to a chosen note as a timestamped, collapsible entry | fn, right ⌘/⌥/⌃ or ⌥F17 (hold or tap), ⌃⌥⇧R retry |
| Meetings (off by default) | Granola | records the mic plus system audio beside dictation; live transcript, tidied as it goes, gaps backfilled from the recording, summary with decisions and action items; a small capsule while recording; notes in Markdown | ⇧⌥F17 record/stop |
| Assistant (off by default) | — | chat window for Hermes over ACP: Markdown, equations, images, tool steps, plan, attachments, `/` commands and `@` context, queue and steer, edit/regenerate/branch, history; continuous voice calls through Azure GPT-Live or Gemini 3.8 Live with Hermes doing the work | ⇧⌥F18 window, ⌥F18 talk |

**Keyboard Shortcuts (⌃⌥/)**, also in the menu bar menu, lists every action by
module with its current shortcut. Type to filter by name, module or key (“left”
finds Left Half, “⌘⇧” every ⌘⇧ shortcut). ↩ runs the selected action in the app
you were in, ⌘E changes its shortcut in Settings, ⌘, opens Settings, and each
module has a link to its own settings. The search also finds installed apps
without a hotkey (with their icons): ⌘E adds the app to App Hotkeys and records
its shortcut straight away, and ⌘⌫ removes an app hotkey again. The header shows
whether Accessibility and Screen Recording are granted. A hint points to it once
after launch.

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
lists Bento ready to switch on. Press **⌃⌥/** any time for the list of
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
The other transcription models, meeting notes through Vertex AI and Gemini Live
calls go through a small local helper you run yourself: see `helper/README.md`.

## Configuration

Everything lives in `~/.config/bento/config.json`, one section per module plus
`shortcuts` (action id → shortcut). The settings window edits the same file and
external edits apply live. Shortcut syntax: `ctrl+opt+cmd+left`, `cmd+shift+2`,
`hyper+t` (⌃⌥⌘⇧), `meh+n` (⌃⌥⇧); `""` unbinds. Key names follow the US layout
and mean a key's position: on a German or Nordic keyboard `ctrl+opt+slash` is ⌃⌥
plus the key left of the right Shift (`-`), and the keyboard overview says so.

**Themes.** Settings → General → Appearance switches Bento's windows (Settings,
Keyboard Shortcuts, Clipboard, Todo, Notes, menu bar search, Capture History)
between **Standard**, the native look, **Glass**, frosted glass that lets the
desktop show through, and **Aero**, glass tinted with your accent colour and a
gloss across the top, after Windows Vista. It's `general.theme` in the config
(`"standard"`, `"glass"`, `"aero"`). With Reduce Transparency on, every theme
looks like Standard; Increase Contrast frosts the glass more.

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
`docs/SPEC.md`. Sync protocol (notes and todos): `docs/SYNC_PROTOCOL.md`. Server:
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
