package com.charles.bento.core.notes

import com.charles.bento.core.sync.SyncConnection
import com.charles.bento.core.sync.SyncEndpoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Images in notes (docs/SYNC_PROTOCOL.md, Images): a line `![alt](bento-image:<sha256>)`
 * refers to a blob stored by the SHA-256 of its bytes, kept in a local cache and on the sync
 * server. The Mac's NoteImage.
 */
object NoteImage {
    const val SCHEME = "bento-image:"
    /** Largest blob the server takes (server/src/store.rs). */
    const val MAX_BYTES = 10 * 1024 * 1024
    /** Longest side of an image that gets re-encoded. */
    const val MAX_PIXELS = 4096

    private val lineRe = Regex("^[ \\t]*!\\[[^\\]\\n]*\\]\\(bento-image:([0-9a-f]{64})\\)[ \\t]*$")

    /** The hash of the image when the line (without its newline) is nothing but one image. */
    fun hash(line: String): String? {
        if (line.length < 78 || SCHEME !in line) return null
        return lineRe.matchEntire(line)?.groupValues?.get(1)
    }

    fun markdown(hash: String): String = "![]($SCHEME$hash)"

    /** Hashes of the image lines in a body, in order, without repeats. */
    fun hashes(body: String): List<String> {
        if (SCHEME !in body) return emptyList()
        val out = LinkedHashSet<String>()
        SwiftText.enumerateLines(body) { line, _ -> hash(line)?.let(out::add) }
        return out.toList()
    }

    /** Inserts images at the selection (replacing it), each on a line of its own, with the caret on the line after them. */
    fun insertion(text: String, selection: TextRange, hashes: List<String>): EditResult {
        val leading = selection.location > 0 && text[selection.location - 1] != '\n'
        val rep = (if (leading) "\n" else "") + hashes.joinToString("\n", transform = ::markdown) + "\n"
        return EditResult(listOf(TextEdit(selection, rep)), TextRange(selection.location + rep.length, 0))
    }

    /** Removes the lines showing the image (with their line breaks); null when there are none. */
    fun removal(text: String, hash: String): EditResult? {
        val edits = ArrayList<TextEdit>()
        SwiftText.enumerateLines(text) { line, full -> if (hash(line) == hash) edits.add(TextEdit(full, "")) }
        if (edits.isEmpty()) return null
        // a last line without a line break takes the one before it
        val last = edits.last()
        if (last.range.end == text.length && !text.endsWith("\n") && last.range.location > 0 &&
            edits.none { it.range.end == last.range.location }) {
            edits[edits.size - 1] = TextEdit(TextRange(last.range.location - 1, last.range.length + 1), "")
        }
        val removedBefore = edits.first().range.location
        return EditResult(edits, TextRange(minOf(removedBefore, text.length - edits.sumOf { it.range.length }), 0))
    }

    fun sha256(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /** The image format of `bytes` the server accepts, from its first bytes. */
    fun mimeType(bytes: ByteArray): String? {
        fun at(i: Int, s: String) = bytes.size >= i + s.length && s.indices.all { bytes[i + it] == s[it].code.toByte() }
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        return when {
            bytes.size >= 8 && png.indices.all { bytes[it] == png[it] } -> "image/png"
            bytes.size >= 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte() -> "image/jpeg"
            at(0, "GIF87a") || at(0, "GIF89a") -> "image/gif"
            at(0, "RIFF") && at(8, "WEBP") -> "image/webp"
            at(4, "ftyp") && (at(8, "heic") || at(8, "heix") || at(8, "heim") || at(8, "heis")) -> "image/heic"
            at(4, "ftyp") && (at(8, "mif1") || at(8, "msf1")) -> "image/heif"
            else -> null
        }
    }
}

/**
 * The images of notes on this device: `<dir>/<hash>`, with an empty `<dir>/upload/<hash>`
 * while the server doesn't have it yet. Thread safe (files only).
 */
class NoteImageStore(val dir: File) {
    private val uploadDir = File(dir, "upload")

    init { uploadDir.mkdirs() }

    private fun file(hash: String) = File(dir, hash)

    fun has(hash: String): Boolean = file(hash).isFile

    fun data(hash: String): ByteArray? = runCatching { file(hash).readBytes() }.getOrNull()

    fun path(hash: String): File? = file(hash).takeIf { it.isFile }

    /** Adds an image made here (bytes the server takes: see [NoteImage.mimeType]); returns its hash. Uploaded on the next chance. */
    fun add(bytes: ByteArray): String? {
        if (NoteImage.mimeType(bytes) == null || bytes.size > NoteImage.MAX_BYTES) return null
        val hash = NoteImage.sha256(bytes)
        if (!has(hash) && !write(hash, bytes)) return null
        File(uploadDir, hash).createNewFile()
        return hash
    }

    /** Stores an image fetched from the server (checked against its hash). */
    fun store(bytes: ByteArray, hash: String): Boolean = NoteImage.sha256(bytes) == hash && write(hash, bytes)

    private fun write(hash: String, bytes: ByteArray): Boolean = runCatching {
        val tmp = File(dir, ".$hash.tmp")
        tmp.writeBytes(bytes)
        tmp.renameTo(file(hash)) || error("rename failed")
    }.isSuccess

    /** Images still to upload. */
    val pendingUploads: List<String>
        get() = uploadDir.list()?.filter { it.length == 64 && has(it) }?.sorted().orEmpty()

