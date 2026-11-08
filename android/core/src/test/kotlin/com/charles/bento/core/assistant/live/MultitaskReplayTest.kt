package com.charles.bento.core.assistant.live

import com.charles.bento.core.voice.FakeTransport
import com.charles.bento.core.voice.Frames
import com.charles.bento.core.voice.blocking
import com.charles.bento.core.voice.json
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.Test
import kotlin.test.assertTrue

/**
 * The call of 2026-11-07, replayed with a scripted Gemini and Hermes (no network): the user's
 * words are the transcript's, Hermes's replies are the ones its sessions logged, and the scripted
 * Gemini does what Gemini Live did when Bento pushed another task's result into the middle of a
 * request: it answered that and dropped the request's call.
 *
 * What went wrong that day: the Pennyworth task's result was spoken in a turn that also answered
 * the user, so the call didn't count it as heard; it went again as the user started the
 * multitasking request, and after the longest a result waits it went in while they were still
 * talking. Gemini dropped the request ("I'm sorry, I couldn't…") and spoke the stale result
 * instead. Later the user's "yes" to the coding-session question met another Pennyworth result
 * and never reached Hermes. Gemini called the work "task one" throughout.
 */
class MultitaskReplayTest {
    private val limits = AssistantCall.Limits(settleQuiet = 0.1, settleMax = 1.5, tickMillis = 50, deliverMax = 1.0)

    private companion object {
        const val WAKE_WORD = "Can you think of a different wake word model we could use on Bento for Android because it's clashing with my home " +
            "wake word? I want something quite nice and easy to say. Don't want it to be too cliché like Jarvis, and I don't want to have to say hey."
        const val GO_AHEAD = "Yeah, okay, let's go ahead with Pennyworth. I think that's a good idea."
        const val VIA_T3 = "The way I would like you to do it, though, is you should spin up a coding session, a coding agent, T3 code. And " +
            "repeat the flow we had for the V2 of the other one we did, which was quite good."
        const val ASIDE = "As this is happening, we can do something else. Is that correct? You can spin up a different session too?"
        const val MULTITASK = "Okay, so please spin up a coding agent to also investigate how we can have a better multitasking flow on the " +
            "Android Bento app. You shouldn't fixate so much on session one, session this, session that. It should just be a little bit of " +
            "an overview for me to see what's currently in flight, and you should just naturally be able to mix between them."
        const val ABLE = "Are you able to spin up a new coding session?"
        const val YES = "Yes, because you didn't do that and I'm less confused why you didn't."

        const val SUGGESTION = "I couldn't find a ready-made model that fits. My suggestion is to train \"Pennyworth\" with the LiveKit pipeline " +
            "you already have. Shall I go ahead?\n\nWhy there's nothing ready-made: Bento runs LiveKit WakeWord v2 models."
        const val TRAINING = "I've started training \"Pennyworth\" on homelab. It should take roughly one to two hours. Nothing on your phone has changed yet."
        const val T3_AGENT = "I've started a T3 coding agent to train Pennyworth. It's repeating the Woodhouse v2 flow and is already working."
        const val CAN_DO = "Yes, I can. T3 Code is running on the homelab and Bento is registered as a project. Shall I start one now to " +
            "investigate the multitasking flow?"
        const val MULTITASK_DONE = "A coding agent is now working on the multitasking problems."
        const val YES_DONE = "Started a T3 coding agent in the Bento project for the multitasking flow."

        /** How a number gets narrated: "task 1", "Task one", "session 2". */
        val NUMBERED = Regex("\\b(?:task|session)s?\\s+(?:\\d+|one|two|three|four|five)\\b", RegexOption.IGNORE_CASE)
    }

    private fun JsonObject.response() = this["response"]!!.jsonObject
    private fun FakeTransport.responses(): List<JsonObject> = sent.filter { "toolResponse" in it }.map {
        Json.parseToJsonElement(it).jsonObject["toolResponse"]!!.jsonObject["functionResponses"]!!.jsonArray.single().jsonObject
    }
    private fun FakeTransport.response(id: String, status: String? = null) =
        responses().firstOrNull { it["id"]!!.jsonPrimitive.content == id && (status == null || it.response()["status"]!!.jsonPrimitive.content == status) }

