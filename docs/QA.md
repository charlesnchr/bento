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
