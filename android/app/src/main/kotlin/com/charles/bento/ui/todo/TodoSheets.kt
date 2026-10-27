package com.charles.bento.ui.todo

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Label
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.DateRange
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Event
import androidx.compose.material.icons.rounded.EventBusy
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material.icons.rounded.Inbox
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.Schedule
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Tag
import androidx.compose.material.icons.rounded.Today
import androidx.compose.material.icons.rounded.Upcoming
import androidx.compose.material.icons.rounded.Weekend
import androidx.compose.material.icons.rounded.WbSunny
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.todo.DueDate
import com.charles.bento.core.todo.QuickAddParser
import com.charles.bento.core.todo.QuickAddResult
import com.charles.bento.core.todo.TodoActions
import com.charles.bento.core.todo.TodoDates
import com.charles.bento.core.todo.TodoListView
import com.charles.bento.core.todo.TodoQuery
import com.charles.bento.core.todo.TodoStore
import com.charles.bento.core.todo.TodoStyle
import com.charles.bento.core.todo.archived
import com.charles.bento.core.todo.color
import com.charles.bento.core.todo.due
import com.charles.bento.core.todo.isCompleted
import com.charles.bento.core.todo.labels
import com.charles.bento.core.todo.name
import com.charles.bento.core.todo.notes
import com.charles.bento.core.todo.priority
import com.charles.bento.core.todo.project
import com.charles.bento.core.todo.title
import com.charles.bento.graph
import com.charles.bento.voice.DictationState
import com.charles.bento.voice.DictationTarget
import com.charles.bento.voice.FieldContext
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.time.temporal.TemporalAdjusters

