# Bento

One small native macOS menu-bar app instead of six: screenshots and annotation
(Shottr), window management with snapping and modifier-drag (Rectangle Pro),
app hotkeys (Raycast), optional auto-tiling (AeroSpace-lite), clipboard history
with images, and Raycast-style floating notes synced through a tiny Rust server.

Swift + AppKit/SwiftUI, no third-party dependencies, macOS 14+.

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
