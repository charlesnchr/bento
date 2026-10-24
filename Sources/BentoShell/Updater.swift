import AppKit
import BentoCore

/// Version and install-location rules for the updater, kept pure for tests.
enum UpdateRules {
    /// Numeric dotted versions, compared component by component ("0.10.0" > "0.9.1").
    /// Anything after the leading digits-and-dots (a "-dev" suffix) is ignored.
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ v: String) -> [Int] {
            v.prefix { $0.isNumber || $0 == "." }.split(separator: ".").map { Int($0) ?? 0 }
        }
        let a = parts(candidate), b = parts(current)
        for i in 0..<max(a.count, b.count) {
            let x = i < a.count ? a[i] : 0, y = i < b.count ? b[i] : 0
            if x != y { return x > y }
        }
        return false
    }

    /// The `version "x.y.z"` line of the Homebrew formula.
    static func formulaVersion(_ source: String) -> String? {
        for line in source.split(whereSeparator: \.isNewline) {
            let t = line.trimmingCharacters(in: .whitespaces)
            guard t.hasPrefix("version ") else { continue }
            let quoted = t.dropFirst("version ".count).trimmingCharacters(in: .whitespaces)
            guard quoted.count > 2, quoted.first == "\"", quoted.last == "\"" else { continue }
            let v = String(quoted.dropFirst().dropLast())
            if v.first?.isNumber == true, v.allSatisfy({ $0.isNumber || $0 == "." }) { return v }
        }
        return nil
    }

    /// The Homebrew prefix when `bundlePath` (symlinks resolved) is a keg's app:
    /// `<prefix>/Cellar/<formula>/<version>/Bento.app`.
    static func homebrewPrefix(forBundle bundlePath: String, formula: String = "bento") -> String? {
        let c = bundlePath.split(separator: "/", omittingEmptySubsequences: false)
        guard c.count >= 5, c[c.count - 1] == "Bento.app", c[c.count - 3] == formula, c[c.count - 4] == "Cellar" else { return nil }
        let prefix = c[..<(c.count - 4)].joined(separator: "/")
        return prefix.isEmpty ? nil : prefix
    }
}

/// Finds newer releases in the Homebrew tap and installs them with `brew upgrade`,
/// so Homebrew stays the only thing that writes the installed app. A copy that
/// isn't running from a Homebrew keg (a local build) is only told about them.
///
/// The tap's formula is the source of truth: it is exactly what `brew upgrade`
/// would install. Releases are all signed with the same certificate, so the new
/// app keeps the Accessibility and Screen Recording grants.
final class Updater: ObservableObject {
    static let shared = Updater()

    // BENTO_UPDATE_FORMULA(_URL) point a test copy at another tap.
    private static let env = ProcessInfo.processInfo.environment
    static let formula = env["BENTO_UPDATE_FORMULA"] ?? "charlesnchr/tap/bento"
    static let formulaURL = env["BENTO_UPDATE_FORMULA_URL"].flatMap(URL.init(string:))
        ?? URL(string: "https://raw.githubusercontent.com/charlesnchr/homebrew-tap/main/Formula/bento.rb")!
    static var formulaName: String { formula.split(separator: "/").last.map(String.init) ?? "bento" }
    static func releaseURL(_ version: String) -> URL {
        URL(string: "https://github.com/charlesnchr/bento/releases/tag/v\(version)")!
    }

    enum State: Equatable {
        case idle
        case checking
        case upToDate
        case available(String)
        case installing(String)
        /// A newer version is installed (by an update, or `brew upgrade` in a
        /// terminal) but this older copy is still running.
        case restartNeeded(String)
        case failed(String)
    }

    @Published private(set) var state: State = .idle
    @Published private(set) var lastChecked: Date?

    let currentVersion = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
    let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? ""
    /// Set when this copy runs from a Homebrew keg.
    let homebrewPrefix: String?
    var isHomebrew: Bool { homebrewPrefix != nil }
    /// The stable path of the Homebrew install (`<prefix>/opt/bento/Bento.app`).
    var installedApp: URL? { homebrewPrefix.map { URL(fileURLWithPath: "\($0)/opt/\(Self.formulaName)/Bento.app") } }
    var logURL: URL { AppPaths.supportDir.appendingPathComponent("update.log") }

    private var timer: Timer?
    private var started = false
    private static let checkInterval: TimeInterval = 24 * 3600
    private static let notifiedKey = "UpdaterNotifiedVersion"

    private init() {
        // Launched through /Applications/Bento.app or opt/bento: match the keg itself.
        let path = Bundle.main.bundlePath
        let real = realpath(path, nil).map { p in defer { free(p) }; return String(cString: p) } ?? path
        homebrewPrefix = UpdateRules.homebrewPrefix(forBundle: real, formula: Self.formulaName)
    }

