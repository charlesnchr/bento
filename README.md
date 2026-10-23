# Bento

One small native macOS menu-bar app instead of six: screenshots and annotation
(Shottr), window management with snapping and modifier-drag (Rectangle Pro),
app hotkeys (Raycast), optional auto-tiling (AeroSpace-lite), clipboard history
with images, Raycast-style floating notes and a Todoist-style todo list, both
synced in real time through a tiny Rust server.

Swift + AppKit/SwiftUI, no third-party dependencies, macOS 14+. Idles at
~0 % CPU with a ~16 MB footprint; the bundle is 6.5 MB.

## What's in it

| Module | Replaces | Highlights | Default keys |
|---|---|---|---|
| Capture + Editor | Shottr | frozen-screen area capture with loupe, window/fullscreen/repeat/delayed, scrolling capture, OCR + QR, colour picker, ruler, pins; editor with editable annotations (arrow, text, shapes, blur/pixelate, smart erase, counter, spotlight, crop, ruler…), **Esc copies and closes**, ⌘S save, drag out, history with re-editing | ⌘⇧2 area, ⌘⇧1 fullscreen, ⌃⌥⌘O copy text |
| Windows | Rectangle Pro | every Rectangle action with cycling, gaps, snap areas, **⌘⌥-drag move / ⌘⌥⇧-drag resize**, displays, Spaces, layouts, launch positions, stash; imports your Rectangle (Pro) settings on first run | Rectangle's ⌃⌥ set (or your imported keys) |
| Tiling (off by default) | AeroSpace | auto-tiling manager you toggle on/off: tiles/master-stack/columns/rows/monocle, gaps, float rules, mouse swap/resize | ⌃⌥⌘T toggle, ⌃⌥⌘ H/J/K/L focus, ⌃⌥⌘⇧ H/J/K/L move |
| App Hotkeys | Raycast hotkeys | shortcut per app (toggle/focus/cycle windows), URL, file or shell command; pick apps from a grid of running apps or type to search installed ones, then type the shortcut | your own |
| Clipboard | Raycast/Alfred | text, rich text, images, files, links, colours; 30-day history, search incl. OCR of images, pins, paste/plain paste/⌘1–9 | ⌘⇧V |
| Notes | Raycast Notes | floating markdown notes, Raycast's shortcuts and look, browse/actions, live sync via `bento-sync` | ⌃⌥N |
| Todo | Todoist | Inbox/Today/Upcoming, projects, labels, p1–p4, natural-language dates, quick-add syntax (`#project @label p1 tomorrow 5pm`), Todoist's single-key bindings (Q A E T Y L V X, G-chords, ⌘K, ?), undo, field-level merging live sync via `bento-sync` | ⌃⌘T window, ⌃⌥Space Quick Add |

**Keyboard Shortcuts (⌃⌥/)**, also in the menu bar menu, lists every action by
module with its current shortcut. Type to filter by name, module or key (“left”
finds Left Half, “⌘⇧” every ⌘⇧ shortcut). ↩ runs the selected action in the app
you were in, ⌘E changes its shortcut in Settings, ⌘, opens Settings, and each
module has a link to its own settings. The header shows whether Accessibility and
Screen Recording are granted. A hint points to it once after launch.

## Install

```sh
brew install charlesnchr/tap/bento
open /opt/homebrew/opt/bento/Bento.app
```

Apple Silicon, macOS 14+. The app lives in the Homebrew prefix
(`/opt/homebrew/opt/bento/Bento.app`), so installing needs no admin rights and
works on managed Macs that only run apps from `/opt/homebrew`. Spotlight doesn't
look inside `/opt`, so on first launch Bento adds a Finder alias to itself at
`~/Applications/Bento.app`; Spotlight, Raycast and Finder find it there. Then
grant **Accessibility** and **Screen Recording** from Settings → General: each
**Grant…** brings up the macOS prompt, whose **Open System Settings** button
lists Bento ready to switch on. Press **⌃⌥/** any time for the list of
shortcuts.

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
pasting) and **Screen Recording** (screenshots) from Settings → General.

## Configuration

Everything lives in `~/.config/bento/config.json`, one section per module plus
`shortcuts` (action id → shortcut). The settings window edits the same file and
external edits apply live. Shortcut syntax: `ctrl+opt+cmd+left`, `cmd+shift+2`,
`hyper+t` (⌃⌥⌘⇧), `meh+n` (⌃⌥⇧); `""` unbinds. Key names follow the US layout
and mean a key's position: on a German or Nordic keyboard `ctrl+opt+slash` is ⌃⌥
plus the key left of the right Shift (`-`), and the keyboard overview says so.

Any action can be triggered from scripts, Karabiner, etc.:

```sh
open "bento://action/shot.area"
open "bento://action/windows.left-half"
open "bento://settings"
open "bento://settings/shortcuts/Left%20Half"    # the Shortcuts page, filtered
open "bento://action/bento.keyboard-overview"
```

Data (clipboard history, captures, notes and todo DBs) is in
`~/Library/Application Support/Bento/`. Sync is optional and off by default: it needs your own
`bento-sync` server (`server/README.md`), set under Settings → Notes and Todo, and its token in
`~/.config/bento/sync-token` (shared by Notes and Todo).

## Development

```sh
swift build                                   # everything
swift build --scratch-path .build-x --product DevClipboard && .build-x/debug/DevClipboard
scripts/test ClipboardTests                   # Swift Testing (Command Line Tools-only wrapper)
scripts/perform clipboard.show                # trigger an action in a running dev harness
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
