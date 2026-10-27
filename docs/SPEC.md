# Bento — spec and conventions

Bento is one native macOS menu-bar app (Swift, AppKit + SwiftUI) that replaces Shottr,
Rectangle Pro, Raycast app hotkeys, a tiling window manager (AeroSpace-lite), a clipboard
manager, Raycast Notes, Todoist and Jot (dictation, meeting notes, a Hermes assistant). It also
shows and hides manually arranged menu bar sections. Third-party code is confined to the voice
targets (MarkdownUI, FluidAudio, vendored SwiftMath); no other module may add a dependency.

Priorities, in order: **correct, low resource use, neat**. It runs all day:
idle CPU must be ~0 %, memory small, nothing polls when an event or notification
exists, windows are created lazily and released when closed.

Target: macOS 14+ (runs on macOS 15.8 work Mac and macOS 26 personal Mac),
Apple Silicon. Swift 5 language mode (tools 5.10). Build with SwiftPM only;
there is no Xcode project and no asset catalog.

## Layout

```
Package.swift
Sources/BentoCore     shared foundation (do not edit from module work; see below)
Sources/BentoShell    app delegate, menu bar, settings window, keyboard overview, updater, BentoApp.run(modules:)
Sources/Bento         main.swift for the real app (all modules)
Sources/<Module>      one target per feature area
Dev/Dev<Module>       single-module dev harness executables
Tests/<Module>Tests   swift-testing tests per target (`import Testing`, `@Test`, `#expect`)
server/               bento-sync (Rust) for notes and todo sync
helper/               Python helpers for the voice modules (voice helper, GPT-Live, Hermes ACP)
Vendor/SwiftMath      vendored LaTeX renderer (MIT) for the assistant
Resources/Voice       sounds, fonts and math fonts for the voice modules
scripts/build.sh      release build -> dist/Bento.app, signed (see script header)
scripts/voice-helper.sh  install/update the voice helper as a launchd agent
scripts/release.sh    GitHub release + Homebrew formula (charlesnchr/homebrew-tap)
packaging/bento.rb    the formula template release.sh fills in
docs/                 this file, SYNC_PROTOCOL.md
```

Modules: `Shot` (capture), `ShotEditor` (annotation editor, history, pin),
`Windows` (Rectangle Pro), `Tiling`, `Launcher` (app hotkeys), `Clipboard`, `Notes`, `Todo`,
`MenuBar` (manually arranged hidden menu bar sections).

Voice: `VoiceCore` (UI-free: audio capture, transcription clients, formatting, insertion,
hotkey engine, history index, settings, meetings) and `Voice` (the Dictation, Meetings and
Assistant modules, which share one engine, `VoiceApp`, and so live in one target; pill HUD,
composer, meeting capsule and notes, assistant window, settings panes). Ported from Jot
(Apache 2.0, see THIRD_PARTY_NOTICES.md); Jot's tests live in `Tests/VoiceCoreTests`.
`helper/` holds the Python pieces: the loopback voice helper (Vertex/Azure/OpenRouter/gateway),
the Azure GPT-Live transport and the Hermes ACP launcher (`helper/README.md`). build.sh copies
`Resources/Voice` and `helper/` into `Contents/Resources/Voice`; Swift finds them through
`VoiceResources` (not `Bundle.module`, which looks only in the bundle root and the build
machine's `.build`). Voice settings live in UserDefaults and are mirrored both ways into the
`dictation` section of config.json (`SettingsSync`); data is under
`~/Library/Application Support/Bento/Voice`; the helper runtime is
`~/.config/bento/voice-runtime.json`.

## BentoCore API (read the sources, they are short)

- `BentoModule` protocol + `BentoAction` (Module.swift). A module returns its actions;
  the registry binds them to global hotkeys, the menu, and `bento://action/<id>` URLs.
  Call `ActionRegistry.shared.reload()` when your dynamic action list changes.
- `Shortcut` — parse/format `"ctrl+opt+left"`, `"hyper+t"`, `displayString` (`⌃⌥←`), `matches(NSEvent)`.
- `HotkeyCenter` — Carbon global hotkeys (`register(_:onRelease:onPress:)`). Use it directly
  only for hotkeys that exist temporarily (e.g. while a panel is open); permanent ones should be actions.
