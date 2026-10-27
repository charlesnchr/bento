package com.charles.bento.core.notes

import com.charles.bento.core.json.JSONValue
import com.charles.bento.core.json.compareCodePoints
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import java.text.BreakIterator
import java.util.UUID
import kotlin.math.max

/**
 * The newest version of one device's text that a version of a note contains: that
 * device's `updated_at` for it (only ever grows for a note) and the hash of its body.
 */
data class SyncHead(val at: Long, val hash: ULong)

/** Per device (install id), the newest of its versions a version contains. */
typealias SyncHeads = Map<String, SyncHead>

/**
 * JSON text for stored heads, tagged with the hash of the body they describe:
 * `{"body":"<hex>","heads":{"<install id>":[updated_at,"<hex hash>"]}}` (sorted keys, as
 * the Mac writes it).
 */
object SyncHeadsCodec {
    fun encode(h: SyncHeads, body: String): String {
        val sb = StringBuilder()
        sb.append("{\"body\":\"").append(NoteText.hash(body).toString(16)).append("\",\"heads\":{")
        h.keys.sortedWith(::compareCodePoints).forEachIndexed { i, k ->
            if (i > 0) sb.append(',')
            sb.append(JSONValue.Str(k).canonical.let { it.substring(1, it.length - 1) })
            val v = h.getValue(k)
            sb.append(":[").append(v.at).append(",\"").append(v.hash.toString(16)).append("\"]")
        }
        sb.append("}}")
        return sb.toString()
    }