    fun uploaded(hash: String) { File(uploadDir, hash).delete() }
}

/**
 * Moves images between the store and the sync server: uploads the pending ones and fetches
 * the ones notes show that aren't here. Network calls run on [Dispatchers.IO].
 */
class NoteImageSync(
    val store: NoteImageStore,
    private val http: OkHttpClient,
    /** The server and token while paired; null otherwise. */
    private val endpoint: () -> SyncEndpoint?,
    private val scope: CoroutineScope,
    private val log: (String) -> Unit = {},
    private val now: () -> Long = System::currentTimeMillis,
) {
    private val _changed = MutableSharedFlow<String>(extraBufferCapacity = 64)
    /** An image arrived, or turned out not to be on the server yet (the placeholder says so). */
    val changed: SharedFlow<String> = _changed

    private val uploading = ConcurrentHashMap.newKeySet<String>()
    private val fetching = ConcurrentHashMap.newKeySet<String>()
    /** Images the server didn't have, and when we last asked (asked again after a while). */
    private val missing = ConcurrentHashMap<String, Long>()
    @Volatile private var serverHasBlobs: Pair<String, Boolean>? = null
    private val json = Json { ignoreUnknownKeys = true }

    /** Sync (re)connected: upload what's pending and ask again for what was missing. */
    fun connected() {
        missing.clear()
        serverHasBlobs = null
        uploadPending()
    }

    fun uploadPending() { scope.launch { uploadPendingNow() } }

    /** Uploads what's pending; true when nothing is left. */
    suspend fun uploadPendingNow(): Boolean = withContext(Dispatchers.IO) {
        val (base, token) = target() ?: return@withContext store.pendingUploads.isEmpty()
        if (!hasBlobs(base)) return@withContext store.pendingUploads.isEmpty()
        for (hash in store.pendingUploads) {
            if (!uploading.add(hash)) continue
            try { upload(hash, base, token) } finally { uploading.remove(hash) }
        }
        store.pendingUploads.isEmpty()
    }

    /** Whether the image is coming (being fetched, or not known to be missing while paired). */
    fun isLoading(hash: String): Boolean = hash in fetching || (missing[hash] == null && target() != null)

    /** Fetches an image that isn't here ([changed] follows). Asks again for a missing one after 30 s. */
    fun fetch(hash: String) {
        if (store.has(hash) || hash in fetching || target() == null) return
        if ((missing[hash] ?: Long.MIN_VALUE) > now() - 30_000) return
        if (!fetching.add(hash)) return
        scope.launch {
            try { fetchNow(hash) } finally { fetching.remove(hash); _changed.tryEmit(hash) }
        }
    }

    suspend fun fetchNow(hash: String): Boolean = withContext(Dispatchers.IO) {
        val (base, token) = target() ?: return@withContext false
        val ok = runCatching {
            http.newCall(Request.Builder().url("$base/v1/blobs/$hash").header("Authorization", "Bearer $token").build())
                .also { it.timeout().timeout(60, TimeUnit.SECONDS) }.execute().use { r ->
                    if (r.code != 404 && !r.isSuccessful) log("Image ${hash.take(12)} not fetched: HTTP ${r.code}")
                    r.isSuccessful && store.store(r.body.bytes(), hash)
                }
        }.onFailure { log("Image ${hash.take(12)} not fetched: ${it.message}") }.getOrDefault(false)
        if (ok) missing.remove(hash) else missing[hash] = now()
        ok
    }

    private fun upload(hash: String, base: String, token: String) {
        val bytes = store.data(hash) ?: return
        val type = (NoteImage.mimeType(bytes) ?: "application/octet-stream").toMediaType()
        runCatching {
            http.newCall(Request.Builder().url("$base/v1/blobs/$hash").header("Authorization", "Bearer $token")
                             .put(bytes.toRequestBody(type)).build())
                .also { it.timeout().timeout(120, TimeUnit.SECONDS) }.execute().use { r ->
                    when (r.code) {
                        200 -> store.uploaded(hash)
                        // the server will never take it: stop trying, the image stays on this device
                        400, 413, 415 -> { store.uploaded(hash); log("Image ${hash.take(12)} refused by the server (HTTP ${r.code})") }
                        else -> log("Image ${hash.take(12)} not uploaded: HTTP ${r.code}")
                    }
                }
        }.onFailure { log("Image ${hash.take(12)} not uploaded: ${it.message}") }
    }

    private fun target(): Pair<String, String>? {
        val e = endpoint() ?: return null
        val token = e.token?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        val base = SyncConnection.baseUrl(e.server)?.toString()?.trimEnd('/') ?: return null
        return base to token
    }

    /** Whether the server stores images (`/v1/health` says `blobs`). */
    private fun hasBlobs(base: String): Boolean {
        serverHasBlobs?.takeIf { it.first == base }?.let { return it.second }
        val ok = runCatching {
            http.newCall(Request.Builder().url("$base/v1/health").build()).also { it.timeout().timeout(15, TimeUnit.SECONDS) }.execute().use { r ->
                if (!r.isSuccessful) return false // unreachable: ask again next time
                json.parseToJsonElement(r.body.string()).jsonObject["blobs"]?.jsonPrimitive?.boolean == true
            }
        }.getOrElse { return false }
        serverHasBlobs = base to ok
        if (!ok) log("Sync server doesn't store images yet; they stay on this device")
        return ok
    }
}
