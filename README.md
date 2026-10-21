# Bento

One small native macOS menu-bar app instead of six: screenshots and annotation
(Shottr), window management with snapping and modifier-drag (Rectangle Pro),
app hotkeys (Raycast), optional auto-tiling (AeroSpace-lite), clipboard history
with images, and Raycast-style floating notes synced through a tiny Rust server.

Swift + AppKit/SwiftUI, no third-party dependencies, macOS 14+. Idles at
~0 % CPU with a ~16 MB footprint; the bundle is 6.5 MB.

## What's in it

| Module | Replaces | Highlights | Default keys |
|---|---|---|---|
| Capture + Editor | Shottr | frozen-screen area capture with loupe, window/fullscreen/repeat/delayed, scrolling capture, OCR + QR, colour picker, ruler, pins; editor with editable annotations (arrow, text, shapes, blur/pixelate, smart erase, counter, spotlight, crop, ruler…), **Esc copies and closes**, ⌘S save, drag out, history with re-editing | ⌘⇧2 area, ⌘⇧1 fullscreen, ⌃⌥⌘O copy text |
| Windows | Rectangle Pro | every Rectangle action with cycling, gaps, snap areas, **⌘⌥-drag move / ⌘⌥⇧-drag resize**, displays, Spaces, layouts, launch positions, stash; imports your Rectangle (Pro) settings on first run | Rectangle's ⌃⌥ set (or your imported keys) |
| Tiling (off by default) | AeroSpace | auto-tiling manager you toggle on/off: tiles/master-stack/columns/rows/monocle, gaps, float rules, mouse swap/resize | ⌃⌥⌘T toggle, ⌃⌥⌘ H/J/K/L focus, ⌃⌥⌘⇧ H/J/K/L move |
| App Hotkeys | Raycast hotkeys | shortcut per app (toggle/focus/cycle windows), URL, file or shell command | your own |
| Clipboard | Raycast/Alfred | text, rich text, images, files, links, colours; 30-day history, search incl. OCR of images, pins, paste/plain paste/⌘1–9 | ⌘⇧V |
| Notes | Raycast Notes | floating markdown notes, Raycast's shortcuts and look, browse/actions, live sync via `bento-sync` | ⌃⌥N |

## Build and install

```sh
scripts/build.sh                 # release build -> dist/Bento.app (signed)
scripts/build.sh --install       # + install to /Applications and relaunch
scripts/build.sh --install-gskm4 # + install on gskm4 (/opt/homebrew/opt/Bento.app, ~/Applications link)
```

Builds are signed with the same persistent self-signed identity as Jot
(**Jot Local Development**). The private key only exists in gskm4's login
keychain, so the script signs over SSH on gskm4 when the identity isn't in a
local keychain. The designated requirement pins `com.charles.bento` plus the
certificate's leaf hash, so Accessibility and Screen Recording grants survive
rebuilds. `--adhoc` signs ad hoc instead (grants then reset on every build).

On first launch, grant **Accessibility** (window management, modifier-drag,
pasting) and **Screen Recording** (screenshots) from Settings → General.

## Configuration

Everything lives in `~/.config/bento/config.json`, one section per module plus
`shortcuts` (action id → shortcut). The settings window edits the same file and
external edits apply live. Shortcut syntax: `ctrl+opt+cmd+left`, `cmd+shift+2`,
`hyper+t` (⌃⌥⌘⇧), `meh+n` (⌃⌥⇧); `""` unbinds.

Any action can be triggered from scripts, Karabiner, etc.:

```sh
open "bento://action/shot.area"
open "bento://action/windows.left-half"
open "bento://settings"
```

Data (clipboard history, captures, notes DB) is in
`~/Library/Application Support/Bento/`. The notes sync token is in
`~/.config/bento/sync-token`.

## Development

```sh
swift build                                   # everything
swift build --scratch-path .build-x --product DevClipboard && .build-x/debug/DevClipboard
scripts/test ClipboardTests                   # Swift Testing (Command Line Tools-only wrapper)
scripts/perform clipboard.show                # trigger an action in a running dev harness
```

Each module has a `Dev<Module>` harness that runs only that module, with config
and data isolated under `/tmp/bento-dev/<module>`. Layout and conventions:
`docs/SPEC.md`. Notes sync protocol: `docs/SYNC_PROTOCOL.md`. Server:
`server/README.md`.
