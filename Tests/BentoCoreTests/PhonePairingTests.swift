import CoreImage
import Foundation
import Testing
@testable import BentoCore

@Suite struct PhonePairingTests {
    /// The query as a URL parser on the phone reads it.
    private func query(_ link: String) -> [String: String] {
        let items = URLComponents(string: link)?.queryItems ?? []
        return Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { a, _ in a })
    }

    @Test func percentEncodesEverythingButUnreservedCharacters() throws {
        let link = try PhonePairing.link(server: "https://sync.example.com/", token: "ab+c/d=e&f g",
                                         name: "Charles’s MacBook Pro").get()
        #expect(link == "bento://pair?v=1&server=https%3A%2F%2Fsync.example.com&token=ab%2Bc%2Fd%3De%26f%20g&name=Charles%E2%80%99s%20MacBook%20Pro")
        let q = query(link)
        #expect(q == ["v": "1", "server": "https://sync.example.com", "token": "ab+c/d=e&f g", "name": "Charles’s MacBook Pro"])
        #expect(URL(string: link)?.scheme == "bento" && URL(string: link)?.host == "pair")
    }

    @Test func geminiKeyOnlyWhenThereIsOne() throws {
        let with = try PhonePairing.link(server: "sync.example.com", token: "t0ken", name: "Mac", geminiKey: "AIza-x_y.z~").get()
        #expect(with.hasSuffix("&name=Mac&gemini=AIza-x_y.z~"))
        #expect(query(with)["gemini"] == "AIza-x_y.z~")
        for key in [nil, "", "  \n"] {
            let without = try PhonePairing.link(server: "sync.example.com", token: "t0ken", name: "Mac", geminiKey: key).get()
            #expect(!without.contains("gemini"))
        }
    }

    @Test func serverIsWrittenTheWayTheClientsReadIt() throws {
        #expect(query(try PhonePairing.link(server: " sync.example.com ", token: "t", name: "M").get())["server"] == "https://sync.example.com")
        #expect(query(try PhonePairing.link(server: "http://127.0.0.1:8787//", token: "t", name: "M").get())["server"] == "http://127.0.0.1:8787")
        #expect(query(try PhonePairing.link(server: "https://example.com/sync/", token: "t", name: "M").get())["server"] == "https://example.com/sync")
    }

    @Test func noServerOrNoTokenIsAProblemNotALink() {
        #expect(PhonePairing.link(server: "", token: "t", name: "M") == .failure(.noServer))
        #expect(PhonePairing.link(server: "   ", token: nil, name: "M") == .failure(.noServer))
        #expect(PhonePairing.link(server: "sync.example.com", token: nil, name: "M") == .failure(.noToken))
        #expect(PhonePairing.link(server: "sync.example.com", token: " \n", name: "M") == .failure(.noToken))
    }

    @Test func pairsWithNotesServerThenTodos() {
        let notes = SyncServerSettings(enabled: true, server: "https://notes.example.com")
        let todo = SyncServerSettings(enabled: true, server: "https://todo.example.com")
        #expect(PhonePairing.serverSettings(notes: notes, todo: todo) == notes)
        #expect(PhonePairing.serverSettings(notes: SyncServerSettings(), todo: todo) == todo)
        // A server that is switched on wins over one that isn't.
        var off = notes
        off.enabled = false
        #expect(PhonePairing.serverSettings(notes: off, todo: todo) == todo)
        var todoOff = todo
        todoOff.enabled = false
        #expect(PhonePairing.serverSettings(notes: off, todo: todoOff) == off)
        #expect(PhonePairing.serverSettings(notes: SyncServerSettings(), todo: SyncServerSettings()) == nil)
    }

    @Test func tokenComesFromTheTokenFile() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("pair-token-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: file) }
        try "  s3cret-token\n".write(to: file, atomically: true, encoding: .utf8)
        #expect(SyncServerSettings(enabled: true, server: "x", tokenFile: file.path).loadToken() == "s3cret-token")
        #expect(SyncServerSettings(enabled: true, server: "x", tokenFile: file.path + ".missing").loadToken() == nil)
    }

    /// The QR code reads back as exactly the link.
    @Test func qrCodeDecodesToTheLink() throws {
        let link = try PhonePairing.link(server: "https://sync.example.com", token: String(repeating: "k", count: 40),
                                         name: "Charles’s MacBook Pro", geminiKey: "AIzaSyD-0123456789abcdefghijklmnopqrstu").get()
        let code = try #require(PhonePairing.qrCode(link))
        let modules = Int(code.extent.width)
        #expect(code.extent.width == code.extent.height && modules >= 21)
        let bitmap = try #require(PhonePairing.bitmap(code, pixelsPerModule: 8))
        #expect(bitmap.width == modules * 8 && bitmap.height == modules * 8)
        // Pure black and white: no pixels blended at the module edges.
        let gray = try #require(CGContext(data: nil, width: bitmap.width, height: bitmap.height, bitsPerComponent: 8, bytesPerRow: bitmap.width,
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue))
        gray.draw(bitmap, in: CGRect(x: 0, y: 0, width: bitmap.width, height: bitmap.height))
        let pixels = UnsafeBufferPointer(start: gray.data!.assumingMemoryBound(to: UInt8.self), count: bitmap.width * bitmap.height)
        #expect(pixels.allSatisfy { $0 < 8 || $0 > 247 })
        // With a white quiet zone, as the sheet shows it, it reads back as the link.
        let image = CIImage(cgImage: bitmap)
        let card = image.composited(over: CIImage(color: .white).cropped(to: image.extent.insetBy(dx: -32, dy: -32)))
        let detector = try #require(CIDetector(ofType: CIDetectorTypeQRCode, context: nil, options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]))
        let messages = detector.features(in: card).compactMap { ($0 as? CIQRCodeFeature)?.messageString }
        #expect(messages == [link])
    }
}