// MARK: Quick add

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun QuickAddSheet(view: TodoListView, onDismiss: () -> Unit, onAdded: (String) -> Unit) {
    val graph = LocalContext.current.graph
    val todo = graph.todo
    val docs by todo.docs.collectAsStateWithLifecycle()
    val store = remember(docs) { TodoStore(SnapshotRepo(docs)) }
    val scope = rememberCoroutineScope()
    var value by remember { mutableStateOf(TextFieldValue("")) }
    val focus = remember { FocusRequester() }
    val dictation by graph.dictation.state.collectAsStateWithLifecycle()
    val dates = remember { todo.dates() }
    fun parse(text: String): QuickAddResult = QuickAddParser.parse(text, store.projectNames, store.labels, dates.now, dates.zone)
    val parsed = remember(value.text, store) { parse(value.text) }
    val highlight = remember(store) { TokenHighlight(::parse) }
    var menu by remember { mutableStateOf<String?>(null) }

    fun appendToken(token: String) {
        val t = value.text.trimEnd()
        val next = if (t.isEmpty()) token else "$t $token"
        value = TextFieldValue("$next ", TextRange(next.length + 1))
    }

    fun submit() {
        val text = value.text
        if (text.isBlank()) return
        scope.launch {
            val added = todo.perform {
                val (defaults, anchor) = addDefaults(view)
                quickAdd(text, defaults, anchor)
            }
            if (added != null) { value = TextFieldValue(""); onAdded(added.title) }
        }
    }

    LaunchedEffect(Unit) { focus.requestFocus() }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().padding(horizontal = 16.dp, vertical = 4.dp)) {
            TextField(
                value, { value = it },
                modifier = Modifier.fillMaxWidth().focusRequester(focus),
                placeholder = { Text("e.g. Call mum tomorrow 5pm p1 #Family @phone") },
                singleLine = true,
                visualTransformation = highlight,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences, imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { submit() }),
                colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                                                  focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
                textStyle = MaterialTheme.typography.bodyLarge,
            )
            // what the text means so far
            FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                parsed.due?.let { Chip(Icons.Rounded.Event, dates.label(it), TodoStyle.token(QuickAddResult.Token.Kind.DATE).compose()) }
                parsed.project?.let { Chip(Icons.Rounded.Tag, it, TodoStyle.token(QuickAddResult.Token.Kind.PROJECT).compose()) }
                parsed.priority?.let { Chip(Icons.Rounded.Flag, "P$it", TodoStyle.priority(it)?.compose() ?: MaterialTheme.colorScheme.outline) }
                parsed.labels.forEach { Chip(Icons.AutoMirrored.Rounded.Label, it, TodoStyle.token(QuickAddResult.Token.Kind.LABEL).compose()) }
            }
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Box {
                    IconButton(onClick = { menu = "date" }) { Icon(Icons.Rounded.Event, "Due date") }
                    DropdownMenu(menu == "date", onDismissRequest = { menu = null }) {
                        listOf("today", "tomorrow", "this weekend", "next week", "no date").forEach { phrase ->
                            DropdownMenuItem(text = { Text(phrase.replaceFirstChar(Char::uppercase)) }, onClick = { appendToken(phrase); menu = null })
                        }
                    }
                }
                Box {
                    IconButton(onClick = { menu = "priority" }) { Icon(Icons.Rounded.Flag, "Priority") }
                    DropdownMenu(menu == "priority", onDismissRequest = { menu = null }) {
                        (1..4).forEach { p ->
                            DropdownMenuItem(
                                text = { Text("Priority $p") },
                                leadingIcon = { Icon(Icons.Rounded.Flag, null, tint = TodoStyle.priority(p)?.compose() ?: MaterialTheme.colorScheme.outline) },
                                onClick = { appendToken("p$p"); menu = null },
                            )
                        }
                    }
                }
                Box {
                    IconButton(onClick = { menu = "project" }) { Icon(Icons.Rounded.Tag, "Project") }
                    DropdownMenu(menu == "project", onDismissRequest = { menu = null }) {
                        store.projects.filter { !it.archived }.forEach { p ->
                            DropdownMenuItem(text = { Text(p.name) }, leadingIcon = { Dot(projectColor(p.color)) },
                                             onClick = { appendToken("#" + p.name); menu = null })
                        }
                    }
                }
                if (store.labels.isNotEmpty()) Box {
                    IconButton(onClick = { menu = "label" }) { Icon(Icons.AutoMirrored.Rounded.Label, "Label") }
                    DropdownMenu(menu == "label", onDismissRequest = { menu = null }) {
                        store.labels.forEach { l -> DropdownMenuItem(text = { Text("@$l") }, onClick = { appendToken("@$l"); menu = null }) }
                    }
                }
                Spacer(Modifier.weight(1f))
                val listening = dictation is DictationState.Listening
                IconButton(onClick = {
                    if (listening) graph.dictation.stop()
                    else graph.dictation.start(DictationTarget.Editor({ text -> appendToken(text.trim().trimEnd('.')) },
                        FieldContext(appLabel = "Bento Todo", hint = "A task with an optional date, #project, @label or p1–p4", singleLine = true)), handsFree = true)
                }) { Icon(if (listening) Icons.Rounded.Stop else Icons.Rounded.Mic, "Dictate") }
                FilledIconButton(onClick = ::submit, enabled = value.text.isNotBlank()) { Icon(Icons.AutoMirrored.Rounded.Send, "Add") }
            }
            if (dictation is DictationState.Listening) {
                Text((dictation as DictationState.Listening).partial.ifBlank { "Listening…" }, style = MaterialTheme.typography.bodySmall,
                     color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 8.dp))
            }
        }
    }
}

