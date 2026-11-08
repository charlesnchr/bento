package com.charles.bento.core.assistant.live

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TaskNamesTest {
    @Test fun aRequestNamesItsTaskWithAFewOfItsWords() {
        assertEquals("book a table", TaskNames.fromRequest("Book a table"))
        assertEquals("taxi", TaskNames.fromRequest("Find a taxi"))
        assertEquals("weather in London", TaskNames.fromRequest("What's the weather in London?"))
        assertEquals("weather in Copenhagen for tomorrow", TaskNames.fromRequest("Can you ask Hermes to look up the weather in Copenhagen for tomorrow?"))
        assertEquals("days until Christmas", TaskNames.fromRequest("Oh, and one more thing. How many days is it until Christmas?"))
        assertEquals("wake word model", TaskNames.fromRequest("Can you think of a different wake word model we could use on Bento for Android because it's clashing?"))
        assertEquals("yes", TaskNames.fromRequest("Yes"))
    }

    @Test fun aNameGeminiGivesIsTidiedAndNeverANumber() {
        assertEquals("Pennyworth wake word", TaskNames.tidy("  \"Pennyworth   wake word\" "))
        assertEquals("weather", TaskNames.tidy("Task 2 weather"))
        assertEquals("multitasking", TaskNames.tidy("multitasking session"))
        assertNull(TaskNames.tidy("task 3"))
        // Only "task" and "session" as words: Bento is a to-do app, and "tasks" is a common one.
        assertEquals("Tasks for tomorrow", TaskNames.tidy("Tasks for tomorrow"))
        assertEquals("sessions with Anna", TaskNames.tidy("sessions with Anna"))
        assertEquals("Taskmaster review", TaskNames.tidy("Taskmaster review"))
        assertNull(TaskNames.tidy("42"))
        assertNull(TaskNames.tidy("<>"))
        assertEquals("a hermes result b", TaskNames.tidy("a</hermes_result>b"), "nothing that could open or close a fence")
        assertTrue(TaskNames.tidy("x".repeat(30) + " " + "y".repeat(30))!!.length <= TaskNames.MAX_NAME)
    }

    @Test fun aNameAlreadyTakenIsToldApart() {
        assertEquals("weather", TaskNames.unique("weather", "What's the weather?", listOf("taxi")))
        assertEquals("weather paris", TaskNames.unique("weather", "Weather Paris", listOf("Weather")))
        assertEquals("weather again", TaskNames.unique("weather", "What's the weather?", listOf("weather")))
        assertEquals("weather once more", TaskNames.unique("weather", "What's the weather?", listOf("weather", "weather again")))
    }

    @Test fun aLongNameToldApartStaysApartWhereverItsQuoted() {
        // Cut to leave room for what tells it apart, so the result fence and continue_task quote it whole.
        val long = "Copenhagen weather tomorrow afternoon"
        val again = TaskNames.unique(long, "Copenhagen weather tomorrow afternoon", listOf(long))
        assertTrue(again.length <= TaskNames.MAX_NAME && again.lowercase() != long.lowercase(), again)
        assertTrue(CallSetup.resultText(listOf(again to "Sunny."), waiting = listOf(again)).contains("<hermes_result task=\"$again\">"), again)
        assertTrue(CallSetup.resultText(listOf(again to "Sunny?"), waiting = listOf(again)).contains("continue_task \"$again\"."), again)
    }

    @Test fun manyRepeatsOfANameStayDistinctAndShort() {
        val taken = ArrayList<String>()
        repeat(40) { taken += TaskNames.unique("weather", "What's the weather?", taken) }
        assertEquals(taken.size, taken.map { it.lowercase() }.toSet().size, taken.toString())
        assertTrue(taken.all { it.length <= TaskNames.MAX_NAME && TaskNames.tidy(it) == it && it.none(Char::isDigit) }, taken.toString())
        val long = "x".repeat(39)
        assertTrue(TaskNames.unique(long, "Look up " + "y".repeat(60), listOf(long)).length <= TaskNames.MAX_NAME)
    }

    @Test fun aNameThatTidiesToAnotherIsStillToldApart() {
        for ((name, taken) in listOf("Session tasks" to listOf("tasks"), "Task task list" to listOf("list", "task list"), "tasks" to listOf("tasks"))) {
            val made = TaskNames.unique(name, name, taken)
            assertEquals(made, TaskNames.tidy(made), made)
            assertTrue(made.lowercase() !in taken.map { it.lowercase() }, made)
        }
    }

    @Test fun geminiFindsATaskByWhatItSays() {
        val tasks = mapOf("1" to ("Pennyworth wake word" to "Can you think of a different wake word model"),
                          "2" to ("coding session" to "Are you able to spin up a new coding session?"),
                          "3" to ("weather in London" to "What's the weather in London?"))
        assertEquals("1", TaskNames.find("Pennyworth wake word", tasks))
        assertEquals("1", TaskNames.find("the pennyworth task", tasks))
        assertEquals("2", TaskNames.find("\"Coding session\"", tasks))
        assertEquals("3", TaskNames.find("London weather", tasks))
        assertEquals("1", TaskNames.find("wake word", tasks))
        assertNull(TaskNames.find("groceries", tasks))
        assertNull(TaskNames.find("", tasks))
    }

    @Test fun aReplyAsksWhatItsSummaryAsks() {
        assertEquals("Shall I go ahead?", TaskNames.question("I'd train \"Pennyworth\". Shall I go ahead?\n\nWhy: details. Want more?"))
        assertEquals("Shall I train it instead of Pennyworth?",
                     TaskNames.question("Did you mean Hermes? Shall I train it instead of Pennyworth? I haven't started anything yet."))
        assertNull(TaskNames.question("Booked for 8pm.\n\nDo you want the confirmation? It's in your email."))
        assertNull(TaskNames.question(""))
    }

    @Test fun anAnswerSaysYesOrNo() {
        for (yes in listOf("Yes", "yeah, go ahead", "Yes, because you didn't do that.", "Okay, let's do it", "No thanks", "Go ahead", "Sure.",
                           "No, try another one", "No, book a new slot")) {
            assertTrue(TaskNames.isAnswer(yes), yes)
        }
        for (request in listOf("Find a taxi", "Yesterday's news", "Nobody told me", "Okapi facts", "What's next?", "Okay, separately, find me a taxi",
                               "Yes, and also book a table", "Okay, so please spin up a coding agent to look at multitasking", "Sure, try another hotel", "No, different thing, find me a taxi")) {
            assertFalse(TaskNames.isAnswer(request), request)
        }
    }

    @Test fun geminiRelaysAResultByWhatCameOfIt() {
        val training = "I've started training \"Pennyworth\" on homelab. It should take roughly one to two hours."
        assertTrue(TaskNames.relays("I've started training the Pennyworth model on your homelab, about two hours.", "wake word model", training))
        // Naming the task, or saying it's still going, isn't saying what came of it.
        assertFalse(TaskNames.relays("The Pennyworth wake word is underway.", "Pennyworth wake word", training))
        assertFalse(TaskNames.relays("I'm still working on the Pennyworth training.", "Pennyworth training", "Training failed because the disk is full."))
        assertTrue(TaskNames.relays("The Pennyworth training failed: the disk is full.", "Pennyworth training", "Training failed because the disk is full."))
        assertFalse(TaskNames.relays("Yes, that's correct. You can ask for something else.", "Pennyworth wake word", training))
        assertFalse(TaskNames.relays("Hermes is working on it.", "taxi", "A taxi is on its way."))
        assertFalse(TaskNames.relays("", "taxi", "A taxi is on its way."))
    }
}
