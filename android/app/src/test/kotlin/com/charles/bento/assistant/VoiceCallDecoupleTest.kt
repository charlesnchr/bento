package com.charles.bento.assistant

import com.charles.bento.core.assistant.ChatMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

class VoiceCallDecoupleTest {
    private val activeCall = CallUi(
        status = "Listening while Hermes works.",
        connecting = false,
        hermesWorking = true,
        tapToTalk = false,
        muted = false,
    )

    @Test fun hangingUpPromotesActiveCallTasksAndPreservesTheirApprovals() {
        val liveApproval = ChatMessage(
            id = "appr-live",
            role = "approval",
            text = "Run script",
            toolDetail = "ls",
            status = "pending",
            choices = listOf("once", "deny"),
            runId = "run-1",
        )
        val abandonedApproval = ChatMessage(
            id = "appr-stale",
            role = "approval",
            text = "Old command",
            toolDetail = "rm",
            status = "pending",
            choices = listOf("once", "deny"),
            runId = "run-old",
        )
        val streamingVoice = ChatMessage(
            id = "voice-1",
            role = "assistant",
            text = "Sure, I'll...",
            speaker = AssistantController.GEMINI,
            voice = true,
            streaming = true,
            call = true,
        )
        val runningTask = TaskUi(
            id = "call-1-1",
            request = "Deploy the service",
            label = "Deploy service",
            question = "Should I proceed?",
            status = "waiting",
            sessionId = "sid-1",
            messages = listOf(liveApproval),
        )
        val doneTask = TaskUi(
            id = "call-1-2",
            request = "Check weather",
            label = "Weather",
            status = "completed",
            sessionId = "sid-2",
        )
        val before = AssistantUi(
            messages = listOf(streamingVoice, abandonedApproval, liveApproval),
            caption = "Still speaking",
            call = activeCall.copy(tasks = listOf(runningTask, doneTask)),
        )

        val after = AssistantController.endCallState(before, error = null)

        assertNull(after.call)
        assertNull(after.caption)
        assertNull(after.error)
        assertEquals(listOf("call-1-1"), after.tasks.map { it.id }, "only active call tasks move to the chat task strip")
        val promoted = after.tasks.single()
        assertTrue(promoted.detached)
        assertNull(promoted.question, "call-scoped spoken questions clear when the call ends")
        assertEquals("sid-1", promoted.sessionId)
        assertEquals("pending", after.messages.first { it.id == "appr-live" }.status, "active detached task approvals remain answerable")
        assertEquals("expired", after.messages.first { it.id == "appr-stale" }.status, "abandoned approvals expire")
        assertFalse(after.messages.first { it.id == "voice-1" }.streaming, "call streaming rows stop streaming")
    }

    @Test fun detachedTasksDoNotBlockNewCallsOrChats() {
        val detached = TaskUi(id = "call-1-1", request = "Long task", status = "running", detached = true)
        val uiWithDetached = AssistantUi(tasks = listOf(detached))
        assertFalse(uiWithDetached.chatBusy, "detached voice tasks must not block starting another call or switching chats")
        assertFalse(uiWithDetached.busy)

        val chatOwned = TaskUi(id = "chat-1-1", request = "Typed task", status = "running", detached = false)
        val uiWithChatTask = AssistantUi(tasks = listOf(detached, chatOwned))
        assertTrue(uiWithChatTask.chatBusy, "chat-owned tasks still mark chatBusy")
        assertTrue(uiWithChatTask.busy)
    }

    @Test fun endChatPreservesDetachedVoiceTasksAndDropsChatTasks() {
        val detachedActive = TaskUi(id = "call-1-1", request = "Voice task", status = "running", detached = true)
        val detachedDone = TaskUi(id = "call-1-2", request = "Finished voice task", status = "completed", detached = true)
        val chatOwned = TaskUi(id = "chat-1-1", request = "Typed task", status = "running", detached = false)
        val streamingGemini = ChatMessage("g1", "assistant", "Thinking...", speaker = AssistantController.GEMINI, streaming = true, call = true)
        val before = AssistantUi(thinking = true, tasks = listOf(detachedActive, detachedDone, chatOwned), messages = listOf(streamingGemini))

        val after = AssistantController.endChatState(before)

        assertFalse(after.thinking)
        assertEquals(listOf(detachedActive), after.tasks, "only active detached voice tasks survive chat teardown")
        assertFalse(after.messages.single().streaming)
    }

