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

## MenuBar corrective regression checks

`swift build --scratch-path .build-menubar --target MenuBar` and
`scripts/test MenuBarTests` are desktop-free. The tests inject snapshots, AX
reads/actions and a controller environment without system UI. Structural tests
reject cursor APIs, input synthesis, movement UI and runtime consumers of
legacy layout/profile settings. Keep the AX cancellation/drain tests.

`scripts/e2e/menubar.sh` is obsolete and exits 2 without side effects. It formerly
synthesized moves through profile actions that no longer exist. Do not revive
that script to validate the manual arrangement workflow.

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