    /** Everything Bento has told Gemini in words: responses, turns and the setup's instruction and tool descriptions. */
    private fun FakeTransport.toldGemini(): List<String> = sent.filter { "realtimeInput" !in it }

    private suspend fun until(timeout: Long = 5_000, check: () -> Boolean) = withTimeoutOrNull(timeout) { while (!check()) delay(20); true } == true

    @Test fun todaysCallKeepsEveryRequestAndNeverNumbersTheWork() = blocking {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val training = CompletableDeferred<String>()
        val t3Agent = CompletableDeferred<String>()
        val multitask = CompletableDeferred<String>()
        val asked = CopyOnWriteArrayList<HermesCall>()
        val call = AssistantCall(transport, FakeAudio(), null, { c ->
            asked.add(c)
            when (c.task) {
                WAKE_WORD -> SUGGESTION
                GO_AHEAD -> training.await()
                VIA_T3 -> t3Agent.await()
                MULTITASK -> multitask.await()
                ABLE -> CAN_DO
                YES -> YES_DONE
                else -> "Hermes didn't follow: \"${c.task}\""
            }
        }, limits = limits)
        val problems = ArrayList<String>()
        fun expect(ok: Boolean, problem: String) { if (!ok) problems += problem }
        call.start()
        until { transport.sent.any { "realtimeInput" in it } }

        // 1. The wake word request; Hermes suggests Pennyworth and asks whether to go ahead. Gemini says so.
        Live.turn(transport, WAKE_WORD)
        transport.push(Live.call("c1", args = mapOf("label" to "Pennyworth wake word")))
        expect(until { transport.response("c1", "ok") != null }, "the wake word task's result never reached Gemini")
        // Gemini names a task the way Bento named it.
        val pennyworth = transport.response("c1", "started")?.response()?.get("task")?.jsonPrimitive?.content.orEmpty()
        Live.speaks(transport, "I couldn't find a ready-made model that fits. My pick is to train Pennyworth with your current pipeline. Should I go ahead?")

        // 2. The user says go ahead, and while Hermes starts training, how to do it: with a T3 coding agent.
        Live.turn(transport, GO_AHEAD)
        transport.push(Live.call("c2", args = mapOf("continue_task" to pennyworth, "task_id" to pennyworth)))
        until { transport.response("c2", "started") != null }
        transport.push(Live.turnComplete())
        Live.turn(transport, VIA_T3)
        transport.push(Live.call("c3", args = mapOf("continue_task" to pennyworth, "task_id" to pennyworth)))
        until { transport.response("c3", "started") != null }
        transport.push(Live.turnComplete())

        // 3. The user asks something aside; training starts meanwhile, and Gemini, partway through its answer, says that too.
        transport.push(Live.activity("ACTIVITY_START"))
        delay(100)
        training.complete(TRAINING)
        delay(300)
        transport.push(Live.heard(ASIDE)); transport.push(Live.activity("ACTIVITY_END"))
        transport.push(Live.said("Yes, that's correct. You can ask for something else while that runs."))
        expect(until { transport.sent.any { "I've started training" in it } }, "the training result never reached Gemini")
        transport.push(Live.said("I've started training the Pennyworth wake word model on your homelab. It'll take about one or two hours."))
        Live.speaksNothingMore(transport)
        delay(300)

        // 4. The multitasking request, longer than a result waits for a quiet line.
        val before = transport.sent.size
        transport.push(Live.activity("ACTIVITY_START"))
        delay(1_600)
        transport.push(Live.heard(MULTITASK)); transport.push(Live.activity("ACTIVITY_END"))
        delay(200)
        val pushedIn = transport.sent.drop(before).filter { "realtimeInput" !in it }
        expect(pushedIn.isEmpty(), "Bento pushed into the multitasking request while the user was still saying it: ${pushedIn.map { it.take(160) }}")
        transport.push(Live.call("c4", args = mapOf("label" to "multitasking flow")))
        if (pushedIn.isNotEmpty()) {
            // What Gemini Live did: it answered what Bento sent, and the request's call went with the interrupted turn.
            transport.push(json("toolCallCancellation" to mapOf("ids" to listOf("c4"))))
            Live.speaks(transport, "I'm sorry, I couldn't… By the way, training for the Pennyworth wake word model is already underway.")
        } else {
            until { transport.response("c4", "started") != null }
            transport.push(Live.turnComplete())
        }
        delay(300)

        // 5. The user asks whether Gemini can start a coding session; Hermes says yes and asks whether to start one now.
        Live.turn(transport, ABLE)
        transport.push(Live.call("c5", args = mapOf("label" to "coding session")))
        expect(until { transport.response("c5", "ok") != null }, "the coding session question never reached Gemini")
        Live.speaks(transport, "Yes, I can. T3 Code is running on your homelab with Bento registered. Shall I start one now to investigate the multitasking flow?")
        delay(300)

        // 6. The user says yes, and the T3 agent's result lands while they do. Gemini makes the call without naming a task.
        val beforeYes = transport.sent.size
        transport.push(Live.activity("ACTIVITY_START"))
        delay(100)
        t3Agent.complete(T3_AGENT)
        delay(300)
        transport.push(Live.heard(YES)); transport.push(Live.activity("ACTIVITY_END"))
        delay(200)
        transport.push(Live.call("c6"))
        until { transport.response("c6", "started") != null }
        val intoYes = transport.sent.drop(beforeYes).takeWhile { !("\"c6\"" in it && "started" in it) }.filter { "realtimeInput" !in it }
        expect(intoYes.none { "T3 coding agent" in it }, "the T3 agent's result went to Gemini before it had acted on the user's yes")
        transport.push(Live.turnComplete())
        expect(until { transport.sent.any { "T3 coding agent" in it } }, "the T3 agent's result never reached Gemini")
        Live.speaks(transport, "The Pennyworth training now runs in a T3 coding agent, repeating the Woodhouse v2 flow.")
        delay(500)

        // 7. What's in flight.
        transport.push(Live.call("l1", name = CallProtocol.LIST_TASKS))
        until { transport.response("l1") != null }
        val overview = transport.response("l1")?.response()?.get("message")?.jsonPrimitive?.content.orEmpty()

        // Hermes got every request, each in the task it belongs to.
        fun taskOf(words: String) = asked.firstOrNull { it.task == words }
        val got = asked.map { it.task.take(40) + if (it.followUp) " (follow-up)" else "" }
        expect(taskOf(MULTITASK)?.followUp == false, "the multitasking request never reached Hermes as a task of its own; Hermes got: $got")
        expect(taskOf(GO_AHEAD)?.let { it.followUp && it.taskId == taskOf(WAKE_WORD)?.taskId } == true, "\"go ahead\" didn't continue the wake word task")
        expect(taskOf(VIA_T3)?.let { it.followUp && it.taskId == taskOf(WAKE_WORD)?.taskId } == true, "the T3 instruction didn't continue the wake word task")
        val yes = taskOf(YES)
        expect(yes != null && yes.followUp && yes.taskId == taskOf(ABLE)?.taskId,
               "the user's yes didn't answer the coding session question: " +
                   (yes?.let { "it went to ${if (it.followUp) "the follow-up of ${asked.first { a -> a.taskId == it.taskId }.task.take(40)}" else "a new task"}" } ?: "Hermes never got it"))
        // Each result was told once: one Gemini has said isn't pushed at the user again.
        val trainingTold = transport.toldGemini().count { "I've started training" in it }
        expect(trainingTold == 1, "the training result went to Gemini $trainingTold times after Gemini had said it")
        // Nothing Bento says to Gemini numbers the work, so Gemini has no number to say.
        val numbered = transport.toldGemini().flatMap { frame -> NUMBERED.findAll(frame).map { it.value }.toList() } +
            transport.responses().mapNotNull { it.response()["task"]?.jsonPrimitive?.content?.takeIf { t -> t.all(Char::isDigit) }?.let { t -> "task field \"$t\"" } }
        expect(numbered.isEmpty(), "Bento numbered the work to Gemini: ${numbered.distinct()}")
        expect("Pennyworth" in overview && "multitasking" in overview, "the overview doesn't name the work in flight: \"$overview\"")

        call.stop()
        assertTrue(problems.isEmpty(), "\n" + problems.joinToString("\n") { "- $it" })
    }

