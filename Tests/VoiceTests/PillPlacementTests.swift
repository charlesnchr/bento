import AppKit
import Testing
@testable import Voice

@Suite struct PillPlacementTests {
    let laptop = NSRect(x: 0, y: 25, width: 1728, height: 1067)
    let monitor = NSRect(x: 1728, y: -200, width: 3840, height: 1595)

    @Test func nothingSavedIsBottomCentre() {
        let anchor = PillPlacement.anchor(relative: nil, in: laptop)
        #expect(anchor == CGPoint(x: laptop.midX, y: laptop.minY + 24))
        // The same panel frame as before the pill could move.
        let placement = PillPlacement.panelOrigin(anchor: anchor, in: laptop)
        #expect(placement.origin == CGPoint(x: laptop.midX - 300, y: laptop.minY + 16))
        #expect(placement.anchorX == 300)
    }

    @Test func savedSpotRoundTripsAndScalesToAnotherScreen() {
        let dropped = CGPoint(x: 1500, y: 900)
        let relative = PillPlacement.relative(anchor: dropped, in: laptop)
        let restored = PillPlacement.anchor(relative: relative, in: laptop)
        #expect(abs(restored.x - dropped.x) < 0.001 && abs(restored.y - dropped.y) < 0.001)
        // Top-right on the laptop is top-right on the monitor.
        let there = PillPlacement.anchor(relative: relative, in: monitor)
        #expect(there.x > monitor.midX && there.y > monitor.midY)
        #expect(monitor.contains(there))
    }

    @Test func aSpotOffTheScreenIsPulledBackOn() {
        for relative in [CGPoint(x: -3, y: 0.5), CGPoint(x: 4, y: 9), CGPoint(x: 0.5, y: -1), CGPoint(x: .nan, y: 0.2)] {
            let anchor = PillPlacement.anchor(relative: relative, in: laptop)
            let panel = NSRect(origin: PillPlacement.panelOrigin(anchor: anchor, in: laptop).origin, size: PillPlacement.panelSize)
            #expect(laptop.contains(panel), "\(relative)")
        }
    }

    @Test func nearAnEdgeThePanelStaysOnScreenAndTheAnchorMovesInside() {
        let corner = CGPoint(x: laptop.maxX - 10, y: laptop.minY)
        let placement = PillPlacement.panelOrigin(anchor: corner, in: laptop)
        let panel = NSRect(origin: placement.origin, size: PillPlacement.panelSize)
        #expect(laptop.contains(panel))
        #expect(placement.origin.x + placement.anchorX == laptop.maxX - 62)
        #expect(placement.origin.y == laptop.minY)
    }

    @Test func aWidePillGrowsAboutItsCentreUntilThePanelEdge() {
        // Centred: the 520-wide live pill straddles the anchor.
        #expect(PillPlacement.pillMinX(anchorX: 300, width: 520, panelWidth: 600) == 40)
        #expect(PillPlacement.pillMinX(anchorX: 300, width: 40, panelWidth: 600) == 280)
        // Dragged to the right edge: the resting pill hugs the panel edge, the
        // wide state slides inward.
        #expect(PillPlacement.pillMinX(anchorX: 538, width: 124, panelWidth: 600) == 476)
        #expect(PillPlacement.pillMinX(anchorX: 538, width: 520, panelWidth: 600) == 80)
        #expect(PillPlacement.pillMinX(anchorX: 20, width: 520, panelWidth: 600) == 0)
    }
}
