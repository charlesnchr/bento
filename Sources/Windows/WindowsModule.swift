import AppKit
import SwiftUI
import BentoCore

/// Windows module. See docs/SPEC.md.
public final class WindowsModule: BentoModule {
    public let id = "windows"
    public let title = "Windows"
    public let symbol = "rectangle.split.2x1"

    public init() {}

    public var actions: [BentoAction] { [] }

    public func start() {}
    public func stop() {}
}
