import AppKit
import SwiftUI

struct AssistantScrollFollower: NSViewRepresentable {
    final class Observer: NSView {
        private weak var scroll: NSScrollView?
        private var tokens: [NSObjectProtocol] = []
        private var lastHeight: CGFloat = 0
        private var following = true { didSet { if following != oldValue { report() } } }
        var onFollow: ((Bool) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            DispatchQueue.main.async { [weak self] in self?.connect() }
        }
        private func connect() {
            guard let scroll = enclosingScrollView, let document = scroll.documentView, self.scroll !== scroll else { return }
            self.scroll = scroll
            lastHeight = document.frame.height
            scroll.contentView.postsBoundsChangedNotifications = true
            document.postsFrameChangedNotifications = true
            for (name, object) in [(NSView.boundsDidChangeNotification, scroll.contentView), (NSView.frameDidChangeNotification, document)] {
                tokens.append(NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in self?.changed() })
            }
            scrollToEnd()
        }
        private func changed() {
            guard let scroll, let document = scroll.documentView else { return }
            let height = document.frame.height
            if height != lastHeight {
                lastHeight = height
                if following { DispatchQueue.main.async { [weak self] in if self?.following == true { self?.scrollToEnd() } } }
            } else {
                let bounds = scroll.contentView.bounds
                following = document.isFlipped ? height - bounds.maxY <= 36 : bounds.minY <= 36
            }
        }
        private func report() {
            let following = following
            DispatchQueue.main.async { [weak self] in self?.onFollow?(following) }
        }
        private func scrollToEnd() {
            guard let scroll, let document = scroll.documentView else { return }
            let y = document.isFlipped ? max(0, document.frame.height - scroll.contentView.bounds.height) : 0
            scroll.contentView.scroll(to: NSPoint(x: 0, y: y))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        deinit { tokens.forEach(NotificationCenter.default.removeObserver) }
    }
    var onFollow: ((Bool) -> Void)?
    func makeNSView(context: Context) -> Observer { Observer() }
    func updateNSView(_ view: Observer, context: Context) { view.onFollow = onFollow }
}
