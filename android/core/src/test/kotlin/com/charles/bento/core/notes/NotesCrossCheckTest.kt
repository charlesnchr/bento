package com.charles.bento.core.notes

import com.charles.bento.core.json.JSONValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import java.time.Instant
import java.time.ZoneId
import java.util.zip.GZIPInputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Checks the port against outputs of the Mac's real Swift code (notes-vectors.jsonl.gz,
 * made by android/core/xcheck/notes/generate.sh on macOS with Swift 6.2): diffs, merges
 * and selection mapping, Swift characters and NSString composed character sequences,
 * markdown parsing, titles and plain text, the wire format, thought capture, search, and
 * 900 live-merge fuzz runs replayed step by step.
 */
class NotesCrossCheckTest {
    companion object {
        val vectors: Map<String, List<JsonObject>> by lazy {
            val stream = NotesCrossCheckTest::class.java.getResourceAsStream("/notes/notes-vectors.jsonl.gz")
                ?: error("notes-vectors.jsonl.gz missing")
            GZIPInputStream(stream).bufferedReader(Charsets.UTF_8).useLines { lines ->
                lines.filter { it.isNotBlank() }.map { Json.parseToJsonElement(it).jsonObject }.toList()
            }.groupBy { it.str("t") }
        }

        fun JsonObject.str(k: String): String = getValue(k).jsonPrimitive.content
        fun JsonObject.strOrNull(k: String): String? = (get(k) as? JsonPrimitive)?.takeIf { it.isString }?.content
        fun JsonElement.range(): TextRange = jsonArray.let { TextRange(it[0].jsonPrimitive.int, it[1].jsonPrimitive.int) }
        fun JsonElement.rangeOrNull(): TextRange? = if (this is JsonNull) null else range()
    }

    private class Report(val what: String) {
        var checked = 0
        val failures = ArrayList<String>()
        fun check(ok: Boolean, detail: () -> String) {
            checked++
            if (!ok) failures.add(detail())
        }
        fun eq(expected: Any?, actual: Any?, label: () -> String) = check(expected == actual) { "${label()}: expected ${show(expected)}, got ${show(actual)}" }
        fun done(min: Int) {
            println("$what: $checked checks, ${failures.size} mismatches")
            // XCHECK_DUMP=<dir>: every mismatch, for debugging
            System.getenv("XCHECK_DUMP")?.let { dir ->
                java.io.File(dir, what.replace(Regex("[^A-Za-z]+"), "_") + ".txt").writeText(failures.joinToString("\n"))
            }
            if (failures.isNotEmpty()) fail("$what: ${failures.size} of $checked differ from the Mac:\n" + failures.take(25).joinToString("\n"))
            assertTrue(checked >= min, "$what: only $checked checks")
        }
        private fun show(x: Any?): String = when (x) {
            is String -> esc(x)
            is List<*> -> x.joinToString(prefix = "[", postfix = "]") { show(it) }
            else -> x.toString()
        }
    }

    private fun edits(a: JsonElement): List<TextEdit> =
        a.jsonArray.map { e -> e.jsonArray.let { TextEdit(it[0].jsonPrimitive.int, it[1].jsonPrimitive.int, it[2].jsonPrimitive.content) } }

    @Test
    fun textMergeMatchesTheMac() {
        val r = Report("TextMerge")
        for (v in vectors.getValue("merge")) {
            val base = v.str("base")
            val local = v.str("local")
            val remote = v.str("remote")
            val label = { "base=${esc(base.take(120))} local=${esc(local.take(120))} remote=${esc(remote.take(120))}" }
            val el = TextMerge.edits(base, local)
            r.eq(edits(v.getValue("el")), el) { "edits(base, local) ${label()}" }
            val er = TextMerge.edits(base, remote)
            r.eq(edits(v.getValue("er")), er) { "edits(base, remote) ${label()}" }
            v["ex"]?.let { r.eq(edits(it), TextMerge.edits(local, remote)) { "edits(local, remote) ${label()}" } }
            r.eq(v.strOrNull("m"), TextMerge.merge(base, local, remote)) { "merge ${label()}" }
            r.eq(v.strOrNull("m2"), TextMerge.merge(base, remote, local)) { "merge reversed ${label()}" }
            for (s in v.getValue("sel").jsonArray) {
                val a = s.jsonArray.map { it.jsonPrimitive.int }
                r.eq(TextRange(a[2], a[3]), TextMerge.map(TextRange(a[0], a[1]), el)) { "map(${a[0]}, ${a[1]}) ${label()}" }
            }
            for (p in v.getValue("pt").jsonArray) {
                val a = p.jsonArray.map { it.jsonPrimitive.int }
                r.eq(a[3], TextMerge.map(a[0], er, pastInsertions = a[1] == 1, insideToEnd = a[2] == 1)) { "map point $a ${label()}" }
            }
        }
        r.done(2000 * 5)
    }

