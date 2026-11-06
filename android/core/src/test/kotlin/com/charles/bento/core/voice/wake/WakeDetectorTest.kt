package com.charles.bento.core.voice.wake

import com.charles.bento.core.voice.silence
import com.charles.bento.core.voice.tone
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.float
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.util.Random
import kotlin.math.abs
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** A model that scores by a rule and counts what it hears. */
private class FakeModel(private val scoreOf: (FloatArray) -> Float = { 0f }) : WakeModel {
    var steps = 0
    var resets = 0
    val heard = ArrayList<FloatArray>()
    override fun step(frame: FloatArray): Float { steps++; heard.add(frame); return scoreOf(frame) }
    override fun reset() { resets++ }
}

/** Quiet-room noise at about -64 dBFS, seeded. */
private fun noise(seconds: Double, sigma: Double = 20.0, seed: Long = 1): ShortArray {
    val r = Random(seed)
    return ShortArray((seconds * 16_000).toInt()) { (r.nextGaussian() * sigma).toInt().toShort() }
}

private fun wav(name: String): ShortArray {
    val bytes = File(WakeDetectorTest::class.java.getResource("/wake/$name.wav")!!.toURI()).readBytes()
    val data = bytes.copyOfRange(44, bytes.size)
    return ShortArray(data.size / 2) { i -> ((data[2 * i].toInt() and 0xFF) or (data[2 * i + 1].toInt() shl 8)).toShort() }
}

class WakeDetectorTest {
    @Test
    fun aQuietRoomRunsNoInference() {
        val model = FakeModel()
        val d = WakeDetector(model)
        d.feed(noise(30.0))
        d.feed(silence(10.0))
        assertEquals(0, model.steps)
        assertEquals(500L, d.frames)
        assertEquals(0L, d.scored)
    }

    @Test
    fun soundOpensTheGateWithTheMomentBefore() {
        val model = FakeModel()
        val d = WakeDetector(model)
        d.feed(noise(5.0))
        val speech = tone(0.8, amplitude = 3_000.0)
        d.feed(speech)
        // the model started afresh and heard the 2 s before the sound, then the sound itself
        assertEquals(1, model.resets)
        val limits = WakeDetector.Limits()
        assertTrue(model.steps >= limits.preRollFrames + speech.size / WakeModel.FRAME)
        // the first frames it heard were the room before the speech
        assertTrue(WakeDetector.dbfs(model.heard.first()) < -55)
    }

    @Test
    fun theGateClosesAfterTheHangover() {
        val model = FakeModel()
        val d = WakeDetector(model)
        d.feed(noise(5.0))
        d.feed(tone(1.0, amplitude = 3_000.0))
        val during = model.steps
        d.feed(noise(10.0, seed = 2))
        val after = model.steps - during
        // about 2 s of hangover, then nothing
        assertTrue(after in 20..30, "scored $after frames after the sound")
    }

    @Test
    fun steadyNoiseStopsOpeningTheGate() {
        // a fan: loud, but its own floor
        val model = FakeModel()
        val d = WakeDetector(model)
        d.feed(noise(20.0, sigma = 600.0))
        val first = model.steps
        d.feed(noise(20.0, sigma = 600.0, seed = 3))
        assertTrue(model.steps - first < 100, "steady noise scored ${model.steps - first} of 250 frames")
    }

    @Test
    fun aDetectionResetsAndIsQuietForTheRefractoryTime() {
        val model = FakeModel { 0.9f }
        val d = WakeDetector(model)
        d.feed(noise(3.0))
        var detections = 0
        val loud = tone(4.0, amplitude = 3_000.0)
        for (i in loud.indices step WakeModel.FRAME) {
            if (d.feed(loud.copyOfRange(i, minOf(i + WakeModel.FRAME, loud.size))) != null) detections++
        }
        // 4 s of "wake word" with a 2 s refractory time: two detections
        assertEquals(2, detections)
    }

    @Test
    fun theAudioAfterADetectionIsLeftForTheCall() {
        // the model fires on the first loud frame: the rest of the read is the start of the request
        val model = FakeModel { if (WakeDetector.dbfs(it) > -40) 0.9f else 0f }
        val d = WakeDetector(model)
        d.feed(noise(2.4)) // 30 whole frames: the read starts on a frame boundary
        val read = tone(0.32, amplitude = 3_000.0) // four frames
        val hit = assertNotNull(d.feed(read))
        assertEquals(WakeModel.FRAME, hit.rest)
        assertEquals(0L, d.frames - 1 - hit.atFrame, "nothing after the detection was fed")
    }

    @Test
    fun partialChunksAddUp() {
        val model = FakeModel()
        val d = WakeDetector(model)
        val pcm = noise(1.0)
        var i = 0
        while (i < pcm.size) { val n = minOf(333, pcm.size - i); d.feed(pcm.copyOfRange(i, i + n)); i += n }
        assertEquals(12L, d.frames) // 16000 / 1280, the rest pending
    }
}

/** The shipped model, run through the app's runtime, against the LiveKit Python client's scores for the same audio. */
class OnnxWakeModelTest {
    private val modelFile = File("../app/src/main/assets/wakeword/woodhouse.onnx")
    private val reference = Json.parseToJsonElement(File(javaClass.getResource("/wake/reference_scores.json")!!.toURI()).readText()) as JsonObject

    @Test
    fun scoresMatchThePythonClient() {
        OnnxWakeModel(modelFile.readBytes()).use { model ->
            for ((name, expected) in reference) {
                model.reset()
                val pcm = wav(name)
                val scores = (0 until pcm.size / WakeModel.FRAME).map { f ->
                    model.step(FloatArray(WakeModel.FRAME) { pcm[f * WakeModel.FRAME + it] / 32768f })
                }
                val want = expected.jsonArray.map { it.jsonPrimitive.float }
                assertEquals(want.size, scores.size, name)
                val worst = scores.zip(want).maxOf { (a, b) -> abs(a - b) }
                assertTrue(worst < 1e-3, "$name: largest difference $worst")
            }
        }
    }

    @Test
    fun theDetectorFindsTheWordAndNothingElse() {
        OnnxWakeModel(modelFile.readBytes()).use { model ->
            for (name in reference.keys) {
                val d = WakeDetector(model)
                // a stretch of quiet room first: the gate is shut when the word starts
                d.feed(noise(4.0))
                val hit = d.feed(wav(name))
                if (name.startsWith("woodhouse")) assertNotNull(hit, name) else assertNull(hit, name)
                hit?.let { assertTrue(it.score > 0.7f) }
                // the gate saved the silence
                assertTrue(d.scored < d.frames, name)
            }
        }
    }

    @Test
    fun aWordRightAfterAnotherStillCounts() {
        // "Woodhouse" 2.5 s after another, on one detector: the refractory time is over
        OnnxWakeModel(modelFile.readBytes()).use { model ->
            val d = WakeDetector(model)
            d.feed(noise(2.0))
            assertNotNull(d.feed(wav("woodhouse_alan")))
            assertNotNull(d.feed(wav("woodhouse_amy")))
        }
    }
}
