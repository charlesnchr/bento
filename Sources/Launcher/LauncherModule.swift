import AppKit
import SwiftUI
import BentoCore

/// App Hotkeys module. See docs/SPEC.md.
public final class LauncherModule: BentoModule {
    public let id = "launcher"
    public let title = "App Hotkeys"
    public let symbol = "keyboard"

    public init() {}

    public var actions: [BentoAction] { [] }

    public func start() {}
    public func stop() {}
}
