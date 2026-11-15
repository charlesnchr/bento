package com.charles.bento.core.voicecore

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** QuickJS answers every recorded scenario (voice-core/scenarios) exactly as Node did when it recorded them. */
class VoiceCoreConformanceTest {
    private val dir = File(System.getProperty("voiceCore.dir") ?: "../../voice-core")
    private fun core() = VoiceCore(dir.resolve("dist/voice-core.js").readText())

    @Test fun everyScenarioAnswersAsItsGoldenFileSays() {
        val scenarios = dir.resolve("scenarios").listFiles { f -> f.name.endsWith(".json") && !f.name.endsWith(".golden.json") }!!.sorted()
        assertTrue(scenarios.isNotEmpty())
        for (file in scenarios) {
            val name = file.name.removeSuffix(".json")
            val recording = Json.parseToJsonElement(file.readText()).jsonObject
            val golden = dir.resolve("scenarios/$name.golden.json").readText().trimEnd('\n').split("\n")
            core().use { core ->
                val created = core.create(recording["config"].toString(), recording["start"]!!.jsonPrimitive.content.toDouble())
                val answers = mutableListOf(created)
                val id = Json.parseToJsonElement(created).jsonObject["id"]!!.jsonPrimitive.int
                for (event in recording["events"]!!.jsonArray) answers += core.push(id, event.toString())
                assertEquals(golden.size, answers.size, name)
                answers.forEachIndexed { i, a -> assertEquals(golden[i], a, "$name: answer $i differs") }
            }
        }
    }

    @Test fun aCallStartsWithItsSocket() {
        core().use { core ->
            val created = Json.parseToJsonElement(core.create("""{"today":"2026-11-08"}""", 0.0)).jsonObject
            val types = created["commands"]!!.jsonArray.map { it.jsonObject["type"]!!.jsonPrimitive.content }
            assertEquals(listOf("status", "ws.connect"), types)
            assertEquals(12, core.version.length)
        }
    }

    @Test fun anyStringSurvivesTheTripIntoJavaScript() {
        val tricky = "quote \" backslash \\ newline \n tab \t nul \u0000 separator   emoji 🙂"
        assertEquals(tricky, Json.parseToJsonElement(Json.parseToJsonElement(VoiceCore.literal(Json.encodeToString(tricky))).jsonPrimitive.content).jsonPrimitive.content)
    }
}
