import BentoCore
import BentoShell
import Shot
import Windows
import Tiling
import Launcher
import Clipboard
import Notes
import Todo
import MenuBar
import Voice

StatusItemSizing.shared.configure()

let notes = NotesModule()
// Dictation's Capture Thought to Note appends to a note; the modules don't know each other.
DictationModule.noteCapture = { notes.capture($0) }

BentoApp.run(modules: [
    ShotModule(),
    WindowsModule(),
    TilingModule(),
    LauncherModule(),
    ClipboardModule(),
    notes,
    TodoModule(),
    MenuBarModule(),
] + VoiceModules.all())