@Composable
private fun Chip(icon: ImageVector, text: String, color: Color) {
    Row(
        Modifier.background(color.copy(alpha = 0.12f), CircleShape).padding(horizontal = 10.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = color, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(4.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = color)
    }
}

@Composable
fun Dot(color: Color, size: Int = 10) = Box(Modifier.size(size.dp).background(color, CircleShape))

// MARK: Task details

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun TaskDetailSheet(id: String, docs: List<FieldDoc>, dates: TodoDates, onDismiss: () -> Unit, perform: (TodoActions.() -> TodoActions.Change?) -> Unit) {
    val graph = LocalContext.current.graph
    val todo = graph.todo
    val scope = rememberCoroutineScope()
    val task = docs.firstOrNull { it.id == id && !it.deleted }
    if (task == null) { LaunchedEffect(Unit) { onDismiss() }; return }
    val store = remember(docs) { TodoStore(SnapshotRepo(docs)) }
    val originalTitle = remember(id) { task.title }
    val originalNotes = remember(id) { task.notes }
    var title by remember(id) { mutableStateOf(task.title) }
    var notes by remember(id) { mutableStateOf(task.notes) }
    var schedule by remember { mutableStateOf(false) }
    var projectMenu by remember { mutableStateOf(false) }
    var newLabel by remember { mutableStateOf("") }

    fun save() {
        if (title == originalTitle && notes == originalNotes) return
        val t = title
        val n = notes
        scope.launch { todo.perform { saveEdit(id, t, n, originalTitle, originalNotes) } }
    }
    DisposableEffect(id) { onDispose { save() } }

    ModalBottomSheet(onDismissRequest = { save(); onDismiss() }) {
        Column(Modifier.fillMaxWidth().imePadding().navigationBarsPadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
            Row(verticalAlignment = Alignment.Top) {
                PriorityCircle(task.priority, task.isCompleted, onToggle = { perform { toggleComplete(listOf(id)) } })
                Column(Modifier.weight(1f)) {
                    TextField(title, { title = it }, textStyle = MaterialTheme.typography.titleMedium, modifier = Modifier.fillMaxWidth(),
                              colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                                                                focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent))
                    TextField(notes, { notes = it }, placeholder = { Text("Description") }, textStyle = MaterialTheme.typography.bodyMedium,
                              modifier = Modifier.fillMaxWidth(),
                              colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                                                                focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent))
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            // project
            Box {
                val p = task.project?.let { pid -> store.projects.firstOrNull { it.id == pid } }
                DetailRow(Icons.Rounded.Inbox, p?.name ?: "Inbox", p?.let { projectColor(it.color) }) { projectMenu = true }
                DropdownMenu(projectMenu, onDismissRequest = { projectMenu = false }) {
                    DropdownMenuItem(text = { Text("Inbox") }, leadingIcon = { Icon(Icons.Rounded.Inbox, null) },
                                     onClick = { perform { move(listOf(id), null) }; projectMenu = false })
                    store.projects.filter { !it.archived }.forEach { pr ->
                        DropdownMenuItem(text = { Text(pr.name) }, leadingIcon = { Dot(projectColor(pr.color)) },
                                         onClick = { perform { move(listOf(id), pr.id) }; projectMenu = false })
                    }
                }
            }
            // due
            val due = task.due
            DetailRow(Icons.Rounded.Event, due?.let { dates.label(it) } ?: "No date",
                      due?.let { TodoStyle.due(it, dates)?.compose() }) { schedule = true }
            // priority
            Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Flag, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 12.dp, end = 20.dp))
                (1..4).forEach { pr ->
                    val c = TodoStyle.priority(pr)?.compose() ?: MaterialTheme.colorScheme.outline
                    val selected = task.priority == pr
                    Box(
                        Modifier.padding(end = 8.dp).background(if (selected) c.copy(alpha = 0.18f) else Color.Transparent, CircleShape)
                            .clickable { perform { setPriority(pr, listOf(id)) } }.padding(horizontal = 12.dp, vertical = 6.dp),
                    ) { Text("P$pr", color = c, fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal) }
                }
            }
            // labels
            FlowRow(Modifier.padding(start = 12.dp, top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                task.labels.forEach { l ->
                    InputChip(selected = false, onClick = { perform { setLabels(listOf(id), task.labels - l) } }, label = { Text("@$l") },
                              trailingIcon = { Icon(Icons.Rounded.Close, "Remove", Modifier.size(16.dp)) })
                }
            }
            OutlinedTextField(
                newLabel, { newLabel = it.replace(" ", "_") }, singleLine = true, placeholder = { Text("Add a label") },
                leadingIcon = { Icon(Icons.AutoMirrored.Rounded.Label, null) },
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = KeyboardActions(onDone = {
                    val l = newLabel.trim().removePrefix("@")
                    if (l.isNotEmpty()) perform { setLabels(listOf(id), (task.labels + l).distinct()) }
                    newLabel = ""
                }),
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            )
            if (store.labels.any { it !in task.labels }) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    store.labels.filter { it !in task.labels }.take(8).forEach { l ->
                        AssistChip(onClick = { perform { setLabels(listOf(id), task.labels + l) } }, label = { Text("@$l") })
                    }
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 8.dp))
            DetailRow(Icons.Rounded.Delete, "Delete task", MaterialTheme.colorScheme.error) {
                perform { delete(listOf(id)) }
                onDismiss()
            }
            Spacer(Modifier.size(16.dp))
        }
    }
    if (schedule) ScheduleSheet(dates, current = task.due, onPick = { d -> perform { setDue(d, listOf(id)) }; schedule = false }, onDismiss = { schedule = false })
}

