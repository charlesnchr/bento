import AppKit
import SwiftUI
import BentoCore

/// Capture module. See docs/SPEC.md.
public final class ShotModule: BentoModule {
    public let id = "shot"
    public let title = "Capture"
    public let symbol = "camera.viewfinder"

    public init() {}

    public var actions: [BentoAction] { [] }

    public func start() {}
    public func stop() {}
}
