package com.charles.bento.ui.todo

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Event
import androidx.compose.material.icons.rounded.ExpandMore
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.Search
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material.icons.rounded.WbSunny
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.fielddoc.FieldDocRepository
import com.charles.bento.core.todo.TodoActions
import com.charles.bento.core.todo.TodoListView
import com.charles.bento.core.todo.TodoRow
import com.charles.bento.core.todo.TodoStore
import com.charles.bento.core.todo.TodoStyle
import com.charles.bento.core.todo.color
import com.charles.bento.core.todo.isCompleted
import com.charles.bento.core.todo.name
import com.charles.bento.core.todo.project
import com.charles.bento.graph
import com.charles.bento.ui.HomeAction
import com.charles.bento.ui.Routes
import com.charles.bento.ui.SettingsRoute
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** Read-only view of a snapshot, so the ported TodoStore queries run on the UI thread. */
class SnapshotRepo(docs: List<FieldDoc>) : FieldDocRepository {
    private val byId = docs.associateBy { it.id }
    override fun doc(id: String): FieldDoc? = byId[id]
    override fun save(doc: FieldDoc, remote: Boolean) = error("read only")
    override var lastSeq: Long = 0
    override val allDocs: List<FieldDoc> = docs
}

fun TodoListView.encode(): String = when (this) {
    TodoListView.Inbox -> "inbox"
    TodoListView.Today -> "today"
    TodoListView.Upcoming -> "upcoming"
    is TodoListView.Project -> "project:$id"
    is TodoListView.Label -> "label:$name"
    is TodoListView.Search -> "today"
}

