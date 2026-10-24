import AppKit
import Testing
@testable import BentoCore

/// Keep inherited defaults deterministic without reading or writing global preferences.
private final class InheritedSpacingDefaults: UserDefaults {
    let spacing: Any?
    private var domains: [String: [String: Any]] = [:]

    init(spacing: Any?, suite: String = "bento-status-sizing-\(UUID().uuidString)") {
        self.spacing = spacing
        super.init(suiteName: suite)!
    }

    override func volatileDomain(forName name: String) -> [String: Any] {
        domains[name] ?? [:]
    }

    override func setVolatileDomain(_ domain: [String: Any], forName name: String) {
        domains[name] = domain
    }

    override func object(forKey key: String) -> Any? {
        volatileDomain(forName: UserDefaults.argumentDomain)[key] ??
            (key == "NSStatusItemSpacing" ? spacing : nil)
    }
}

@Test func statusItemSpacingOverridesOnlyTheVolatileArgumentKey() throws {
    let suite = "bento-status-sizing-\(UUID().uuidString)"
    let defaults = InheritedSpacingDefaults(spacing: nil, suite: suite)
    defaults.setVolatileDomain(["NSStatusItemSpacing": 12, "NSStatusItemSelectionPadding": 7,
                               "unrelated": "kept"], forName: UserDefaults.argumentDomain)
    let persistentBefore = defaults.persistentDomain(forName: suite) as NSDictionary?
    let sizing = StatusItemSizing()

    sizing.configure(defaults: defaults, currentHostSpacing: { nil })

    #expect(defaults.integer(forKey: "NSStatusItemSpacing") == 0)
    #expect(sizing.originalSpacing == 12)
    #expect(defaults.volatileDomain(forName: UserDefaults.argumentDomain) as NSDictionary ==
            ["NSStatusItemSpacing": 0, "NSStatusItemSelectionPadding": 7, "unrelated": "kept"] as NSDictionary)
    #expect(defaults.persistentDomain(forName: suite) as NSDictionary? == persistentBefore)
}

@Test func statusItemSpacingCapturesEffectiveOriginalBeforeOverridingIt() {
    let cases: [(argument: Any?, host: CGFloat?, inherited: Any?, expected: CGFloat)] = [
        (nil, nil, nil, 16),
        (nil, nil, 6, 6),
        (nil, nil, 0, 0),
        (nil, 10, 6, 10),
        (nil, 0, 6, 0),
        (12, 10, 6, 12),
        (0, 10, 6, 0),
        ("8", 10, 6, 8),
        (nil, nil, "4", 4),
    ]
    for value in cases {
        let defaults = InheritedSpacingDefaults(spacing: value.inherited)
        if let argument = value.argument {
            defaults.setVolatileDomain(["NSStatusItemSpacing": argument], forName: UserDefaults.argumentDomain)
        }
        let sizing = StatusItemSizing()
        sizing.configure(defaults: defaults, currentHostSpacing: { value.host })
        #expect(sizing.originalSpacing == value.expected)
        #expect(defaults.object(forKey: "NSStatusItemSpacing") as? Int == 0)
    }
}

@Test func statusItemSpacingConfigurationKeepsTheFirstCapturedValue() {
    let defaults = InheritedSpacingDefaults(spacing: 10)
    let sizing = StatusItemSizing()
    sizing.configure(defaults: defaults, currentHostSpacing: { nil })
    sizing.configure(defaults: defaults, currentHostSpacing: {
        Issue.record("Repeated configuration must not recapture defaults")
        return 24
    })
    #expect(sizing.originalSpacing == 10)
    #expect(defaults.object(forKey: "NSStatusItemSpacing") as? Int == 0)
}

@Test func statusItemNormalLengthsPreserveNativePaddingOnlyWhenConfigured() {
    for spacing in [CGFloat(0), 6, 16, 24] {
        let sizing = StatusItemSizing()
        let widths: [(CGFloat, CGFloat)] = [(9, NSStatusItem.variableLength), (7, NSStatusItem.variableLength),
                                           (22, NSStatusItem.squareLength), (24, 24)]
        for (content, fallback) in widths {
            #expect(sizing.normalLength(contentWidth: content, fallback: fallback) == fallback)
        }
        sizing.configure(defaults: InheritedSpacingDefaults(spacing: spacing), currentHostSpacing: { nil })
        for (content, fallback) in widths {
            #expect(sizing.normalLength(contentWidth: content, fallback: fallback) == content + spacing)
        }
    }
}