    private suspend fun started(limits: AssistantCall.Limits = this.limits, hermes: suspend (HermesCall) -> String): Pair<FakeTransport, AssistantCall> {
        val transport = FakeTransport(listOf(Frames.setupComplete()))
        val call = AssistantCall(transport, FakeAudio(), null, hermes, limits = limits)
        call.start()
        until { transport.sent.any { "realtimeInput" in it } }
        return transport to call
    }

    @Test fun aQuestionTheUserHasntHeardDoesntTakeTheirAnswer() = blocking {
        val backups = CompletableDeferred<String>()
        val asked = CopyOnWriteArrayList<HermesCall>()
        val (transport, call) = started { c ->
            asked.add(c)
            when (c.task) { "Remind me about the dentist" -> "I can add one for 9am. Shall I add a reminder?"; "Tidy up the backup drive" -> backups.await(); else -> "Done." }
        }
        Live.turn(transport, "Remind me about the dentist"); transport.push(Live.call("c1", args = mapOf("label" to "dentist reminder")))
        until { transport.response("c1", "ok") != null }
        Live.speaks(transport, "I can add a dentist reminder for 9am. Shall I add the reminder?")
        Live.turn(transport, "Tidy up the backup drive"); transport.push(Live.call("c2", args = mapOf("label" to "backup cleanup")))
        until { transport.response("c2", "started") != null }
        transport.push(Live.turnComplete())
        delay(300)
        // The user answers the reminder question; the backups ask theirs while they do, unheard.
        transport.push(Live.activity("ACTIVITY_START"))
        delay(100)
        backups.complete("I found 40 GB of old backups. Shall I delete the old backups?")
        delay(300)
        transport.push(Live.heard("Yes please")); transport.push(Live.activity("ACTIVITY_END"))
        transport.push(Live.call("c3"))
        assertTrue(until { asked.any { it.task == "Yes please" } })
        val yes = asked.single { it.task == "Yes please" }
        assertTrue(yes.followUp && yes.taskId == asked.first().taskId, "the yes went to ${yes.label}, not the dentist reminder")
        call.stop()
    }

