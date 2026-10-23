import AppKit
import Testing
@testable import Launcher

@Test func entryDecodesWithOnlyTarget() throws {
    let json = #"{"entries":[{"target":"Safari","shortcut":"ctrl+opt+cmd+1"},{"kind":"url","target":"https://github.com"}]}"#
    let s = try JSONDecoder().decode(LauncherSettings.self, from: Data(json.utf8))
    #expect(s.entries.count == 2)
    #expect(s.entries[0].kind == .app)
    #expect(s.entries[0].behavior == .toggle)
    #expect(s.entries[0].actionID == "launcher.safari")
    #expect(s.entries[1].kind == .url)
    #expect(s.entries[1].displayName == "github.com")
}

@Test func unknownBehaviorFallsBackToToggle() throws {
    let json = #"{"target":"Notes","behavior":"bogus"}"#
    let e = try JSONDecoder().decode(LauncherEntry.self, from: Data(json.utf8))
    #expect(e.behavior == .toggle)
}

@Test func resolvesSystemAppsByNameAndBundleID() {
    #expect(AppResolver.url(for: "Finder") != nil)
    #expect(AppResolver.url(for: "com.apple.finder") != nil)
    #expect(AppResolver.url(for: "definitely-not-an-app-xyz") == nil)
}

@Test func newEntriesGetStableKeys() {
    let e = LauncherEntry(target: "com.apple.Safari")
    #expect(e.key != nil)
    #expect(e.actionID.hasPrefix("launcher."))
}

