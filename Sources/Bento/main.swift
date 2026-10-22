import BentoShell
import Shot
import Windows
import Tiling
import Launcher
import Clipboard
import Notes
import Todo

BentoApp.run(modules: [
    ShotModule(),
    WindowsModule(),
    TilingModule(),
    LauncherModule(),
    ClipboardModule(),
    NotesModule(),
    TodoModule(),
])
