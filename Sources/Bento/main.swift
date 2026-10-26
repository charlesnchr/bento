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

BentoApp.run(modules: [
    ShotModule(),
    WindowsModule(),
    TilingModule(),
    LauncherModule(),
    ClipboardModule(),
    NotesModule(),
    TodoModule(),
    MenuBarModule(),
] + VoiceModules.all())
