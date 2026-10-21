import Foundation

/// `clipboard` section of the config file. Every field has a default so a
/// hand-edited file can stay minimal.
public struct ClipboardSettings: Codable, Equatable {
    public enum ReturnAction: String, Codable, CaseIterable {
        case paste, copy
    }

    /// Unpinned items older than this are deleted. 0 = keep forever.
    public var retentionDays = 30
    /// Maximum number of unpinned items.
    public var maxItems = 2000
    /// Maximum storage (images + text) for unpinned items, in megabytes.
    public var maxStorageMB = 1024
    /// Images larger than this (encoded bytes) are not recorded.
    public var maxImageMB = 50

    public var captureText = true
    /// Keep RTF/HTML (and app-specific formats) so items paste back with formatting.
    public var captureRichText = true
    public var captureImages = true
    public var captureFiles = true
    /// Recognise text in images in the background so they can be searched.
    public var recognizeTextInImages = true

    /// What ↵ does in the history panel (⌘↵ does the other one).
    public var returnAction: ReturnAction = .paste
    /// Paste without formatting by default (⇧↵ then pastes with formatting).
    public var pastePlainTextByDefault = false

    /// Bundle identifiers whose copies are never recorded.
    public var ignoredApps: [String] = ClipboardSettings.defaultIgnoredApps

    public init() {}

    public static let defaultIgnoredApps = [
        "com.1password.1password",
        "com.agilebits.onepassword7",
        "com.agilebits.onepassword-osx",
        "com.bitwarden.desktop",
        "com.apple.keychainaccess",
        "com.apple.Passwords",
        "com.lastpass.LastPass",
        "com.dashlane.dashlanephonefinal",
        "org.keepassxc.keepassxc",
        "com.kpassx.KeePassXC",
        "me.proton.pass.electron",
        "com.enpass.Enpass",
    ]
}
