package com.charles.bento.core.voice.gemini

import com.charles.bento.core.voice.TranscriptionError
import com.charles.bento.core.voice.VoiceJsonCompact
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull

/** Port of InteractionsClientTests.swift (transcription config and the interactions envelope). */
class InteractionsClientTest {
    @Test fun neverSendsLanguageCodes() {
        for (mode in GeminiClient.TranscriptionMode.entries) {
            for (vocabulary in listOf(emptyList(), listOf("Spanner"), listOf("Ammaar", "Kubernetes"))) {
                val config = GeminiClient.transcriptionConfig(mode, vocabulary)
                assertNull(config?.get("language_codes"), "language_codes silently disables smart mode — $mode, $vocabulary")
                assertNull(config?.get("languageCodes"))
            }
        }
    }

    @Test fun verbatimOmitsConfigEntirely() = assertNull(GeminiClient.transcriptionConfig(GeminiClient.TranscriptionMode.VERBATIM, emptyList()))

    @Test fun smartCarriesModeAndVocabulary() {
        val config = assertNotNull(GeminiClient.transcriptionConfig(GeminiClient.TranscriptionMode.SMART, listOf("Kubernetes")))
        assertEquals("smart", config["mode"]!!.jsonPrimitive.content)
        assertEquals(listOf("Kubernetes"), config["custom_vocabulary"]!!.jsonArray.map { it.jsonPrimitive.content })
    }

    @Test fun verbatimStillCarriesVocabulary() {
        val config = assertNotNull(GeminiClient.transcriptionConfig(GeminiClient.TranscriptionMode.VERBATIM, listOf("Kubernetes")))
        assertEquals(listOf("Kubernetes"), config["custom_vocabulary"]!!.jsonArray.map { it.jsonPrimitive.content })
        assertNull(config["mode"], "verbatim is the default; naming it buys nothing")
    }

    @Test fun parsesRealEnvelope() = assertEquals("Let's meet at 2pm.", GeminiClient.extractInteractionText("""
        {"id":"interaction-1","object":"interaction","model":"gemini-3.5-transcribe",
         "status":"completed","created":"2026-08-20T12:00:00Z",
         "steps":[{"type":"model_output","content":[{"type":"text","text":"Let's meet at 2pm."}]}],
         "usage":{"total_input_tokens":268,"total_output_tokens":0}}
    """))

    @Test fun joinsMultipleStepsAndTextItems() = assertEquals("one two three", GeminiClient.extractInteractionText("""
        {"status":"completed","steps":[
          {"type":"model_output","content":[{"type":"text","text":"one "},{"type":"text","text":"two "}]},
          {"type":"model_output","content":[{"type":"text","text":"three"}]}]}
    """))

    @Test fun ignoresNonModelOutputSteps() = assertEquals("kept", GeminiClient.extractInteractionText("""
        {"status":"completed","steps":[
          {"type":"tool_use","content":[{"type":"text","text":"SHOULD NOT APPEAR"}]},
          {"type":"model_output","content":[{"type":"text","text":"kept"}]}]}
    """))

    @Test fun emptyTextReturnsEmptyStringRatherThanThrowing() =
        assertEquals("", GeminiClient.extractInteractionText("""{"status":"completed","steps":[{"type":"model_output","content":[]}]}"""))

    @Test fun unknownStatusIsRetryable() {
        val error = assertFailsWith<TranscriptionError> { GeminiClient.extractInteractionText("""{"status":"queued","steps":[]}""") }
        assertIs<TranscriptionError.Network>(error)
    }

    @Test fun failedWithSafetyDetailMapsToSafetyBlocked() = assertEquals(TranscriptionError.SafetyBlocked,
        GeminiClient.mapInteractionStatus("failed",
            VoiceJsonCompact.parseToJsonElement("""{"error":{"message":"Response blocked by safety filters"}}""").jsonObject))

    @Test fun failedWithoutSafetyDetailIsRetryable() {
        assertIs<TranscriptionError.Network>(GeminiClient.mapInteractionStatus("failed", JsonObject(emptyMap())))
    }

    @Test fun errorMessageParsesArrayWrappedEnvelope() {
        assertEquals("API key not valid.", GeminiClient.errorMessage("""[{"error":{"code":400,"message":"API key not valid."}}]"""))
        assertEquals("API key not valid.", GeminiClient.errorMessage("""{"error":{"code":400,"message":"API key not valid."}}"""))
    }

    @Test fun errorMessageSurvivesStringCode() =
        assertEquals("Model 'x' not found.", GeminiClient.errorMessage("""{"error":{"code":"not_found","message":"Model 'x' not found."}}"""))
}
