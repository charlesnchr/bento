import CoreGraphics

// Pure layout engine: no AppKit / AX here, so everything is unit-testable.
//
// Model (a deliberately small subset of AeroSpace / yabai):
// - Each display owns one binary tree (`TileNode`). Leaves are windows, inner
//   nodes split their rect horizontally (side by side) or vertically with a ratio.
// - The in-order leaf sequence of the tree is the window *order* used by the
//   list layouts (master-stack, columns, rows, monocle), so one structure serves
//   every layout and switching layouts never loses the arrangement.
// - Leaves can be "hidden" (window on another Space, minimized, app hidden).
//   Geometry is computed visible-aware: a subtree without visible windows takes
//   no space, so windows come back to their old place when they reappear.

typealias WindowID = UInt32

enum Axis: String, Codable, Equatable {
    /// Children side by side (left | right).
    case horizontal
    /// Children stacked (top / bottom).
    case vertical

    var flipped: Axis { self == .horizontal ? .vertical : .horizontal }
}

enum Direction: String, CaseIterable {
    case left, down, up, right

    var axis: Axis { self == .left || self == .right ? .horizontal : .vertical }
    /// Right and down point towards the second child of a split.
    var isForward: Bool { self == .right || self == .down }
}

public enum LayoutKind: String, Codable, CaseIterable, Identifiable {
    case tiles, masterStack, columns, rows, monocle

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .tiles: "Tiles"
        case .masterStack: "Master-Stack"
        case .columns: "Columns"
        case .rows: "Rows"
        case .monocle: "Monocle"
        }
    }

    public var symbol: String {
        switch self {
        case .tiles: "rectangle.split.2x2"
        case .masterStack: "sidebar.left"
        case .columns: "rectangle.split.3x1"
        case .rows: "rectangle.split.1x2"
        case .monocle: "rectangle.stack"
        }
    }

    var next: LayoutKind {
        let all = LayoutKind.allCases
        return all[(all.firstIndex(of: self)! + 1) % all.count]
    }
}

public enum Placement: String, Codable, CaseIterable, Identifiable {
    /// Split the focused window (BSP) / insert after it in the order.
    case afterFocused
    /// Split the last window / append to the order (dwindle).
    case end
    /// Become the first window (master).
    case first

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .afterFocused: "Next to focused window"
        case .end: "At the end"
        case .first: "As master (first)"
        }
    }
}

enum LayoutMath {
    static let minRatio = 0.1
    static let maxRatio = 0.9

    /// Clamped to [minRatio, maxRatio]; NaN/infinite (min/max would pass NaN through) becomes 0.5.
    static func clampRatio(_ r: Double) -> Double { r.isFinite ? min(max(r, minRatio), maxRatio) : 0.5 }

    /// Splits `r` in two along `axis`, leaving `gap` between the parts.
    static func split(_ r: CGRect, _ axis: Axis, ratio: Double, gap: CGFloat) -> (CGRect, CGRect) {
        let ratio = ratio.isFinite ? min(max(ratio, 0), 1) : 0.5
        switch axis {
        case .horizontal:
            let avail = max(0, r.width - gap)
            let w1 = (avail * ratio).rounded()
            return (CGRect(x: r.minX, y: r.minY, width: w1, height: r.height),
                    CGRect(x: r.minX + w1 + gap, y: r.minY, width: avail - w1, height: r.height))
        case .vertical:
            let avail = max(0, r.height - gap)
            let h1 = (avail * ratio).rounded()
            return (CGRect(x: r.minX, y: r.minY, width: r.width, height: h1),
                    CGRect(x: r.minX, y: r.minY + h1 + gap, width: r.width, height: avail - h1))
        }
    }

    /// Distributes `r` along `axis` proportionally to `weights`, with gaps.
    static func distribute(_ r: CGRect, _ axis: Axis, weights: [Double], gap: CGFloat) -> [CGRect] {
        let n = weights.count
        guard n > 0 else { return [] }
        let length = axis == .horizontal ? r.width : r.height
        let avail = max(0, length - gap * CGFloat(n - 1))
        let total = weights.reduce(0, +)
        var out: [CGRect] = []
        var pos = axis == .horizontal ? r.minX : r.minY
        let end = axis == .horizontal ? r.maxX : r.maxY
        for (i, w) in weights.enumerated() {
            let size = i == n - 1 ? max(0, end - pos) : (avail * (total > 0 ? w / total : 1 / Double(n))).rounded()
            out.append(axis == .horizontal
                ? CGRect(x: pos, y: r.minY, width: size, height: r.height)
                : CGRect(x: r.minX, y: pos, width: r.width, height: size))
            pos += size + gap
        }
        return out
    }
}