    @Test fun sayingWhatATaskIsAboutIsntSayingItsResult() = blocking {
        val training = CompletableDeferred<String>()
        val (transport, call) = started(limits.copy(deliverMax = 1.0)) { training.await() }
        Live.turn(transport, "Train the Pennyworth model"); transport.push(Live.call("c1", args = mapOf("label" to "Pennyworth training")))
        until { transport.response("c1", "started") != null }
        transport.push(Live.turnComplete())
        // The user asks something; the training fails while Gemini is partway through its answer, which only says it's going.
        Live.turn(transport, "How long will it take?")
        transport.push(Live.said("Let me think."))
        training.complete("Training failed because the disk is full.")
        assertTrue(until { transport.sent.any { "disk is full" in it } })
        transport.push(Live.said("I'm still working on the Pennyworth training."))
        Live.speaksNothingMore(transport)
        // Not heard: it goes again.
        assertTrue(until(8_000) { transport.sent.count { "disk is full" in it } >= 2 }, "the failure was taken for heard")
        call.stop()
    }

    @Test fun aNewTaskGeminiLabelledIsntTakenForAnAnswer() = blocking {
        val asked = CopyOnWriteArrayList<HermesCall>()
        val (transport, call) = started { c -> asked.add(c); if (c.task == "What's on my calendar?") "You're free at 3. Shall I book it?" else "Done." }
        Live.turn(transport, "What's on my calendar?"); transport.push(Live.call("c1"))
        until { transport.response("c1", "ok") != null }
        Live.speaks(transport, "You're free at 3. Shall I book the slot at 3?")
        Live.turn(transport, "Okay, separately, find me a taxi"); transport.push(Live.call("c2"))
        until { asked.size >= 2 }
        transport.push(Live.turnComplete())
        Live.turn(transport, "Okay, get me a coffee order going"); transport.push(Live.call("c3", args = mapOf("label" to "coffee order")))
        until { asked.size >= 3 }
        transport.push(Live.turnComplete())
        Live.turn(transport, "Okay, and can you get me a taxi there at half seven?"); transport.push(Live.call("c4", args = mapOf("label" to "taxi to Noma")))
        until { asked.size >= 4 }
        assertTrue(asked.drop(1).none { it.followUp }, "a separate request went to the calendar: ${asked.map { it.task to it.followUp }}")
        call.stop()
    }