    @Test fun endCallDropsPreviouslyFinishedDetachedTasksWhileKeepingActiveOnes() {
        val oldActive = TaskUi(id = "call-1-1", request = "Still running", status = "running", detached = true)
        val oldDone = TaskUi(id = "call-1-2", request = "Old done", status = "completed", detached = true)
        val newActive = TaskUi(id = "call-2-1", request = "New running", status = "running")
        val before = AssistantUi(tasks = listOf(oldActive, oldDone), call = activeCall.copy(tasks = listOf(newActive)))

        val after = AssistantController.endCallState(before, error = null)

        assertEquals(listOf("call-1-1", "call-2-1"), after.tasks.map { it.id })
        assertTrue(after.tasks.all { it.detached && it.active })
    }

    @Test fun taskBoardRemembersSessionAcrossHangUpForLateDispatchedFollowUps() {
        var state = AssistantUi(call = activeCall)
        val board = TaskBoard(
            spoken = true,
            prefix = "call-1",
            epoch = 0L,
            state = { state },
            updateState = { f -> state = f(state) },
        )
        val uiId = board.uiId("1")
        board.update { it + TaskUi(uiId, "Book table", "Table", status = "completed", sessionId = "sid-original") }
        board.setSessionId(uiId, "sid-original")

        // Hang up drops completed rows from UI, but the board retains session identity for a dispatched follow-up.
        board.detach()
        state = AssistantController.endCallState(state, error = null)
        assertNull(board.find(uiId))
        assertEquals("sid-original", board.sessionId(uiId))
    }

    @Test fun activeTaskForSessionMatchesRunningCallOrDetachedTasksOnly() {
        val runningDetached = TaskUi(id = "call-1-1", request = "Deep search", status = "running", sessionId = "sid-run", detached = true)
        val completedDetached = TaskUi(id = "call-1-2", request = "Weather", status = "completed", sessionId = "sid-done", detached = true)
        val runningInCall = TaskUi(id = "call-2-1", request = "Email", status = "waiting", sessionId = "sid-call")
        val ui = AssistantUi(tasks = listOf(runningDetached, completedDetached), call = activeCall.copy(tasks = listOf(runningInCall)))

        assertEquals(runningDetached, AssistantController.activeTaskForSession(ui, "sid-run"))
        assertEquals(runningInCall, AssistantController.activeTaskForSession(ui, "sid-call"))
        assertNull(AssistantController.activeTaskForSession(ui, "sid-done"))
        assertNull(AssistantController.activeTaskForSession(ui, "sid-other"))
    }

    @Test fun taskBoardDetachesCallReferenceAndRoutesLateUpdatesToChatTasks() {
        var state = AssistantUi(call = activeCall)
        val progressSeen = mutableListOf<Pair<String, String>>()
        val board = TaskBoard(
            spoken = true,
            prefix = "call-1",
            epoch = 0L,
            state = { state },
            updateState = { f -> state = f(state) },
        )
        board.attach { id, text -> progressSeen.add(id to text) }

        val uiId = board.uiId("1")
        assertEquals("call-1-1", uiId)
        assertEquals("1", board.coreId(uiId))
        assertTrue(board.ownsUi(uiId))
        assertFalse(board.detached)

        // While attached, task updates land in state.call.tasks and progress forwards to the call.
        board.update { it + TaskUi(uiId, "Research topic", "Research", sessionId = "sid-1") }
        board.progress("1", "Using web_search")
        assertEquals(1, state.call?.tasks?.size)
        assertTrue(state.tasks.isEmpty())
        assertEquals(listOf("1" to "Using web_search"), progressSeen)

        // Hang up: detach board and run endCallState.
        board.detach()
        state = AssistantController.endCallState(state, error = null)
        assertTrue(board.detached)
        assertNull(state.call)
        assertEquals(1, state.tasks.size)

        // Late progress and completion updates after hang-up go to state.tasks and do not touch the ended call.
        board.progress("1", "Writing its reply")
        assertEquals(1, progressSeen.size, "detached board must not forward progress to the ended call")
        board.task(uiId) { it.copy(status = "completed", progress = null) }
        assertEquals("completed", board.find(uiId)?.status)
        assertEquals("completed", state.tasks.single().status)

        // A later call or chat uses a distinct prefix so task ids never collide with surviving detached tasks.
        val nextBoard = TaskBoard(spoken = false, prefix = "chat-2", epoch = 0L, state = { state }, updateState = { f -> state = f(state) })
        assertNotEquals(uiId, nextBoard.uiId("1"))
    }
}