// MARK: - Tree

indirect enum TileNode: Equatable {
    case leaf(WindowID)
    /// Axis, ratio of the first child, first child, second child.
    case split(Axis, Double, TileNode, TileNode)

    var leaves: [WindowID] {
        switch self {
        case .leaf(let id): [id]
        case .split(_, _, let a, let b): a.leaves + b.leaves
        }
    }

    func contains(_ id: WindowID) -> Bool {
        switch self {
        case .leaf(let x): x == id
        case .split(_, _, let a, let b): a.contains(id) || b.contains(id)
        }
    }

    func hasVisible(_ visible: Set<WindowID>) -> Bool {
        switch self {
        case .leaf(let id): visible.contains(id)
        case .split(_, _, let a, let b): a.hasVisible(visible) || b.hasVisible(visible)
        }
    }

    func visibleLeaves(_ visible: Set<WindowID>) -> [WindowID] { leaves.filter(visible.contains) }

    // MARK: Structural edits

    /// The tree without `id`; its sibling takes the parent's place. Nil when empty.
    func removing(_ id: WindowID) -> TileNode? {
        switch self {
        case .leaf(let x):
            return x == id ? nil : self
        case .split(let axis, let ratio, let a, let b):
            guard contains(id) else { return self }
            let na = a.removing(id), nb = b.removing(id)
            switch (na, nb) {
            case let (x?, y?): return .split(axis, ratio, x, y)
            case let (x?, nil): return x
            case let (nil, y?): return y
            case (nil, nil): return nil
            }
        }
    }

    func replacing(_ id: WindowID, with node: TileNode) -> TileNode {
        switch self {
        case .leaf(let x): x == id ? node : self
        case .split(let axis, let ratio, let a, let b):
            .split(axis, ratio, a.replacing(id, with: node), b.replacing(id, with: node))
        }
    }

    func swapping(_ x: WindowID, _ y: WindowID) -> TileNode {
        switch self {
        case .leaf(let id): id == x ? .leaf(y) : id == y ? .leaf(x) : self
        case .split(let axis, let ratio, let a, let b):
            .split(axis, ratio, a.swapping(x, y), b.swapping(x, y))
        }
    }

    /// Replaces leaf `target` by a split holding `target` and `new`.
    func splitting(_ target: WindowID, with new: WindowID, axis: Axis, newFirst: Bool) -> TileNode {
        replacing(target, with: newFirst
            ? .split(axis, 0.5, .leaf(new), .leaf(target))
            : .split(axis, 0.5, .leaf(target), .leaf(new)))
    }

    // MARK: Geometry

    func frames(in rect: CGRect, gap: CGFloat, visible: Set<WindowID>) -> [WindowID: CGRect] {
        var out: [WindowID: CGRect] = [:]
        fill(rect, gap: gap, visible: visible, into: &out)
        return out
    }

    private func fill(_ r: CGRect, gap: CGFloat, visible: Set<WindowID>, into out: inout [WindowID: CGRect]) {
        switch self {
        case .leaf(let id):
            if visible.contains(id) { out[id] = r }
        case .split(let axis, let ratio, let a, let b):
            let av = a.hasVisible(visible), bv = b.hasVisible(visible)
            if av && bv {
                let (r1, r2) = LayoutMath.split(r, axis, ratio: ratio, gap: gap)
                a.fill(r1, gap: gap, visible: visible, into: &out)
                b.fill(r2, gap: gap, visible: visible, into: &out)
            } else if av {
                a.fill(r, gap: gap, visible: visible, into: &out)
            } else if bv {
                b.fill(r, gap: gap, visible: visible, into: &out)
            }
        }
    }

    // MARK: Paths (false = first child, true = second child)

    func path(to id: WindowID) -> [Bool]? {
        switch self {
        case .leaf(let x): return x == id ? [] : nil
        case .split(_, _, let a, let b):
            if let p = a.path(to: id) { return [false] + p }
            if let p = b.path(to: id) { return [true] + p }
            return nil
        }
    }

    func node(at path: ArraySlice<Bool>) -> TileNode? {
        guard let first = path.first else { return self }
        guard case .split(_, _, let a, let b) = self else { return nil }
        return (first ? b : a).node(at: path.dropFirst())
    }

    func updating(at path: ArraySlice<Bool>, _ transform: (TileNode) -> TileNode) -> TileNode {
        guard let first = path.first else { return transform(self) }
        guard case .split(let axis, let ratio, let a, let b) = self else { return self }
        return first
            ? .split(axis, ratio, a, b.updating(at: path.dropFirst(), transform))
            : .split(axis, ratio, a.updating(at: path.dropFirst(), transform), b)
    }

    /// The (visible-aware) rect of the node at `path`.
    func rect(at path: ArraySlice<Bool>, in r: CGRect, gap: CGFloat, visible: Set<WindowID>) -> CGRect {
        guard let first = path.first, case .split(let axis, let ratio, let a, let b) = self else { return r }
        let child = first ? b : a
        var childRect = r
        if a.hasVisible(visible) && b.hasVisible(visible) {
            let (r1, r2) = LayoutMath.split(r, axis, ratio: ratio, gap: gap)
            childRect = first ? r2 : r1
        }
        return child.rect(at: path.dropFirst(), in: childRect, gap: gap, visible: visible)
    }

    /// Ancestors of `id` (deepest first) whose both sides contain visible
    /// windows, i.e. splits that actually show on screen. Returns
    /// (path to the split, whether `id` is in its second child, axis).
    func visibleAncestors(of id: WindowID, visible: Set<WindowID>) -> [(path: [Bool], inSecond: Bool, axis: Axis)] {
        guard let p = path(to: id) else { return [] }
        var out: [(path: [Bool], inSecond: Bool, axis: Axis)] = []
        for k in stride(from: p.count - 1, through: 0, by: -1) {
            let prefix = Array(p[0..<k])
            guard case .split(let axis, _, let a, let b)? = node(at: prefix[...]),
                  a.hasVisible(visible), b.hasVisible(visible) else { continue }
            out.append((prefix, p[k], axis))
        }
        return out
    }

    private func settingRatio(at path: [Bool], _ f: (Double) -> Double) -> TileNode {
        updating(at: path[...]) { n in
            guard case .split(let axis, let ratio, let a, let b) = n else { return n }
            return .split(axis, LayoutMath.clampRatio(f(ratio)), a, b)
        }
    }

    /// Grows (delta > 0) or shrinks the window by moving its nearest visible split.
    func adjustingRatio(of id: WindowID, by delta: Double, visible: Set<WindowID>) -> TileNode? {
        guard let anc = visibleAncestors(of: id, visible: visible).first else { return nil }
        return settingRatio(at: anc.path) { anc.inSecond ? $0 - delta : $0 + delta }
    }

    /// Moves the boundary on `edge` of window `id` to `coordinate` (used when
    /// the user resizes a tiled window with the mouse).
    func settingEdge(of id: WindowID, edge: Direction, to coordinate: CGFloat,
                     in area: CGRect, gap: CGFloat, visible: Set<WindowID>) -> TileNode? {
        // The left/top edge belongs to a split where the window is in the second child.
        let wantSecond = !edge.isForward
        guard let anc = visibleAncestors(of: id, visible: visible)
            .first(where: { $0.axis == edge.axis && $0.inSecond == wantSecond }) else { return nil }
        let r = rect(at: anc.path[...], in: area, gap: gap, visible: visible)
        let start = edge.axis == .horizontal ? r.minX : r.minY
        let avail = (edge.axis == .horizontal ? r.width : r.height) - gap
        guard avail > 0 else { return nil }
        let firstSize = wantSecond ? coordinate - gap - start : coordinate - start
        return settingRatio(at: anc.path) { _ in Double(firstSize / avail) }
    }

    /// Flips the axis of the window's nearest visible split.
    func togglingAxis(of id: WindowID, visible: Set<WindowID>) -> TileNode? {
        guard let anc = visibleAncestors(of: id, visible: visible).first else { return nil }
        return updating(at: anc.path[...]) { n in
            guard case .split(let axis, let ratio, let a, let b) = n else { return n }
            return .split(axis.flipped, ratio, a, b)
        }
    }

    /// Ratios that give every window along a chain of same-axis splits equal size.
    func balanced(visible: Set<WindowID>) -> TileNode {
        switch self {
        case .leaf: return self
        case .split(let axis, _, let a, let b):
            let ca = Double(a.slots(along: axis, visible: visible))
            let cb = Double(b.slots(along: axis, visible: visible))
            let ratio = ca + cb > 0 && ca > 0 && cb > 0 ? ca / (ca + cb) : 0.5
            return .split(axis, ratio, a.balanced(visible: visible), b.balanced(visible: visible))
        }
    }

    /// Number of visible cells this subtree contributes along `axis`.
    private func slots(along axis: Axis, visible: Set<WindowID>) -> Int {
        switch self {
        case .leaf(let id): return visible.contains(id) ? 1 : 0
        case .split(let ax, _, let a, let b):
            let sa = a.slots(along: axis, visible: visible), sb = b.slots(along: axis, visible: visible)
            if ax == axis { return sa + sb }
            return max(sa, sb) > 0 ? 1 : 0
        }
    }
}