    @Test fun aQuestionTheUserTalksPastLapses() = blocking {
        val asked = CopyOnWriteArrayList<HermesCall>()
        val (transport, call) = started { c -> asked.add(c); if (c.task == "Push the branch") "Pushed. Want me to open a PR?" else "Done." }
        Live.turn(transport, "Push the branch"); transport.push(Live.call("c1"))
        until { transport.response("c1", "ok") != null }
        Live.speaks(transport, "Pushed the branch. Want me to open a PR as well?")
        assertTrue(until { call.questions.value.values.singleOrNull() == "Want me to open a PR?" }, "the screen shows it waiting: ${call.questions.value}")
        // Two turns about other things, then a bare yes: the offer has lapsed, so it starts a task of its own.
        repeat(2) { n -> Live.turn(transport, "Hmm, let me think $n"); Live.speaks(transport, "Take your time.") }
        Live.turn(transport, "Yes")
        assertTrue(until { call.questions.value.isEmpty() }, "the offer still shows as waiting")
        transport.push(Live.call("c2"))
        assertTrue(until { asked.any { it.task == "Yes" } })
        assertTrue(!asked.single { it.task == "Yes" }.followUp, "a lapsed offer took the yes")
        call.stop()
    }

    @Test fun aNumberIsATasksKeyBeforeAnyName() = blocking {
        val asked = CopyOnWriteArrayList<HermesCall>()
        val (transport, call) = started { c -> asked.add(c); "Done." }
        Live.turn(transport, "Check the top films"); transport.push(Live.call("c1", args = mapOf("label" to "top 2 films")))
        until { transport.response("c1", "ok") != null }
        Live.speaks(transport, "All done.")
        Live.turn(transport, "Find a taxi"); transport.push(Live.call("c2", args = mapOf("label" to "taxi")))
        until { transport.response("c2", "ok") != null }
        Live.speaks(transport, "All done.")
        Live.turn(transport, "Make it a big one"); transport.push(Live.call("c3", args = mapOf("continue_task" to "2")))
        assertTrue(until { asked.size >= 3 })
        assertTrue(asked[2].followUp && asked[2].taskId == "2", "\"2\" went to ${asked[2].label}")
        call.stop()
    }

    @Test fun aTurnGeminiNeverEndsHoldsResultsOnlySoLong() = blocking {
        val result = CompletableDeferred<String>()
        val (transport, call) = started(limits.copy(deliverMax = 0.5)) { result.await() }
        Live.turn(transport, "Book a table"); transport.push(Live.call("c1"))
        until { transport.response("c1", "started") != null }
        transport.push(Live.turnComplete())
        // The user starts speaking and mutes mid-word: Gemini never sends ACTIVITY_END.
        transport.push(Live.activity("ACTIVITY_START"))
        result.complete("Booked for 8pm.")
        delay(800)
        assertTrue(transport.sent.none { "Booked for 8pm." in it }, "it waits while the user may still be talking")
        assertTrue(until(6_000) { transport.sent.any { "Booked for 8pm." in it } }, "it waits for good")
        call.stop()
    }

