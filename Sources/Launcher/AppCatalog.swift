import AppKit

/// An app the picker offers: running, installed, or both (one tile per app).
struct AppCandidate: Identifiable, Equatable {
    let url: URL
    let name: String
    let bundleID: String?
    var isRunning: Bool
    /// The bundle id when known (an app installed twice is still one app), else the path.
    let id: String
    /// Standardized, symlink-free path, for matching entries that name a path.
    let pathKey: String

    init(url: URL, name: String, bundleID: String?, isRunning: Bool = false) {
        self.url = url
        self.name = name
        self.bundleID = bundleID.flatMap { $0.isEmpty ? nil : $0 }
        self.isRunning = isRunning
        pathKey = AppPicker.pathKey(url.path)
        id = self.bundleID?.lowercased() ?? pathKey
    }
}

/// Picker logic: merging, ranking and matching. Pure, so it is unit-tested.
enum AppPicker {
    static func pathKey(_ path: String) -> String {
        URL(fileURLWithPath: (path as NSString).expandingTildeInPath).standardizedFileURL.resolvingSymlinksInPath().path
    }

    /// Running apps first (they carry the live location), then installed ones
    /// not already listed. The first of several copies of an app wins; an
    /// installed app named like a running one is taken to be another copy.
    static func merge(running: [AppCandidate], installed: [AppCandidate]) -> [AppCandidate] {
        var seen = Set<String>()
        var names = Set<String>()
        var out: [AppCandidate] = []
        for var app in running where seen.insert(app.id).inserted {
            app.isRunning = true
            names.insert(app.name.lowercased())
            out.append(app)
        }
        for app in installed where !names.contains(app.name.lowercased()) && seen.insert(app.id).inserted {
            out.append(app)
        }
        return out
    }

    /// What the grid shows: with no query the running apps by name, otherwise
    /// the best matches among all apps (running ones first within a match tier).
    static func results(_ apps: [AppCandidate], query: String, limit: Int) -> [AppCandidate] {
        let q = normalize(query)
        guard !q.isEmpty else {
            return apps.filter(\.isRunning).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        }
        let scored: [(score: Int, app: AppCandidate)] = apps.compactMap { app in
            score(q, name: app.name, bundleID: app.bundleID).map { ($0 + (app.isRunning ? 50 : 0), app) }
        }
        return scored.sorted { a, b in
            if a.score != b.score { return a.score > b.score }
            if a.app.name.count != b.app.name.count { return a.app.name.count < b.app.name.count }
            return a.app.name.localizedStandardCompare(b.app.name) == .orderedAscending
        }
        .prefix(limit).map(\.app)
    }

    static func normalize(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }

    /// How well a normalized query matches an app; nil = no match. Tiers are
    /// 100 apart so the running bonus (50) only reorders within a tier.
    static func score(_ q: String, name: String, bundleID: String?) -> Int? {
        guard !q.isEmpty else { return nil }
        let n = normalize(name)
        if n == q { return 1000 }
        if n.hasPrefix(q) { return 900 }
        let words = AppPicker.words(name)
        if words.dropFirst().contains(where: { $0.hasPrefix(q) }) { return 800 }
        // One letter only matches the start of a word: "s" shouldn't list every app with an s.
        guard q.count > 1 else { return nil }
        if String(words.compactMap(\.first)).hasPrefix(q) { return 700 }       // "vsc" → Visual Studio Code
        if n.contains(q) { return 600 }
        // Letters in order with a few skipped ("xcd" → Xcode); more is noise
        // ("chess" isn't Keychain Access).
        let compact = q.filter { !$0.isWhitespace }
        if let gaps = subsequenceGaps(compact, in: n), gaps <= maxGaps { return 400 + maxGaps - gaps }
        if let b = bundleID.map(normalize), b.contains(q) { return 300 }       // "vscode" → com.microsoft.VSCode
        return nil
    }

    static let maxGaps = 3

    /// Normalized words of a name, split at spaces/punctuation and camel case
    /// ("OmniFocus" → omni, focus; "iTerm" → i, term).
    static func words(_ name: String) -> [String] {
        var out: [String] = []
        var current = ""
        var prev: Character?
        for ch in name {
            if !(ch.isLetter || ch.isNumber) {
                if !current.isEmpty { out.append(current) }
                current = ""
            } else if ch.isUppercase, let p = prev, p.isLowercase {
                if !current.isEmpty { out.append(current) }
                current = String(ch)
            } else {
                current.append(ch)
            }
            prev = ch
        }
        if !current.isEmpty { out.append(current) }
        return out.map(normalize)
    }