    /** null when malformed or stored with another body. */
    fun decode(s: String, body: String): SyncHeads? {
        val obj = runCatching { Json.parseToJsonElement(s) }.getOrNull() as? JsonObject ?: return null
        val tag = (obj["body"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (tag != NoteText.hash(body).toString(16)) return null
        val heads = obj["heads"] as? JsonObject ?: return null
        if (heads.values.any { it !is JsonArray }) return null
        val out = LinkedHashMap<String, SyncHead>()
        for ((k, v) in heads) {
            val a = v as JsonArray
            if (a.size != 2) return null
            val n = a[0] as? JsonPrimitive
            val at = if (n == null || n.isString) null else n.longOrNull ?: n.doubleOrNull?.let(JSONValue::int64)
            val h = (a[1] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let(::parseHex64)
            if (at == null || h == null) return null
            out[k] = SyncHead(at, h)
        }
        return out
    }
}

/**
 * `UInt64(text, radix: 16)` as Swift parses it: ASCII hex digits only, an optional "+"
 * (or "-" before zeros), null on overflow.
 */
internal fun parseHex64(text: String): ULong? {
    if (text.isEmpty()) return null
    var i = 0
    var negative = false
    if (text[0] == '+' || text[0] == '-') {
        negative = text[0] == '-'
        i = 1
        if (text.length == 1) return null
    }
    var v = 0UL
    while (i < text.length) {
        val c = text[i]
        val d = when (c) {
            in '0'..'9' -> c - '0'
            in 'a'..'z' -> c - 'a' + 10
            in 'A'..'Z' -> c - 'A' + 10
            else -> return null
        }
        if (d >= 16) return null
        if (negative) {
            if (d != 0) return null
        } else {
            if (v > (ULong.MAX_VALUE - d.toULong()) / 16UL) return null
            v = v * 16UL + d.toULong()
        }
        i++
    }
    return v
}

/**
 * One note, mirroring the sync protocol's note object plus local bookkeeping. Immutable
 * like the Mac's struct (a value type): change it with `copy`.
 */
data class Note(
    val id: String = newId(),
    val body: String = "",
    val createdAt: Long = now(),
    val updatedAt: Long = createdAt,
    /** Protocol tombstone (permanently deleted; body is ""). */
    val deleted: Boolean = false,
    /** Server seq of the version we last saw (null: never synced). */
    val seq: Long? = null,
    val device: String = "",
    val meta: Map<String, JSONValue> = emptyMap(),
    // Local only
    val dirty: Boolean = false,
    val openedAt: Long = 0,
    /**
     * `NoteText.hash` of the body of the server version this local version is based on
     * (null: unknown). Lets the sync engine tell a real concurrent edit from a meta-only
     * change on either side.
     */
    val baseHash: ULong? = null,
    /**
     * Which versions of each device's text this text contains, as far as the sync engine
     * knows (null: unknown). Local only; kept so merges survive a relaunch.
     */
    val syncHeads: SyncHeads? = null,
    /**
     * Wire only (never stored): which versions of each device's text a remote version
     * contains (`meta.base`); null when it doesn't say. Lets the engine merge concurrent
     * edits.
     */
    val remoteHeads: SyncHeads? = null,
    /** Wire only: the install id of the device that sent this version (`meta.base.from`). */
    val remoteOrigin: String? = null,
    /** Wire only: install ids its sender found shared with another device (`meta.base.retired`). */
    val remoteRetired: List<String> = emptyList(),
) {
    // MARK: Meta helpers (synced client extras)

    val pinned: Boolean get() = meta["pinned"]?.bool ?: false

    fun withPinned(value: Boolean): Note =
        copy(meta = if (value) meta + ("pinned" to JSONValue.Bool(true)) else meta - "pinned" - "pinOrder")

    /** Sort key among pinned notes (ascending). */
    val pinOrder: Double get() = meta["pinOrder"]?.double ?: createdAt.toDouble()

    fun withPinOrder(value: Double): Note = copy(meta = meta + ("pinOrder" to JSONValue.Number(value)))

    /** When the note was moved to Recently Deleted (ms), null when live. */
    val trashedAt: Long? get() = meta["trashedAt"]?.double?.let(::int64)

    fun withTrashedAt(value: Long?): Note =
        copy(meta = if (value != null) meta + ("trashedAt" to JSONValue.Number(value.toDouble())) else meta - "trashedAt")

    val isTrashed: Boolean get() = trashedAt != null
    /** Visible in the normal notes list. */
    val isLive: Boolean get() = !deleted && trashedAt == null

    // MARK: Derived text

    val title: String get() = NoteText.title(body)

    companion object {
        /** Test seam: a fixed clock for `now()`. */
        @Volatile internal var clock: (() -> Long)? = null
        /** Test seam: ids for new notes. */
        @Volatile internal var idSource: (() -> String)? = null

        fun now(): Long = clock?.invoke() ?: System.currentTimeMillis()

        /** A new note id: an uppercase UUID, as the Mac makes them. */
        fun newId(): String = idSource?.invoke() ?: UUID.randomUUID().toString().uppercase()

        /**
         * updated_at for a new local version: now, but always after each of `after`
         * (timestamps come from other clients' clocks and may be far in the future; never
         * overflow).
         */
        fun nextUpdate(vararg after: Long): Long =
            after.fold(now()) { acc, x -> max(acc, if (x == Long.MAX_VALUE) Long.MAX_VALUE else x + 1) }

        /** Long from a JSON number of any size (meta values come from other clients). */
        fun int64(d: Double): Long? = JSONValue.int64(d)
    }
}

/** Pure helpers deriving titles, plain text and counts from markdown bodies. */
object NoteText {
    /** First non-empty line with markdown stripped; "" when the note is empty. */
    fun title(body: String): String {
        SwiftText.enumerateLines(body) { line, _ ->
            val t = SwiftText.trimWhitespaces(plainLine(line))
            if (t.isNotEmpty() && !isFenceOrRule(line)) return t
        }
        return ""
    }

    fun displayTitle(body: String): String = title(body).ifEmpty { "Untitled" }

    private fun isFenceOrRule(line: String): Boolean {
        val t = SwiftText.trimWhitespaces(line)
        return swiftHasPrefix(t, "```") || swiftHasPrefix(t, "~~~") || MarkdownParser.isRule(t)
    }

    /** One line without block markers and inline syntax. */
    fun plainLine(line: String): String {
        val parsed = MarkdownParser.parseLine(line, inCode = false)
        if (parsed.kind == BlockKind.Rule) return ""
        if (parsed.kind is BlockKind.Fence) return ""
        if (parsed.kind == BlockKind.DetailsEnd) return line
        val content = line.substring(parsed.contentRange.location, parsed.contentRange.end)
        return MarkdownParser.stripInline(content)
    }

    /** Whole note as plain text (no markdown syntax), used for counts. */
    fun plainText(body: String): String {
        val lines = ArrayList<String>()
        var inCode = false
        var detailsEnd: Int? = null
        SwiftText.enumerateLines(body) { line, full ->
            val loc = full.location
            val p = MarkdownParser.parseLine(line, inCode)
            when (val k = p.kind) {
                is BlockKind.Fence -> inCode = k.opening
                BlockKind.Code -> lines.add(line)
                BlockKind.Rule -> {}
                BlockKind.DetailsEnd -> if (detailsEnd == loc) detailsEnd = null else lines.add(line)
                BlockKind.Details -> {
                    detailsEnd = MarkdownParser.expanderEnd(full, body)?.location
                    lines.add(MarkdownParser.stripInline(line.substring(p.contentRange.location, p.contentRange.end)))
                }
                else -> lines.add(MarkdownParser.stripInline(line.substring(p.contentRange.location, p.contentRange.end)))
            }
        }
        return lines.joinToString("\n")
    }

    /** Characters (Swift's) of the plain text, not counting line breaks. */
    fun characterCount(body: String): Int {
        val text = plainText(body)
        var n = 0
        val b = Graphemes.boundaries(text)
        for (k in 0 until b.size - 1) if (!(b[k + 1] - b[k] == 1 && text[b[k]] == '\n')) n++
        return n
    }

    /**
     * Words of the plain text (shown only, never synced). The Mac counts with NSString's
     * word enumeration (ICU word breaks, with dictionaries for Chinese, Japanese and
     * Thai); this counts the platform word break iterator's segments with a letter or
     * digit, split at hyphens like ICU, which agrees for space-separated scripts (all but
     * 1 of 721 test documents).
     */
    fun wordCount(body: String): Int {
        val text = plainText(body)
        val it = BreakIterator.getWordInstance(java.util.Locale.ROOT)
        it.setText(text)
        var n = 0
        var start = it.first()
        var end = it.next()
        while (end != BreakIterator.DONE) {
            // ICU splits at hyphens ("code-ish" is two words), the JDK's iterator doesn't
            var word = false
            var i = start
            while (i < end) {
                val c = text.codePointAt(i)
                if (c == '-'.code) {
                    if (word) n++
                    word = false
                } else if (Character.isLetterOrDigit(c)) {
                    word = true
                }
                i += Character.charCount(c)
            }
            if (word) n++
            start = end
            end = it.next()
        }
        return n
    }

    /** Lowercased haystack for search. */
    fun searchText(body: String): String = SwiftText.lowercased(plainText(body))

    /** Stable 64-bit FNV-1a hash of the UTF-8 bytes. */
    fun hash(s: String): ULong {
        var h = 0xcbf29ce484222325UL
        val prime = 0x00000100000001b3UL
        fun byte(b: Int) {
            h = h xor b.toULong()
            h *= prime
        }
        var i = 0
        val n = s.length
        while (i < n) {
            val c = s[i].code
            when {
                c < 0x80 -> byte(c)
                c < 0x800 -> {
                    byte(0xC0 or (c shr 6))
                    byte(0x80 or (c and 0x3F))
                }
                Character.isHighSurrogate(s[i]) && i + 1 < n && Character.isLowSurrogate(s[i + 1]) -> {
                    val cp = Character.toCodePoint(s[i], s[i + 1])
                    byte(0xF0 or (cp shr 18))
                    byte(0x80 or ((cp shr 12) and 0x3F))
                    byte(0x80 or ((cp shr 6) and 0x3F))
                    byte(0x80 or (cp and 0x3F))
                    i++
                }
                c in 0xD800..0xDFFF -> { // a lone surrogate: U+FFFD, as Swift stores it
                    byte(0xEF)
                    byte(0xBF)
                    byte(0xBD)
                }
                else -> {
                    byte(0xE0 or (c shr 12))
                    byte(0x80 or ((c shr 6) and 0x3F))
                    byte(0x80 or (c and 0x3F))
                }
            }
            i++
        }
        return h
    }

    /**
     * Body of a conflicted copy: the title line gets " (conflicted copy, <device>)".
     * null when the body has no visible text (nothing worth keeping).
     */
    fun conflictCopyBody(body: String, device: String): String? {
        // same line `title` picks, so the copy is recognisable in the notes list
        val lines = body.split("\n").toMutableList()
        for ((i, line) in lines.withIndex()) {
            if (isFenceOrRule(line) || SwiftText.trimWhitespaces(plainLine(line)).isEmpty()) continue
            val suffix = if (device.isEmpty()) " (conflicted copy)" else " (conflicted copy, $device)"
            lines[i] = trimTrailingWhiteSpace(line) + suffix
            return lines.joinToString("\n")
        }
        return null
    }

    /** `replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)`. */
    private fun trimTrailingWhiteSpace(s: String): String {
        var end = s.length
        while (end > 0 && SwiftText.isWhiteSpaceProperty(s[end - 1].code)) end--
        return s.substring(0, end)
    }
}

/** "4m ago", "3w ago" style relative dates like Raycast's notes list. */
object RelativeDate {
    fun short(ms: Long, now: Long = Note.now()): String {
        val diff = now - ms
        val overflow = ((now xor ms) and (now xor diff)) < 0
        val s = if (overflow) (if (ms < 0) Long.MAX_VALUE / 1000 else 0) else max(0, diff / 1000)
        if (s < 60) return "just now"
        val m = s / 60
        if (m < 60) return "${m}m ago"
        val h = m / 60
        if (h < 24) return "${h}h ago"
        val d = h / 24
        if (d < 7) return "${d}d ago"
        if (d < 30) return "${d / 7}w ago"
        if (d < 365) return "${d / 30}mo ago"
        return "${d / 365}y ago"
    }
}