    @Test fun aResultTurnWaitsIfTheUserStartsWhileItsCallsClose() = blocking {
        val results = mapOf("1" to CompletableDeferred<String>(), "2" to CompletableDeferred())
        val (transport, call) = started { c -> results.getValue(c.taskId).await() }
        Live.turn(transport, "Book a table"); transport.push(Live.call("c1")); until { transport.response("c1", "started") != null }
        transport.push(Live.turnComplete())
        Live.turn(transport, "Find a taxi"); transport.push(Live.call("c2")); until { transport.response("c2", "started") != null }
        transport.push(Live.turnComplete())
        // Both finish together; closing the first call is held up on the socket, and the user starts talking meanwhile.
        val gate = CompletableDeferred<Unit>()
        val held = CompletableDeferred<Unit>()
        transport.beforeSend = { frame -> if ("\"SILENT\"" in frame && "Booked." in frame) { held.complete(Unit); gate.await() } }
        // Both finish while the user talks, so they go together once the line is quiet.
        transport.push(Live.activity("ACTIVITY_START"))
        delay(100)
        results.getValue("1").complete("Booked."); results.getValue("2").complete("A taxi is on its way.")
        delay(300)
        transport.push(Live.heard("Hmm")); transport.push(Live.activity("ACTIVITY_END")); transport.push(Live.turnComplete())
        assertTrue(until { held.isCompleted }, "the batch never went")
        transport.push(Live.activity("ACTIVITY_START"))
        delay(200)
        gate.complete(Unit)
        delay(500)
        assertTrue(transport.sent.none { "clientContent" in it && "turnComplete\":true" in it }, "the result turn went in over the user")
        transport.push(Live.heard("Go on")); transport.push(Live.activity("ACTIVITY_END")); Live.speaks(transport, "Yes?")
        assertTrue(until { transport.sent.any { "clientContent" in it && "A taxi is on its way." in it } }, "the results never went")
        call.stop()
    }

    @Test fun aQuestionStillPlayingDoesntTakeTheAnswer() = blocking {
        val backups = CompletableDeferred<String>()
        val asked = CopyOnWriteArrayList<HermesCall>()
        val (transport, call) = started { c ->
            asked.add(c)
            when (c.task) { "Remind me about the dentist" -> "I can add one for 9am. Shall I add a reminder?"; "Tidy up the backup drive" -> backups.await(); else -> "Done." }
        }
        Live.turn(transport, "Remind me about the dentist"); transport.push(Live.call("c1", args = mapOf("label" to "dentist reminder")))
        until { transport.response("c1", "ok") != null }
        Live.speaks(transport, "I can add a dentist reminder for 9am. Shall I add the reminder?")
        Live.turn(transport, "Tidy up the backup drive"); transport.push(Live.call("c2", args = mapOf("label" to "backup cleanup")))
        until { transport.response("c2", "started") != null }
        transport.push(Live.turnComplete())
        backups.complete("I found 40 GB of old backups. Shall I delete the old backups?")
        until { transport.response("c2", "ok") != null }
        // Gemini's whole turn about the backups arrives, ten seconds still to play, and the user talks over its start to answer the reminder.
        transport.push(Live.said("I found 40 GB of old backups. Shall I delete them?"))
        transport.push(Live.audio(ByteArray(480_000)))
        Live.speaksNothingMore(transport)
        delay(100)
        transport.push(Live.activity("ACTIVITY_START")); transport.push(Live.interrupted())
        transport.push(Live.heard("Yes please")); transport.push(Live.activity("ACTIVITY_END"))
        transport.push(Live.call("c3"))
        assertTrue(until { asked.any { it.task == "Yes please" } })
        val yes = asked.single { it.task == "Yes please" }
        assertTrue(yes.followUp && yes.taskId == asked.first().taskId, "the yes went to ${yes.label}, whose question was still playing")
        call.stop()
    }

