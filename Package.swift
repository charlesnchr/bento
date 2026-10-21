// swift-tools-version:5.10
// Bento: one menu-bar app for capture, window management, tiling, app hotkeys,
// clipboard history and floating notes. Built with SwiftPM only (no Xcode);
// scripts/build.sh assembles and signs the .app bundle.
import PackageDescription
import Foundation

// Swift Testing with Command Line Tools only (no Xcode): the framework lives
// outside the default search path and its Foundation cross-import overlay ships
// without a module, so point at it and disable cross-import overlays.
let cltFrameworks = "/Library/Developer/CommandLineTools/Library/Developer/Frameworks"
let testingFix = FileManager.default.fileExists(atPath: cltFrameworks + "/Testing.framework")
let testSwiftSettings: [SwiftSetting] = testingFix
    ? [.unsafeFlags(["-F", cltFrameworks, "-Xfrontend", "-disable-cross-import-overlays"])] : []
let testLinkerSettings: [LinkerSetting] = testingFix
    ? [.unsafeFlags(["-F", cltFrameworks, "-Xlinker", "-rpath", "-Xlinker", cltFrameworks])] : []

let modules = ["Shot", "ShotEditor", "Windows", "Tiling", "Launcher", "Clipboard", "Notes"]

let package = Package(
    name: "Bento",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Bento", targets: ["Bento"]),
    ],
    targets: [
        .target(
            name: "BentoCore",
            linkerSettings: [.linkedFramework("Carbon"), .linkedLibrary("sqlite3")]
        ),
        .target(name: "BentoShell", dependencies: ["BentoCore"]),

        .target(name: "ShotEditor", dependencies: ["BentoCore"]),
        .target(name: "Shot", dependencies: ["BentoCore", "ShotEditor"]),
        .target(name: "Windows", dependencies: ["BentoCore"]),
        .target(name: "Tiling", dependencies: ["BentoCore"]),
        .target(name: "Launcher", dependencies: ["BentoCore"]),
        .target(name: "Clipboard", dependencies: ["BentoCore"]),
        .target(name: "Notes", dependencies: ["BentoCore"]),

        .executableTarget(
            name: "Bento",
            dependencies: ["BentoCore", "BentoShell"] + modules.map { .byName(name: $0) }
        ),

        // Single-module dev harnesses: `swift run --scratch-path .build-shot DevShot`
        // starts the shell with only that module, so modules can be built and
        // exercised independently of each other.
        .executableTarget(name: "DevShot", dependencies: ["BentoShell", "Shot", "ShotEditor"], path: "Dev/DevShot"),
        .executableTarget(name: "DevWindows", dependencies: ["BentoShell", "Windows"], path: "Dev/DevWindows"),
        .executableTarget(name: "DevTiling", dependencies: ["BentoShell", "Tiling"], path: "Dev/DevTiling"),
        .executableTarget(name: "DevLauncher", dependencies: ["BentoShell", "Launcher"], path: "Dev/DevLauncher"),
        .executableTarget(name: "DevClipboard", dependencies: ["BentoShell", "Clipboard"], path: "Dev/DevClipboard"),
        .executableTarget(name: "DevNotes", dependencies: ["BentoShell", "Notes"], path: "Dev/DevNotes"),

        .testTarget(name: "BentoCoreTests", dependencies: ["BentoCore"],
                    swiftSettings: testSwiftSettings, linkerSettings: testLinkerSettings),
    ] + modules.map {
        .testTarget(name: "\($0)Tests", dependencies: ["BentoCore", .byName(name: $0)],
                    swiftSettings: testSwiftSettings, linkerSettings: testLinkerSettings)
    }
)