fun decodeView(s: String): TodoListView = when {
    s == "inbox" -> TodoListView.Inbox
    s == "upcoming" -> TodoListView.Upcoming
    s.startsWith("project:") -> TodoListView.Project(s.removePrefix("project:"))
    s.startsWith("label:") -> TodoListView.Label(s.removePrefix("label:"))
    else -> TodoListView.Today
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TodoScreen(modifier: Modifier, nav: NavController, homeAction: MutableStateFlow<HomeAction?>) {
    val context = LocalContext.current
    val graph = context.graph
    val todo = graph.todo
    val docs by todo.docs.collectAsStateWithLifecycle()
    val viewKey by graph.prefs.todoView.flow.collectAsStateWithLifecycle()
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    val view = if (searching) TodoListView.Search(query) else decodeView(viewKey)
    var showCompleted by rememberSaveable { mutableStateOf(false) }
    var quickAdd by rememberSaveable { mutableStateOf(false) }
    var picker by rememberSaveable { mutableStateOf(false) }
    var detail by rememberSaveable { mutableStateOf<String?>(null) }
    var schedule by remember { mutableStateOf<String?>(null) }
    var menu by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current

    // the day rolls over at midnight; due labels ("in 5 min" colours) follow the clock
    val minute by produceState(System.currentTimeMillis()) {
        while (true) { delay(60_000 - System.currentTimeMillis() % 60_000); value = System.currentTimeMillis() }
    }
    val dates = remember(minute) { todo.dates() }
    val store = remember(docs) { TodoStore(SnapshotRepo(docs)) }
    val rows = remember(docs, view, showCompleted, dates) { store.rows(view, showCompleted, dates) }
    val counts = remember(docs, dates) { store.counts(dates) }
    val projects = remember(docs) { store.projects }

    LaunchedEffect(Unit) {
        homeAction.collect { a -> if (a == HomeAction.QuickAdd) { quickAdd = true; homeAction.value = null } }
    }
    val openTask by Routes.openTask.collectAsStateWithLifecycle()
    LaunchedEffect(openTask) { openTask?.let { detail = it; Routes.openTask.value = null } }

    fun perform(block: TodoActions.() -> TodoActions.Change?) {
        scope.launch {
            val change = todo.perform(block) ?: return@launch
            val msg = change.message ?: return@launch
            if (snackbar.showSnackbar(msg, actionLabel = "Undo", duration = SnackbarDuration.Short) == SnackbarResult.ActionPerformed) {
                todo.perform { undo(change.id) }
            }
        }
    }

    Scaffold(
        modifier = modifier,
        contentWindowInsets = WindowInsets(0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            if (searching) {
                TopAppBar(title = {
                    TextField(
                        query, { query = it }, placeholder = { Text("Search tasks") }, singleLine = true,
                        colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                                                          focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }, actions = { IconButton(onClick = { searching = false; query = "" }) { Icon(Icons.Rounded.Check, "Done") } })
            } else {
                TopAppBar(
                    title = {
                        Row(Modifier.clickable { picker = true }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(store.title(view), fontWeight = FontWeight.SemiBold)
                            Icon(Icons.Rounded.ExpandMore, "Choose a list")
                        }
                    },
                    actions = {
                        IconButton(onClick = { searching = true }) { Icon(Icons.Rounded.Search, "Search") }
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Rounded.MoreVert, "More") }
                            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(text = { Text(if (showCompleted) "Hide completed" else "Show completed") },
                                                 onClick = { showCompleted = !showCompleted; menu = false })
                                DropdownMenuItem(text = { Text("Settings") }, leadingIcon = { Icon(Icons.Rounded.Settings, null) },
                                                 onClick = { menu = false; nav.navigate(SettingsRoute) })
                            }
                        }
                    },
                )
            }
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { quickAdd = true }, containerColor = MaterialTheme.colorScheme.primary) {
                Icon(Icons.Rounded.Add, "Add task")
            }
        },
    ) { padding ->
        if (rows.isEmpty()) {
            EmptyState(view, Modifier.padding(padding))
        } else {
            LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(bottom = 96.dp)) {
                items(rows, key = { it.id }) { row ->
                    when (row) {
                        is TodoRow.Header -> GroupHeader(row.title, row.subtitle, overdue = row.headerId == "overdue")
                        is TodoRow.Task -> {
                            val t = row.doc
                            val projectLabel = if (view is TodoListView.Project) null else {
                                t.project?.let { pid -> projects.firstOrNull { it.id == pid } }?.let { it.name to projectColor(it.color) }
                                    ?: if (view is TodoListView.Inbox) null else "Inbox" to MaterialTheme.colorScheme.outline
                            }
                            SwipeableTask(
                                onComplete = { haptics.performHapticFeedback(HapticFeedbackType.Confirm); perform { toggleComplete(listOf(t.id)) } },
                                onSchedule = { schedule = t.id },
                            ) {
                                TaskRow(
                                    t, dates, projectLabel,
                                    onToggle = {
                                        haptics.performHapticFeedback(if (t.isCompleted) HapticFeedbackType.SegmentTick else HapticFeedbackType.Confirm)
                                        perform { toggleComplete(listOf(t.id)) }
                                    },
                                    onOpen = { detail = t.id },
                                    modifier = Modifier.animateItem().background(MaterialTheme.colorScheme.surface),
                                )
                            }
                        }
                    }
                }
            }
        }
    }

    if (quickAdd) QuickAddSheet(view, onDismiss = { quickAdd = false }, onAdded = { title ->
        scope.launch { snackbar.showSnackbar("Added “$title”", duration = SnackbarDuration.Short) }
    })
    if (picker) ViewPickerSheet(view, counts, projects, store.labels, onPick = {
        graph.prefs.todoView.value = it.encode(); picker = false
    }, onDismiss = { picker = false })
    detail?.let { id -> TaskDetailSheet(id, docs, dates, onDismiss = { detail = null }, perform = ::perform) }
    schedule?.let { id -> ScheduleSheet(dates, onPick = { due -> perform { setDue(due, listOf(id)) }; schedule = null }, onDismiss = { schedule = null }) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeableTask(onComplete: () -> Unit, onSchedule: () -> Unit, content: @Composable () -> Unit) {
    val state = rememberSwipeToDismissBoxState()
    LaunchedEffect(state.currentValue) {
        when (state.currentValue) {
            SwipeToDismissBoxValue.StartToEnd -> { onComplete(); state.reset() }
            SwipeToDismissBoxValue.EndToStart -> { onSchedule(); state.reset() }
            SwipeToDismissBoxValue.Settled -> {}
        }
    }
    SwipeToDismissBox(
        state,
        backgroundContent = {
            val toEnd = state.dismissDirection == SwipeToDismissBoxValue.StartToEnd
            val color = if (toEnd) TodoStyle.token(com.charles.bento.core.todo.QuickAddResult.Token.Kind.DATE).compose()
                        else TodoStyle.priority(3)!!.compose()
            Row(
                Modifier.fillMaxSize().background(color).padding(horizontal = 24.dp),
                horizontalArrangement = if (toEnd) Arrangement.Start else Arrangement.End,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(if (toEnd) Icons.Rounded.Check else Icons.Rounded.Event, null, tint = Color.White)
            }
        },
    ) { content() }
}

@Composable
private fun EmptyState(view: TodoListView, modifier: Modifier) {
    Column(modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Box(Modifier.size(72.dp).background(MaterialTheme.colorScheme.secondaryContainer, RoundedCornerShape(36.dp)), contentAlignment = Alignment.Center) {
            Icon(if (view is TodoListView.Today) Icons.Rounded.WbSunny else Icons.Rounded.Check, null, tint = MaterialTheme.colorScheme.onSecondaryContainer)
        }
        Spacer(Modifier.size(16.dp))
        Text(
            when (view) {
                TodoListView.Today -> "Nothing due today."
                TodoListView.Inbox -> "Your inbox is empty."
                is TodoListView.Search -> if (view.query.isBlank()) "Type to search." else "No tasks match “${view.query}”."
                else -> "No tasks here."
            },
            style = MaterialTheme.typography.titleMedium,
        )
        Spacer(Modifier.size(6.dp))
        Text("Tap + to add one: “Call mum tomorrow 5pm p1 #Family”", style = MaterialTheme.typography.bodyMedium,
             color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