    /// Dev harnesses never update.
    var isAvailable: Bool { ProcessInfo.processInfo.environment["BENTO_DEV"] == nil && Bundle.main.bundlePath.hasSuffix(".app") }

    var versionDescription: String { build.isEmpty ? currentVersion : "\(currentVersion) (\(build))" }

    func start(automatic: Bool) {
        guard isAvailable, !started else { return }
        started = true
        refreshInstalled()
        setAutomatic(automatic)
    }

    /// Daily checks, the first shortly after launch.
    func setAutomatic(_ on: Bool) {
        guard started else { return }
        guard on else { timer?.invalidate(); timer = nil; return }
        guard timer == nil else { return }
        let t = Timer(timeInterval: Self.checkInterval, repeats: true) { [weak self] _ in self?.check(.automatic) }
        t.tolerance = 3600
        RunLoop.main.add(t, forMode: .common)
        timer = t
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            if self?.timer != nil { self?.check(.automatic) }
        }
    }

    // MARK: Checking

    /// Who asked: automatic checks stay quiet except to announce a new version
    /// (once per version); the settings pane shows progress and errors inline;
    /// `bento://update` reports everything with a HUD.
    enum Origin { case automatic, settings, url }

    func check(_ origin: Origin = .automatic) {
        guard isAvailable else { return }
        switch state {
        case .checking, .installing: return
        default: break
        }
        if origin != .automatic { state = .checking }
        var request = URLRequest(url: Self.formulaURL, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        request.setValue("Bento/\(currentVersion)", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            // A file:// formula (tests) has no HTTP status.
            let status = (response as? HTTPURLResponse)?.statusCode ?? (error == nil && data != nil ? 200 : 0)
            let latest = data.flatMap { String(data: $0, encoding: .utf8) }.flatMap(UpdateRules.formulaVersion)
            DispatchQueue.main.async {
                guard let self else { return }
                // An automatic check that was in flight when Install was clicked.
                if case .installing = self.state { return }
                guard let latest, status == 200 else {
                    let why = error?.localizedDescription ?? (status == 200 ? "no version in the formula" : "HTTP \(status)")
                    BentoLog.core.error("Update check failed: \(why, privacy: .public)")
                    guard origin != .automatic else { return }
                    self.state = .failed("Couldn't check for updates: \(why)")
                    if origin == .url { HUD.show("Couldn't check for updates", symbol: "exclamationmark.triangle", duration: 2) }
                    return
                }
                self.lastChecked = Date()
                self.apply(latest: latest, origin: origin)
            }
        }.resume()
    }

    private func apply(latest: String, origin: Origin) {
        if case .checking = state { state = .idle }
        refreshInstalled()
        if case .restartNeeded = state, !UpdateRules.isNewer(latest, than: installedVersion ?? currentVersion) {
            if origin == .url { HUD.show("Restart Bento to finish updating", symbol: "arrow.clockwise.circle", duration: 2) }
            return
        }
        guard UpdateRules.isNewer(latest, than: currentVersion) else {
            state = .upToDate
            if origin == .url { HUD.show("Bento is up to date", symbol: "checkmark.circle", duration: 1.5) }
            return
        }
        state = .available(latest)
        let seen = UserDefaults.standard.string(forKey: Self.notifiedKey) == latest
        UserDefaults.standard.set(latest, forKey: Self.notifiedKey)
        if origin == .url || (origin == .automatic && !seen) {
            HUD.show("Bento \(latest) is available: install it from the menu bar", symbol: "arrow.down.circle", duration: 4)
        }
    }

    /// Version of the app at the Homebrew install path, read fresh (Bundle caches).
    private var installedVersion: String? {
        guard let app = installedApp else { return nil }
        let plist = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
        return plist?["CFBundleShortVersionString"] as? String
    }

    /// Notices a newer app installed behind this one's back (`brew upgrade`).
    func refreshInstalled() {
        guard let v = installedVersion, UpdateRules.isNewer(v, than: currentVersion) else { return }
        switch state {
        case .installing: return
        default: state = .restartNeeded(v)
        }
    }

    // MARK: Installing

    /// `brew update` (for the tap) and `brew upgrade` through a login shell, so
    /// brew gets PATH and whatever the login profile (~/.zprofile) sets. Not
    /// ~/.zshrc: an interactive shell can block on prompts or start tmux.
    /// Proxy settings brew needs belong in ~/.homebrew/brew.env, which brew
    /// reads itself. Restarts into the new version when it's in place.
    func install() {
        guard case .available(let version) = state else { return }
        guard let prefix = homebrewPrefix else {
            NSWorkspace.shared.open(Self.releaseURL(version))
            return
        }
        state = .installing(version)
        HUD.show("Updating Bento to \(version)…", symbol: "arrow.down.circle", duration: 2)
        let brew = "\(prefix)/bin/brew"
        let env = ProcessInfo.processInfo.environment
        let userShell = env["SHELL"] ?? ""
        let shell = userShell.hasSuffix("/zsh") || userShell.hasSuffix("/bash") ? userShell : "/bin/zsh"
        let script = """
        "$1" update --quiet || echo "brew update failed; upgrading with the tap as it is"
        HOMEBREW_NO_AUTO_UPDATE=1 exec "$1" upgrade --formula "$2"
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: shell)
        p.arguments = ["-l", "-c", script, "bento-update", brew, Self.formula]
        var childEnv = env
        childEnv["HOMEBREW_NO_ENV_HINTS"] = "1"
        p.environment = childEnv
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        FileManager.default.createFile(atPath: logURL.path, contents: Data("$ brew upgrade \(Self.formula)\n".utf8))
        let log = try? FileHandle(forWritingTo: logURL)
        log?.seekToEndOfFile()
        p.standardOutput = log
        p.standardError = log
        p.standardInput = FileHandle.nullDevice
        p.terminationHandler = { [weak self] proc in
            try? log?.close()
            DispatchQueue.main.async { self?.finishInstall(version: version, status: proc.terminationStatus) }
        }
        do {
            try p.run()
        } catch {
            state = .failed("Couldn't run \(shell): \(error.localizedDescription)")
            return
        }
        // brew waiting on a lock or a dead network shouldn't leave "Installing…" forever.
        DispatchQueue.main.asyncAfter(deadline: .now() + 15 * 60) { if p.isRunning { p.terminate() } }
    }

    private func finishInstall(version: String, status: Int32) {
        if let v = installedVersion, UpdateRules.isNewer(v, than: currentVersion) {
            BentoLog.core.info("Updated to \(v, privacy: .public), restarting")
            state = .restartNeeded(v)
            restart()
            return
        }
        let tail = (try? String(contentsOf: logURL, encoding: .utf8))?
            .split(whereSeparator: \.isNewline).suffix(3).joined(separator: " ") ?? ""
        state = .failed(status == 0
            ? "Homebrew didn't install \(version) yet (the tap may lag a few minutes). Try again shortly."
            : "brew upgrade failed (exit \(status)). \(tail)")
        HUD.show("Bento update failed (details in Settings)", symbol: "exclamationmark.triangle", duration: 3)
    }

    /// Quits and opens the Homebrew install once this process is gone (a second
    /// instance would just hand over to this one and exit). BENTO_* variables
    /// (BENTO_HOME…) carry over, so an isolated copy stays isolated.
    func restart() {
        guard let app = installedApp else { return }
        let carried = Self.env.filter { $0.key.hasPrefix("BENTO_") }.sorted { $0.key < $1.key }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        // Give up after ~30 s, so a quit that gets cancelled doesn't relaunch much later.
        p.arguments = ["-c", """
            pid=$1; shift
            i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 150 ]; do sleep 0.2; i=$((i+1)); done
            kill -0 "$pid" 2>/dev/null || exec /usr/bin/open "$@"
            """, "bento-relaunch", String(getpid())] + carried.flatMap { ["--env", "\($0.key)=\($0.value)"] }
                + ["-g", app.path, "--args", "--background"]
        do {
            try p.run()
        } catch {
            state = .failed("Couldn't restart: \(error.localizedDescription). Quit and reopen Bento.")
            return
        }
        NSApp.terminate(nil)
    }

    // MARK: Menu and diagnostics

    /// Menu bar entry while there's something to do.
    func menuItem(showSettings: @escaping () -> Void) -> NSMenuItem? {
        let item: NSMenuItem
        switch state {
        case .available(let v):
            item = isHomebrew
                ? ClosureMenuItem(title: "Install Bento \(v) and Restart") { [weak self] in self?.install() }
                : ClosureMenuItem(title: "Bento \(v) Available…") { showSettings() }
        case .installing(let v):
            item = NSMenuItem(title: "Installing Bento \(v)…", action: nil, keyEquivalent: "")
            item.isEnabled = false
        case .restartNeeded(let v):
            item = ClosureMenuItem(title: "Restart to Finish Updating to \(v)") { [weak self] in self?.restart() }
        default:
            return nil
        }
        item.image = NSImage(systemSymbolName: "arrow.down.circle", accessibilityDescription: nil)
        return item
    }

    var diagnostics: [String: Any] {
        ["version": currentVersion, "homebrew": homebrewPrefix ?? "", "state": String(describing: state),
         "automatic": timer != nil, "lastChecked": lastChecked?.timeIntervalSince1970 ?? 0]
    }
}
