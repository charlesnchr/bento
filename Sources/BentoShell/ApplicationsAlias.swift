import AppKit
import BentoCore

/// Keeps a Finder alias to Bento at ~/Applications/Bento.app when Bento runs from
/// somewhere Spotlight can't see. Spotlight skips /opt (it has the hidden flag), so
/// a Homebrew install is invisible to it, and it never indexes symlinks. It does
/// index aliases, and Raycast and the "+" picker in System Settings follow them.
enum ApplicationsAlias {
    enum Existing: Equatable {
        case none
        case symlink(toBento: Bool)
        /// `current`: it already resolves to this copy.
        case alias(current: Bool, toBento: Bool)
        /// A real app or anything else the user put there.
        case other
    }

    enum Action: Equatable { case keep, write, replace }

    /// `bundlePath` is where this copy really runs from (symlinks resolved).
    static func action(bundlePath: String, home: String, existing: Existing,
                       realAppInApplications: Bool) -> Action {
        let indexed = ["/Applications/", home + "/Applications/"]
        if indexed.contains(where: bundlePath.hasPrefix) || realAppInApplications { return .keep }
        switch existing {
        case .none: return .write
        case .symlink(let toBento): return toBento ? .replace : .keep
        case .alias(let current, let toBento): return current ? .keep : (toBento ? .replace : .keep)
        case .other: return .keep
        }
    }

    static var url: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Bento.app")
    }

    /// Cheap enough for every launch: a few stat calls and, at most, one alias resolution.
    static func ensure() {
        let env = ProcessInfo.processInfo.environment
        guard env["BENTO_DEV"] == nil, env["BENTO_HOME"] == nil, Bundle.main.bundlePath.hasSuffix(".app"),
              let bundleID = Bundle.main.bundleIdentifier else { return }
        let bundle = Bundle.main.bundleURL.resolvingSymlinksInPath()
        // The stable Homebrew path (opt/bento) outlives the versioned keg this copy runs from.
        let target = Updater.shared.installedApp ?? bundle
        let realApp = (try? URL(fileURLWithPath: "/Applications/Bento.app").resourceValues(forKeys: [.isSymbolicLinkKey]))
            .map { $0.isSymbolicLink != true } ?? false
        let existing = inspect(url, bundle: bundle, bundleID: bundleID)
        let action = action(bundlePath: bundle.path, home: FileManager.default.homeDirectoryForCurrentUser.path,
                            existing: existing, realAppInApplications: realApp)
        guard action != .keep else { return }
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            if action == .replace { try FileManager.default.removeItem(at: url) }
            let data = try target.bookmarkData(options: .suitableForBookmarkFile, includingResourceValuesForKeys: nil, relativeTo: nil)
            try URL.writeBookmarkData(data, to: url)
            BentoLog.core.info("Alias for Spotlight: \(url.path, privacy: .public) -> \(target.path, privacy: .public)")
        } catch {
            BentoLog.core.error("Couldn't write \(url.path, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func inspect(_ url: URL, bundle: URL, bundleID: String) -> Existing {
        guard let values = try? url.resourceValues(forKeys: [.isSymbolicLinkKey, .isAliasFileKey]) else { return .none }
        func isBento(_ u: URL) -> Bool { Bundle(url: u)?.bundleIdentifier == bundleID }
        if values.isSymbolicLink == true { return .symlink(toBento: isBento(url.resolvingSymlinksInPath())) }
        if values.isAliasFile == true {
            guard let resolved = try? URL(resolvingAliasFileAt: url, options: [.withoutUI, .withoutMounting]) else {
                return .alias(current: false, toBento: true) // dangling: an old keg
            }
            let real = resolved.resolvingSymlinksInPath()
            return .alias(current: real.path == bundle.path, toBento: isBento(real))
        }
        return .other
    }
}