    @Test fun aQuestionsAnswerWindowStartsWhenItsHeard() = blocking {
        val asked = CopyOnWriteArrayList<HermesCall>()
        val (transport, call) = started { c -> asked.add(c); if (c.task == "Push the branch") "Pushed. Want me to open a PR?" else "Done." }
        Live.turn(transport, "Push the branch"); transport.push(Live.call("c1"))
        until { transport.response("c1", "ok") != null }
        // The user talks over it three times before Gemini says anything of it.
        repeat(3) { n -> Live.turn(transport, "Hold on $n"); delay(150) }
        assertTrue(until(8_000) { transport.sent.count { "open a PR" in it } >= 2 }, "it never went again")
        Live.speaks(transport, "Pushed the branch. Want me to open a PR as well?")
        Live.turn(transport, "Yes"); transport.push(Live.call("c2"))
        assertTrue(until { asked.any { it.task == "Yes" } })
        assertTrue(asked.single { it.task == "Yes" }.followUp, "the question lapsed before the user heard it")
        call.stop()
    }

    @Test fun aTurnGeminiNeverEndsHoldsAResultTurnOnlySoLong() = blocking {
        val result = CompletableDeferred<String>()
        val (transport, call) = started(limits.copy(deliverMax = 0.5)) { result.await() }
        Live.turn(transport, "Book a table"); transport.push(Live.call("c1"))
        until { transport.response("c1", "started") != null }
        transport.push(Live.turnComplete())
        // Gemini drops the call, so the result goes as a turn of its own; the user's next turn never ends.
        transport.push(json("toolCallCancellation" to mapOf("ids" to listOf("c1"))))
        transport.push(Live.activity("ACTIVITY_START"))
        result.complete("Booked for 8pm.")
        assertTrue(until(6_000) { transport.sent.any { "clientContent" in it && "Booked for 8pm." in it } }, "the result turn waits for good")
        call.stop()
    }

    @Test fun aQuestionGeminiRelaysMidTurnCanBeAnsweredAtOnce() = blocking {
        val reply = CompletableDeferred<String>()
        val asked = CopyOnWriteArrayList<HermesCall>()
        val (transport, call) = started { c -> asked.add(c); if (c.task == "Remind me about the dentist") reply.await() else "Done." }
        Live.turn(transport, "Remind me about the dentist"); transport.push(Live.call("c1", args = mapOf("label" to "dentist reminder")))
        until { transport.response("c1", "started") != null }
        // Gemini is partway through a turn when the reply comes, and relays its question in that turn.
        transport.push(Live.said("Sure, one moment."))
        reply.complete("Your dentist appointment is Tuesday at 9am. Shall I add a calendar reminder the evening before?")
        assertTrue(until { transport.response("c1", "ok") != null })
        transport.push(Live.said("Your dentist appointment is on Tuesday. Shall I add a calendar reminder the evening before?"))
        // The user answers before the turn has ended.
        transport.push(Live.activity("ACTIVITY_START")); transport.push(Live.heard("Yes")); transport.push(Live.activity("ACTIVITY_END"))
        transport.push(Live.call("c2"))
        assertTrue(until { asked.any { it.task == "Yes" } })
        assertTrue(asked.single { it.task == "Yes" }.followUp, "the yes to a question Gemini relayed started a task of its own")
        call.stop()
    }