- `ShortcutRecorder` — SwiftUI recorder (`ShortcutRecorder(shortcut: $binding)` or `(actionID:)`).
- `ConfigStore` / `ConfigSection<T>` — the JSON config. Each module owns a `Codable, Equatable`
  settings struct with defaults for every field, stored under its module id. Call
  `ConfigStore.shared.materialize(id, default:)` in `start()` so every option shows up in the file.
  Use `ConfigSection` in SwiftUI; `ConfigStore.shared.observe(id) { … }` for live reload.
- `AXWindow` — AX window wrapper (focused, at point, windows(of:), frame get/set, focus, windowID…).
  **AX coordinates** = top-left origin of the primary screen. `NSScreen.axFrame/axVisibleFrame`,
  `NSScreen.axRect(fromCocoa:)`, `NSScreen.mouseAX`, `NSScreen.containing(axRect:)`.
- `Permissions`, `Keyboard.paste()/copy()/post(...)`, `HUD.show("Left Half", symbol:)`,
  `KeyablePanel`, `AppActivation.activateSelf()/previousApp`, `AppPaths.support("name")`,
  `SQLiteDB` (tiny sqlite3 wrapper), `BentoLog.make("category")`.
- `Theme` / `ThemeCenter` (Theme.swift) — Standard, Glass or Aero; `ThemeCenter.shared.style`
  says what to draw (standard under Reduce Transparency), `didChange` when it changes.
  `ThemedBackgroundView(material:content:)`, SwiftUI `ThemeBackdrop`, `themedBackground(_:)`,
  `themedScrollBackground()`.

## Rules for module work

1. Only edit files inside your own `Sources/<Module>/`, `Tests/<Module>Tests/`, `Dev/Dev<Module>/`
   (and `server/` for the server). **Do not edit BentoCore, BentoShell, Package.swift or other
   modules** — several people work in parallel. If you need a helper, add it to your own module
   (internal). If you believe Core needs a change, put it in your final report.
2. Build only your target, with your own scratch dir so parallel builds don't fight over locks:
   `swift build --scratch-path .build-<module> --target <Module>` and run your dev harness with
   `swift build --scratch-path .build-<module> --product Dev<Module> && .build-<module>/debug/Dev<Module>`.
   Tests: `scripts/test <Module>Tests` (Command Line Tools only: plain `swift test` can't find
   Swift Testing; the wrapper adds the flag and uses its own scratch dir `.build-test-*`). It
   builds every test target, so if another module is broken at that moment, retry later.
3. Processes started from this shell inherit Accessibility + Screen Recording permission, so the
   dev harness can be exercised for real: launch it in the background, drive it with CGEvents
   (`osascript`/a tiny swift script posting key events), take screenshots with
   `screencapture -x /tmp/x.png` and look at them. Kill your harness when done. Don't leave
   windows of other apps moved around. Only one instance of a given dev harness at a time.
4. The user's real apps are running (this is their machine). Be careful when testing window
   management: prefer testing on a window you open yourself (e.g. `open -a TextEdit` new doc,
   or a window from your harness) and restore what you move.
5. Idle cost: no timers that fire when nothing happens, except the clipboard changeCount poll
   (≤ 2 Hz with tolerance), MenuBar's opt-in "show when the icon changes" check (0.5 Hz, only
   for the items picked, only while they're hidden), the dictation tap's health check while
   Dictation or the Assistant is on (every 5 s: macOS disables taps silently), and once a voice
   module has run, a 6-hourly recording-retention sweep. The voice modules are off by default. Event taps only while their feature is
   enabled. AX observers only while needed. Release big images when windows close.
6. Look and feel: native macOS — SF Symbols, system materials (NSVisualEffectView / SwiftUI
   materials), system accent colour, light + dark mode, 8-pt spacing, no custom chrome unless the
   reference app has it. Keyboard-first: every panel fully usable without the mouse.
   Main windows follow the theme (`general.theme`): put content on a `ThemedBackgroundView`
   (or `ThemeBackdrop` in SwiftUI) instead of a bare NSVisualEffectView, and wrap opaque
   backgrounds in `themedBackground(_:)` so the glass shows through.
7. Settings: each module provides `makeSettingsView()` (SwiftUI `Form { … }.formStyle(.grouped)`)
   with its options and a "Shortcuts" section listing its actions with `ShortcutRecorder(actionID:)`.
