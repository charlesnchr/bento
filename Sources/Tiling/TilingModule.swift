import AppKit
import SwiftUI
import BentoCore

/// Tiling module. See docs/SPEC.md.
public final class TilingModule: BentoModule {
    public let id = "tiling"
    public let title = "Tiling"
    public let symbol = "square.grid.2x2"

    public let enabledByDefault = false

    public init() {}

    public var actions: [BentoAction] { [] }

    public func start() {}
    public func stop() {}
}
