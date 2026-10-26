// Copyright 2026 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import Foundation

/// The transcription pipeline.
///
///   CAF → FLAC → interactions (mode: smart, custom_vocabulary)
///       → [optional] flash-lite cleanup for per-app tone → validation gate
///       → ReplacementEngine → inserted text.
///
/// The model now does filler removal, self-correction collapse and list
/// formatting itself, so the default path is ONE call. The cleanup pass survives
/// as an opt-in because it is the only thing that carries per-app tone.
///
/// Rules unchanged: one silent retry on transient transcribe failures; cleanup
/// has a hard deadline and NEVER blocks a good transcript; every failure is a
/// typed TranscriptionError mapping to the failure matrix.
public struct GeminiTranscriptionService: TranscriptionServicing {
    public var supportsEditing: Bool { true }
    private let client: GeminiClient
    private let settings: SettingsStore
    /// Cleanup budget: probe median 0.3s; hard cap so raw fallback keeps us fast.
    static let cleanupDeadline: TimeInterval = 1.5

    public init(client: GeminiClient, settings: SettingsStore = SettingsStore()) {
        self.client = client
        self.settings = settings
    }

    public func transcribe(audioURL: URL, durationSeconds: Double, context: DictationContext) async throws -> TranscriptionResult {
        if context.isAssistant {
            let config = settings.geminiConfig
            let flac = audioURL.deletingLastPathComponent().appendingPathComponent("assistant.flac")
            defer { try? FileManager.default.removeItem(at: flac) }
            let encoded = try FLACEncoder.encode(cafURL: audioURL, flacURL: flac)
            let text = try await client.transcribeInteraction(audio: Data(contentsOf: encoded.url),
                model: config.transcribeModel, endpoint: config.endpoint, mode: .verbatim,
                customVocabulary: DictionaryStore().sanitizedVocabulary(), deadline: 60)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { throw TranscriptionError.emptyTranscript }
            return TranscriptionResult(rawTranscript: text, cleanedTranscript: text, modelID: config.transcribeModel)
        }
        if let editing = context.editingSession {
            return try await transcribeEditing(audioURL: audioURL, editing: editing)
        }
        if settings.usesDualTranscription {
            return try await transcribeDual(audioURL: audioURL, durationSeconds: durationSeconds, context: context)
        }
        let toneMatching = settings.smartCleanupPassEnabled
        let instructions = settings.activeCustomInstructions
        let config = settings.geminiConfig
        let policy = settings.effectiveFormattingPolicy()
        // Read once per dictation: a toggle flipped mid-flight must not change
        // the rules this transcript is being produced under.
        let localModel = settings.localTranscriptionModel
        let transcriber = localModel ?? config.transcribeModel

        let trimmedRaw: String
        if let localModel {
            let started = Date()
            trimmedRaw = try await LocalSpeech.transcribe(audioURL: audioURL, model: localModel)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            Log.transcription.info("\(localModel, privacy: .public) on device in \(Int(Date().timeIntervalSince(started) * 1000))ms")
        } else {
            trimmedRaw = try await transcribeUploaded(audioURL: audioURL, durationSeconds: durationSeconds,
                                                      config: config, policy: policy)
        }
        guard !trimmedRaw.isEmpty else {
            // The coordinator classifies silence vs dropped-transcript by energy.
            throw TranscriptionError.emptyTranscript
        }

        guard policy.cleanupPass else {
            // Dictionary rules are a HARD guarantee — they apply on every path
            // (audit L9). The gate is deliberately NOT run here: with no second
            // model there is no independent reference, and validate(raw:X, cleaned:X)
            // passes trivially, so running it would be theatre rather than safety.
            let rules = DictionaryStore().replacementRules()
            let text = ReplacementEngine.apply(rules, to: trimmedRaw)
            return TranscriptionResult(
                rawTranscript: trimmedRaw,
                cleanedTranscript: text,
                modelID: "\(transcriber)/\(policy.mode.rawValue)"
            )
        }

        let cleaned = await cleanupOrFallback(raw: trimmedRaw, context: context, config: config,
                                              toneMatching: toneMatching, instructions: instructions)
        return TranscriptionResult(
            rawTranscript: trimmedRaw,
            cleanedTranscript: cleaned,
            modelID: "\(transcriber)/\(policy.mode.rawValue)+\(config.cleanupModel)"
        )
    }