    /// Characters skipped when `q` is read as a subsequence of `s`, or nil if it isn't one.
    static func subsequenceGaps(_ q: String, in s: String) -> Int? {
        guard !q.isEmpty else { return nil }
        var gaps = 0
        var qi = q.startIndex
        var started = false
        for ch in s {
            if qi == q.endIndex { break }
            if ch == q[qi] {
                qi = q.index(after: qi)
                started = true
            } else if started {
                gaps += 1
            }
        }
        return qi == q.endIndex ? gaps : nil
    }
}

/// Which launcher entry, if any, already opens a given app. Entries name
/// their app by bundle id, path or name; all three are matched.
struct BoundApps {
    private var byBundleID: [String: LauncherEntry] = [:]
    private var byPath: [String: LauncherEntry] = [:]
    private var byName: [String: LauncherEntry] = [:]

    init(_ entries: [LauncherEntry], resolve: (String) -> URL? = AppResolver.url(for:),
         bundleID: (URL) -> String? = AppResolver.bundleID(for:)) {
        for e in entries where e.kind == .app {
            let t = e.target.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !t.isEmpty else { continue }
            let lower = t.lowercased()
            if t.hasPrefix("/") || t.hasPrefix("~") {
                Self.add(e, AppPicker.pathKey(t), &byPath)
            } else {
                if lower.contains("."), !lower.hasSuffix(".app") { Self.add(e, lower, &byBundleID) }
                Self.add(e, lower.hasSuffix(".app") ? String(lower.dropLast(4)) : lower, &byName)
            }
            if let url = resolve(t) {
                Self.add(e, AppPicker.pathKey(url.path), &byPath)
                if let b = bundleID(url) { Self.add(e, b.lowercased(), &byBundleID) }
            }
        }
    }

    /// The first entry in list order wins (the one whose shortcut is shown).
    private static func add(_ e: LauncherEntry, _ key: String, _ map: inout [String: LauncherEntry]) {
        if map[key] == nil { map[key] = e }
    }

    func entry(for app: AppCandidate) -> LauncherEntry? {
        if let b = app.bundleID?.lowercased(), let e = byBundleID[b] { return e }
        if let e = byPath[app.pathKey] { return e }
        return byName[app.name.lowercased()]
    }
}

enum GridMove: Equatable { case left, right, up, down }

/// Arrow-key movement in a grid laid out row by row.
enum GridNavigation {
    static func columns(width: CGFloat, minTile: CGFloat, spacing: CGFloat) -> Int {
        guard width > 0 else { return 1 }
        return max(1, Int((width + spacing) / (minTile + spacing)))
    }

    /// The index after an arrow key. Selection stops at the edges; Down from a
    /// column the short last row doesn't reach goes to the last tile (like Finder).
    static func move(_ index: Int?, _ move: GridMove, count: Int, columns: Int) -> Int? {
        guard count > 0 else { return nil }
        guard let i = index, (0..<count).contains(i) else { return 0 }
        let cols = max(1, columns)
        switch move {
        case .left: return max(i - 1, 0)
        case .right: return min(i + 1, count - 1)
        case .up: return i >= cols ? i - cols : i
        case .down:
            if i + cols < count { return i + cols }
            return i / cols < (count - 1) / cols ? count - 1 : i
        }
    }
}

// MARK: - Installed apps

/// Installed apps for the picker's search: the usual app folders, then
/// whatever Spotlight knows about. Built when the picker appears and dropped
/// with it, so nothing runs (or stays in memory) while it isn't on screen.
final class InstalledAppIndex {
    private var query: NSMetadataQuery?
    private var observer: NSObjectProtocol?
    /// Bumped on cancel, so late background results are dropped.
    private var generation = 0

    deinit { stopQuery() }

