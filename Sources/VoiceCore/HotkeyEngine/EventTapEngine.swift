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

import AppKit
import CoreGraphics
import Foundation

/// Owns the system-wide CGEventTap that powers the configured dictation key.
///
/// Design (docs/design/architecture.md — HotkeyEngine):
///  - Dedicated thread with its own CFRunLoop; the callback only classifies events,
///    runs the pure `HotkeyProcessor` under a lock (microseconds), and forwards
///    intents to the owner via a closure.
///  - Consumes only matched hotkey events and active-session gestures. It does
///    not log events; unrelated keyboard events pass through unchanged.
///  - Self-healing: re-enables on kCGEventTapDisabledBy* and polls tapIsEnabled
///    every 5s — a non-nil tap is not a healthy tap.
public final class EventTapEngine {
    public enum State: Equatable {
        case stopped
        /// Tap creation failed — Accessibility permission is missing.
        case permissionDenied
        case running
    }

    public private(set) var state: State = .stopped

    /// Called with each intent, on an arbitrary internal thread — the owner hops
    /// to the main actor.
    public var onIntent: ((HotkeyIntent) -> Void)?
    /// Called when the tap had to be revived (telemetry for the #1 field failure).
    public var onTapRevived: (() -> Void)?
    /// Shift-Option-F17 — start or stop meeting recording. Called on the tap
    /// thread, like `onIntent`; the handler hops to the main actor itself.
    /// The chord is claimed only while a handler is installed: without one,
    /// Option-F17 with an extra modifier passes through like any shortcut.
    public var onMeetingToggle: (() -> Void)?
    private var meetingToggleDown = false

    private var key: HotkeyKey
    private let lock = NSLock()
    private var processor = HotkeyProcessor()
    private var keyIsDown = false
    private var activeChord: Int64 = 64
    private var editingGesture = false
    /// Option may be released before F17. In that case the chord has already
    /// ended, but F17's eventual key-up still belongs to it and is consumed.
    private var swallowOptionF17KeyUp = false
    private var assistantToggleDown = false
    private var assistantCallDown = false
    private var assistantLiveCall = false
    /// Off: the dictation key passes through untouched.
    private var dictationKeyEnabled = true
    /// Off: ⌥F18 (voice editing, assistant requests and calls) passes through.
    private var assistantKeysEnabled = true
    /// Whether the tap claims Shift-Option-F18 for showing the assistant. Bento
    /// binds that as an ordinary, rebindable shortcut instead.
    private var claimsAssistantWindowToggle = true
    /// Set by the app while a session is in flight beyond the grammar's view
    /// (transcribing/inserting, or UI-started hands-free) so Esc still cancels
    /// (audit L8/L13 — the machine supported cancel, the tap never delivered it).
    private var externalSessionActive = false

    private var tapThread: Thread?
    private var tapPort: CFMachPort?
    private var runLoop: CFRunLoop?
    private let timerQueue = DispatchQueue(label: "com.charles.bento.voice.hotkey.timer")
    private var doubleTapTimer: DispatchSourceTimer?
    private var healthTimer: DispatchSourceTimer?

    public init(key: HotkeyKey = .fn) {
        self.key = key
    }

    deinit {
        stop()
    }

    public func setKey(_ newKey: HotkeyKey) {
        lock.lock()
        // Same key ⇒ keep keyIsDown: resetting the edge detector while the user
        // is physically holding the key would swallow the coming key-up and
        // strand the session (reachable via any settings write re-applying
        // hotkey config mid-hold).
        if key != newKey {
            key = newKey
            keyIsDown = false
            swallowOptionF17KeyUp = false
        }
        lock.unlock()
    }

    public func setDoubleTapLockEnabled(_ enabled: Bool) {
        lock.lock()
        processor.doubleTapLockEnabled = enabled
        lock.unlock()
    }

    public func setSingleTapHandsFreeEnabled(_ enabled: Bool) {
        lock.lock()
        processor.singleTapHandsFreeEnabled = enabled
        lock.unlock()
    }

    /// The coordinator refused our .begin — the grammar's session is phantom.
    public func resetGrammar() {
        lock.lock()
        processor.reset()
        lock.unlock()
    }

    public func setExternalSessionActive(_ active: Bool) {
        lock.lock()
        externalSessionActive = active
        lock.unlock()
    }