@Composable
private fun DetailRow(icon: ImageVector, text: String, tint: Color? = null, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, tint = tint ?: MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(20.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, color = tint ?: MaterialTheme.colorScheme.onSurface)
    }
}

// MARK: Scheduling

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleSheet(dates: TodoDates, current: DueDate? = null, onPick: (DueDate?) -> Unit, onDismiss: () -> Unit) {
    var pickDate by remember { mutableStateOf(false) }
    var pickTime by remember { mutableStateOf<String?>(null) } // the day a time is being chosen for
    val today = dates.todayDate
    fun day(d: LocalDate) = dates.string(d)
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 12.dp)) {
            val options = listOf(
                Triple(Icons.Rounded.Today, "Today", today),
                Triple(Icons.Rounded.WbSunny, "Tomorrow", today.plusDays(1)),
                Triple(Icons.Rounded.Weekend, "This weekend", today.with(TemporalAdjusters.nextOrSame(java.time.DayOfWeek.SATURDAY))),
                Triple(Icons.Rounded.Upcoming, "Next week", today.with(TemporalAdjusters.next(java.time.DayOfWeek.MONDAY))),
            )
            options.forEach { (icon, label, d) ->
                Row(Modifier.fillMaxWidth().clickable { onPick(DueDate(day(d), current?.time)) }.padding(horizontal = 24.dp, vertical = 14.dp),
                    verticalAlignment = Alignment.CenterVertically) {
                    Icon(icon, null, tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.width(20.dp))
                    Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    Text(dates.label(DueDate(day(d))), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
                }
            }
            Row(Modifier.fillMaxWidth().clickable { pickDate = true }.padding(horizontal = 24.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.DateRange, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(20.dp))
                Text("Pick a date", style = MaterialTheme.typography.bodyLarge)
            }
            Row(Modifier.fillMaxWidth().clickable { pickTime = current?.date ?: day(today) }.padding(horizontal = 24.dp, vertical = 14.dp),
                verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.Schedule, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(20.dp))
                Text(if (current?.time != null) "Time: ${current.time}" else "Add a time", style = MaterialTheme.typography.bodyLarge)
            }
            Row(Modifier.fillMaxWidth().clickable { onPick(null) }.padding(horizontal = 24.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.EventBusy, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(20.dp))
                Text("No date", style = MaterialTheme.typography.bodyLarge)
            }
        }
    }
    if (pickDate) {
        val initial = current?.let { dates.date(it.date) } ?: today
        val state = rememberDatePickerState(initialSelectedDateMillis = initial.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { pickDate = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { ms ->
                        onPick(DueDate(day(Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate()), current?.time))
                    }
                    pickDate = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { pickDate = false }) { Text("Cancel") } },
        ) { DatePicker(state) }
    }
    pickTime?.let { d ->
        val (h, m) = current?.time?.split(":")?.mapNotNull { it.toIntOrNull() }?.takeIf { it.size == 2 }?.let { it[0] to it[1] } ?: (9 to 0)
        val state = rememberTimePickerState(h, m)
        AlertDialog(
            onDismissRequest = { pickTime = null },
            confirmButton = {
                TextButton(onClick = { onPick(DueDate(d, DueDate.timeString(state.hour, state.minute))); pickTime = null }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { pickTime = null }) { Text("Cancel") } },
            text = { TimePicker(state) },
        )
    }
}