    /// Calls `update` on the main queue with the folder scan (fast), then
    /// again with Spotlight's apps added.
    func build(_ update: @escaping ([AppCandidate]) -> Void) {
        cancel()
        let gen = generation
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let apps = InstalledAppIndex.candidates(InstalledAppIndex.scanFolders())
            DispatchQueue.main.async {
                guard let self, gen == self.generation else { return }
                update(apps)
                self.querySpotlight(gen: gen, known: apps, update: update)
            }
        }
    }

    func cancel() {
        generation += 1
        stopQuery()
    }

    private func querySpotlight(gen: Int, known: [AppCandidate], update: @escaping ([AppCandidate]) -> Void) {
        let q = NSMetadataQuery()
        q.predicate = NSPredicate(format: "%K == 'com.apple.application-bundle'", NSMetadataItemContentTypeKey)
        q.searchScopes = [NSMetadataQueryLocalComputerScope]
        observer = NotificationCenter.default.addObserver(forName: .NSMetadataQueryDidFinishGathering, object: q, queue: .main) { [weak self] _ in
            guard let self, gen == self.generation else { return }
            q.disableUpdates()
            let paths = (0..<q.resultCount).compactMap {
                (q.result(at: $0) as? NSMetadataItem)?.value(forAttribute: NSMetadataItemPathKey) as? String
            }
            self.stopQuery()
            DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                let knownPaths = Set(known.map(\.url.path))
                let extra = paths.filter { !knownPaths.contains($0) && InstalledAppIndex.isUserFacing($0) }
                let apps = InstalledAppIndex.dedup(known + InstalledAppIndex.candidates(extra.map { URL(fileURLWithPath: $0) }))
                DispatchQueue.main.async {
                    guard let self, gen == self.generation else { return }
                    update(apps)
                }
            }
        }
        query = q
        // No Spotlight (indexing off): the folder scan is all there is.
        if !q.start() { stopQuery() }
    }

    private func stopQuery() {
        query?.stop()
        query = nil
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
    }

    static var folders: [String] {
        let home = NSHomeDirectory()
        return ["/Applications", "/Applications/Utilities", "/System/Applications", "/System/Applications/Utilities",
                home + "/Applications", "/System/Library/CoreServices/Applications"]
    }

    /// Apps in the usual folders and one level of subfolders (e.g. "Setapp",
    /// "Chrome Apps"), plus Finder.
    static func scanFolders() -> [URL] {
        let fm = FileManager.default
        var out: [URL] = [URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app")]
        for dir in folders {
            guard let items = try? fm.contentsOfDirectory(atPath: dir) else { continue }
            for item in items.sorted() where !item.hasPrefix(".") {
                let url = URL(fileURLWithPath: dir).appendingPathComponent(item)
                if item.lowercased().hasSuffix(".app") {
                    out.append(url)
                } else if !folders.contains(url.path), let sub = try? fm.contentsOfDirectory(atPath: url.path) {
                    out += sub.sorted().filter { $0.lowercased().hasSuffix(".app") }.map { url.appendingPathComponent($0) }
                }
            }
        }
        return out
    }

    /// Spotlight also finds helpers, installers on disk images and apps in the
    /// trash: keep the ones a person would launch.
    static func isUserFacing(_ path: String) -> Bool {
        let home = NSHomeDirectory()
        for bad in ["/Volumes/", "/private/", "/Library/", "/Users/Shared/", home + "/Library/"] where path.hasPrefix(bad) { return false }
        for bad in ["/.Trash/", "/DerivedData/", "/.build/"] where path.contains(bad) { return false }
        if path.hasPrefix("/System/"), !(path.hasPrefix("/System/Applications/")
            || path.hasPrefix("/System/Library/CoreServices/Applications/")
            || path == "/System/Library/CoreServices/Finder.app") {
            return false
        }
        // Apps inside other bundles are helpers, except bundled companion
        // apps (Xcode's Simulator and Instruments).
        if let r = path.range(of: ".app/") {
            let inner = path[r.upperBound...]
            guard let prefix = ["Contents/Applications/", "Contents/Developer/Applications/"].first(where: inner.hasPrefix) else { return false }
            return !inner.dropFirst(prefix.count).contains("/")
        }
        return true
    }

    /// Reads names and bundle ids, skipping background-only apps. Finder
    /// aliases and symlinks (~/Applications often has them) stand for their app.
    static func candidates(_ urls: [URL]) -> [AppCandidate] {
        let fm = FileManager.default
        return dedup(urls.compactMap { link in
            var url = link
            if (try? link.resourceValues(forKeys: [.isAliasFileKey]))?.isAliasFile == true {
                guard let target = try? URL(resolvingAliasFileAt: link, options: [.withoutUI, .withoutMounting]),
                      target.pathExtension.lowercased() == "app" else { return nil }
                url = target
            }
            let info = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist")) as? [String: Any]
            guard !flag(info?["LSBackgroundOnly"]), fm.fileExists(atPath: url.path) else { return nil }
            var name = fm.displayName(atPath: url.path)
            if name.lowercased().hasSuffix(".app") { name = String(name.dropLast(4)) }
            return AppCandidate(url: url, name: name, bundleID: info?["CFBundleIdentifier"] as? String)
        })
    }

    /// One candidate per app: the first copy of a bundle id (or path) wins,
    /// and of several apps with the same name the one in the preferred place
    /// (the folder scan comes before Spotlight) — Add Other → Application…
    /// still reaches the others.
    static func dedup(_ apps: [AppCandidate]) -> [AppCandidate] {
        var seen = Set<String>()
        var names = Set<String>()
        return apps.filter { names.insert($0.name.lowercased()).inserted && seen.insert($0.id).inserted }
    }

    private static func flag(_ value: Any?) -> Bool {
        if let b = value as? Bool { return b }
        if let n = value as? NSNumber { return n.boolValue }
        if let s = value as? String { return ["1", "yes", "true"].contains(s.lowercased()) }
        return false
    }
}