    @Test
    fun charactersAndComposedSequencesMatchTheMac() {
        val r = Report("Characters")
        for (v in vectors.getValue("g")) {
            val s = v.str("s")
            r.eq(v.getValue("chars").jsonArray.map { it.jsonPrimitive.int }, Graphemes.boundaries(s).toList()) { "characters of ${esc(s)}" }
            v.getValue("composed").jsonArray.forEachIndexed { i, e ->
                r.eq(e.range(), ComposedCharacters.range(s, i)) { "composed range at $i of ${esc(s)}" }
            }
        }
        r.done(400)
    }

    private fun kindDesc(k: BlockKind): String = when (k) {
        BlockKind.Paragraph -> "paragraph"
        is BlockKind.Heading -> "heading:${k.level}"
        BlockKind.Bullet -> "bullet"
        is BlockKind.Ordered -> "ordered:${k.number}"
        is BlockKind.Task -> "task:${if (k.checked) 1 else 0}"
        is BlockKind.Quote -> "quote:${k.depth}"
        BlockKind.Rule -> "rule"
        is BlockKind.Fence -> "fence:${if (k.opening) 1 else 0}:${k.lang}"
        BlockKind.Code -> "code"
    }

    private fun lineDesc(p: ParsedLine): List<Any?> =
        listOf(kindDesc(p.kind), p.level, p.prefixRange, p.contentRange, p.markerRange, p.bulletChar.toString())

    private fun lineDesc(e: JsonElement): List<Any?> = e.jsonArray.let {
        listOf(it[0].jsonPrimitive.content, it[1].jsonPrimitive.int, it[2].range(), it[3].range(), it[4].rangeOrNull(), it[5].jsonPrimitive.content)
    }

    private fun spanDesc(s: InlineSpan): List<Any> {
        val kind = when (val k = s.kind) {
            InlineKind.Bold -> "bold"
            InlineKind.Italic -> "italic"
            InlineKind.BoldItalic -> "boldItalic"
            InlineKind.Strike -> "strike"
            InlineKind.Underline -> "underline"
            InlineKind.Code -> "code"
            is InlineKind.Link -> "link:" + k.url
            is InlineKind.Autolink -> "autolink:" + k.url
        }
        return listOf(kind, s.range, s.contentRange, s.markers)
    }

    private fun spanDesc(e: JsonElement): List<Any> = e.jsonArray.let { a ->
        listOf(a[0].jsonPrimitive.content, a[1].range(), a[2].range(), a[3].jsonArray.map { it.range() })
    }