// MARK: - Per-display layout state

struct LayoutState: Equatable {
    var kind: LayoutKind
    var tree: TileNode?
    var masterRatio: Double
    /// Relative sizes for the list layouts (columns, rows, master-stack's stack). Missing = 1.
    var weights: [WindowID: Double] = [:]

    init(kind: LayoutKind, masterRatio: Double = 0.55, tree: TileNode? = nil) {
        self.kind = kind
        self.masterRatio = masterRatio
        self.tree = tree
    }

    var windows: [WindowID] { tree?.leaves ?? [] }

    func contains(_ id: WindowID) -> Bool { tree?.contains(id) ?? false }

    func order(_ visible: Set<WindowID>) -> [WindowID] { tree?.visibleLeaves(visible) ?? [] }

    private func weight(_ id: WindowID) -> Double {
        guard let w = weights[id], w.isFinite, w > 0.01 else { return 1 }
        return w
    }

    // MARK: Edits

    /// Adds a window. `focused` is the window to place it next to (for `.afterFocused`).
    mutating func insert(_ id: WindowID, focused: WindowID?, placement: Placement,
                         area: CGRect, gap: CGFloat, visible: Set<WindowID>) {
        guard let tree else { self.tree = .leaf(id); return }
        guard !tree.contains(id) else { return }
        var vis = visible
        vis.remove(id)
        let order = tree.visibleLeaves(vis)
        let target: WindowID?
        var newFirst = false
        switch placement {
        case .afterFocused: target = focused.flatMap { order.contains($0) ? $0 : nil } ?? order.last
        case .end: target = order.last
        case .first: target = order.first; newFirst = true
        }
        guard let target else {
            // Nothing visible on this display (only windows of other Spaces).
            self.tree = .split(.horizontal, 0.5, tree, .leaf(id))
            return
        }
        let r = tree.frames(in: area, gap: gap, visible: vis)[target] ?? area
        self.tree = tree.splitting(target, with: id, axis: r.width >= r.height ? .horizontal : .vertical, newFirst: newFirst)
    }