    public func setDictationKeyEnabled(_ enabled: Bool) {
        lock.lock()
        dictationKeyEnabled = enabled
        if !enabled, !editingGesture { keyIsDown = false; processor.reset() }
        lock.unlock()
    }

    public func setAssistantKeysEnabled(_ enabled: Bool) {
        lock.lock()
        assistantKeysEnabled = enabled
        lock.unlock()
    }

    public func setClaimsAssistantWindowToggle(_ claims: Bool) {
        lock.lock()
        claimsAssistantWindowToggle = claims
        lock.unlock()
    }

    public func setAssistantLiveCall(_ enabled: Bool) {
        lock.lock()
        assistantLiveCall = enabled
        lock.unlock()
    }

    /// Starts the tap. Returns false (state == .permissionDenied) without Accessibility trust.
    /// Safe to call again after the user grants Accessibility (onboarding flow).
    @discardableResult
    public func start() -> Bool {
        if state == .permissionDenied {
            tapThread = nil
            state = .stopped
        }
        guard tapThread == nil else { return state == .running }

        let thread = Thread { [weak self] in
            self?.threadMain()
        }
        thread.name = "com.charles.bento.voice.eventtap"
        thread.qualityOfService = .userInteractive
        tapThread = thread
        thread.start()

        // Wait briefly for the thread to report tap creation success/failure.
        let deadline = Date().addingTimeInterval(2)
        while state == .stopped && Date() < deadline {
            usleep(10_000)
        }
        if state == .running {
            startHealthTimer()
        }
        return state == .running
    }

    public func stop() {
        doubleTapTimer?.cancel(); doubleTapTimer = nil
        healthTimer?.cancel(); healthTimer = nil
        if let runLoop { CFRunLoopStop(runLoop) }
        if let tapPort { CGEvent.tapEnable(tap: tapPort, enable: false) }
        tapPort = nil
        runLoop = nil
        tapThread = nil
        state = .stopped
    }

    // MARK: - Tap thread

    private func threadMain() {
        let mask: CGEventMask =
            (1 << CGEventType.flagsChanged.rawValue) |
            (1 << CGEventType.keyDown.rawValue) |
            (1 << CGEventType.keyUp.rawValue)

        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: mask,
            callback: { _, type, event, userInfo in
                guard let userInfo else { return Unmanaged.passUnretained(event) }
                let engine = Unmanaged<EventTapEngine>.fromOpaque(userInfo).takeUnretainedValue()
                return engine.handle(type: type, event: event)
            },
            userInfo: selfPtr
        ) else {
            Log.hotkey.error("EventTapEngine: tap creation failed — Accessibility not granted")
            state = .permissionDenied
            return
        }

