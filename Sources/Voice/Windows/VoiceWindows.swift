import AppKit
import BentoCore
import SwiftUI
import VoiceCore

/// A plain document-style window for History and Meetings: created when
/// opened, torn down when closed, frame remembered under `autosaveName`.
/// Like Bento's Settings, it puts Bento in the Dock and ⌘-Tab while open.
@MainActor
final class VoiceWindowController: NSObject, NSWindowDelegate {
    private var window: NSWindow?
    private let onClose: () -> Void

    init(title: String, autosaveName: String, size: NSSize, content: () -> AnyView, onClose: @escaping () -> Void) {
        self.onClose = onClose
        super.init()
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                              backing: .buffered, defer: false)
        window.title = title
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unified
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 520, height: 400)
        let host = NSHostingView(rootView: content())
        // The window's frame is the user's: SwiftUI content must not resize it.
        host.sizingOptions = []
        window.contentView = host
        if !window.setFrameUsingName(autosaveName) { window.center() }
        window.setFrameAutosaveName(autosaveName)
        window.delegate = self
        self.window = window
        DockPresence.retain()
    }

    func present() {
        AppActivation.activateSelf()
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()
    }

    func close() { window?.close() }

    func windowWillClose(_ notification: Notification) {
        guard let window else { return }
        window.delegate = nil
        window.setFrameAutosaveName("")
        self.window = nil
        DockPresence.release()
        onClose()
        DispatchQueue.main.async { window.contentView = nil }
    }
}

/// History in its own window.
struct HistoryWindowContent: View {
    let pages: AppPages

    var body: some View {
        if let store = pages.store {
            HistoryPane(store: store, onRetry: pages.onRetry)
                .padding(.top, 8)
        } else {
            ContentUnavailableView("History unavailable", systemImage: "clock.badge.exclamationmark",
                                   description: Text("The history index couldn't be opened."))
        }
    }
}
