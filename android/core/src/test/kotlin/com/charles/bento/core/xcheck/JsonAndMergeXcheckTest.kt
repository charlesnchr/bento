package com.charles.bento.core.xcheck

import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocWire
import com.charles.bento.core.fielddoc.SwiftText
import com.charles.bento.core.json.JSONValue
import com.charles.bento.core.xcheck.Vectors.arr
import com.charles.bento.core.xcheck.Vectors.boolValue
import com.charles.bento.core.xcheck.Vectors.obj
import kotlinx.serialization.json.Json
import kotlin.test.Test

/** JSONValue.canonical, Swift string order, TodoDoc.merged/body/wire against the Mac's Swift. */
class JsonAndMergeXcheckTest {
    @Test fun canonicalMatchesJSONSerialization() {
        val m = Mismatches("canonical")
        for (rec in Vectors.load("canonical").arr) {
            val v = Vectors.value(rec.obj["v"]!!)
            val expected = Vectors.str(rec.obj["c"]!!)
            val got = v.canonical
            m.check(got == expected) { "  value $v\n    mac    ${esc(expected)}\n    kotlin ${esc(got)}" }
        }
        m.assertNone()
    }

    @Test fun stringOrderMatchesSwift() {
        val m = Mismatches("string order")
        for (p in Vectors.load("string_order").arr) {
            val a = Vectors.str(p.arr[0])
            val b = Vectors.str(p.arr[1])
            val less = p.arr[2].boolValue()
            val equal = p.arr[3].boolValue()
            m.check((SwiftText.compare(a, b) < 0) == less && SwiftText.equal(a, b) == equal) {
                "  ${esc(a)} vs ${esc(b)}: mac less=$less equal=$equal, kotlin cmp=${SwiftText.compare(a, b)}"
            }
        }
        m.assertNone()
    }

    @Test fun mergeBodyAndWireMatchTheMac() {
        val merge = Mismatches("merged")
        val body = Mismatches("body")
        val wire = Mismatches("wire round trip")
        val todos = FieldDocWire("todos")
        for (rec in Vectors.load("merge").arr) {
            val o = rec.obj
            val a = Vectors.doc(o["a"]!!)!!
            val b = Vectors.doc(o["b"]!!)!!
            val ab = Vectors.doc(o["ab"]!!)!!
            val ba = Vectors.doc(o["ba"]!!)!!
            val gotAB = a.merged(b)
            val gotBA = b.merged(a)
            merge.check(gotAB == ab) { diff("a.merged(b) ${a.id}", ab, gotAB) }
            merge.check(gotBA == ba) { diff("b.merged(a) ${a.id}", ba, gotBA) }
            merge.check(a.sameContent(b) == o["same"]!!.boolValue()) { "  sameContent ${a.id}" }

            val macBody = Vectors.str(o["body"]!!)
            body.check(a.body == macBody) { "  ${a.id}\n    mac    ${esc(macBody)}\n    kotlin ${esc(a.body)}" }
            // Our parser reads the Mac's body as the Mac's own load does.
            val back = Vectors.doc(o["back"]!!)
            val reread = FieldDoc(id = a.id, type = "", createdAt = 0, updatedAt = 0)
            val ok = reread.load(macBody)
            body.check(a.deleted || (ok && back != null && reread.type == back.type && sameParsed(reread.fields, back.fields) && reread.clocks == back.clocks && sameParsed(reread.extra, back.extra))) {
                "  load(mac body) ${a.id} ok=$ok\n    mac    $back\n    kotlin $reread"
            }

            val decoded = todos.decode(Json.parseToJsonElement(Vectors.str(o["wire"]!!)))
            wire.check(sameParsed(decoded, back)) { diff("decode(mac wire) ${a.id}", back, decoded) }
            if (decoded != back) ulpDrift++
        }
        merge.assertNone()
        body.assertNone()
        wire.assertNone()
        // Apple's JSONSerialization rounds some 17-digit decimals a few ulps off; we parse exactly.
        println("wire round trip: $ulpDrift documents differ only by the Mac's number parsing (<= 4 ulps)")
    }

    private var ulpDrift = 0

    /** Equal, except that non-integral numbers may differ by the Mac's parsing error (at most 4 ulps). */
    private fun sameParsed(a: FieldDoc?, b: FieldDoc?): Boolean {
        if (a == null || b == null) return a == b
        return a.copy(fields = emptyMap(), extra = emptyMap(), meta = emptyMap()) == b.copy(fields = emptyMap(), extra = emptyMap(), meta = emptyMap()) &&
            sameParsed(a.fields, b.fields) && sameParsed(a.extra, b.extra) && sameParsed(a.meta, b.meta)
    }

    private fun sameParsed(a: Map<String, JSONValue>, b: Map<String, JSONValue>): Boolean =
        a.keys == b.keys && a.all { (k, v) -> sameParsed(v, b.getValue(k)) }

    private fun sameParsed(a: JSONValue, b: JSONValue): Boolean = when {
        a is JSONValue.Number && b is JSONValue.Number ->
            a == b || (a.value.isFinite() && b.value.isFinite() && kotlin.math.abs(a.value.toRawBits() - b.value.toRawBits()) <= 4)
        a is JSONValue.Arr && b is JSONValue.Arr -> a.items.size == b.items.size && a.items.indices.all { sameParsed(a.items[it], b.items[it]) }
        a is JSONValue.Obj && b is JSONValue.Obj -> sameParsed(a.fields, b.fields)
        else -> a == b
    }

    @Test fun wireDecodeMatchesTheMac() {
        val m = Mismatches("wire decode")
        val todos = FieldDocWire("todos")
        for (p in Vectors.load("wire_decode").arr) {
            val text = Vectors.str(p.arr[0])
            val expected = Vectors.doc(p.arr[1])
            val got = todos.decode(Json.parseToJsonElement(text))
            m.check(got == expected) { diff(text, expected, got) }
        }
        m.assertNone()
    }

    private fun diff(what: String, mac: FieldDoc?, kotlin: FieldDoc?) = "  $what\n    mac    $mac\n    kotlin $kotlin"
}
