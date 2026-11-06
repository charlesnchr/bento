package com.charles.bento.core.voice.wake

import ai.onnxruntime.OnnxJavaType
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * A LiveKit WakeWord v2 model (`livekit-wakeword train`, Apache 2.0) on ONNX Runtime: input
 * `chunk` (1, 1280) and its state tensors, outputs `score` and each state as `<name>_out`.
 * Port of the Python client's `_Stream`: the state starts at zero and is warmed up on 2 s of
 * silence, which is what [reset] returns to.
 *
 * The state lives in two sets of direct buffers that swap each step (ONNX Runtime writes the
 * outputs straight into the other set), so a step allocates nothing. One thread at a time.
 * The app has ONNX Runtime for Android; this module compiles against the same Java API.
 */
class OnnxWakeModel(model: ByteArray) : WakeModel {
    private val env = OrtEnvironment.getEnvironment()
    private val session: OrtSession
    private val chunk: Buffer
    private val score: Buffer
    /** Each state input's name, its two buffers, and the warm state. */
    private class State(val name: String, val sets: Array<Buffer>, var warm: ByteArray = ByteArray(0))
    private val states: List<State>
    private var current = 0
    private lateinit var chunkFloats: java.nio.FloatBuffer
    /** For each [current]: the inputs and the outputs ONNX Runtime writes into. */
    private lateinit var runs: List<Pair<Map<String, OnnxTensor>, Map<String, OnnxTensor>>>

    /** One direct buffer and the tensor over it. */
    private class Buffer(val bytes: ByteBuffer, val tensor: OnnxTensor)

    init {
        runCatching { env.setTelemetry(false) }
        val options = OrtSession.SessionOptions().apply {
            setIntraOpNumThreads(1)
            setInterOpNumThreads(1)
            setExecutionMode(OrtSession.SessionOptions.ExecutionMode.SEQUENTIAL)
            setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
            addConfigEntry("session.intra_op.allow_spinning", "0")
            addConfigEntry("session.inter_op.allow_spinning", "0")
            // ONNX Runtime 1.27 on arm64 ran batch-1 convolutions through KleidiAI kernels that returned wrong results (the Python client's fix)
            addConfigEntry("mlas.disable_kleidiai", "1")
        }
        session = options.use { env.createSession(model, it) }
        val inputs = session.inputInfo
        require("chunk" in inputs) { "not a streaming wake word model (no chunk input)" }
        chunk = buffer(longArrayOf(1, WakeModel.FRAME.toLong()), OnnxJavaType.FLOAT)
        score = buffer(longArrayOf(1), OnnxJavaType.FLOAT)
        states = inputs.filterKeys { it != "chunk" }.map { (name, info) ->
            val t = info.info as ai.onnxruntime.TensorInfo
            State(name, Array(2) { buffer(t.shape, t.type) })
        }
        for (s in states) require("${s.name}_out" in session.outputNames) { "no ${s.name}_out output" }
        chunkFloats = chunk.bytes.asFloatBuffer()
        runs = (0..1).map { from ->
            val inputs = mapOf("chunk" to chunk.tensor) + states.associate { it.name to it.sets[from].tensor }
            val outputs = mapOf("score" to score.tensor) + states.associate { "${it.name}_out" to it.sets[1 - from].tensor }
            inputs to outputs
        }
        val silence = FloatArray(WakeModel.FRAME)
        repeat(WARMUP_STEPS) { step(silence) }
        for (s in states) s.warm = ByteArray(s.sets[current].bytes.capacity()).also { s.sets[current].bytes.duplicate().clear().get(it) }
    }

    private fun buffer(shape: LongArray, type: OnnxJavaType): Buffer {
        val size = shape.fold(1L) { a, b -> a * b }.toInt() * if (type == OnnxJavaType.INT64 || type == OnnxJavaType.DOUBLE) 8 else 4
        val bytes = ByteBuffer.allocateDirect(size).order(ByteOrder.nativeOrder())
        return Buffer(bytes, OnnxTensor.createTensor(env, bytes, shape, type))
    }

    override fun step(frame: FloatArray): Float {
        require(frame.size == WakeModel.FRAME)
        chunkFloats.clear()
        chunkFloats.put(frame)
        val (inputs, outputs) = runs[current]
        session.run(inputs, outputs).close()
        current = 1 - current
        return score.bytes.getFloat(0)
    }

    override fun reset() {
        for (s in states) s.sets[current].bytes.duplicate().clear().put(s.warm)
    }

    override fun close() {
        session.close()
        (states.flatMap { it.sets.toList() } + chunk + score).forEach { it.tensor.close() }
    }

    companion object {
        /** 2 s of silence: the state every stream starts from, as in training. */
        const val WARMUP_STEPS = 25
    }
}