    mutating func remove(_ id: WindowID) {
        tree = tree?.removing(id)
        weights.removeValue(forKey: id)
    }

    mutating func swap(_ a: WindowID, _ b: WindowID) {
        tree = tree?.swapping(a, b)
        let wa = weights[a], wb = weights[b]
        weights[a] = wb
        weights[b] = wa
    }

    /// Puts `new` where `old` was (e.g. a native tab replacing another one).
    mutating func replace(_ old: WindowID, with new: WindowID) {
        guard old != new, contains(old) else { return }
        // A window must never appear twice in the tree.
        if contains(new) { remove(new) }
        tree = tree?.replacing(old, with: .leaf(new))
        weights[new] = weights.removeValue(forKey: old)
    }

    /// Swaps the window with the master (or, if it is the master, with the next one).
    mutating func promote(_ id: WindowID, visible: Set<WindowID>) -> Bool {
        let order = order(visible)
        guard order.count > 1, order.contains(id) else { return false }
        swap(id, id == order[0] ? order[1] : order[0])
        return true
    }

    mutating func toggleSplitAxis(_ id: WindowID, visible: Set<WindowID>) -> Bool {
        guard kind == .tiles, let t = tree?.togglingAxis(of: id, visible: visible) else { return false }
        tree = t
        return true
    }

    mutating func balance(masterRatio: Double, visible: Set<WindowID>) {
        tree = tree?.balanced(visible: visible)
        weights = [:]
        self.masterRatio = masterRatio
    }

