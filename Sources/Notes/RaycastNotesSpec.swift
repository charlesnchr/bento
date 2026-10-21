// Raycast Notes reference spec for the Bento port (kept as a comment so SwiftPM
// doesn't warn about an unhandled resource file).
/*
# Raycast Notes: reference spec for the Bento port

Sources: raycast.com/core-features/notes, manual.raycast.com/notes, the "Meet the new
Raycast Notes" blog post and launch video (v1.85, Nov 2024), MacStories and Scott Willsey
reviews, the macOS v1/v2 changelogs, the editor CSS/JS shipped inside Raycast 1.104
(`RaycastWeb.bundle`), UI strings in the Raycast binary, and the user's own Raycast
preferences (`com.raycast.macos`). Status: **done** / *partial* / ~~not ported~~.

## Window
- Floating window above other apps, one note visible at a time. **done**
- Native titlebar with traffic lights (minimise/zoom greyed out), the note title (first
  line, markdown stripped, truncated) centred in secondary colour, three toolbar buttons
  on the right: ⌘ (Actions), Browse Notes (rounded rect with lines), + (New Note). **done**
- Double-click the title: window floats back to its original position. **done**
- Footer: hairline separator, centred status text that toggles between "N Characters"
  and "N Words" when clicked (persisted, `raycastNotesStatusTextType`, 0 = characters,
  1 = words), "T" button on the right that shows the format bar. **done**
- Format bar (optional, persisted, hidden by default, ⌥⌘,): H▾ (heading menu), Bold,
  Italic, Strikethrough, Code, Link, Code block, Blockquote, Ordered list, Bullet list,
  Task list, divider, close (x). Tooltips show the shortcut. **done**
- Default size ~396×448 pt (the user's Raycast frame); size and position remembered. **done**
- Window auto-sizing: height follows the content; resizing by hand turns it off; action
  "Enable/Disable Window Auto-sizing" (⇧⌘/). Default off (user's setting). **done**
  ~~hover "auto-size" HUD button at the bottom edge~~ (use the action instead).
- Toggle command ("Raycast Notes"): hidden → show and focus; visible but unfocused →
  focus; focused → hide (focus returns to the previous app). Reopens the last note. **done**
- Escape: closes the window, or only gives up focus ("Escape Key Behaviour"). **done**
- "Hide While Screen Sharing" / "Show While Screen Sharing" action. **done**
- Always on Top (Raycast 2.x). Bento: "Float on Top" setting + action. **done**
- Optional menu-bar toggle button (click toggles, ⌥-click creates a note). **done**
- Zoom: ⌘= / ⌘- / ⌘0 (Reset Zoom follows the text-size setting); text sizes
  small 12/145 %, medium 14/145 %, large 16/135 %, x-large 18/130 %, xx-large 20/130 %. **done**

## Editor look (from Raycast's editor CSS)
- Padding 8 pt × 24 pt. Paragraphs 8 pt apart. Headings: H1 1.7 em weight 650,
  H2 1.425 em weight 625, H3 1.15 em weight 600, line height 1.25, extra space above a
  heading that follows content (30/18/18 pt). Paragraph text slightly dimmer than headings.
- Bold = weight 600. Italic, strikethrough, underline.
- Inline code: monospace 0.9 em, rounded 6 pt pill, 10 % tint background.
- Code block: same tint, rounded box, padding 0.6 em × 1 em, monospace.
- Blockquote: 2 pt accent bar 7 pt from the left, text indented 22 pt.
- Lists indented 22 pt per level; bullets • ◦ ▪ by depth; ordered numbers in accent
  colour, right-aligned; task checkbox 14 pt, radius 5, 1.5 pt accent border, checked =
  8 pt filled accent square, checked text at 70 % opacity (no strike-through).
- Horizontal rule: 2 pt rounded line in separator colour.
- Links in accent colour, underlined. Caret and selection tinted with the accent
  (Raycast red #FF6363; Bento can use the system accent instead).
- All markdown syntax is hidden (WYSIWYG). Bento stores markdown and hides the markers:
  block markers are always hidden and drawn as bullets/numbers/checkboxes/bars; inline
  markers show (dimmed) only while the caret touches that span; code fences show dimmed
  while the caret is inside the block.

## Formatting (manual)
Markdown typed at line start: `# `/`## `/`### `, ```` ``` ```` or `~~~` + space (code block),
`> `, `1. `, `* ` / `- `, `[] ` / `[x] ` (task), `---` / `___ ` (rule). Inline: `**b**`,
`__b__`, `*i*`, `_i_`, `~~s~~`, `` `c` ``, `[text](url)`. **done**

| Format | Shortcut |
|---|---|
| Heading 1/2/3 | ⌥⌘1 / ⌥⌘2 / ⌥⌘3 (⌥⌘0 back to paragraph) |
| Code block | ⌥⌘C |
| Blockquote | ⇧⌘B |
| Ordered / bullet / task list | ⇧⌘7 / ⇧⌘8 / ⇧⌘9 |
| Toggle task | ⌘↩ (⌘-click a parent checkbox toggles nested tasks) |
| Bold / italic / underline | ⌘B / ⌘I / ⌘U |
| Strikethrough | ⇧⌘S |
| Inline code | ⌘E |
| Link | ⌘L |
| Move list item up / down | ⌃⌘↑ / ⌃⌘↓ |
| Indent / outdent list item | Tab / ⇧Tab |

Return continues lists (empty item ends the list or outdents a nested one). Underline is
stored as `<u>…</u>`. `/` opens the block-format menu and `:` + 2 letters the inline
emoji picker (Unicode names + common shortcodes). **done** ~~drag handle to reorder list
items~~ (use ⌃⌘↑/↓).

## Notes
- Multiple notes as a stack; first line is the title. ⌘N new note. **done**
- ⌘P Browse Notes: "Search for notes…", sections Pinned and Notes (with count), rows with
  title and "● Current • N Characters" / "Opened 4m ago • N Characters", pin and trash
  buttons on the selected row; fuzzy search over title and content; empty state button
  to create a note. **done**
- Pin/unpin ⇧⌘P (⌘. in the list); pinned notes first, reorderable (⇧⌘↑/↓ in the list),
  ⌘1…⌘9 open pinned notes (Raycast also lists ⌘0, which Bento keeps for Reset Zoom). **done**
- Back/forward through previously opened notes ⌘[ / ⌘] (history survives restarts). **done**
- Delete Note ⌃X (confirmation with "don't ask again"), Delete All Notes ⌃⇧X; deleted
  notes go to Recently Deleted for 60 days (restore, delete permanently). **done**
- Duplicate Note ⌘D. Find in Note ⌘F (find & replace). **done**
- Copy Note As / Copy Selected Text As (Markdown, Plain Text, HTML) ⇧⌘C. **done**
- Export… ⇧⌘E (save Markdown / plain text / HTML file, share sheet). **done**
- ~~Copy Note Deeplink, Create Quicklink, AI commands, Raycast attachments~~ (Raycast
  ecosystem only; Bento has `bento://action/notes.toggle|new|search`).
- Settings: menu-bar button, escape key behaviour, zoom/text size. **done**
- ~~5-note free limit~~, ~~"Welcome to Raycast Notes" onboarding note~~ (would duplicate
  across synced Macs).

## Actions panel (⌘K)
"Search for actions…" list with sections and shortcut keycaps:
New Note ⌘N, Browse Notes ⌘P, Pin/Unpin Note ⇧⌘P, Duplicate Note ⌘D, Copy Note As… ⇧⌘C,
Format… ⇧⌘, (submenu), Show/Hide Format Bar ⌥⌘,, Find in Note ⌘F, Zoom In/Out/Reset,
Enable/Disable Window Auto-sizing ⇧⌘/, Float on Top, Hide While Screen Sharing,
Export… ⇧⌘E, Recently Deleted Notes, Open Notes Settings ⌘,, Delete Note ⌃X,
Delete All Notes ⌃⇧X. **done**

## Sync (Bento-specific, replaces Raycast Cloud Sync)
See docs/SYNC_PROTOCOL.md. Pinned state, pin order and Recently Deleted live in `meta`
(`pinned`, `pinOrder`, `trashedAt`), so they sync; "Delete Permanently" sends a tombstone.
*/
