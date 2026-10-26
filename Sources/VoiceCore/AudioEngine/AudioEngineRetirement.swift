import AVFoundation
import Foundation

/// Keeps a stopped engine alive for a few seconds before it is freed.
///
/// AVAudioIOUnit registers CoreAudio property listeners whose blocks run on its
/// own queue and message the unit without retaining it. Freeing the engine
/// while one is in flight crashed in `AVAudioIOUnit::IOUnitPropertyListener`
/// (field crash, build 42: the warm graph was dropped on a default-input
/// change, which is exactly when those listeners fire). Parking the engine
/// lets the blocks drain before the unit goes away.
public enum AudioEngineRetirement {
    public static let grace: TimeInterval = 5

    private static let queue = DispatchQueue(label: "com.charles.bento.voice.audio.retire", qos: .utility)

    /// Takes ownership of an engine that has already been stopped and had its
    /// taps removed. The last reference is dropped `grace` seconds later.
    public static func retire(_ engine: AVAudioEngine) {
        let parked = Parked(engine: engine)
        queue.asyncAfter(deadline: .now() + grace) { withExtendedLifetime(parked) {} }
    }

    private final class Parked: @unchecked Sendable {
        let engine: AVAudioEngine
        init(engine: AVAudioEngine) { self.engine = engine }
    }
}