    /// Resize command: grow (delta > 0) or shrink the window by `delta` (fraction of the area).
    mutating func grow(_ id: WindowID, by delta: Double, visible: Set<WindowID>) -> Bool {
        let order = order(visible)
        guard order.count > 1, order.contains(id) else { return false }
        switch kind {
        case .tiles:
            guard let t = tree?.adjustingRatio(of: id, by: delta, visible: visible) else { return false }
            tree = t
        case .masterStack:
            masterRatio = LayoutMath.clampRatio(id == order[0] ? masterRatio + delta : masterRatio - delta)
        case .columns, .rows:
            let ids = order
            let total = ids.reduce(0) { $0 + weight($1) }
            let share = weight(id) / total
            let newShare = min(max(share + delta, 0.05), 0.95)
            guard share < 1 else { return false }
            let scaleOthers = (1 - newShare) / (1 - share)
            for other in ids {
                weights[other] = other == id
                    ? newShare * Double(ids.count)
                    : weight(other) / total * scaleOthers * Double(ids.count)
            }
        case .monocle:
            return false
        }
        return true
    }

    // MARK: Geometry

    func frames(area: CGRect, gap: CGFloat, visible: Set<WindowID>) -> [WindowID: CGRect] {
        guard let tree else { return [:] }
        let order = tree.visibleLeaves(visible)
        guard !order.isEmpty else { return [:] }
        switch kind {
        case .tiles:
            return tree.frames(in: area, gap: gap, visible: visible)
        case .monocle:
            return Dictionary(order.map { ($0, area) }, uniquingKeysWith: { a, _ in a })
        case .columns, .rows:
            let rects = LayoutMath.distribute(area, kind == .columns ? .horizontal : .vertical,
                                              weights: order.map(weight), gap: gap)
            return Dictionary(zip(order, rects).map { ($0, $1) }, uniquingKeysWith: { a, _ in a })
        case .masterStack:
            guard order.count > 1 else { return [order[0]: area] }
            let (masterRect, stackRect) = LayoutMath.split(area, .horizontal, ratio: masterRatio, gap: gap)
            var out = [order[0]: masterRect]
            let stack = Array(order.dropFirst())
            for (id, r) in zip(stack, LayoutMath.distribute(stackRect, .vertical, weights: stack.map(weight), gap: gap)) {
                out[id] = r
            }
            return out
        }
    }

    /// Adapts ratios/weights after the user resized window `id` from `old` to `new`.
    /// Returns false when nothing could be adjusted.
    mutating func applyUserResize(_ id: WindowID, from old: CGRect, to new: CGRect,
                                  area: CGRect, gap: CGFloat, visible: Set<WindowID>) -> Bool {
        let threshold: CGFloat = 2
        var edges: [(Direction, CGFloat)] = []
        if abs(new.minX - old.minX) > threshold { edges.append((.left, new.minX)) }
        if abs(new.maxX - old.maxX) > threshold { edges.append((.right, new.maxX)) }
        if abs(new.minY - old.minY) > threshold { edges.append((.up, new.minY)) }
        if abs(new.maxY - old.maxY) > threshold { edges.append((.down, new.maxY)) }
        var changed = false
        for (edge, coord) in edges {
            if applyEdge(id, edge, coord, area: area, gap: gap, visible: visible) { changed = true }
        }
        return changed
    }

    private mutating func applyEdge(_ id: WindowID, _ edge: Direction, _ coord: CGFloat,
                                    area: CGRect, gap: CGFloat, visible: Set<WindowID>) -> Bool {
        let order = order(visible)
        guard order.count > 1, let index = order.firstIndex(of: id) else { return false }
        switch kind {
        case .tiles:
            guard let t = tree?.settingEdge(of: id, edge: edge, to: coord, in: area, gap: gap, visible: visible) else { return false }
            tree = t
            return true
        case .monocle:
            return false
        case .columns, .rows:
            let axis: Axis = kind == .columns ? .horizontal : .vertical
            guard edge.axis == axis else { return false }
            return setListBoundary(order, index: index, edge: edge, coord: coord, rect: area, axis: axis, gap: gap)
        case .masterStack:
            let avail = area.width - gap
            if edge.axis == .horizontal {
                guard avail > 0 else { return false }
                if index == 0 && edge == .right {
                    masterRatio = LayoutMath.clampRatio(Double((coord - area.minX) / avail))
                    return true
                }
                if index > 0 && edge == .left {
                    masterRatio = LayoutMath.clampRatio(Double((coord - gap - area.minX) / avail))
                    return true
                }
                return false
            }
            guard index > 0 else { return false }
            let stackRect = LayoutMath.split(area, .horizontal, ratio: masterRatio, gap: gap).1
            return setListBoundary(Array(order.dropFirst()), index: index - 1, edge: edge, coord: coord,
                                   rect: stackRect, axis: .vertical, gap: gap)
        }
    }

