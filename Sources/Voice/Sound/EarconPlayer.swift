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

import AVFoundation
import VoiceCore

/// Preloaded earcon playback (<10ms trigger latency). Sounds fire on the same
/// state-machine tick as the matching animation — the Pixel frame-sync principle.
/// No sounds on hover/menus, ever: design the silence.
///
/// One shared instance. The players are touched only on `queue`: AudioQueue
/// calls are XPC round trips that can block for a long time (the first play,
/// a sleeping output route), and a main-thread setVolume once waited forever
/// behind another player's warm-up, hanging the whole app.
final class EarconPlayer: @unchecked Sendable {
    enum Earcon: String, CaseIterable {
        case start, stop, lock, success, cancel, error, celebration
    }

    static let shared = EarconPlayer()

    private let queue = DispatchQueue(label: "com.charles.bento.voice.earcons", qos: .userInitiated)
    /// Only on `queue`.
    private var players: [Earcon: AVAudioPlayer] = [:]
    /// Live-follows the Settings toggle (UserDefaults reads are cheap).
    var enabled: Bool { SettingsStore().soundsEnabled }

    private init() {
        // Loading 7 players takes ~120ms: never on the main thread at launch,
        // never in front of the first key press.
        queue.async { [self] in players = Self.loadPlayers() }
    }

    private static func loadPlayers() -> [Earcon: AVAudioPlayer] {
        var players: [Earcon: AVAudioPlayer] = [:]
        for earcon in Earcon.allCases {
            guard let url = VoiceResources.url(earcon.rawValue, "wav", in: "Sounds") else {
                Log.ui.warning("EarconPlayer: missing \(earcon.rawValue, privacy: .public).wav")
                continue
            }
            if let player = try? AVAudioPlayer(contentsOf: url) {
                player.prepareToPlay()
                player.volume = 0.9
                players[earcon] = player
            }
        }
        return players
    }

    /// The first play() of a player blocks while its AudioQueue is built and the
    /// output route spins up (45–475 ms on USB/Bluetooth). That now happens on
    /// the earcon queue, so it delays only the sound, not the microphone. Jot
    /// paid it at launch with a silent play, but any playback can make AirPods
    /// switch to the Mac. Never stop() a player: an explicit stop re-costs the
    /// next play ~440ms.
    func play(_ earcon: Earcon) {
        guard enabled else { return }
        queue.async { [self] in
            guard let player = players[earcon] else { return }
            player.currentTime = 0
            player.play()
        }
    }
}
