import AppKit
import SwiftUI
import BentoCore

/// Clipboard module. See docs/SPEC.md.
public final class ClipboardModule: BentoModule {
    public let id = "clipboard"
    public let title = "Clipboard"
    public let symbol = "doc.on.clipboard"

    public init() {}

    public var actions: [BentoAction] { [] }

    public func start() {}
    public func stop() {}
}