    /// Moves the boundary between two neighbours of a weighted list.
    private mutating func setListBoundary(_ ids: [WindowID], index: Int, edge: Direction, coord: CGFloat,
                                          rect: CGRect, axis: Axis, gap: CGFloat) -> Bool {
        // Boundary k lies between ids[k] and ids[k+1].
        let k = edge.isForward ? index : index - 1
        guard k >= 0, k + 1 < ids.count else { return false }
        let rects = LayoutMath.distribute(rect, axis, weights: ids.map(weight), gap: gap)
        var sizes = rects.map { axis == .horizontal ? $0.width : $0.height }
        let start = axis == .horizontal ? rects[k].minX : rects[k].minY
        let pair = sizes[k] + sizes[k + 1]
        let minSize = min(80, pair / 4)
        let firstSize = edge.isForward ? coord - start : coord - gap - start
        sizes[k] = min(max(firstSize, minSize), pair - minSize)
        sizes[k + 1] = pair - sizes[k]
        let mean = sizes.reduce(0, +) / CGFloat(sizes.count)
        guard mean > 0 else { return false }
        for (id, s) in zip(ids, sizes) { weights[id] = Double(s / mean) }
        return true
    }
}

// MARK: - Direction-based neighbour finding

enum Neighbor {
    /// The candidate closest to `source` in `direction`.
    ///
    /// Candidates strictly beyond the source's edge win over ones that merely
    /// have their centre further along (overlapping floating windows). Among
    /// those, windows overlapping the source on the perpendicular axis win;
    /// then the nearest edge; ties go to the lower `rank` (e.g. most recently used).
    static func find<ID: Hashable>(from source: CGRect, direction: Direction,
                                   candidates: [(ID, CGRect)], rank: [ID: Int] = [:]) -> ID? {
        let slop: CGFloat = 2
        func distance(_ c: CGRect) -> CGFloat {
            switch direction {
            case .left: source.minX - c.maxX
            case .right: c.minX - source.maxX
            case .up: source.minY - c.maxY
            case .down: c.minY - source.maxY
            }
        }
        func centreAhead(_ c: CGRect) -> Bool {
            switch direction {
            case .left: c.midX < source.midX - 1
            case .right: c.midX > source.midX + 1
            case .up: c.midY < source.midY - 1
            case .down: c.midY > source.midY + 1
            }
        }
        func overlap(_ c: CGRect) -> CGFloat {
            direction.axis == .horizontal
                ? min(source.maxY, c.maxY) - max(source.minY, c.minY)
                : min(source.maxX, c.maxX) - max(source.minX, c.minX)
        }
        let strict = candidates.filter { distance($0.1) >= -slop }
        let pool = strict.isEmpty ? candidates.filter { centreAhead($0.1) } : strict
        guard !pool.isEmpty else { return nil }

        let overlapping = pool.filter { overlap($0.1) > 0 }
        if !overlapping.isEmpty {
            return overlapping.min { a, b in
                let da = max(0, distance(a.1)), db = max(0, distance(b.1))
                if abs(da - db) > slop { return da < db }
                let ra = rank[a.0] ?? Int.max, rb = rank[b.0] ?? Int.max
                if ra != rb { return ra < rb }
                // Prefer the one aligned with the source's top / left.
                return direction.axis == .horizontal
                    ? abs(a.1.minY - source.minY) < abs(b.1.minY - source.minY)
                    : abs(a.1.minX - source.minX) < abs(b.1.minX - source.minX)
            }?.0
        }
        let centre = CGPoint(x: source.midX, y: source.midY)
        return pool.min { a, b in
            hypot(a.1.midX - centre.x, a.1.midY - centre.y) < hypot(b.1.midX - centre.x, b.1.midY - centre.y)
        }?.0
    }

    /// Previous/next in a cyclic order (monocle focus/move).
    static func cycle<ID: Equatable>(_ order: [ID], from id: ID, forward: Bool) -> ID? {
        guard order.count > 1, let i = order.firstIndex(of: id) else { return nil }
        return order[(i + (forward ? 1 : order.count - 1)) % order.count]
    }
}