    @Test fun aQuestionThatAllButEndedCanBeAnsweredBeforeTheNextTick() = blocking {
        val backups = CompletableDeferred<String>()
        val asked = CopyOnWriteArrayList<HermesCall>()
        // The watchdog ticks once a second, as in the app.
        val (transport, call) = started(limits.copy(tickMillis = 1_000)) { c ->
            asked.add(c)
            when (c.task) { "Remind me about the dentist" -> "I can add one for 9am. Shall I add a reminder?"; "Tidy up the backup drive" -> backups.await(); else -> "Done." }
        }
        Live.turn(transport, "Remind me about the dentist"); transport.push(Live.call("c1", args = mapOf("label" to "dentist reminder")))
        until { transport.response("c1", "ok") != null }
        Live.speaks(transport, "I can add a dentist reminder for 9am. Shall I add the reminder?")
        Live.turn(transport, "Tidy up the backup drive"); transport.push(Live.call("c2", args = mapOf("label" to "backup cleanup")))
        until { transport.response("c2", "started") != null }
        transport.push(Live.turnComplete())
        backups.complete("I found 40 GB of old backups. Shall I delete the old backups?")
        until { transport.response("c2", "ok") != null }
        // A second and a half of speech; the user says yes over its last half second.
        transport.push(Live.said("I found 40 GB of old backups. Shall I delete them?"))
        transport.push(Live.audio(ByteArray(72_000)))
        Live.speaksNothingMore(transport)
        delay(1_000)
        transport.push(Live.activity("ACTIVITY_START")); transport.push(Live.heard("Yes")); transport.push(Live.activity("ACTIVITY_END"))
        transport.push(Live.call("c3"))
        assertTrue(until { asked.any { it.task == "Yes" } })
        val yes = asked.single { it.task == "Yes" }
        assertTrue(yes.followUp && yes.taskId == asked[1].taskId, "the yes went to ${yes.label}, not the question that had just ended")
        call.stop()
    }

    @Test fun aYesRightAfterAQuestionGeminiSpokeAnswersIt() = blocking {
        val asked = CopyOnWriteArrayList<HermesCall>()
        val (transport, call) = started { c -> asked.add(c); if (c.task == "What's on my calendar?") "You're free at 3. Shall I book it?" else "Done." }
        Live.turn(transport, "What's on my calendar?"); transport.push(Live.call("c1"))
        until { transport.response("c1", "ok") != null }
        // Gemini says it in an ordinary turn, and the user answers before that turn's turnComplete arrives.
        transport.push(Live.said("You're free at 3. Shall I book it?"))
        delay(100)
        transport.push(Live.activity("ACTIVITY_START")); transport.push(Live.heard("Yes")); transport.push(Live.activity("ACTIVITY_END"))
        Live.speaksNothingMore(transport)
        transport.push(Live.call("c2"))
        assertTrue(until { asked.any { it.task == "Yes" } })
        assertTrue(asked.single { it.task == "Yes" }.followUp, "the yes started a task of its own")
        call.stop()
    }

    @Test fun twoTasksWithTheSameLongNameStayApart() = blocking {
        val asked = CopyOnWriteArrayList<HermesCall>()
        val (transport, call) = started { c -> asked.add(c); "Done." }
        val name = "Copenhagen weather tomorrow afternoon"
        Live.turn(transport, "What's the weather in Copenhagen tomorrow afternoon?"); transport.push(Live.call("c1", args = mapOf("label" to name)))
        until { transport.response("c1", "ok") != null }
        Live.speaks(transport, "All done.")
        Live.turn(transport, "And the weather in Copenhagen tomorrow afternoon for the harbour?"); transport.push(Live.call("c2", args = mapOf("label" to name)))
        until { transport.response("c2", "ok") != null }
        Live.speaks(transport, "All done.")
        val second = transport.response("c2", "started")!!.response()["task"]!!.jsonPrimitive.content
        assertTrue(second != name, second)
        Live.turn(transport, "Make it the evening"); transport.push(Live.call("c3", args = mapOf("continue_task" to second)))
        assertTrue(until { asked.size >= 3 })
        assertTrue(asked[2].followUp && asked[2].taskId == asked[1].taskId, "\"$second\" went to ${asked[2].label}")
        call.stop()
    }
}
