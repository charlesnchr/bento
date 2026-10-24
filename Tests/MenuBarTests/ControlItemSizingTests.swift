import AppKit
import Testing
import BentoCore
@testable import MenuBar

private final class ControlSizingDefaults: UserDefaults {
    private var arguments: [String: Any] = [:]
    override func volatileDomain(forName name: String) -> [String: Any] { arguments }
    override func setVolatileDomain(_ domain: [String: Any], forName name: String) { arguments = domain }
}

@Test func controlLengthsKeepCompactAndExpandedWidthsIndependentOfNormalPadding() throws {
    for spacing: CGFloat? in [nil, 0, 6, 16, 24] {
        let sizing = StatusItemSizing()
        if let spacing {
            let defaults = try #require(ControlSizingDefaults(suiteName: "bento-controls-\(UUID().uuidString)"))
            sizing.configure(defaults: defaults, currentHostSpacing: { spacing })
        }
        for compact in [false, true] {
            #expect(ControlItems.length(kind: .toggle, imageWidth: 7, compact: compact,
                                        expandedLength: nil, sizing: sizing) ==
                    spacing.map { 7 + $0 } ?? NSStatusItem.variableLength)
            for kind in [ControlItems.Kind.hidden, .alwaysHidden] {
                #expect(ControlItems.length(kind: kind, imageWidth: compact ? 2 : 9, compact: compact,
                                            expandedLength: nil, sizing: sizing) ==
                        (compact ? 8 : spacing.map { 9 + $0 } ?? NSStatusItem.variableLength))
                // Wider than the 1728-point display even without automatic padding.
                #expect(ControlItems.length(kind: kind, imageWidth: 0, compact: compact,
                                            expandedLength: 1928, sizing: sizing) == 1928)
            }
        }
    }
}
