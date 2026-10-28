package com.charles.bento.core.voice

import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.io.File
import java.io.IOException
import java.time.Instant

/**
 * Where the voice module's diagnostics go. The app points [sink] at android.util.Log;
 * the default drops everything. Messages never carry transcript text, prompts or keys.
 */
object VoiceLog {
    enum class Level { DEBUG, INFO, WARN, ERROR }

    @Volatile var sink: ((Level, String, String) -> Unit)? = null

    fun d(tag: String, message: String) = sink?.invoke(Level.DEBUG, tag, message)
    fun i(tag: String, message: String) = sink?.invoke(Level.INFO, tag, message)
    fun w(tag: String, message: String) = sink?.invoke(Level.WARN, tag, message)
    fun e(tag: String, message: String) = sink?.invoke(Level.ERROR, tag, message)
}

/**
 * Small persistent key/value state: Live's success/failure counters and the cleanup
 * gate's trip log (the Mac keeps both in UserDefaults). The app may back it with
 * SharedPreferences; [FileKeyValueStore] is the default.
 */
interface KeyValueStore {
    fun getLong(key: String): Long?
    fun getDouble(key: String): Double?
    fun getDoubles(key: String): List<Double>
    fun putLong(key: String, value: Long)
    fun putDouble(key: String, value: Double)
    fun putDoubles(key: String, values: List<Double>)
    fun remove(key: String)
}

class InMemoryKeyValueStore : KeyValueStore {
    private val values = HashMap<String, Any>()
    @Synchronized override fun getLong(key: String) = (values[key] as? Number)?.toLong()
    @Synchronized override fun getDouble(key: String) = (values[key] as? Number)?.toDouble()
    @Suppress("UNCHECKED_CAST")
    @Synchronized override fun getDoubles(key: String) = (values[key] as? List<Double>) ?: emptyList()
    @Synchronized override fun putLong(key: String, value: Long) { values[key] = value }
    @Synchronized override fun putDouble(key: String, value: Double) { values[key] = value }
    @Synchronized override fun putDoubles(key: String, values: List<Double>) { this.values[key] = values.toList() }
    @Synchronized override fun remove(key: String) { values.remove(key) }
}

/** A JSON object in one file, rewritten atomically on every change. Tiny by design. */
class FileKeyValueStore(private val file: File) : KeyValueStore {
    private val memory = InMemoryKeyValueStore()
    private val keys = LinkedHashSet<String>()

    init {
        val text = runCatching { file.readText() }.getOrNull()
        val root = text?.let { runCatching { VoiceJson.parseToJsonElement(it) as? JsonObject }.getOrNull() }
        root?.forEach { (key, value) ->
            when (value) {
                is JsonPrimitive -> {
                    val long = value.longOrNull
                    if (long != null && !value.content.contains('.')) memory.putLong(key, long)
                    else value.doubleOrNull?.let { memory.putDouble(key, it) }
                }
                is kotlinx.serialization.json.JsonArray ->
                    memory.putDoubles(key, value.mapNotNull { (it as? JsonPrimitive)?.doubleOrNull })
                else -> {}
            }
            keys.add(key)
        }
    }

    @Synchronized override fun getLong(key: String) = memory.getLong(key) ?: memory.getDouble(key)?.toLong()
    @Synchronized override fun getDouble(key: String) = memory.getDouble(key) ?: memory.getLong(key)?.toDouble()
    @Synchronized override fun getDoubles(key: String) = memory.getDoubles(key)
    @Synchronized override fun putLong(key: String, value: Long) { memory.putLong(key, value); keys.add(key); flush() }
    @Synchronized override fun putDouble(key: String, value: Double) { memory.putDouble(key, value); keys.add(key); flush() }
    @Synchronized override fun putDoubles(key: String, values: List<Double>) { memory.putDoubles(key, values); keys.add(key); flush() }
    @Synchronized override fun remove(key: String) { memory.remove(key); keys.remove(key); flush() }

    private fun flush() {
        val obj = buildMap {
            for (key in keys) {
                val list = memory.getDoubles(key)
                when {
                    list.isNotEmpty() -> put(key, kotlinx.serialization.json.JsonArray(list.map { JsonPrimitive(it) }))
                    memory.getLong(key) != null -> put(key, JsonPrimitive(memory.getLong(key)))
                    memory.getDouble(key) != null -> put(key, JsonPrimitive(memory.getDouble(key)))
                }
            }
        }
        try {
            AtomicFile.write(file, VoiceJson.encodeToString(JsonObject.serializer(), JsonObject(obj)).toByteArray())
        } catch (e: IOException) {
            VoiceLog.e("VoiceState", "write failed: ${e.message}")
        }
    }
}

/** Shared JSON settings for everything the module writes to disk. */
internal val VoiceJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
    prettyPrint = true
}

/** Compact variant for request bodies and large files. */
internal val VoiceJsonCompact = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    encodeDefaults = true
}

/** ISO-8601 instants ("2026-10-27T20:45:26.123Z"), like the Mac's `.iso8601` dates. */
object InstantIsoSerializer : KSerializer<Instant> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("InstantIso", PrimitiveKind.STRING)
    override fun serialize(encoder: Encoder, value: Instant) = encoder.encodeString(value.toString())
    override fun deserialize(decoder: Decoder): Instant = Instant.parse(decoder.decodeString())
}

/**
 * Write-to-temp then rename, so a killed process never leaves half a file behind
 * (the Mac's `.atomic` writes). `sync` also survives power loss, at a cost.
 */
object AtomicFile {
    @Throws(IOException::class)
    fun write(target: File, bytes: ByteArray, sync: Boolean = false) {
        target.parentFile?.mkdirs()
        val temp = File(target.parentFile, ".${target.name}.tmp")
        temp.outputStream().use { out ->
            out.write(bytes)
            if (sync) out.fd.sync()
        }
        if (!temp.renameTo(target)) {
            // Some filesystems refuse to rename over an existing file.
            target.delete()
            if (!temp.renameTo(target)) throw IOException("rename failed for ${target.name}")
        }
    }
}

/** Seconds as a double, the unit the Mac uses for every duration. */
internal fun nowSeconds(clock: () -> Instant): Double = clock().toEpochMilli() / 1000.0

/** Works for the extremes too (Instant.MIN stands in for Swift's `distantPast`; epoch millis would overflow). */
internal fun Instant.secondsSince(other: Instant): Double = (epochSecond - other.epochSecond) + (nano - other.nano) / 1e9

internal fun Instant.after(seconds: Double): Instant = plusMillis((seconds * 1000).toLong())
