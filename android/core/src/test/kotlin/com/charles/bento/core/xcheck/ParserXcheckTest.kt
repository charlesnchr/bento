package com.charles.bento.core.xcheck

import com.charles.bento.core.todo.DateParser
import com.charles.bento.core.todo.DueDate
import com.charles.bento.core.todo.QuickAddParser
import com.charles.bento.core.todo.TextRange
import com.charles.bento.core.xcheck.Vectors.arr
import com.charles.bento.core.xcheck.Vectors.boolValue
import com.charles.bento.core.xcheck.Vectors.intValue
import com.charles.bento.core.xcheck.Vectors.isNull
import com.charles.bento.core.xcheck.Vectors.obj
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test

/** DateParser and QuickAddParser outputs (values and UTF-16 token ranges) against the Mac's, in several time zones. */
class ParserXcheckTest {
    private fun range(e: JsonElement) = TextRange(e.arr[0].intValue(), e.arr[0].intValue() + e.arr[1].intValue())

    private fun phrase(e: JsonElement): DateParser.Phrase? = when {
        e is JsonNull -> null
        e.jsonPrimitiveOrNull() == "clear" -> DateParser.Phrase.Clear
        else -> DateParser.Phrase.Due(Vectors.due(e)!!)
    }

    private fun JsonElement.jsonPrimitiveOrNull(): String? = runCatching { jsonPrimitive.content }.getOrNull()

    @Test fun dateParserMatchesTheMac() {
        val m = Mismatches("date parser")
        val data = Vectors.load("dateparser").obj
        for (rec in data["records"]!!.arr) {
            val o = rec.obj
            val ctx = Vectors.contexts[o["c"]!!.intValue()]
            val s = Vectors.str(o["s"]!!)
            fun where() = "ctx ${o["c"]} ${esc(s)}"
            val parse = DateParser.parse(s, ctx.now, ctx.zone)
            m.check(parse == Vectors.due(o["parse"])) { "  parse ${where()}: mac ${Vectors.due(o["parse"])} kotlin $parse" }
            val ph = DateParser.parsePhrase(s, ctx.now, ctx.zone)
            m.check(ph == phrase(o["phrase"]!!)) { "  parsePhrase ${where()}: mac ${phrase(o["phrase"]!!)} kotlin $ph" }
            val find = DateParser.find(s, ctx.now, ctx.zone)
            val macFind = o["find"]!!.takeUnless { it.isNull() }?.let { range(it.arr[0]) to Vectors.due(it.arr[1])!! }
            m.check(find == macFind) { "  find ${where()}: mac $macFind kotlin $find" }
            val fp = DateParser.findPhrase(s, now = ctx.now, zone = ctx.zone)
            val macFP = o["findPhrase"]!!.takeUnless { it.isNull() }?.let { DateParser.Match(range(it.arr[0]), phrase(it.arr[1])!!) }
            m.check(fp == macFP) { "  findPhrase ${where()}: mac $macFP kotlin $fp" }
        }
        m.assertNone()
    }

    @Test fun quickAddMatchesTheMac() {
        val m = Mismatches("quick add")
        val data = Vectors.load("quickadd").obj
        val projects = data["projects"]!!.arr.map(Vectors::str)
        val labels = data["labels"]!!.arr.map(Vectors::str)
        for (rec in data["records"]!!.arr) {
            val o = rec.obj
            val ctx = Vectors.contexts[o["c"]!!.intValue()]
            val s = Vectors.str(o["s"]!!)
            val r = QuickAddParser.parse(s, projects, labels, ctx.now, ctx.zone)
            fun where() = "ctx ${o["c"]} ${esc(s)}"
            val title = Vectors.str(o["title"]!!)
            m.check(r.title == title) { "  title ${where()}: mac ${esc(title)} kotlin ${esc(r.title)}" }
            val project = Vectors.strOrNull(o["project"])
            m.check(r.project == project) { "  project ${where()}: mac ${esc(project)} kotlin ${esc(r.project)}" }
            val lbl = o["labels"]!!.arr.map(Vectors::str)
            m.check(r.labels == lbl) { "  labels ${where()}: mac $lbl kotlin ${r.labels}" }
            val priority = o["priority"]!!.takeUnless { it.isNull() }?.intValue()
            m.check(r.priority == priority) { "  priority ${where()}: mac $priority kotlin ${r.priority}" }
            val due: DueDate? = Vectors.due(o["due"])
            m.check(r.due == due) { "  due ${where()}: mac $due kotlin ${r.due}" }
            m.check(r.clearDue == o["clearDue"]!!.boolValue()) { "  clearDue ${where()}" }
            val tokens = o["tokens"]!!.arr.map { t -> t.arr[0].jsonPrimitive.content.uppercase() to TextRange(t.arr[1].intValue(), t.arr[1].intValue() + t.arr[2].intValue()) }
            val ours = r.tokens.map { it.kind.name to it.range }
            m.check(ours == tokens) { "  tokens ${where()}: mac $tokens kotlin $ours" }
            o["completion"]?.arr?.forEach { c ->
                if (c.isNull()) return@forEach
                val caret = c.arr[0].intValue()
                val got = QuickAddParser.completionContext(s, caret)
                val ok = got != null && got.kind.name == c.arr[1].jsonPrimitive.content.uppercase() && got.query == Vectors.str(c.arr[2]) &&
                    got.range == TextRange(c.arr[3].intValue(), c.arr[3].intValue() + c.arr[4].intValue())
                m.check(ok) { "  completion ${where()} caret $caret: mac $c kotlin $got" }
            }
            // carets where the Mac found no context must give none here too
            o["completion"]?.arr?.let { list ->
                val len = s.length
                listOf(0, len / 2, len, len + 5).zip(list).filter { it.second.isNull() }.forEach { (caret, _) ->
                    val got = QuickAddParser.completionContext(s, caret)
                    m.check(got == null) { "  completion ${where()} caret $caret: mac none kotlin $got" }
                }
            }
        }
        m.assertNone()
    }
}
