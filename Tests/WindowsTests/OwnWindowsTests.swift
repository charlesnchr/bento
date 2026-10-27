import AppKit
import Testing
@testable import BentoCore
@testable import Windows

private let assistantStyle: NSWindow.StyleMask = [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel]

@Test func nonactivatingPanelsAreNotRegularUnlessManaged() {
    // Popups and HUD-style panels (the clipboard panel, Quick Add) stay out of window management…
    #expect(!OwnWindows.isRegular(style: assistantStyle, movable: true, ignoresMouse: false, managed: false))
    // …but the assistant, non-activating so it can stay on top, is moved, snapped and dragged like any window.
    #expect(OwnWindows.isRegular(style: assistantStyle, movable: true, ignoresMouse: false, managed: true))
}

@Test func managedPanelsStillNeedToBeRegularWindows() {
    #expect(OwnWindows.isRegular(style: [.titled, .resizable], movable: true, ignoresMouse: false, managed: false))
    #expect(!OwnWindows.isRegular(style: [.borderless, .nonactivatingPanel], movable: true, ignoresMouse: false, managed: true))
    #expect(!OwnWindows.isRegular(style: assistantStyle, movable: false, ignoresMouse: false, managed: true))
    #expect(!OwnWindows.isRegular(style: assistantStyle, movable: true, ignoresMouse: true, managed: true))
    #expect(!OwnWindows.isRegular(style: assistantStyle.union(.fullScreen), movable: true, ignoresMouse: false, managed: true))
}

@MainActor @Test func managedPanelIsAnOptIn() {
    final class Managed: NSPanel, ManagedPanel {}
    let style: NSWindow.StyleMask = [.titled, .nonactivatingPanel]
    let managed: NSWindow = Managed(contentRect: .zero, styleMask: style, backing: .buffered, defer: true)
    let plain: NSWindow = NSPanel(contentRect: .zero, styleMask: style, backing: .buffered, defer: true)
    #expect(managed is ManagedPanel)
    #expect(!(plain is ManagedPanel))
}