    // MARK: - Stages

    /// FLAC upload to the configured transcriber, with the silent retry and the
    /// empty-transcript second chance. Returns the trimmed transcript.
    private func transcribeUploaded(audioURL: URL, durationSeconds: Double, config: GeminiConfig,
                                    policy: SettingsStore.FormattingPolicy) async throws -> String {
        let flacURL = audioURL.deletingLastPathComponent().appendingPathComponent("audio.flac")

        let encoded = try FLACEncoder.encode(cafURL: audioURL, flacURL: flacURL)
        Log.transcription.info("FLAC \(encoded.byteCount) bytes in \(Int(encoded.encodeSeconds * 1000))ms")
        let flacData = try Data(contentsOf: encoded.url)
        // The FLAC is derived data (re-encoded from the CAF on any retry) — once
        // it's in memory the file is pure duplication. Storage policy: the CAF is
        // the only audio artifact that persists.
        try? FileManager.default.removeItem(at: encoded.url)

        let vocabulary = Self.vocabularyIfEnabled()
        let deadline = TimeoutPolicy.overallDeadline(audioDuration: durationSeconds)
        var raw = try await transcribeWithRetry(
            flacData: flacData, config: config, policy: policy,
            vocabulary: vocabulary, deadline: deadline
        )

        var trimmedRaw = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedRaw.isEmpty, durationSeconds >= 0.6 {
            // F9a second chance: an empty result on real audio is sometimes model
            // nondeterminism — one re-send before surfacing anything (audit L25).
            Log.transcription.info("empty transcript on \(String(format: "%.1f", durationSeconds))s audio — one re-send")
            // NB: goes through the same policy-aware call as the primary path.
            // Sending this one down the old endpoint would leave a rare branch
            // silently on a different pipeline.
            raw = (try? await sendTranscribe(
                flacData: flacData, config: config, policy: policy,
                vocabulary: vocabulary, deadline: deadline
            )) ?? ""
            trimmedRaw = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return trimmedRaw
    }

    private func transcribeEditing(audioURL: URL, editing: EditingSession) async throws -> TranscriptionResult {
        var config = settings.geminiConfig
        if VertexRuntimeConfig.state().config?.isDirect == true, !CleanupModels.isRelayed(config.cleanupModel) {
            config.cleanupModel = "gemini-3.8-flash"
        }
        let flacURL = audioURL.deletingLastPathComponent().appendingPathComponent("editing.flac")
        defer { try? FileManager.default.removeItem(at: flacURL) }
        let encoded = try FLACEncoder.encode(cafURL: audioURL, flacURL: flacURL)
        let audio = try Data(contentsOf: encoded.url)
        let instruction = try await client.transcribeInteraction(audio: audio, model: config.transcribeModel,
            endpoint: config.endpoint, mode: .verbatim, customVocabulary: DictionaryStore().sanitizedVocabulary(), deadline: 60)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instruction.isEmpty else { throw TranscriptionError.emptyTranscript }
        try Task.checkCancellation()
        let revision = try await client.cleanup(prompt: editing.prompt(instruction: instruction),
            model: config.cleanupModel, endpoint: config.endpoint, deadline: 30)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        try Task.checkCancellation()
        // The cleanup similarity gate deliberately does not apply: summarization changes content length.
        guard !revision.isEmpty else { throw TranscriptionError.emptyTranscript }
        return TranscriptionResult(rawTranscript: instruction, cleanedTranscript: revision,
                                   modelID: config.transcribeModel + "+edit/" + config.cleanupModel)
    }

    /// Two recognisers (Gemini and GPT by default, any pair in Settings) transcribe
    /// in parallel, then 3.8 Flash hears the audio and writes the final text from both drafts. Formatting, tone and custom
    /// instructions ride in that same review call, so it is three model calls,
    /// not four. One failed recogniser means reviewing the other's draft alone;
    /// a failed review fails the dictation, never inserting an unreviewed draft.
    private func transcribeDual(audioURL: URL, durationSeconds: Double, context: DictationContext) async throws -> TranscriptionResult {
        // Read once per dictation, like the single-model path.
        let smart = settings.smartTranscriptionEnabled
        // Tone and instructions ride in the review, but obey the cleanup switch like everywhere else.
        let cleanup = settings.cleanupEnabled
        let tone = cleanup && settings.smartCleanupPassEnabled ? PromptV1.toneCategory(forBundleID: context.targetAppBundleID) : .neutral
        let instructions = cleanup ? settings.activeCustomInstructions : ""
        let config = settings.geminiConfig
        let pair = settings.dualEngines
        @Sendable func draftConfig(_ engine: SettingsStore.TranscriptionEngine) -> GeminiConfig {
            GeminiConfig(endpoint: config.endpoint, transcribeModel: engine.helperModel ?? config.transcribeModel,
                         cleanupModel: config.cleanupModel)
        }
        @Sendable func source(_ engine: SettingsStore.TranscriptionEngine) -> String {
            engine.isLocal ? engine.rawValue : draftConfig(engine).transcribeModel
        }
        let flacURL = audioURL.deletingLastPathComponent().appendingPathComponent("audio.flac")
        let encoded = try FLACEncoder.encode(cafURL: audioURL, flacURL: flacURL)
        let flacData = try Data(contentsOf: encoded.url)
        try? FileManager.default.removeItem(at: encoded.url)

        let vocabulary = Self.vocabularyIfEnabled()
        let deadline = TimeoutPolicy.overallDeadline(audioDuration: durationSeconds)
        // Both drafts are verbatim: formatting happens once, in the review, where
        // the model can hear which words were fillers and which were meant.
        let verbatim = SettingsStore.FormattingPolicy(nativeSmart: false, cleanupPass: false)
        @Sendable func draft(_ engine: SettingsStore.TranscriptionEngine) async -> Result<String, Error> {
            do {
                let text = engine.isLocal
                    ? try await LocalSpeech.transcribe(audioURL: audioURL, model: engine.rawValue)
                    : try await transcribeWithRetry(flacData: flacData, config: draftConfig(engine), policy: verbatim,
                                                    vocabulary: vocabulary, deadline: deadline)
                return .success(text.trimmingCharacters(in: .whitespacesAndNewlines))
            } catch {
                return .failure(error)
            }
        }
        async let firstDraft = draft(pair[0])
        async let secondDraft = draft(pair[1])
        let results = await [firstDraft, secondDraft]
        try Task.checkCancellation()

        var drafts: [DualReviewPrompt.Draft] = []
        for (source, result) in zip(pair.map(source), results) {
            switch result {
            case .success(let text) where !text.isEmpty:
                drafts.append(DualReviewPrompt.Draft(source: source, text: text))
            case .success:
                Log.transcription.info("dual: \(source, privacy: .public) returned an empty draft")
            case .failure(let error):
                Log.transcription.info("dual: \(source, privacy: .public) draft unavailable (\(String(describing: error), privacy: .public))")
            }
        }
        if drafts.isEmpty {
            // A real error must never be read as silence: the coordinator may
            // discard silent audio, while an error keeps it retryable. Gemini's
            // is preferred, the one the failure matrix was built around.
            for index in pair[1] == .gemini ? [1, 0] : [0, 1] {
                if case .failure(let error) = results[index] { throw error }
            }
            // F9a second chance, as on the single-model path: both empty on real
            // audio is sometimes nondeterminism, so re-send a cloud recogniser once.
            if durationSeconds >= 0.6, let cloud = pair.first(where: { !$0.isLocal }), let text = try? await sendTranscribe(
                flacData: flacData, config: draftConfig(cloud), policy: verbatim, vocabulary: vocabulary, deadline: deadline
            ).trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty {
                drafts.append(DualReviewPrompt.Draft(source: source(cloud), text: text))
            }
        }
        guard let primary = drafts.first else { throw TranscriptionError.emptyTranscript }
        try Task.checkCancellation()

        let dictionary = DictionaryStore()
        let rules = dictionary.replacementRules()
        let sources = drafts.map(\.source).joined(separator: "+")
        let prompt = DualReviewPrompt.prompt(drafts: drafts, smart: smart, tone: tone, vocabulary: vocabulary,
                                             spellings: dictionary.spellings(), customInstructions: instructions)
        // Only reviewed text is ever inserted. An unreviewed draft would look like
        // a normal result with nothing saying the review never happened, so a
        // failed review fails the dictation instead: the recording stays in
        // History, retryable. The deadline is generous for the same reason.
        let reviewDeadline = TimeoutPolicy.reviewDeadline(audioDuration: durationSeconds)
        let response: String
        do {
            response = try await client.cleanup(prompt: prompt, model: Self.dualReviewModel, endpoint: config.endpoint,
                                                deadline: reviewDeadline, audio: flacData)
        } catch let error as TranscriptionError {
            switch error {
            case .network, .rateLimitedTransient:
                // One silent retry for transient classes. Not after .timeout:
                // that already waited the whole generous budget.
                Log.transcription.info("dual review retrying after \(String(describing: error), privacy: .public)")
                try await Task.sleep(nanoseconds: 500_000_000)
                response = try await client.cleanup(prompt: prompt, model: Self.dualReviewModel, endpoint: config.endpoint,
                                                    deadline: reviewDeadline, audio: flacData)
            default:
                throw error
            }
        }
        try Task.checkCancellation()
        let reviewed = ValidationGate.stripArtifacts(response)
        // Any draft can vouch for the review, which may rightly side with the
        // one that is not first, but only a draft long enough for the gate's
        // length checks to apply: a hallucinated "Thank you." vouches for
        // anything. No gate trips are recorded, because auto-degrade switches
        // off tone and instructions, not this review.
        let references = drafts.filter { ValidationGate.contentWords(of: $0.text).count >= 3 }
        let verdicts = (references.isEmpty ? drafts : references).map { ValidationGate.validate(raw: $0.text, cleaned: reviewed) }
        guard verdicts.contains(where: \.accepted) else {
            Log.transcription.warning("dual review gate REJECTED (\(verdicts.compactMap(\.reason).joined(separator: ", "), privacy: .public))")
            throw TranscriptionError.reviewRejected
        }
        return TranscriptionResult(rawTranscript: primary.text,
                                   cleanedTranscript: ReplacementEngine.apply(rules, to: reviewed),
                                   modelID: "\(sources)/review+\(Self.dualReviewModel)")
    }

    static let dualReviewModel = "gemini-3.8-flash"

    public func finishLive(_ result: TranscriptionResult, context: DictationContext) async -> TranscriptionResult {
        if context.isAssistant { return result }
        guard settings.effectiveFormattingPolicy().cleanupPass else { return result }
        let cleaned = await cleanupOrFallback(raw: result.rawTranscript, context: context, config: settings.geminiConfig,
                                              toneMatching: settings.smartCleanupPassEnabled,
                                              instructions: settings.activeCustomInstructions)
        return TranscriptionResult(rawTranscript: result.rawTranscript, cleanedTranscript: cleaned,
                                   modelID: result.modelID + "+" + settings.geminiConfig.cleanupModel)
    }

    /// Vocabulary is suppressed once it has PROVABLY broken a request.
    ///
    /// Keyed on the vocabulary itself rather than a bare flag: editing the
    /// Dictionary changes the key and we try again, so one bad entry cannot
    /// disable the feature until relaunch with nothing telling the user why.
    private static let vocabularySuppressed = Suppression()
    final class Suppression: @unchecked Sendable {
        private let lock = NSLock()
        private var blocked: Int?
        func isBlocked(_ vocabulary: [String]) -> Bool {
            lock.lock(); defer { lock.unlock() }
            return blocked != nil && blocked == vocabulary.hashValue
        }
        func block(_ vocabulary: [String]) {
            lock.lock(); blocked = vocabulary.hashValue; lock.unlock()
        }
    }

    private static func vocabularyIfEnabled() -> [String] {
        let vocabulary = DictionaryStore().sanitizedVocabulary()
        return vocabularySuppressed.isBlocked(vocabulary) ? [] : vocabulary
    }

    /// The ONE place a transcription request is sent. Every caller — primary,
    /// silent retry, and the empty-transcript second chance — goes through here.
    private func sendTranscribe(
        flacData: Data, config: GeminiConfig, policy: SettingsStore.FormattingPolicy,
        vocabulary: [String], deadline: TimeInterval
    ) async throws -> String {
        // The transport decision lives in ONE place so the fail-open retry below
        // cannot silently switch endpoints half way through a recovery.
        func send(_ terms: [String]) async throws -> String {
            if settings.usesLegacyTranscribeEndpoint && VertexRuntimeConfig.state().config?.isDirect != true {
                // Verbatim only — `mode` returns an empty transcript on this
                // endpoint. The tone pass, if enabled, still runs on top.
                return try await client.transcribe(
                    flacData: flacData, model: config.transcribeModel,
                    endpoint: config.endpoint, deadline: deadline, customVocabulary: terms
                )
            }
            return try await client.transcribeInteraction(
                audio: flacData, model: config.transcribeModel, endpoint: config.endpoint,
                mode: policy.mode, customVocabulary: terms, deadline: deadline
            )
        }

        do {
            return try await send(vocabulary)
        } catch TranscriptionError.badRequest(let message) where !vocabulary.isEmpty {
            // Fail open. badRequest is deliberately terminal everywhere else, but
            // one strange dictionary entry must never be able to break a user's
            // own dictation. Covers BOTH transports — the legacy endpoint carries
            // vocabulary too.
            Log.transcription.error("transcribe rejected with vocabulary (\(message, privacy: .private)) — retrying without it")
            let text = try await send([])
            // Only latch once the vocabulary-free retry SUCCEEDS. If it also
            // fails, the vocabulary was innocent — and a bad API key returns 400
            // here, not 401, so latching eagerly would disable the Dictionary for
            // the rest of the launch over an auth problem.
            Self.vocabularySuppressed.block(vocabulary)
            return text
        }
    }

    private func transcribeWithRetry(
        flacData: Data, config: GeminiConfig, policy: SettingsStore.FormattingPolicy,
        vocabulary: [String], deadline: TimeInterval
    ) async throws -> String {
        do {
            return try await sendTranscribe(
                flacData: flacData, config: config, policy: policy,
                vocabulary: vocabulary, deadline: deadline
            )
        } catch let error as TranscriptionError {
            switch error {
            case .network, .timeout:
                // One silent retry for transient classes (audio is safe on disk).
                Log.transcription.info("transcribe retrying after \(String(describing: error), privacy: .public)")
                try await Task.sleep(nanoseconds: 500_000_000)
                return try await sendTranscribe(
                    flacData: flacData, config: config, policy: policy,
                    vocabulary: vocabulary, deadline: deadline
                )
            default:
                throw error
            }
        }
    }

    private func cleanupOrFallback(raw: String, context: DictationContext, config: GeminiConfig,
                                   toneMatching: Bool, instructions: String) async -> String {
        let tone = toneMatching ? PromptV1.toneCategory(forBundleID: context.targetAppBundleID) : .neutral
        let dictionary = DictionaryStore()
        let prompt = PromptV1.cleanupPrompt(
            raw: raw,
            tone: tone,
            vocabulary: dictionary.sanitizedVocabulary(),
            spellings: dictionary.spellings(),
            customInstructions: instructions
        )
        do {
            let response = try await client.cleanup(
                prompt: prompt, model: config.cleanupModel,
                endpoint: config.endpoint, deadline: CleanupModels.isRelayed(config.cleanupModel) ? 8.0 : (VertexRuntimeConfig.state().config?.isDirect == true ? 4.0 : Self.cleanupDeadline)
            )
            let cleaned = ValidationGate.stripArtifacts(response)
            let verdict = ValidationGate.validate(raw: raw, cleaned: cleaned)
            guard verdict.accepted else {
                let trips = settings.recordGateTrip()
                Log.transcription.warning("cleanup gate REJECTED (\(verdict.reason ?? "?", privacy: .public), trip #\(trips) in 24h) — inserting raw")
                autoDegradeIfNeeded(trips: trips)
                return ReplacementEngine.apply(dictionary.replacementRules(), to: raw)
            }
            // The dictionary's hard guarantee: explicit wrong→right rules always win.
            return ReplacementEngine.apply(dictionary.replacementRules(), to: cleaned)
        } catch {
            // Deadline miss / network hiccup on cleanup never costs the dictation —
            // and the dictionary guarantee still holds (audit L9).
            Log.transcription.info("cleanup unavailable (\(String(describing: error), privacy: .public)) — inserting raw")
            return ReplacementEngine.apply(dictionary.replacementRules(), to: raw)
        }
    }

    /// F11 auto-degrade (audit L10): three gate trips in 24h means cleanup can't
    /// be trusted right now — switch to exact transcription until re-enabled.
    private func autoDegradeIfNeeded(trips: Int) {
        guard trips >= 3, settings.formattingPolicy.cleanupPass else { return }
        settings.setCleanupEnabled(false)
        NotificationCenter.default.post(name: .gtSmartFormattingAutoDegraded, object: nil)
        Log.transcription.warning("cleanup unreliable (3 gate trips in 24h) — cleanup pass auto-disabled")
    }
}
