package com.charles.bento.ui.voice

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.rounded.FiberManualRecord
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.charles.bento.graph
import com.charles.bento.ui.NoteRoute
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.StateFlow

/** One meeting as the screen shows it. */
data class MeetingUi(
    val id: String,
    val title: String,
    val startedAt: Long,
    val endedAt: Long?,
    val phase: Phase,
    /** Transcript paragraphs, oldest first; `tidy` once the cleanup pass rewrote them. */
    val blocks: List<Block>,
    /** The words being heard right now (not final yet). */
    val pending: String,
    val summary: String?,
    /** The synced note the meeting was filed as. */
    val noteId: String?,
    val error: String?,
) {
    enum class Phase { Recording, Finishing, Done, Failed }
    data class Block(val text: String, val tidy: Boolean)
}

/** Meetings for the screen; wired to the meeting engine. */
interface MeetingSource {
    fun meeting(id: String): StateFlow<MeetingUi?>
    fun stop(id: String)
    fun retry(id: String)
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MeetingScreen(id: String, nav: NavController) {
    val graph = LocalContext.current.graph
    val flow = remember(id) { graph.meetingSource.meeting(id) }
    val m by flow.collectAsStateWithLifecycle()
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(m?.phase) {
        while (m?.phase == MeetingUi.Phase.Recording) { now = System.currentTimeMillis(); delay(1_000) }
    }
    val list = rememberLazyListState()
    LaunchedEffect(m?.blocks?.size, m?.pending) {
        val count = (m?.blocks?.size ?: 0) + 1
        if (m?.phase == MeetingUi.Phase.Recording) list.animateScrollToItem(maxOf(0, count - 1))
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(m?.title ?: "Meeting", maxLines = 1) },
                navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
            )
        },
        bottomBar = {
            val meeting = m ?: return@Scaffold
            Surface(tonalElevation = 3.dp) {
                Row(Modifier.fillMaxWidth().navigationBarsPadding().padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    when (meeting.phase) {
                        MeetingUi.Phase.Recording -> {
                            Icon(Icons.Rounded.FiberManualRecord, null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(14.dp))
                            Spacer(Modifier.width(8.dp))
                            Text(elapsed(now - meeting.startedAt), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                            Button(onClick = { graph.meetingSource.stop(meeting.id) }) { Text("Stop") }
                        }
                        MeetingUi.Phase.Finishing -> {
                            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            Spacer(Modifier.width(12.dp))
                            Text("Writing the notes…", modifier = Modifier.weight(1f))
                        }
                        MeetingUi.Phase.Done -> {
                            Text(elapsed((meeting.endedAt ?: now) - meeting.startedAt), color = MaterialTheme.colorScheme.onSurfaceVariant,
                                 modifier = Modifier.weight(1f))
                            meeting.noteId?.let { note -> Button(onClick = { nav.navigate(NoteRoute(note)) }) { Text("Open note") } }
                        }
                        MeetingUi.Phase.Failed -> {
                            Text(meeting.error ?: "Something went wrong", color = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
                            OutlinedButton(onClick = { graph.meetingSource.retry(meeting.id) }) { Text("Retry") }
                        }
                    }
                }
            }
        },
    ) { padding ->
        val meeting = m
        if (meeting == null) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            return@Scaffold
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding), state = list, contentPadding = PaddingValues(20.dp),
                   verticalArrangement = Arrangement.spacedBy(12.dp)) {
            meeting.summary?.let { summary ->
                item {
                    Surface(shape = RoundedCornerShape(20.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
                        Column(Modifier.padding(16.dp)) {
                            Text("Summary", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                            Spacer(Modifier.size(6.dp))
                            Text(summary, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
            if (meeting.blocks.isEmpty() && meeting.pending.isBlank()) {
                item {
                    Text(if (meeting.phase == MeetingUi.Phase.Recording) "Listening… the transcript appears here as people talk." else "No transcript.",
                         color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            items(meeting.blocks) { b ->
                Text(b.text, style = MaterialTheme.typography.bodyLarge,
                     color = if (b.tidy) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (meeting.pending.isNotBlank()) {
                item { Text(meeting.pending, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)) }
            }
        }
    }
}

private fun elapsed(ms: Long): String {
    val s = maxOf(0, ms / 1000)
    return if (s >= 3600) "%d:%02d:%02d".format(s / 3600, s / 60 % 60, s % 60) else "%d:%02d".format(s / 60, s % 60)
}
