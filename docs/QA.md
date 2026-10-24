# Bento QA protocol

The machine is the user's live Mac. GUI tests must never fight the user for the
screen, keyboard or mouse, and must never touch the user's own windows or data.

## GUI sessions (mandatory for any synthetic input or screen-dependent test)

    scripts/e2e/session start <who>      # blocks until the user has been idle ≥ 90 s, takes the GUI
                                         # lock, starts the input guard, quits the installed Bento
    ... run tests with /tmp/bentoctl ... # keep sessions short (≤ 3 min)
    scripts/e2e/session end <who>        # ALWAYS run this (also on failure): relaunches the installed
                                         # Bento, releases the lock

- The guard flags any real user input (`/tmp/bento-user-active`). From then on `bentoctl` refuses to
  post input (exit 75) and `scripts/e2e/session check` exits 75. When that happens: stop immediately,
  release any held mouse button (`bentoctl up x y` is refused too — it's fine, the user's own input
  resolves it), end the session, and retry later with a new `session start`.
- Only post input through `/tmp/bentoctl … --expect <bundleid>` (or `--expect-pid <pid>` for a raw debug
  binary) targeting your own windows: a TextEdit
  document you opened (`/tmp/<who>-qa.txt`), or the Bento process under test. Never type into or click
  on other apps (T3 Code, browsers, terminals…). `--expect` refuses otherwise; keep it on every input.
- Never move/resize/close windows you didn't create. Tiling tests must set `tiling.onlyApps` to
  `["com.apple.TextEdit"]`. Close your TextEdit docs without saving at the end of each session.
- Outside sessions: no synthetic input at all, no screenshots of the user's screen.

## App under test

Build the full app in your worktree (`swift build --product Bento`) and run the raw binary, so it
inherits this shell's Accessibility/Screen Recording permission and has no bundle id (no
single-instance clash):

    BENTO_HOME=/tmp/bento-e2e-<who> BENTO_DEV=1 .build/debug/Bento &

- Actions: real hotkeys via `bentoctl key` (the installed app is quit during a session so hotkeys are
  free), or `scripts/perform <action-id>`.
- State: `open -g "bento://debug/state"` only reaches the installed app; for your instance read
  `$BENTO_HOME/support/…` files, AX (`bentoctl frame`, `bentoctl windows Bento`), the pasteboard
  (`osascript -e 'clipboard info'`), and screenshots of your own windows (`screencapture -l <id>`).
- Notes sync: point `notes.sync.server` at a **local** `bento-sync` (`server/`, temp DB, own token);
  never sync test instances with the user's real server (it holds their real notes; isolated
  instances refuse anything but a local server unless `BENTO_ALLOW_LIVE_SYNC=1`).
- Kill your instance before `session end`.

## Regression scripts

Each module keeps `scripts/e2e/<module>.sh`: runs inside a session (it may call start/end itself),
asserts outcomes, exits non-zero on failure, cleans up after itself.

`scripts/e2e/launch.sh /path/to/Bento.app` checks foreground cold launch,
background launch and reopen, duplicate launch, and cold action-URL delivery.
Run it inside a session against a separate copy signed with the installed app's
identity, so Accessibility is already granted. The test requires that grant,
disables every module and the status icon in an isolated config, and checks
both fresh diagnostics and actual Settings window visibility. It sends no
keyboard or mouse events. Unregister the test bundle from Launch Services and
register the installed bundle again when the session ends.
The final case enables Menu Bar only in that isolated config and checks the
signed app's real recovery-icon ownership and initial safe expansion.
It then uses Bento's Arrange/Done buttons to check that both dividers and its
recovery icon have actual on-screen windows clear of the notch. Set
`BENTO_EXPECT_COMPACT=1` on a crowded layout to require compact mode, and
`BENTO_QA_CAPTURE_CONTROLS=1` to capture only those known Bento status windows
for visual inspection. These checks still require a guarded session.
For shorter sessions, `BENTO_LAUNCH_CASE=cold|warm|duplicate|url|menu` selects
one case; the default runs all five. Passing one case does not validate the rest.
The additional `enable` case begins with Menu Bar disabled and uses its actual
Settings toggle to enable it, then runs the menu checks and disables it again.
Compact dividers must measure 8 points in the native window snapshot, including
any padding AppKit adds. Optional captures also include the test's own Settings window.

## MenuBar corrective regression checks

`swift build --scratch-path .build-menubar --target MenuBar` and
`scripts/test MenuBarTests` are desktop-free. The tests inject snapshots, AX
reads/actions and a controller environment without system UI. Structural tests
reject cursor APIs, input synthesis, movement UI and runtime consumers of
legacy layout/profile settings. Keep the AX cancellation/drain tests.

`scripts/e2e/menubar.sh` is obsolete and exits 2 without side effects. It formerly
synthesized moves through profile actions that no longer exist. Do not revive
that script to validate the manual arrangement workflow.

The opt-in `nativeManualArrangementSmoke` test creates only Bento's own status
items and exercises Arrange/Done and stop against native AppKit. It checks that
existing menu-item frames and the pointer position are unchanged after cleanup.
Run it only inside a guarded session, after building the tests:

    BENTO_DEV=1 BENTO_NATIVE_MENUBAR_SMOKE=1 swift test --skip-build --filter nativeManualArrangementSmoke -Xswiftc -F/Library/Developer/CommandLineTools/Library/Developer/Frameworks

It does not test a person's Command-drag gesture or move any other app's items.

The compact-width check configures Bento's process-local spacing before AppKit
creates status items, measures two disposable divider windows, and captures
their glyphs for inspection. Run it alone inside a guarded session:

    BENTO_DEV=1 BENTO_NATIVE_COMPACT_SMOKE=1 swift test --scratch-path .build-test-all --skip-build --filter nativeCompactDividersHaveEightPointWindows -Xswiftc -F/Library/Developer/CommandLineTools/Library/Developer/Frameworks

The test prints its capture directory. Both real windows must be 8 points wide;
inspect `hidden.png` and `alwaysHidden.png` for distinct solid and dashed lines.
It does not write persistent preferences or exercise a user's arrangement.

Optional manual macOS smoke (release owner; not part of the unit suite):

1. Use the GUI session protocol above, an isolated DevMenuBar configuration and
   disposable status items. Do not rearrange the user's existing items.
2. Open Menu Bar Settings while the module is disabled, then enable it. Confirm
   the item list and Arrange in Menu Bar button attach to the new controller.
3. Choose Arrange in Menu Bar. Confirm both separators are revealed. Manually
   Command-drag only disposable items across the solid/dashed boundaries.
   Sections must stay revealed past the configured hide delay and when the
   pointer leaves the menu bar or a reveal trigger requests hiding.
4. Choose Done. Confirm the prior visibility returns and the refreshed section
   labels match native positions. Repeat by leaving Settings instead of Done.
5. Check Show/Hide and Show All. Search/Bar opening should use Accessibility in
   place; unsupported or crowded/notch items must explain manual activation,
   with no cursor movement or synthetic click fallback.
6. With legacy profiles and `keepItemsInPlace: true` in the isolated config,
   restart a disposable item or change displays. Bento must not reorder items.
7. Disable during arrangement and during an AX request. Confirm controls go away,
   queued AX actions do not run, and no cursor or restoration work occurs. End
   the session and remove the disposable items.
