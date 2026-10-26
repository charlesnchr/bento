import Foundation

/// Fixed event codes and counts only. Never pass audio, transcripts, tasks, keys, or exception text.
enum AzureLiveDiagnostics {
    enum Code: String {
        case connecting, listening, stopped, disconnected, secureInput, sessionLimit
        case connectionTimeout, captureTimeout, audioFailure, captureBacklog, sendFailure
        case invalidAudio, bridgeFailure, sessionEnded, toolSendFailure
        case delegationReceived, delegationResultSent, approvalShown, approvalAllowed, approvalDenied
        case approvalCancelled, approvalUnavailable, approvalBusy, taskStarted, taskFinished
    }
    /// One bounded file pair per voice provider.
    enum Log: String { case azure = "azure-live", gemini = "gemini-live" }
    private static let enabled = true
    private static let queue = DispatchQueue(label: "com.charles.bento.voice.azure-live.diagnostics", qos: .utility)
    private static let bridgeCodes: Set<String> = [
        "azure_error", "credentials_unavailable", "http_error", "timeout", "connection_error",
        "invalid_event", "transport_error", "session_not_started", "websocket_closed",
        // The helper's Gemini Live route.
        "busy", "upstream_closed", "invalid_message"
    ]

    static func record(_ code: Code, inputChunks: Int = 0, outputChunks: Int = 0, outputBytes: Int = 0,
                       bridgeCode: String? = nil, httpStatus: Int? = nil, closeCode: Int? = nil, log: Log = .azure) {
        guard enabled else { return }
        let safeBridgeCode = bridgeCode.flatMap { bridgeCodes.contains($0) ? $0 : nil }
        let safeStatus = httpStatus.flatMap { (100...599).contains($0) ? $0 : nil }
        let safeClose = closeCode.flatMap { (1000...4999).contains($0) ? $0 : nil }
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "test"
        let timestamp = Date().timeIntervalSince1970
        queue.async {
            let manager = FileManager.default
            let directory = manager.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Bento")
            let file = directory.appendingPathComponent(log.rawValue + ".jsonl")
            let previous = directory.appendingPathComponent(log.rawValue + ".previous.jsonl")
            do {
                try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
                // Only two bounded files. Rotation never contains conversation content.
                if let size = try? manager.attributesOfItem(atPath: file.path)[.size] as? Int, size >= 65536 {
                    if manager.fileExists(atPath: previous.path) { try manager.removeItem(at: previous) }
                    try manager.moveItem(at: file, to: previous)
                }
                var event: [String: Any] = ["time": timestamp, "build": build, "code": code.rawValue,
                    "input_chunks": inputChunks, "output_chunks": outputChunks, "output_bytes": outputBytes]
                if let safeBridgeCode { event["bridge_code"] = safeBridgeCode }
                if let safeStatus { event["http_status"] = safeStatus }
                if let safeClose { event["close_code"] = safeClose }
                var data = try JSONSerialization.data(withJSONObject: event, options: [.sortedKeys])
                data.append(10)
                if !manager.fileExists(atPath: file.path) {
                    guard manager.createFile(atPath: file.path, contents: nil,
                                             attributes: [.posixPermissions: 0o600]) else { return }
                }
                try manager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
                let handle = try FileHandle(forWritingTo: file)
                defer { try? handle.close() }
                try handle.seekToEnd(); try handle.write(contentsOf: data)
            } catch { /* Diagnostics must never stop voice or disclose an exception. */ }
        }
    }
}