@Test func malformedEntriesAreSkippedNotFatal() throws {
    let json = #"{"entries":[{"target":"Safari","shortcut":"hyper+s"},{"shortcut":"hyper+x"},42,{"target":"Notes","shortcut":7,"name":false,"kind":"bogus"}]}"#
    let s = try JSONDecoder().decode(LauncherSettings.self, from: Data(json.utf8))
    #expect(s.entries.map(\.target) == ["Safari", "Notes"])
    #expect(s.entries[1].shortcut == nil)   // wrong type -> missing, entry kept
    #expect(s.entries[1].kind == .app)
    let notAnArray = try JSONDecoder().decode(LauncherSettings.self, from: Data(#"{"entries":"oops"}"#.utf8))
    #expect(notAnArray.entries.isEmpty)
}

@Test func duplicateEntriesGetUniqueActionIDs() throws {
    let json = #"{"entries":[{"target":"Safari"},{"target":"safari"},{"target":"Safari"},{"key":"x","target":"A"},{"key":"x","target":"B"},{"target":""},{"target":"  "}]}"#
    let s = try JSONDecoder().decode(LauncherSettings.self, from: Data(json.utf8))
    let ids = s.entries.map(\.actionID)
    #expect(Set(ids).count == ids.count)
    #expect(ids[0] == "launcher.safari")
    #expect(ids[1] == "launcher.safari-2")
    #expect(ids[2] == "launcher.safari-3")
    #expect(ids[3] == "launcher.x")
    #expect(ids[4] == "launcher.x-2")
    // Stable across a save/load round trip.
    let again = try JSONDecoder().decode(LauncherSettings.self, from: JSONEncoder().encode(s))
    #expect(again.entries.map(\.actionID) == ids)
}

@Test func urlEntriesAcceptBareHostsAndSchemes() {
    #expect(Launcher.url(from: "github.com")?.absoluteString == "https://github.com")
    #expect(Launcher.url(from: "https://github.com/x")?.absoluteString == "https://github.com/x")
    #expect(Launcher.url(from: "localhost:3000")?.absoluteString == "https://localhost:3000")
    #expect(Launcher.url(from: "raycast://extensions")?.scheme == "raycast")
    #expect(Launcher.url(from: "mailto:a@b.c")?.scheme == "mailto")
    #expect(Launcher.url(from: "x-apple.systempreferences:com.apple.preference.security")?.scheme == "x-apple.systempreferences")
    #expect(Launcher.url(from: "") == nil)
    #expect(Launcher.url(from: "not a url") == nil)
    #expect(LauncherEntry(kind: .url, target: "github.com").displayName == "github.com")
}

@Test func missingAndRenamedAppsResolveSafely() throws {
    #expect(AppResolver.url(for: "") == nil)
    #expect(AppResolver.url(for: "   ") == nil)
    #expect(AppResolver.url(for: "/definitely/not/here.app") == nil)
    #expect(AppResolver.url(for: "com.example.does-not-exist") == nil)
    #expect(AppResolver.url(for: "Finder.app") != nil)
    // A path target whose app is moved away stops resolving (cache is checked).
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-app-\(UUID().uuidString)")
    let app = dir.appendingPathComponent("Fake.app")
    try FileManager.default.createDirectory(at: app, withIntermediateDirectories: true)
    #expect(AppResolver.url(for: app.path) != nil)
    try FileManager.default.moveItem(at: app, to: dir.appendingPathComponent("Renamed.app"))
    #expect(AppResolver.url(for: app.path) == nil)
    let missing = LauncherEntry(target: "definitely-not-an-app-xyz")
    #expect(missing.displayName == "definitely-not-an-app-xyz")
    #expect(missing.actionTitle == "Open definitely-not-an-app-xyz")
}

@Test func entryWithEmptyTargetHasAUsableID() throws {
    let e = try JSONDecoder().decode(LauncherEntry.self, from: Data(#"{"target":""}"#.utf8))
    #expect(e.actionID == "launcher.entry")
}

// MARK: - App picker

private func app(_ name: String, _ bundleID: String?, path: String? = nil, running: Bool = false) -> AppCandidate {
    AppCandidate(url: URL(fileURLWithPath: path ?? "/Applications/\(name).app"), name: name, bundleID: bundleID, isRunning: running)
}

@Test func runningAndInstalledCopiesOfAnAppMergeIntoOneTile() {
    let running = [app("Safari", "com.apple.Safari", running: true), app("Tool", nil, path: "/tmp/x/Tool.app", running: true)]
    let installed = [
        app("Safari", "COM.APPLE.SAFARI", path: "/Applications/Old/Safari.app"),   // same app, other copy
        app("Tool", nil, path: "/tmp/x/../x/Tool.app"),                           // same path, spelled differently
        app("Notes", "com.apple.Notes"),
        app("Notes", "com.apple.Notes", path: "/System/Applications/Notes.app"),  // second copy is ignored
        app("safari", "org.other.safari", path: "/Applications/CrossOver/Safari.app"), // named like a running app
    ]
    let merged = AppPicker.merge(running: running, installed: installed)
    #expect(merged.map(\.name) == ["Safari", "Tool", "Notes"])
    #expect(merged[0].url.path == "/Applications/Safari.app")   // the running copy wins
    #expect(merged.prefix(2).allSatisfy { $0.isRunning })
    #expect(!merged[2].isRunning)
    // Installed apps are deduplicated the same way when the index is built.
    #expect(InstalledAppIndex.dedup(installed).map(\.name) == ["Safari", "Tool", "Notes"])
}

@Test func installedAppsWithTheSameNameKeepThePreferredCopy() {
    // Folder scan order first (/Applications), then a CrossOver wrapper and a staging copy.
    let apps = [app("Epic Games Launcher", "com.epicgames.EpicGamesLauncher"),
                app("Epic Games Launcher", "com.codeweavers.epic", path: "/Users/x/Applications/CrossOver/Epic Games Launcher.app"),
                app("epic games launcher", nil, path: "/Users/x/Elsewhere/Epic Games Launcher.app"),
                app("Chess", "com.apple.Chess")]
    #expect(InstalledAppIndex.dedup(apps).map(\.url.path) == ["/Applications/Epic Games Launcher.app", "/Applications/Chess.app"])
}

@Test func symlinkedAppIsTheSameAppAsItsTarget() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-link-\(UUID().uuidString)")
    let real = dir.appendingPathComponent("Real.app")
    try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
    let link = dir.appendingPathComponent("Link.app")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
    defer { try? FileManager.default.removeItem(at: dir) }
    let merged = AppPicker.merge(running: [AppCandidate(url: real, name: "Real", bundleID: nil)],
                                 installed: [AppCandidate(url: link, name: "Link", bundleID: nil)])
    #expect(merged.count == 1)
}

@Test func emptyQueryShowsRunningAppsByName() {
    let apps = [app("Zed", "dev.zed", running: true), app("Notes", "com.apple.Notes"), app("arc", "company.arc", running: true),
                app("Mail", "com.apple.mail", running: true)]
    #expect(AppPicker.results(apps, query: "", limit: 10).map(\.name) == ["arc", "Mail", "Zed"])
    #expect(AppPicker.results(apps, query: "   ", limit: 10).map(\.name) == ["arc", "Mail", "Zed"])
}

@Test func searchRanksExactThenPrefixThenWordsThenInitialsThenSubstringThenFuzzy() {
    let apps = [
        app("Xcode", "com.apple.dt.Xcode"),
        app("Visual Studio Code", "com.microsoft.VSCode"),
        app("Code", "x.code"),
        app("Codex", "com.openai.codex"),
        app("Decoder", "y.decoder"),
        app("Cyberduck", "ch.sudo.cyberduck"),
        app("Safari", "com.apple.Safari"),
    ]
    #expect(AppPicker.results(apps, query: "code", limit: 10).map(\.name)
            == ["Code", "Codex", "Visual Studio Code", "Xcode", "Decoder"])
    #expect(AppPicker.results(apps, query: "vsc", limit: 10).first?.name == "Visual Studio Code")
    #expect(AppPicker.results(apps, query: "xcd", limit: 10).map(\.name) == ["Xcode"])         // subsequence
    #expect(AppPicker.results(apps, query: "vscode", limit: 10).map(\.name) == ["Visual Studio Code"]) // bundle id / fuzzy
    #expect(AppPicker.results(apps, query: "CODE", limit: 2).map(\.name) == ["Code", "Codex"])  // case, limit
    #expect(AppPicker.results(apps, query: "nothing-like-it", limit: 10).isEmpty)
}

@Test func fuzzyMatchesSkipOnlyAFewLetters() {
    let apps = [app("Chess", "com.apple.Chess"), app("Keychain Access", "com.apple.keychainaccess"),
                app("Chrome Remote Desktop Host Uninstaller", "com.google.chromeremotedesktop.uninstaller")]
    #expect(AppPicker.results(apps, query: "chess", limit: 10).map(\.name) == ["Chess"])
    #expect(AppPicker.score("safr", name: "Safari", bundleID: nil) == 402)      // one letter skipped
    #expect(AppPicker.score("sfri", name: "Safari", bundleID: nil) == 401)      // two
    #expect(AppPicker.score("ka", name: "Keychain Access", bundleID: nil) == 700)  // initials
    #expect(AppPicker.score("kcs", name: "Keychain Access", bundleID: nil) == nil) // too far apart
}

@Test func singleLetterOnlyMatchesWordStarts() {
    let apps = [app("Safari", "com.apple.Safari"), app("Notes", "com.apple.Notes"), app("System Settings", "com.apple.systempreferences")]
    #expect(AppPicker.results(apps, query: "s", limit: 10).map(\.name) == ["Safari", "System Settings"])
    #expect(AppPicker.results(apps, query: "e", limit: 10).isEmpty)
}

@Test func runningAppsComeFirstWithinAMatchTier() {
    let apps = [app("Terminal", "com.apple.Terminal"), app("Telegram", "ru.keepcoder.Telegram", running: true),
                app("Te", "x.te")]
    // "Te" is an exact match: a tier above, so running doesn't beat it.
    #expect(AppPicker.results(apps, query: "te", limit: 10).map(\.name) == ["Te", "Telegram", "Terminal"])
}

@Test func searchIgnoresDiacriticsAndSplitsCamelCase() {
    #expect(AppPicker.words("OmniFocus 4") == ["omni", "focus", "4"])
    #expect(AppPicker.words("iTerm") == ["i", "term"])
    #expect(AppPicker.words("Microsoft Word") == ["microsoft", "word"])
    #expect(AppPicker.score("focus", name: "OmniFocus", bundleID: nil) == 800)
    #expect(AppPicker.score("cafe", name: "Café Menu", bundleID: nil) == 900)
    #expect(AppPicker.score("menu", name: "Café Menu", bundleID: nil) == 800)
    #expect(AppPicker.subsequenceGaps("xcd", in: "xcode") == 1)
    #expect(AppPicker.subsequenceGaps("xz", in: "xcode") == nil)
}

@Test func boundAppsMatchEntriesByBundleIDPathOrName() {
    let entries = [
        LauncherEntry(kind: .app, target: "com.apple.Safari", shortcut: "hyper+s"),
        LauncherEntry(kind: .app, target: "Notes.app"),
        LauncherEntry(kind: .app, target: "/Applications/Tool.app"),
        LauncherEntry(kind: .app, target: "Mail"),                       // resolved below to a bundle id
        LauncherEntry(kind: .url, target: "com.apple.Music"),            // not an app entry
        LauncherEntry(kind: .app, target: "com.apple.Safari", shortcut: "hyper+x"), // later duplicate loses
    ]
    let resolve: (String) -> URL? = { $0 == "Mail" ? URL(fileURLWithPath: "/System/Applications/Mail.app") : nil }
    let bundleID: (URL) -> String? = { $0.lastPathComponent == "Mail.app" ? "com.apple.mail" : nil }
    let bound = BoundApps(entries, resolve: resolve, bundleID: bundleID)
    #expect(bound.entry(for: app("Safari", "com.apple.safari"))?.shortcut == "hyper+s")
    #expect(bound.entry(for: app("Notes", "com.apple.Notes"))?.target == "Notes.app")
    #expect(bound.entry(for: app("Tool", nil, path: "/Applications/Tool.app"))?.target == "/Applications/Tool.app")
    #expect(bound.entry(for: app("Electronic Mail", "com.apple.mail", path: "/Other/Mail.app"))?.target == "Mail")
    #expect(bound.entry(for: app("Music", "com.apple.Music")) == nil)
    #expect(bound.entry(for: app("Calendar", "com.apple.iCal")) == nil)
}

@Test func aNameThatOpensOneAppDoesNotBindAnotherWithTheSameName() {
    // "Notes" opens Apple's Notes; a different app also called Notes isn't bound
    // to it (picking it would otherwise record over Apple Notes' shortcut).
    let entries = [LauncherEntry(kind: .app, target: "Notes", shortcut: "hyper+n"),
                   LauncherEntry(kind: .app, target: "Ghost", shortcut: "hyper+g")]  // opens nothing installed
    let resolve: (String) -> URL? = { $0 == "Notes" ? URL(fileURLWithPath: "/System/Applications/Notes.app") : nil }
    let bundleID: (URL) -> String? = { $0.lastPathComponent == "Notes.app" ? "com.apple.Notes" : nil }
    let bound = BoundApps(entries, resolve: resolve, bundleID: bundleID)
    #expect(bound.entry(for: app("Notes", "com.apple.Notes", path: "/System/Applications/Notes.app"))?.shortcut == "hyper+n")
    #expect(bound.entry(for: app("Notes", "com.example.notes", path: "/Applications/Notes.app")) == nil)
    // A name that opens nothing can only be matched by name.
    #expect(bound.entry(for: app("Ghost", "com.example.ghost"))?.shortcut == "hyper+g")
}

@Test func aRejectedCopyDoesNotHideAnotherAppWithItsName() {
    // The renamed copy of Code is dropped as a duplicate; the unrelated Editor still gets a tile.
    let apps = [app("Code", "id.a"), app("Editor", "id.a", path: "/Applications/Old/Editor.app"), app("Editor", "id.b")]
    #expect(InstalledAppIndex.dedup(apps).map(\.id) == ["id.a", "id.b"])
}

@Test func gridColumnsFitTheWidth() {
    #expect(GridNavigation.columns(width: 0, minTile: 80, spacing: 8) == 1)
    #expect(GridNavigation.columns(width: 50, minTile: 80, spacing: 8) == 1)
    #expect(GridNavigation.columns(width: 80, minTile: 80, spacing: 8) == 1)
    #expect(GridNavigation.columns(width: 168, minTile: 80, spacing: 8) == 2)
    #expect(GridNavigation.columns(width: 167, minTile: 80, spacing: 8) == 1)
    #expect(GridNavigation.columns(width: 600, minTile: 80, spacing: 8) == 6)
}

@Test func arrowKeysMoveThroughTheGrid() {
    // 10 tiles in 4 columns:  0 1 2 3 / 4 5 6 7 / 8 9
    let move = { (i: Int?, m: GridMove) in GridNavigation.move(i, m, count: 10, columns: 4) }
    #expect(move(nil, .down) == 0)          // nothing selected: any arrow selects the first
    #expect(move(42, .left) == 0)           // stale index
    #expect(move(0, .left) == 0)            // edges stop
    #expect(move(0, .up) == 0)
    #expect(move(9, .right) == 9)
    #expect(move(3, .right) == 4)           // wraps to the next row
    #expect(move(4, .left) == 3)
    #expect(move(1, .down) == 5)
    #expect(move(5, .down) == 9)
    #expect(move(6, .down) == 9)            // short last row: the last tile
    #expect(move(7, .down) == 9)
    #expect(move(9, .down) == 9)
    #expect(move(8, .up) == 4)
    #expect(move(9, .up) == 5)
    #expect(GridNavigation.move(0, .down, count: 0, columns: 4) == nil)
    #expect(GridNavigation.move(2, .down, count: 3, columns: 1) == 2)
    #expect(GridNavigation.move(0, .down, count: 3, columns: 1) == 1)
    #expect(GridNavigation.move(0, .down, count: 3, columns: 0) == 1)   // bogus column count
    #expect(GridNavigation.move(1, .down, count: 3, columns: 4) == 1)   // one row
}

@Test func spotlightResultsKeepOnlyAppsPeopleLaunch() {
    let home = NSHomeDirectory()
    #expect(InstalledAppIndex.isUserFacing("/Applications/Safari.app"))
    #expect(InstalledAppIndex.isUserFacing("/Applications/Setapp/CleanShot X.app"))
    #expect(InstalledAppIndex.isUserFacing(home + "/Applications/Chrome Apps.localized/YouTube.app"))
    #expect(InstalledAppIndex.isUserFacing("/opt/homebrew/opt/bento/Bento.app"))
    #expect(InstalledAppIndex.isUserFacing("/System/Applications/Utilities/Terminal.app"))
    #expect(InstalledAppIndex.isUserFacing("/System/Library/CoreServices/Finder.app"))
    #expect(InstalledAppIndex.isUserFacing("/System/Library/CoreServices/Applications/Screen Sharing.app"))
    #expect(InstalledAppIndex.isUserFacing("/Applications/Xcode.app/Contents/Developer/Applications/Simulator.app"))
    #expect(InstalledAppIndex.isUserFacing("/Applications/Xcode.app/Contents/Applications/Instruments.app"))
    #expect(!InstalledAppIndex.isUserFacing("/Applications/Slack.app/Contents/Frameworks/Slack Helper.app"))
    #expect(!InstalledAppIndex.isUserFacing("/Applications/Xcode.app/Contents/Applications/X.app/Contents/Helper.app"))
    #expect(!InstalledAppIndex.isUserFacing("/System/Library/CoreServices/Dock.app"))
    #expect(!InstalledAppIndex.isUserFacing("/Library/Application Support/Vendor/Updater.app"))
    #expect(!InstalledAppIndex.isUserFacing(home + "/Library/Caches/Thing/Installer.app"))
    #expect(!InstalledAppIndex.isUserFacing("/Volumes/Some Installer/Some.app"))
    #expect(!InstalledAppIndex.isUserFacing("/Users/Shared/UnrealEngine/Launcher/SelfUpdateStaging/Install/Epic Games Launcher.app"))
    #expect(!InstalledAppIndex.isUserFacing(home + "/.Trash/Old.app"))
    #expect(!InstalledAppIndex.isUserFacing(home + "/Library/Developer/Xcode/DerivedData/X/Build/Products/Debug/X.app"))
}

@Test func installedIndexReadsBundlesAndSkipsBackgroundOnlyApps() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-apps-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    func make(_ name: String, _ info: [String: Any]) throws -> URL {
        let url = dir.appendingPathComponent("\(name).app")
        try FileManager.default.createDirectory(at: url.appendingPathComponent("Contents"), withIntermediateDirectories: true)
        try (info as NSDictionary).write(to: url.appendingPathComponent("Contents/Info.plist"))
        return url
    }
    let visible = try make("Visible", ["CFBundleIdentifier": "test.visible"])
    let agent = try make("Agent", ["CFBundleIdentifier": "test.agent", "LSBackgroundOnly": true])
    let agent2 = try make("Agent2", ["CFBundleIdentifier": "test.agent2", "LSBackgroundOnly": "1"])
    let bare = try make("Bare", [:])
    let gone = dir.appendingPathComponent("Gone.app")
    let apps = InstalledAppIndex.candidates([visible, agent, agent2, bare, gone, visible])
    #expect(apps.map(\.name) == ["Visible", "Bare"])
    #expect(apps[0].bundleID == "test.visible")
    #expect(apps[0].id == "test.visible")
    #expect(apps[1].bundleID == nil)
    #expect(apps[1].id == AppPicker.pathKey(bare.path))
}

@Test func aliasesAndSymlinksStandForTheirApp() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("bento-alias-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let real = dir.appendingPathComponent("Real/Tool.app")
    try FileManager.default.createDirectory(at: real.appendingPathComponent("Contents"), withIntermediateDirectories: true)
    try (["CFBundleIdentifier": "test.tool"] as NSDictionary).write(to: real.appendingPathComponent("Contents/Info.plist"))
    let alias = dir.appendingPathComponent("Tool alias.app")
    try URL.writeBookmarkData(try real.bookmarkData(options: .suitableForBookmarkFile), to: alias)
    let link = dir.appendingPathComponent("Tool link.app")
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
    let broken = dir.appendingPathComponent("Broken.app")
    try FileManager.default.createSymbolicLink(at: broken, withDestinationURL: dir.appendingPathComponent("gone/Missing.app"))
    let notAnApp = dir.appendingPathComponent("Notes alias.app")
    try URL.writeBookmarkData(try dir.bookmarkData(options: .suitableForBookmarkFile), to: notAnApp)

    let viaAlias = InstalledAppIndex.candidates([alias])
    #expect(viaAlias.map(\.bundleID) == ["test.tool"])
    #expect(viaAlias.first?.pathKey == AppPicker.pathKey(real.path))
    #expect(InstalledAppIndex.candidates([link]).map(\.bundleID) == ["test.tool"])
    #expect(InstalledAppIndex.candidates([broken, notAnApp]).isEmpty)
    #expect(InstalledAppIndex.candidates([alias, link, real]).count == 1)
}

@Test func folderScanFindsSystemApps() {
    let apps = InstalledAppIndex.candidates(InstalledAppIndex.scanFolders())
    #expect(apps.contains { $0.bundleID == "com.apple.finder" })
    #expect(apps.contains { $0.bundleID?.lowercased() == "com.apple.calculator" })
    #expect(Set(apps.map(\.id)).count == apps.count)
}

private func blank(_ px: Int) -> CGImage {
    CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!.makeImage()!
}

/// What Quick Look hands back for icons: 16 bits per component, extended sRGB.
private func wide(_ px: Int) -> CGImage {
    let info = CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder16Little.rawValue
    return CGContext(data: nil, width: px, height: px, bitsPerComponent: 16, bytesPerRow: 0,
                     space: CGColorSpace(name: CGColorSpace.extendedSRGB)!, bitmapInfo: info)!.makeImage()!
}

@Test func iconBitmapsAreKeptAtTwiceTheDrawnSize() {
    func pixels(_ image: NSImage) -> Int? { image.cgImage(forProposedRect: nil, context: nil, hints: nil)?.width }
    let big = IconCache.bitmap(blank(256), side: 48)
    #expect(big.size == NSSize(width: 48, height: 48))
    #expect(pixels(big) == 96)
    let small = IconCache.bitmap(blank(64), side: 48)   // never scaled up
    #expect(pixels(small) == 64)
    // Quick Look's 16-bit extended-sRGB icons become small 8-bit sRGB bitmaps.
    let source = wide(256)
    #expect(source.bitsPerComponent == 16)
    let converted = IconCache.bitmap(source, side: 48).cgImage(forProposedRect: nil, context: nil, hints: nil)
    #expect(converted?.width == 96)
    #expect(converted?.bitsPerComponent == 8)
    #expect(converted?.colorSpace?.name == CGColorSpace.sRGB)
}

@Test @MainActor func iconCacheLoadsIconsThroughQuickLook() async {
    let cache = IconCache()
    let finder = URL(fileURLWithPath: "/System/Library/CoreServices/Finder.app")
    let image = await cache.load(finder, side: 48)
    #expect(image?.size == NSSize(width: 48, height: 48))
    let pixels = image?.cgImage(forProposedRect: nil, context: nil, hints: nil)
    #expect(pixels?.width == 96)                 // not the service's 256 px
    #expect(pixels?.bitsPerComponent == 8)       // nor its 16-bit components
    #expect(cache.cached(finder, side: 48) != nil)
    #expect(cache.cached(finder, side: 24) == nil)
    cache.removeAll()
    #expect(cache.cached(finder, side: 48) == nil)
}