        tapPort = tap
        let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        runLoop = CFRunLoopGetCurrent()
        CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        state = .running
        Log.hotkey.info("EventTapEngine: tap running (key=\(self.key.rawValue, privacy: .public))")
        CFRunLoopRun()
        Log.hotkey.info("EventTapEngine: run loop exited")
    }

    // MARK: - Event classification (tap thread)

    func handle(
        type: CGEventType,
        event: CGEvent,
        at now: TimeInterval = ProcessInfo.processInfo.systemUptime
    ) -> Unmanaged<CGEvent>? {
        // Tap health: the OS silently disables taps that are slow or during login events.
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tapPort {
                CGEvent.tapEnable(tap: tapPort, enable: true)
                Log.hotkey.warning("EventTapEngine: tap disabled by \(type == .tapDisabledByTimeout ? "timeout" : "user input", privacy: .public) — re-enabled")
                onTapRevived?()
            }
            return Unmanaged.passUnretained(event)
        }

        let keyCode = event.getIntegerValueField(.keyboardEventKeycode)
        if consumesMeetingToggle(type: type, keyCode: keyCode, event: event) {
            return nil
        }
        switch type {
        case .flagsChanged:
            lock.lock()
            let configured = key
            if editingGesture, !processor.isSessionActive, !keyIsDown, !swallowOptionF17KeyUp {
                editingGesture = false
            }
            if configured == .optionF17 || editingGesture {
                guard keyIsDown,
                      (keyCode == 58 || keyCode == 61),
                      !event.flags.contains(.maskAlternate) else {
                    lock.unlock()
                    return Unmanaged.passUnretained(event)
                }
                keyIsDown = false
                swallowOptionF17KeyUp = true
                let fx = processor.handle(.hotkeyUp, at: now)
                lock.unlock()
                apply(fx)
                // The matching Option-down was passed through, so pass its up
                // as well; swallowing only one edge can leave the front app in
                // a logically stuck modifier state.
                return Unmanaged.passUnretained(event)
            }
            guard keyCode == configured.keyCode, dictationKeyEnabled else {
                lock.unlock()
                return Unmanaged.passUnretained(event)
            }
            let isDown = configured.isDown(in: event.flags)
            guard isDown != keyIsDown else {
                lock.unlock()
                return Unmanaged.passUnretained(event)
            }
            keyIsDown = isDown
            if isDown { editingGesture = false }
            let fx = processor.handle(isDown ? .hotkeyDown : .hotkeyUp, at: now)
            lock.unlock()
            apply(fx)
            return nil // consume: this key is ours

        case .keyDown:
            // Our own synthetic events (the InsertionEngine's ⌘V) are tagged with a
            // magic userData value and must never feed the grammar.
            guard event.getIntegerValueField(.eventSourceUserData) != SyntheticEventTag.magic else {
                return Unmanaged.passUnretained(event)
            }
            lock.lock()
            if keyCode == 79, assistantToggleDown || assistantCallDown {
                lock.unlock()
                return nil
            }
            if keyCode == 79, !assistantKeysEnabled, !(keyIsDown && activeChord == 79) {
                lock.unlock()
                return Unmanaged.passUnretained(event)
            }
            if keyCode == 79, assistantLiveCall,
               event.flags.contains(.maskAlternate),
               event.flags.intersection([.maskShift, .maskControl, .maskCommand]).isEmpty,
               !keyIsDown, !processor.isSessionActive,
               event.getIntegerValueField(.keyboardEventAutorepeat) == 0 {
                assistantCallDown = true
                lock.unlock()
                onIntent?(.toggleAssistantCall)
                return nil
            }
            if keyCode == 79, claimsAssistantWindowToggle, event.flags.contains([.maskAlternate, .maskShift]),
               event.flags.intersection([.maskControl, .maskCommand]).isEmpty,
               event.getIntegerValueField(.keyboardEventAutorepeat) == 0,
               !(keyIsDown && activeChord == 79) {
                assistantToggleDown = true
                lock.unlock()
                onIntent?(.toggleAssistant)
                return nil
            }
            if ((key == .optionF17 && keyCode == 64 && dictationKeyEnabled) || keyCode == 79),
               event.flags.contains(.maskAlternate),
               event.flags.intersection([.maskShift, .maskControl, .maskCommand]).isEmpty {
                if keyIsDown {
                    lock.unlock()
                    return nil
                }
                if processor.isSessionActive, (keyCode == 79) != editingGesture {
                    lock.unlock()
                    return nil
                }
                guard event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else {
                    lock.unlock()
                    return Unmanaged.passUnretained(event)
                }
                keyIsDown = true
                activeChord = keyCode
                editingGesture = keyCode == 79
                swallowOptionF17KeyUp = false
                let fx = processor.handle(.hotkeyDown, at: now)
                lock.unlock()
                apply(fx)
                return nil
            }
            lock.unlock()
            // Autorepeats are echoes, not intent: a key held down before the
            // session started must not abort it, and repeated Space/Esc must not
            // re-fire gestures (audit #14).
            guard event.getIntegerValueField(.keyboardEventAutorepeat) == 0 else {
                return Unmanaged.passUnretained(event)
            }
            lock.lock()
            // Space while the dictation key is physically held = hands-free lock.
            // Timing-free by construction — both keys are simply down together.
            if keyCode == 49, processor.isKeyHeld {
                let fx = processor.handle(.spaceLock, at: now)
                lock.unlock()
                apply(fx)
                return nil // the Space is a gesture, not typing
            }
            // Esc cancels grammar sessions AND externally-tracked ones
            // (in-flight transcription, UI-started hands-free).
            if keyCode == 53, externalSessionActive, !processor.isSessionActive {
                lock.unlock()
                onIntent?(.cancel)
                return nil
            }
            guard processor.isSessionActive else {
                lock.unlock()
                return Unmanaged.passUnretained(event)
            }
            if keyCode == 53 { // Esc
                let fx = processor.handle(.escDown, at: now)
                lock.unlock()
                apply(fx)
                return nil // consume Esc only while dictating
            }
            let fx = processor.handle(.otherKeyDown, at: now)
            lock.unlock()
            apply(fx)
            return Unmanaged.passUnretained(event) // typing passes through

        case .keyUp:
            lock.lock()
            if keyCode == 79, assistantCallDown {
                assistantCallDown = false
                lock.unlock()
                return nil
            }
            if keyCode == 79, assistantToggleDown {
                assistantToggleDown = false
                lock.unlock()
                return nil
            }
            guard (key == .optionF17 || editingGesture), keyCode == activeChord else {
                lock.unlock()
                return Unmanaged.passUnretained(event)
            }
            if swallowOptionF17KeyUp {
                swallowOptionF17KeyUp = false
                lock.unlock()
                return nil
            }
            guard keyIsDown else {
                lock.unlock()
                return Unmanaged.passUnretained(event)
            }
            keyIsDown = false
            let fx = processor.handle(.hotkeyUp, at: now)
            lock.unlock()
            apply(fx)
            return nil

        default:
            return Unmanaged.passUnretained(event)
        }
    }

    /// The meeting chord sits beside the dictation grammar rather than inside
    /// it: a meeting is not a dictation session, and toggling one must never
    /// start, lock or cancel the other. Mirrors Shift-Option-F18 for the
    /// assistant — both edges are consumed so the front app sees neither.
    private func consumesMeetingToggle(type: CGEventType, keyCode: Int64, event: CGEvent) -> Bool {
        guard keyCode == 64, type == .keyDown || type == .keyUp else { return false }
        lock.lock()
        if type == .keyUp {
            let consume = meetingToggleDown
            meetingToggleDown = false
            lock.unlock()
            return consume
        }
        if meetingToggleDown {
            lock.unlock()
            return true // autorepeat of a toggle already delivered
        }
        guard onMeetingToggle != nil,
              event.flags.contains([.maskAlternate, .maskShift]),
              event.flags.intersection([.maskControl, .maskCommand]).isEmpty,
              event.getIntegerValueField(.keyboardEventAutorepeat) == 0,
              event.getIntegerValueField(.eventSourceUserData) != SyntheticEventTag.magic,
              !(keyIsDown && activeChord == 64)
        else {
            lock.unlock()
            return false
        }
        meetingToggleDown = true
        lock.unlock()
        onMeetingToggle?()
        return true
    }

    private func apply(_ fx: HotkeyProcessor.Effects) {
        // Timer lifecycle is confined to timerQueue — apply() runs on the tap
        // thread AND the timer queue, and unsynchronized DispatchSourceTimer
        // mutation is a crash (audit L17).
        if fx.disarmTimer || fx.armTimer != nil {
            let delay = fx.armTimer
            timerQueue.async { [weak self] in
                guard let self else { return }
                self.doubleTapTimer?.cancel()
                self.doubleTapTimer = nil
                guard let delay else { return }
                let timer = DispatchSource.makeTimerSource(queue: self.timerQueue)
                timer.schedule(deadline: .now() + delay)
                timer.setEventHandler { [weak self] in
                    guard let self else { return }
                    self.lock.lock()
                    let fx = self.processor.handle(.doubleTapTimeout, at: ProcessInfo.processInfo.systemUptime)
                    self.lock.unlock()
                    self.apply(fx)
                }
                timer.resume()
                self.doubleTapTimer = timer
            }
        }
        for intent in fx.intents {
            onIntent?(intent == .begin && editingGesture ? .beginEditing : intent)
        }
    }

    // MARK: - Health polling

    private func startHealthTimer() {
        let timer = DispatchSource.makeTimerSource(queue: timerQueue)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self, let tapPort = self.tapPort else { return }
            if !CGEvent.tapIsEnabled(tap: tapPort) {
                CGEvent.tapEnable(tap: tapPort, enable: true)
                Log.hotkey.warning("EventTapEngine: health poll found tap disabled — re-enabled")
                self.onTapRevived?()
            }
        }
        timer.resume()
        healthTimer = timer
    }
}
