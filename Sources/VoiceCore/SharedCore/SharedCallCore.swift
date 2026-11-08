import Foundation
import JavaScriptCore

/// The shared voice core (`voice-core/` at the repo's root, built to `dist/voice-core.js`) in
/// JavaScriptCore: the same call logic Android, the Echo bridge and the web harness run, byte for
/// byte (voice-core/scenarios; `SharedCallCoreTests` holds this engine to them).
///
/// The core is sans-IO: `create` and `push` take JSON and return the commands for the host to
/// carry out (open a socket, send a frame, play audio, run a Hermes task); see
/// voice-core/src/types.ts. The app can load the bundle from its resources, or in development from
/// the dev server (`http://…:8770/voice-core.js`), so a change to the call logic needs no rebuild.
///
/// A JSContext is not thread-safe: use one from a single queue (the call's).
public final class SharedCallCore {
    public enum Failure: Error, CustomStringConvertible {
        case script(String)
        public var description: String { if case .script(let m) = self { return m }; return "" }
    }

    private let context: JSContext
    private let core: JSValue
    private var exception: String?
    /// The bundle's build, a hash of what it does: shown so it's clear which core a call ran.
    public let version: String

    public init(source: String) throws {
        guard let context = JSContext() else { throw Failure.script("JavaScriptCore couldn't make a context") }
        self.context = context
        var thrown: String?
        context.exceptionHandler = { _, value in thrown = value?.toString() }
        context.evaluateScript(source, withSourceURL: URL(string: "voice-core.js"))
        if let thrown { throw Failure.script(thrown) }
        guard let core = context.objectForKeyedSubscript("VoiceCore"), core.isObject else {
            throw Failure.script("the bundle didn't define VoiceCore")
        }
        self.core = core
        self.version = core.objectForKeyedSubscript("version").toString()
        context.exceptionHandler = { [weak self] _, value in self?.exception = value?.toString() }
    }

    public convenience init(contentsOf url: URL) throws {
        try self.init(source: String(contentsOf: url, encoding: .utf8))
    }

    /// Starts a call: `{"id":…,"commands":[…]}`. `configJSON` is merged over the core's defaults.
    public func create(configJSON: String, t: Double) throws -> String {
        try call("create", [configJSON, t])
    }

    /// One event for call `id`; the commands it answers with, as a JSON array.
    public func push(id: Int, eventJSON: String) throws -> String {
        try call("push", [id, eventJSON])
    }

    /// What the call's trace kept since last asked (config `"trace": true`).
    public func trace(id: Int) throws -> String {
        try call("trace", [id])
    }

    public func dispose(id: Int) {
        core.invokeMethod("dispose", withArguments: [id])
    }

    private func call(_ name: String, _ arguments: [Any]) throws -> String {
        exception = nil
        let result = core.invokeMethod(name, withArguments: arguments)
        if let exception { throw Failure.script(exception) }
        guard let result, result.isString else { throw Failure.script("VoiceCore.\(name) returned no string") }
        return result.toString()
    }
}
