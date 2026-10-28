package com.charles.bento.ui.notes

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.staggeredgrid.LazyVerticalStaggeredGrid
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridCells
import androidx.compose.foundation.lazy.staggeredgrid.StaggeredGridItemSpan
import androidx.compose.foundation.lazy.staggeredgrid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.ViewList
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.CloudOff
import androidx.compose.material.icons.rounded.GridView
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.rounded.Search
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
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.charles.bento.core.notes.FuzzyMatch
import com.charles.bento.core.notes.Note
import com.charles.bento.core.notes.NoteQueries
import com.charles.bento.core.notes.NoteText
import com.charles.bento.core.notes.RelativeDate
import com.charles.bento.core.sync.SyncState
import com.charles.bento.graph
import com.charles.bento.ui.NoteRoute
import com.charles.bento.ui.Routes
import com.charles.bento.ui.SettingsRoute
import com.charles.bento.ui.TrashRoute
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Plain-text lines after the title, for previews. */
fun snippet(body: String, lines: Int = 4): String {
    val plain = NoteText.plainText(body).lines().map { it.trim() }.filter { it.isNotEmpty() }
    return plain.drop(1).take(lines).joinToString("\n")
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotesScreen(modifier: Modifier, nav: NavController) {
    val graph = LocalContext.current.graph
    val module = graph.notes
    val all by module.notes.collectAsStateWithLifecycle()
    val grid by graph.prefs.notesGrid.flow.collectAsStateWithLifecycle()
    val status by (graph.sync.status("notes") ?: kotlinx.coroutines.flow.MutableStateFlow(com.charles.bento.core.sync.SyncStatus())).collectAsStateWithLifecycle()
    var searching by rememberSaveable { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var menu by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    val live = remember(all) { NoteQueries.liveNotes(all) }
    val shown = remember(live, query) {
        if (query.isBlank()) live
        else live.mapNotNull { n -> FuzzyMatch.noteScore(query, NoteText.title(n.body), n.body)?.let { n to it } }
            .sortedByDescending { it.second }.map { it.first }
    }
    val pinned = shown.filter { it.pinned && query.isBlank() }
    val others = if (query.isBlank()) shown.filter { !it.pinned } else shown

    fun delete(n: Note) {
        scope.launch {
            module.trash(n.id)
            if (snackbar.showSnackbar("Note moved to Recently Deleted", "Undo", duration = SnackbarDuration.Short) == SnackbarResult.ActionPerformed) {
                module.restore(n.id)
            }
        }
    }

    Scaffold(
        modifier = modifier,
        contentWindowInsets = WindowInsets(0),
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            if (searching) {
                TopAppBar(
                    navigationIcon = { IconButton(onClick = { searching = false; query = "" }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Close search") } },
                    title = {
                        TextField(query, { query = it }, placeholder = { Text("Search notes") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                                  colors = TextFieldDefaults.colors(focusedContainerColor = Color.Transparent, unfocusedContainerColor = Color.Transparent,
                                                                    focusedIndicatorColor = Color.Transparent, unfocusedIndicatorColor = Color.Transparent))
                    },
                )
            } else {
                TopAppBar(
                    title = {
                        Column {
                            Text("Notes", fontWeight = FontWeight.SemiBold)
                            if (!status.isHealthy && status.state != SyncState.Disabled && status.state != SyncState.NoServer) {
                                Text(status.summary("note"), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    },
                    actions = {
                        if (status.state == SyncState.Offline || status.state == SyncState.Unauthorized) {
                            IconButton(onClick = { nav.navigate(SettingsRoute) }) { Icon(Icons.Rounded.CloudOff, status.summary("note")) }
                        }
                        IconButton(onClick = { searching = true }) { Icon(Icons.Rounded.Search, "Search") }
                        IconButton(onClick = { graph.prefs.notesGrid.value = !grid }) {
                            Icon(if (grid) Icons.AutoMirrored.Rounded.ViewList else Icons.Rounded.GridView, if (grid) "List" else "Grid")
                        }
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Rounded.MoreVert, "More") }
                            DropdownMenu(menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(text = { Text("Recently Deleted") }, onClick = { menu = false; nav.navigate(TrashRoute) })
                                DropdownMenuItem(text = { Text("Settings") }, onClick = { menu = false; nav.navigate(SettingsRoute) })
                            }
                        }
                    },
                )
            }
        },
        floatingActionButton = {
            FloatingActionButton(onClick = { nav.navigate(NoteRoute(Routes.NEW)) }, containerColor = MaterialTheme.colorScheme.primary) {
                Icon(Icons.Rounded.Add, "New note")
            }
        },
    ) { padding ->
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = { refreshing = true; graph.sync.syncNow(); scope.launch { delay(900); refreshing = false } },
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            if (shown.isEmpty()) {
                Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
                    Text(if (query.isBlank()) "No notes yet" else "No notes match “$query”", style = MaterialTheme.typography.titleMedium)
                    if (query.isBlank()) Text("Tap + to write one, or pair with your Mac to bring yours over.", color = MaterialTheme.colorScheme.onSurfaceVariant,
                                              style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 6.dp))
                }
            } else {
                LazyVerticalStaggeredGrid(
                    columns = StaggeredGridCells.Fixed(if (grid) 2 else 1),
                    contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 96.dp),
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                    verticalItemSpacing = 10.dp,
                    modifier = Modifier.fillMaxSize(),
                ) {
                    if (pinned.isNotEmpty()) {
                        item(span = StaggeredGridItemSpan.FullLine) { SectionLabel("Pinned") }
                        items(pinned, key = { it.id }) { n -> NoteCard(n, grid, nav, onPin = { scope.launch { module.togglePin(n.id) } }, onDelete = { delete(n) }) }
                        if (others.isNotEmpty()) item(span = StaggeredGridItemSpan.FullLine) { SectionLabel("Others") }
                    }
                    items(others, key = { it.id }) { n -> NoteCard(n, grid, nav, onPin = { scope.launch { module.togglePin(n.id) } }, onDelete = { delete(n) }) }
                }
            }
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
         modifier = Modifier.padding(start = 8.dp, top = 8.dp, bottom = 2.dp))
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun NoteCard(n: Note, grid: Boolean, nav: NavController, onPin: () -> Unit, onDelete: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Box {
        Surface(
            shape = RoundedCornerShape(18.dp),
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            modifier = Modifier.fillMaxWidth().combinedClickable(onClick = { nav.navigate(NoteRoute(n.id)) }, onLongClick = { menu = true }),
        ) {
            Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(NoteText.displayTitle(n.body), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                         modifier = Modifier.weight(1f))
                    if (n.pinned) Icon(Icons.Rounded.PushPin, "Pinned", tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(16.dp))
                }
                val snip = remember(n.body) { snippet(n.body, if (grid) 8 else 3) }
                if (snip.isNotBlank()) {
                    Text(snip, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                         maxLines = if (grid) 8 else 3, overflow = TextOverflow.Ellipsis)
                }
                Text(RelativeDate.short(maxOf(n.updatedAt, n.openedAt)), style = MaterialTheme.typography.labelSmall,
                     color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f))
            }
        }
        DropdownMenu(menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(text = { Text(if (n.pinned) "Unpin" else "Pin") }, onClick = { menu = false; onPin() })
            DropdownMenuItem(text = { Text("Delete") }, onClick = { menu = false; onDelete() })
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrashScreen(nav: NavController) {
    val graph = LocalContext.current.graph
    val module = graph.notes
    val all by module.notes.collectAsStateWithLifecycle()
    val trashed = remember(all) { NoteQueries.trashedNotes(all) }
    val scope = rememberCoroutineScope()
    Scaffold(topBar = {
        TopAppBar(title = { Text("Recently Deleted") },
                  navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } })
    }) { padding ->
        LazyVerticalStaggeredGrid(StaggeredGridCells.Fixed(1), Modifier.fillMaxSize().padding(padding),
                                  contentPadding = PaddingValues(12.dp), verticalItemSpacing = 8.dp) {
            item { Text("Notes stay here for 60 days.", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp)) }
            items(trashed, key = { it.id }) { n ->
                Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                    Row(Modifier.padding(start = 14.dp, end = 4.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(NoteText.displayTitle(n.body), style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text("Deleted ${RelativeDate.short(n.trashedAt ?: n.updatedAt)}", style = MaterialTheme.typography.labelSmall,
                                 color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { scope.launch { module.restore(n.id) } }) { Text("Restore") }
                        TextButton(onClick = { scope.launch { module.deletePermanently(n.id) } }) { Text("Delete", color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
        }
    }
}

