import Foundation
import BentoCore
import BentoShell
import Windows

// BENTO_LOG_EVENTS=1 prints each windowPlaced event (Windows → Tiling) to stderr.
BentoApp.runDev("windows", modules: [WindowsModule()])
