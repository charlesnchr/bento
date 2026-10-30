import AppKit
import CoreImage
import SwiftUI
import SystemConfiguration

/// Pairing the Bento Android app: a QR code (or link) carrying the sync server, the
/// token and this Mac's name, optionally the Gemini API key:
/// `bento://pair?v=1&server=…&token=…&name=…[&gemini=…]`. Notes and Todo show the
/// same sheet from their sync settings.
public enum PhonePairing {
    public enum Problem: Error, Equatable {
        case noServer, noToken
    }

    /// Reads the Gemini API key, which the voice modules keep (`APIKeyStore`). Set by
    /// the app; nil in builds without them (the sheet then offers no key).
    public static var geminiAPIKey: (() -> String?)?

    /// RFC 3986 unreserved characters. Everything else is percent-encoded, so a `+`, `&`
    /// or `=` in a token or key reads back the same with any URL parser.
    private static let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")

    static func encode(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: unreserved) ?? "" }

    /// The pairing link. The server is written the way the sync clients read it (no
    /// trailing slash, `https://` when the config leaves out the scheme); `gemini` only
    /// when there is a key.
    public static func link(server: String, token: String?, name: String, geminiKey: String? = nil) -> Result<String, Problem> {
        guard let base = SyncServerSettings(server: server).baseURL?.absoluteString else { return .failure(.noServer) }
        guard let token = token?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else { return .failure(.noToken) }
        var link = "bento://pair?v=1&server=\(encode(base))&token=\(encode(token))&name=\(encode(name.trimmingCharacters(in: .whitespacesAndNewlines)))"
        if let key = geminiKey?.trimmingCharacters(in: .whitespacesAndNewlines), !key.isEmpty {
            link += "&gemini=\(encode(key))"
        }
        return .success(link)
    }

    /// The sync settings to pair with: Notes' (`notes.sync`) when they name a server, else
    /// Todo's; one that is switched on wins over one that isn't.
    public static func serverSettings(notes: SyncServerSettings, todo: SyncServerSettings) -> SyncServerSettings? {
        let candidates = [notes, todo].filter(\.hasServer)
        return candidates.first(where: \.enabled) ?? candidates.first
    }

    private struct SyncSection: Codable { var sync = SyncServerSettings() }

    static func configuredServer() -> SyncServerSettings? {
        serverSettings(notes: ConfigStore.shared.section("notes", default: SyncSection()).sync,
                       todo: ConfigStore.shared.section("todo", default: SyncSection()).sync)
    }

    /// The Mac's name as in System Settings → General → Sharing.
    static var computerName: String {
        (SCDynamicStoreCopyComputerName(nil, nil) as String?) ?? Host.current().localizedName ?? ProcessInfo.processInfo.hostName
    }

    /// A QR code, black on white, one unit per module.
    static func qrCode(_ text: String) -> CIImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        return filter.outputImage
    }

    /// `code` as a bitmap with every module `pixels` pixels square, so it's shown without
    /// resampling and the edges stay sharp.
    static func bitmap(_ code: CIImage, pixelsPerModule pixels: Int) -> CGImage? {
        let scaled = code.samplingNearest().transformed(by: CGAffineTransform(scaleX: CGFloat(pixels), y: CGFloat(pixels)))
        return CIContext().createCGImage(scaled, from: scaled.extent.integral)
    }
}

/// "Pair Android Phone…", opening the pairing sheet.
public struct PairPhoneButton: View {
    @State private var showing = false

    public init() {}

    public var body: some View {
        Button("Pair Android Phone…") { showing = true }
            .sheet(isPresented: $showing) { PairPhoneSheet() }
    }
}

struct PairPhoneSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var loaded = false
    @State private var server: SyncServerSettings?
    @State private var token: String?
    @State private var geminiKey: String?
    @State private var includeGemini = true
    @State private var revealed = false
    @State private var copied = false

    private var link: Result<String, PhonePairing.Problem> {
        PhonePairing.link(server: server?.server ?? "", token: token, name: PhonePairing.computerName,
                          geminiKey: includeGemini ? geminiKey : nil)
    }

    var body: some View {
        VStack(spacing: 14) {
            Text("Pair Android Phone").font(.headline)
            Text("In the Bento app on your phone, choose Pair with Mac and scan this code.")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            code
                .frame(width: 232, height: 232)
            if case .success = link {
                Label(geminiKey != nil && includeGemini
                      ? "Anyone who scans it can read and edit your notes and tasks, and use your Gemini API key."
                      : "Anyone who scans it can read and edit your notes and tasks.",
                      systemImage: "exclamationmark.triangle")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if geminiKey != nil {
                    Toggle("Include Gemini API key", isOn: $includeGemini)
                        .toggleStyle(.checkbox)
                }
            }
            HStack {
                Button(copied ? "Copied" : "Copy Link", action: copy)
                    .disabled(!loaded || (try? link.get()) == nil)
                Spacer()
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 340)
        .onAppear(perform: load)
    }

    @ViewBuilder
    private var code: some View {
        if !loaded {
            ProgressView()
        } else {
            switch link {
            case .failure(let problem):
                placeholder {
                    Image(systemName: "exclamationmark.icloud").font(.system(size: 36)).foregroundStyle(.secondary)
                    Text(problem == .noServer ? "No sync server" : "No sync token").font(.headline)
                    Text(problem == .noServer
                         ? "Set a server under Settings → Notes → Sync first."
                         : "The token file \(server?.tokenFile ?? "") is missing or empty.")
                        .font(.caption).foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
            case .success(let text):
                if revealed {
                    QRCodeView(text: text)
                } else {
                    placeholder {
                        Image(systemName: "qrcode").font(.system(size: 64)).foregroundStyle(.tertiary)
                        Button("Show Code") { revealed = true }
                    }
                }
            }
        }
    }

    private func placeholder<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        RoundedRectangle(cornerRadius: 12)
            .fill(.quaternary)
            .overlay(VStack(spacing: 8, content: content).padding(16))
    }

    private func load() {
        guard !loaded else { return }
        server = PhonePairing.configuredServer()
        token = server?.loadToken()
        geminiKey = PhonePairing.geminiAPIKey?().flatMap { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : $0 }
        includeGemini = geminiKey != nil
        loaded = true
    }

    private func copy() {
        guard case .success(let text) = link else { return }
        let pb = NSPasteboard.general
        pb.clearContents()
        // Clipboard managers (Bento's own history included) skip concealed items.
        pb.declareTypes([.string, NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")], owner: nil)
        pb.setString(text, forType: .string)
        pb.setString("", forType: NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType"))
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { copied = false }
    }
}

/// Black modules on a white card in light and dark mode alike (scanners want dark on
/// light), each module a whole number of points and pixels so the edges stay crisp, with
/// a quiet zone of four modules (the generator adds one).
private struct QRCodeView: View {
    let text: String
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let scale = max(1, displayScale.rounded())
        if let code = PhonePairing.qrCode(text) {
            let modules = code.extent.width
            let point = max(1, (232 / (modules + 6)).rounded(.down))
            if let image = PhonePairing.bitmap(code, pixelsPerModule: Int(point * scale)) {
                Image(decorative: image, scale: scale)
                    .padding(3 * point)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
                    .accessibilityLabel("Pairing code")
            }
        } else {
            Text("Couldn't make the code; use Copy Link.").font(.caption).foregroundStyle(.secondary)
        }
    }
}