// MARK: Lists

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun ViewPickerSheet(
    view: TodoListView, counts: TodoQuery.Counts, projects: List<FieldDoc>, labels: List<String>,
    onPick: (TodoListView) -> Unit, onDismiss: () -> Unit,
) {
    val graph = LocalContext.current.graph
    val scope = rememberCoroutineScope()
    var editing by remember { mutableStateOf<FieldDoc?>(null) }
    var creating by remember { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(Modifier.navigationBarsPadding().verticalScroll(rememberScrollState()).padding(bottom = 16.dp)) {
            PickRow(Icons.Rounded.Inbox, "Inbox", counts.inbox.takeIf { it > 0 }?.toString(), view == TodoListView.Inbox,
                    MaterialTheme.colorScheme.primary) { onPick(TodoListView.Inbox) }
            PickRow(Icons.Rounded.Today, "Today", counts.today.takeIf { it > 0 }?.toString(), view == TodoListView.Today,
                    TodoStyle.token(QuickAddResult.Token.Kind.DATE).compose(), alert = counts.overdue > 0) { onPick(TodoListView.Today) }
            PickRow(Icons.Rounded.Upcoming, "Upcoming", null, view == TodoListView.Upcoming, TodoStyle.priority(2)!!.compose()) { onPick(TodoListView.Upcoming) }
            Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Projects", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                TextButton(onClick = { creating = true }) { Text("New") }
            }
            projects.forEach { p ->
                Row(
                    Modifier.fillMaxWidth().combinedClickable(onClick = { onPick(TodoListView.Project(p.id)) }, onLongClick = { editing = p })
                        .background(if (view == TodoListView.Project(p.id)) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                        .padding(horizontal = 24.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Dot(projectColor(p.color), 12)
                    Spacer(Modifier.width(20.dp))
                    Text(p.name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f),
                         color = if (p.archived) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                    counts.byProject[p.id]?.let { Text(it.toString(), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
            if (labels.isNotEmpty()) {
                Text("Labels", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                     modifier = Modifier.padding(start = 24.dp, top = 16.dp, bottom = 4.dp))
                labels.forEach { l ->
                    PickRow(Icons.AutoMirrored.Rounded.Label, l, null, view == TodoListView.Label(l),
                            TodoStyle.token(QuickAddResult.Token.Kind.LABEL).compose()) { onPick(TodoListView.Label(l)) }
                }
            }
        }
    }
    if (creating || editing != null) {
        val p = editing
        var name by remember(p) { mutableStateOf(p?.name ?: "") }
        var color by remember(p) { mutableStateOf(p?.color ?: "blue") }
        AlertDialog(
            onDismissRequest = { creating = false; editing = null },
            title = { Text(if (p == null) "New project" else "Edit project") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    OutlinedTextField(name, { name = it }, singleLine = true, label = { Text("Name") })
                    @OptIn(ExperimentalLayoutApi::class)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        TodoStyle.palette.forEach { (key, c) ->
                            Box(Modifier.size(28.dp).background(c.compose(), CircleShape).clickable { color = key }, contentAlignment = Alignment.Center) {
                                if (color == key) Box(Modifier.size(10.dp).background(Color.White, CircleShape))
                            }
                        }
                    }
                    if (p != null) {
                        Row {
                            TextButton(onClick = {
                                scope.launch { graph.todo.perform { setArchived(p.id, !p.archived) } }; editing = null
                            }) { Text(if (p.archived) "Unarchive" else "Archive") }
                            TextButton(onClick = {
                                scope.launch { graph.todo.perform { deleteProject(p.id) } }; editing = null
                                if (view == TodoListView.Project(p.id)) onPick(TodoListView.Inbox)
                            }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                        }
                    }
                }
            },
            confirmButton = {
                TextButton(enabled = name.isNotBlank(), onClick = {
                    val n = name.trim()
                    val c = color
                    scope.launch {
                        graph.todo.perform {
                            if (p == null) createProject(n, c)
                            else { renameProject(p.id, n); setProjectColor(p.id, c) }
                        }
                    }
                    creating = false; editing = null
                }) { Text("Save") }
            },
            dismissButton = { TextButton(onClick = { creating = false; editing = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun PickRow(icon: ImageVector, title: String, count: String?, selected: Boolean, tint: Color, alert: Boolean = false, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick)
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
            .padding(horizontal = 24.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, null, tint = tint)
        Spacer(Modifier.width(20.dp))
        Text(title, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
        if (count != null) Text(count, color = if (alert) TodoStyle.priority(1)!!.compose() else MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