8. Action ids are `<module>.<kebab-name>`. Titles are short ("Left Half", "Capture Area").
   App-level actions (the keyboard overview) use `bento.`: `AppActionsModule` in
   `Sources/BentoShell/KeyboardOverview.swift`, registered after the modules.

## Default shortcuts (avoid collisions)

| Area | Defaults |
|---|---|
| Shot | `cmd+shift+…` digits/letters, following Shottr's defaults, but **not** ⌘⇧3/⌘⇧4/⌘⇧5 (macOS) |
| Windows | Rectangle defaults: `ctrl+opt+…` (arrows, U/I/J/K, D/F/G/E/T, return, C, delete, minus/equal, shift+up), `ctrl+opt+cmd+left/right` for displays |
| Tiling | `ctrl+opt+cmd+…` letters: h/j/k/l focus, `hyper+h/j/k/l` move, t toggle manager, space cycle layout, f float, minus/equal resize, b balance (0 is emitted by the user's Karabiner layer) |
| Clipboard | `cmd+shift+v` open history |
| Notes | `ctrl+opt+n` toggle notes window, other notes shortcuts are local to its window |
| Todo | `ctrl+cmd+t` toggle the todo window (Todoist's show/hide), `ctrl+opt+space` Quick Add; Todoist's single-key bindings are local to the window (`Sources/Todo/TodoKeys.swift`) |
| Launcher | none by default (user-defined, typically `hyper+<letter>`) |
| MenuBar | `ctrl+opt+cmd+m` show/hide hidden items, `ctrl+opt+cmd+s` search menu bar items; per-item Accessibility open shortcuts are user-defined |
| Dictation | the dictation key is a hold/tap gesture on the voice event tap (fn, right ⌘/⌥/⌃ or `opt+f17`, picked in its pane), not an action; with `opt+f17`, `opt+f18` edits or talks to the assistant; `meh+r` Retry Last Transcription (`ctrl+opt+r` is Windows' Center Two Thirds); Capture Thought to Note (`dictation.capture-note`) has none |
| Meetings | `shift+opt+f17` record/stop |
| Assistant | `shift+opt+f18` show/hide the window; `opt+f18` voice calls (tap gesture); the window's own shortcuts are local (`Sources/Voice/Assistant/AssistantShortcuts.swift`) |
| Bento (app) | `opt+slash` (⌥/) Keyboard Shortcuts overview, also in the menu bar menu. Registered after the modules, so a module's or the user's binding of the same keys wins. `KeyboardOverviewTests` fails if any shortcut literal in `Sources` takes it |

## MenuBar behavior

MenuBar only changes section visibility. Arrange in Menu Bar holds the sections
revealed while the user Command-drags native items or separators. The dashed
Always Hidden separator belongs left of the solid Hidden separator. Done, or
leaving Settings, restores the previous visibility and refreshes the snapshot.
No cursor control, input synthesis, automatic ordering, profile application or
relaunch/display restoration is supported. Saved layout/profile fields are
compatibility data only.

Search and Bento Bar reveal in place and request a cancellable, validated
AXPress. There is no synthetic click fallback or temporary relocation. Crowded
and notched displays can leave items inaccessible; the user must make space,
click or reposition them manually. See QA.md for safe validation.

## Expanders and thought capture

Notes render `::: details <summary>` … `:::` (VitePress / markdown-it-container syntax) as an
expander, collapsed to its summary line until opened with its chevron or ⌘↩ on the summary.
The body is any markdown; an unclosed `::: details` line has no body. Collapse state is per
window and never written to the note, so the body stays plain text for sync and other clients.
Dictation's Capture Thought to Note records hands-free and appends the transcript to the
note set in Settings → Notes (`notes.captureNoteID`; unset or deleted: a new "Thoughts" note) as
`::: details yyyy-MM-dd HH:mm · <first words>` / text / `:::`, after a blank line. The modules
don't depend on each other: `main.swift` connects `DictationModule.noteCapture` to
`NotesModule.capture`; without Notes the transcript goes to the clipboard.

## Sync

See `docs/SYNC_PROTOCOL.md`. Self-hosted `bento-sync` (`server/`); no server by default, set
`notes.sync.server` / `todo.sync.server` in the config. Token in `~/.config/bento/sync-token`.