    @Test
    fun markdownLinesMatchTheMac() {
        val r = Report("MarkdownParser lines")
        for (v in vectors.getValue("line")) {
            val s = v.str("s")
            val l = { esc(s) }
            r.eq(lineDesc(v.getValue("p0")), lineDesc(MarkdownParser.parseLine(s, inCode = false))) { "parseLine ${l()}" }
            r.eq(lineDesc(v.getValue("p1")), lineDesc(MarkdownParser.parseLine(s, inCode = true))) { "parseLine inCode ${l()}" }
            val fence = v.getValue("fence").let { if (it is JsonNull) null else it.jsonArray.let { a -> FenceInfo(a[0].jsonPrimitive.int.toChar(), a[1].jsonPrimitive.content) } }
            r.eq(fence, MarkdownParser.isFence(s)) { "isFence ${l()}" }
            r.eq(v.getValue("rule").jsonPrimitive.boolean, MarkdownParser.isRule(s)) { "isRule ${l()}" }
            r.eq(v.str("strip"), MarkdownParser.stripInline(s)) { "stripInline ${l()}" }
            r.eq(v.getValue("spans").jsonArray.map { spanDesc(it) }, MarkdownParser.inlineSpans(s).map { spanDesc(it) }) { "inlineSpans ${l()}" }
            r.eq(v.str("plainLine"), NoteText.plainLine(s)) { "plainLine ${l()}" }
            r.eq(v.str("title"), NoteText.title(s)) { "title ${l()}" }
        }
        r.done(1500 * 8)
    }

    @Test
    fun noteTextMatchesTheMac() {
        val r = Report("NoteText documents")
        var wordsChecked = 0
        var wordsDiffer = 0
        for (v in vectors.getValue("doc")) {
            val body = v.str("body")
            val l = { esc(body.take(200)) }
            r.eq(v.str("hash"), NoteText.hash(body).toString(16)) { "hash ${l()}" }
            r.eq(v.str("title"), NoteText.title(body)) { "title ${l()}" }
            r.eq(v.str("display"), NoteText.displayTitle(body)) { "displayTitle ${l()}" }
            r.eq(v.str("plain"), NoteText.plainText(body)) { "plainText ${l()}" }
            r.eq(v.getValue("chars").jsonPrimitive.int, NoteText.characterCount(body)) { "characterCount ${l()}" }
            r.eq(v.str("search"), NoteText.searchText(body)) { "searchText ${l()}" }
            r.eq(v.strOrNull("cc"), NoteText.conflictCopyBody(body, "Air")) { "conflictCopyBody Air ${l()}" }
            r.eq(v.strOrNull("cc0"), NoteText.conflictCopyBody(body, "")) { "conflictCopyBody ${l()}" }
            val enumerated = ArrayList<String>()
            SwiftText.enumerateLines(body) { line, _ -> enumerated.add(line) }
            r.eq(v.getValue("enumerated").jsonArray.map { it.jsonPrimitive.content }, enumerated) { "enumerateLines ${l()}" }
            val lines = MarkdownParser.parseLines(body)
            val expected = v.getValue("lines").jsonArray
            r.eq(expected.size, lines.size) { "parseLines count ${l()}" }
            for ((i, e) in expected.withIndex()) {
                val a = e.jsonArray
                val got = lines.getOrNull(i) ?: break
                val full = SwiftText.lineRange(body, got.range.location)
                r.eq(a[0].range(), got.range) { "line $i range ${l()}" }
                r.eq(lineDesc(a[1]), lineDesc(got.line)) { "line $i parse ${l()}" }
                r.eq(a[2].jsonPrimitive.boolean, MarkdownParser.isInCode(body, got.range.location)) { "line $i isInCode ${l()}" }
                val heading = got.line.kind as? BlockKind.Heading
                r.eq((a[3] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.int, heading?.let { MarkdownParser.sectionEnd(full, it.level, body) }) { "line $i sectionEnd ${l()}" }
                r.eq(a[4].range(), full) { "line $i lineRange ${l()}" }
            }
            val sub = v.getValue("sub").jsonArray
            if (sub.isNotEmpty()) {
                val range = sub[0].range()
                val got = MarkdownParser.parseLines(body, range, startInCode = true).map { listOf(it.range, lineDesc(it.line)) }
                r.eq(sub[1].jsonArray.map { e -> e.jsonArray.let { listOf(it[0].range(), lineDesc(it[1])) } }, got) { "parseLines($range) ${l()}" }
            }
            // word counts: the Mac uses ICU's word breaks (dictionaries for CJK and Thai)
            if (body.all { it.code < 0x2E80 }) {
                wordsChecked++
                val mac = v.getValue("words").jsonPrimitive.int
                val mine = NoteText.wordCount(body)
                if (mac != mine) {
                    wordsDiffer++
                    System.getenv("XCHECK_DUMP")?.let { java.io.File(it, "words.txt").appendText("$mac $mine ${esc(NoteText.plainText(body))}\n") }
                }
            }
        }
        println("NoteText.wordCount: $wordsDiffer of $wordsChecked documents without CJK differ from the Mac")
        r.done(800 * 10)
    }

    @Test
    fun wireFormatMatchesTheMac() {
        val r = Report("NoteWire")
        val n = Note(id = "id-1", body = "# T\nbody", createdAt = 5, updatedAt = 1_761_000_123_456).withPinned(true).withPinOrder(2.5).let {
            it.copy(meta = it.meta + ("custom" to JSONValue.Arr(listOf(JSONValue.Str("x/y"), JSONValue.Number(1e20), JSONValue.Number(-3.0),
                JSONValue.Number(0.1), JSONValue.Bool(false), JSONValue.Null, JSONValue.Obj(mapOf("k" to JSONValue.Str("v")))))) + ("base" to JSONValue.Str("dropped")))
        }
        val heads: SyncHeads = mapOf(
            "install-A" to SyncHead(1_761_000_123_456, NoteText.hash("x")),
            "B" to SyncHead(1, 0UL),
            "C" to SyncHead(Long.MAX_VALUE, ULong.MAX_VALUE),
        )
        val encoded = mapOf(
            "full" to NoteWire.encode(n, "Mac", "install-A", heads, (0 until 10).map { "r$it" }.toSet()),
            "noHeads" to NoteWire.encode(n, "Mac", "install-A"),
            "noOrigin" to NoteWire.encode(n, "", heads = heads),
            "deleted" to NoteWire.encode(n.copy(deleted = true), "Mac", "install-A", heads),
        )
        for (v in vectors.getValue("wire")) {
            val name = v.str("name")
            r.eq(JSONValue.parse(v.str("json")), JSONValue.of(encoded.getValue(name))) { "encode $name" }
            // integers are sent as integers
            val swift = Json.parseToJsonElement(v.str("json")).jsonObject
            r.eq(swift.getValue("updated_at").jsonPrimitive.long, encoded.getValue(name).getValue("updated_at").jsonPrimitive.long) { "updated_at $name" }
        }
        for (v in vectors.getValue("heads")) {
            val h = if (v.str("name") == "full") heads else emptyMap()
            r.eq(v.str("out"), SyncHeadsCodec.encode(h, v.str("body"))) { "SyncHeadsCodec.encode ${v.str("name")}" }
        }
        for (v in vectors.getValue("decode")) {
            val json = v.str("json")
            val got = NoteWire.decode(Json.parseToJsonElement(json))
            val want = v.getValue("note")
            if (want is JsonNull) {
                r.eq(null, got) { "decode $json" }
                continue
            }
            val w = want.jsonObject
            r.check(got != null) { "decode $json: null" }
            got ?: continue
            r.eq(w.str("id"), got.id) { "id $json" }
            r.eq(w.str("body"), got.body) { "body $json" }
            r.eq(w.getValue("createdAt").jsonPrimitive.long, got.createdAt) { "createdAt $json" }
            r.eq(w.getValue("updatedAt").jsonPrimitive.long, got.updatedAt) { "updatedAt $json" }
            r.eq(w.getValue("deleted").jsonPrimitive.boolean, got.deleted) { "deleted $json" }
            r.eq((w.getValue("seq") as? JsonPrimitive)?.let { if (it is JsonNull) null else it.long }, got.seq) { "seq $json" }
            r.eq(w.str("device"), got.device) { "device $json" }
            r.eq(JSONValue.objectOf(w.getValue("meta")), got.meta) { "meta $json" }
            r.eq(headsOf(w.getValue("remoteHeads")), got.remoteHeads) { "remoteHeads $json" }
            r.eq(w.strOrNull("remoteOrigin"), got.remoteOrigin) { "remoteOrigin $json" }
            r.eq(w.getValue("remoteRetired").jsonArray.map { it.jsonPrimitive.content }, got.remoteRetired) { "remoteRetired $json" }
        }
        for (v in vectors.getValue("headsDecode")) {
            r.eq(headsOf(v.getValue("out")), SyncHeadsCodec.decode(v.str("s"), v.str("body"))) { "SyncHeadsCodec.decode ${v.str("s")}" }
        }
        r.done(40)
    }

    private fun headsOf(e: JsonElement): SyncHeads? {
        if (e is JsonNull) return null
        return e.jsonObject.mapValues { (_, a) -> a.jsonArray.let { SyncHead(it[0].jsonPrimitive.long, it[1].jsonPrimitive.content.toULong(16)) } }
    }

    @Test
    fun thoughtCaptureMatchesTheMac() {
        val r = Report("ThoughtCapture")
        val at = Instant.ofEpochSecond(1_793_021_145)
        val utc = ZoneId.of("UTC")
        for (v in vectors.getValue("capture")) {
            val text = v.str("text")
            val body = v.str("body")
            val l = { "text=${esc(text)} body=${esc(body)}" }
            val e = ThoughtCapture.entry(text, at, utc)
            r.eq(v.strOrNull("entry"), e) { "entry ${l()}" }
            r.eq(v.str("cleaned"), ThoughtCapture.cleaned(text)) { "cleaned ${l()}" }
            r.eq(v.str("summary"), ThoughtCapture.summary(text)) { "summary ${l()}" }
            r.eq(v.strOrNull("appended"), e?.let { ThoughtCapture.append(it, body) }) { "append ${l()}" }
            r.eq(v.str("appendRaw"), ThoughtCapture.append(text, body)) { "append raw ${l()}" }
        }
        for (v in vectors.getValue("entryHeading")) {
            r.eq(v.getValue("out").jsonPrimitive.boolean, ThoughtCapture.isEntryHeading(v.str("s"))) { "isEntryHeading ${esc(v.str("s"))}" }
        }
        for (v in vectors.getValue("stamp")) {
            val instant = Instant.ofEpochSecond(v.getValue("secs").jsonPrimitive.long)
            val zone = ZoneId.of(v.str("tz"))
            r.eq(v.str("out"), ThoughtCapture.timestamp(instant, zone)) { "timestamp ${v.str("secs")} ${v.str("tz")}" }
            r.eq(v.strOrNull("entry"), ThoughtCapture.entry("Idea", instant, zone)) { "entry ${v.str("tz")}" }
        }
        r.done(400 * 5)
    }

    @Test
    fun searchAndRelativeDatesMatchTheMac() {
        val r = Report("FuzzyMatch, RelativeDate")
        for (v in vectors.getValue("fuzzy")) {
            val q = v.str("q")
            val t = v.str("text")
            val b = v.str("body")
            r.eq((v.getValue("score") as? JsonPrimitive)?.takeIf { it !is JsonNull }?.int, FuzzyMatch.score(q, t)) { "score(${esc(q)}, ${esc(t)})" }
            r.eq((v.getValue("note") as? JsonPrimitive)?.takeIf { it !is JsonNull }?.int, FuzzyMatch.noteScore(q, t, b)) { "noteScore(${esc(q)}, ${esc(t)}, ${esc(b.take(40))})" }
        }
        for (v in vectors.getValue("rel")) {
            val ms = v.getValue("ms").jsonPrimitive.long
            val now = v.getValue("now").jsonPrimitive.long
            r.eq(v.str("out"), RelativeDate.short(ms, now)) { "RelativeDate.short($ms, $now)" }
        }
        r.done(400)
    }

    @Test
    fun liveMergeFuzzMatchesTheMacStepByStep() {
        val r = Report("Live-merge fuzz")
        for (v in vectors.getValue("fuzz")) {
            val seed = v.getValue("seed").jsonPrimitive.int
            val kind = Fuzz.valueOf(v.str("kind"))
            val run = runFuzz(seed, kind)
            val l = { "seed $seed $kind" }
            r.eq(v.getValue("actions").jsonArray.map { it.jsonPrimitive.int }, run.actions) { "random actions ${l()}" }
            r.eq(v.getValue("quiet").jsonPrimitive.boolean, run.quiet) { "quiet ${l()}" }
            r.eq(v.getValue("putWhileQuiet").jsonPrimitive.boolean, run.putWhileQuiet) { "put while quiet ${l()}" }
            r.eq(v.getValue("deleted").jsonPrimitive.boolean, run.deleted) { "deleted ${l()}" }
            r.eq(v.str("typed"), run.typed.sorted().joinToString("")) { "typed ${l()}" }
            r.eq(JSONValue.of(v.getValue("server")), JSONValue.of(run.net.stored)) { "server document ${l()}" }
            val macs = v.getValue("macs").jsonArray
            r.eq(macs.size, run.macs.size) { "devices ${l()}" }
            for ((i, mv) in macs.withIndex()) {
                val m = mv.jsonObject
                val mac = run.macs[i]
                val ml = { "${l()} device $i" }
                r.eq(m.str("installID"), mac.repo.installID) { "installID ${ml()}" }
                r.eq(m.getValue("retired").jsonArray.map { it.jsonPrimitive.content }, mac.repo.retiredInstallIDs.sorted()) { "retired ${ml()}" }
                r.eq(m.getValue("lastSeq").jsonPrimitive.long, mac.repo.lastSeq) { "lastSeq ${ml()}" }
                r.eq(m.getValue("caret").jsonPrimitive.int, mac.caret) { "caret ${ml()}" }
                r.eq(m.getValue("changes").jsonArray.map { it.jsonPrimitive.content }, mac.changes.map { it.name.replaceFirstChar(Char::lowercase) }) { "remote changes ${ml()}" }
                val notes = mac.repo.notes.values.sortedWith { a, b -> com.charles.bento.core.json.compareCodePoints(a.id, b.id) }
                val want = m.getValue("notes").jsonArray
                r.eq(want.map { it.jsonObject.str("id") }, notes.map { it.id }) { "note ids ${ml()}" }
                for ((k, nv) in want.withIndex()) {
                    val n = notes.getOrNull(k) ?: break
                    val w = nv.jsonObject
                    val nl = { "${ml()} note ${n.id}" }
                    r.eq(w.str("body"), n.body) { "body ${nl()}" }
                    r.eq(w.getValue("createdAt").jsonPrimitive.long, n.createdAt) { "createdAt ${nl()}" }
                    r.eq(w.getValue("updatedAt").jsonPrimitive.long, n.updatedAt) { "updatedAt ${nl()}" }
                    r.eq(w.getValue("deleted").jsonPrimitive.boolean, n.deleted) { "deleted ${nl()}" }
                    r.eq((w.getValue("seq") as JsonPrimitive).let { if (it is JsonNull) null else it.long }, n.seq) { "seq ${nl()}" }
                    r.eq(w.str("device"), n.device) { "device ${nl()}" }
                    r.eq(JSONValue.objectOf(w.getValue("meta")), n.meta) { "meta ${nl()}" }
                    r.eq(w.getValue("dirty").jsonPrimitive.boolean, n.dirty) { "dirty ${nl()}" }
                    r.eq(w.getValue("openedAt").jsonPrimitive.long, n.openedAt) { "openedAt ${nl()}" }
                    r.eq(w.strOrNull("baseHash"), n.baseHash?.toString(16)) { "baseHash ${nl()}" }
                    r.eq(headsOf(w.getValue("heads")), n.syncHeads) { "syncHeads ${nl()}" }
                }
            }
        }
        assertEquals(900, vectors.getValue("fuzz").size)
        r.done(900 * 10)
    }
}

fun esc(s: String): String = buildString {
    append('"')
    for (c in s) {
        when {
            c == '\n' -> append("\\n")
            c == '\r' -> append("\\r")
            c == '\t' -> append("\\t")
            c == '"' -> append("\\\"")
            c.code < 0x20 || c.code in 0x7F..0xA0 || c.code in 0x2000..0x200F || c.code in 0x2028..0x202F || c.isSurrogate() ||
                c.code in 0x300..0x36F || c.code in 0xFE00..0xFE0F -> append("\\u").append(c.code.toString(16).padStart(4, '0'))
            else -> append(c)
        }
    }
    append('"')
}
