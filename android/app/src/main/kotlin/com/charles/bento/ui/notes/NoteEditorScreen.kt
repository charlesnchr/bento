package com.charles.bento.ui.notes

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.ArrowBack
import androidx.compose.material.icons.automirrored.rounded.FormatIndentDecrease
import androidx.compose.material.icons.automirrored.rounded.FormatIndentIncrease
import androidx.compose.material.icons.automirrored.rounded.FormatListBulleted
import androidx.compose.material.icons.automirrored.rounded.Redo
import androidx.compose.material.icons.automirrored.rounded.Undo
import androidx.compose.material.icons.rounded.CheckBox
import androidx.compose.material.icons.rounded.Code
import androidx.compose.material.icons.rounded.FormatBold
import androidx.compose.material.icons.rounded.FormatItalic
import androidx.compose.material.icons.rounded.FormatStrikethrough
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Link
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MoreVert
import androidx.compose.material.icons.rounded.PushPin
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Title
import androidx.compose.material.icons.rounded.UnfoldMore
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextRange as UiRange
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.charles.bento.core.notes.BlockFormat
import com.charles.bento.core.notes.BlockKind
import com.charles.bento.core.notes.EditResult
import com.charles.bento.core.notes.InlineFormat
import com.charles.bento.core.notes.MarkdownCommands
import com.charles.bento.core.notes.MarkdownParser
import com.charles.bento.core.notes.NoteText
import com.charles.bento.core.notes.RelativeDate
import com.charles.bento.core.notes.TextMerge
import com.charles.bento.core.notes.TextRange
import com.charles.bento.graph
import com.charles.bento.ui.NoteRoute
import com.charles.bento.ui.Routes
import com.charles.bento.ui.theme.LocalBentoColors
import com.charles.bento.voice.DictationState
import com.charles.bento.voice.DictationTarget
import com.charles.bento.voice.FieldContext
import com.charles.bento.voice.TextInserter
import kotlinx.coroutines.launch

private fun TextFieldValue.sel() = TextRange(selection.min, selection.max - selection.min)
private fun TextRange.ui() = UiRange(location, end)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NoteEditorScreen(routeId: String, nav: NavController) {
    val context = LocalContext.current
    val graph = context.graph
    val notesModule = graph.notes
    val scope = rememberCoroutineScope()

    // "new": create a note and replace this route with it
    if (routeId == Routes.NEW) {
        LaunchedEffect(Unit) {
            val id = notesModule.create()
            nav.navigate(NoteRoute(id)) { popUpTo(NoteRoute(Routes.NEW)) { inclusive = true } }
        }
        return
    }
    val id = routeId
    val all by notesModule.notes.collectAsStateWithLifecycle()
    val note = all.firstOrNull { it.id == id }
    var value by remember(id) { mutableStateOf(TextFieldValue(note?.body.orEmpty(), UiRange(note?.body?.length ?: 0))) }
    var posted by remember(id) { mutableStateOf(note?.body.orEmpty()) } // what the module has (merge base for remote text)
    val history = remember(id) { EditHistory() }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val focusManager = LocalFocusManager.current
    var menu by remember { mutableStateOf(false) }
    var info by remember { mutableStateOf(false) }
    val dictation by graph.dictation.state.collectAsStateWithLifecycle()
    val bento = LocalBentoColors.current
    val colors = MarkdownColors(
        text = MaterialTheme.colorScheme.onSurface,
        muted = MaterialTheme.colorScheme.onSurfaceVariant,
        marker = bento.marker,
        accent = MaterialTheme.colorScheme.primary,
        codeBackground = bento.codeBackground,
    )
    val visual = remember(colors) { MarkdownVisual(colors) }

    fun post(text: String) {
        posted = text
        notesModule.edited(id, text)
    }

    fun set(v: TextFieldValue, record: Boolean = true) {
        if (record && v.text != value.text) history.record(value)
        val changed = v.text != value.text
        value = v
        if (changed) post(v.text)
    }

    fun applyResult(r: EditResult?) {
        r ?: return
        val text = r.apply(value.text)
        set(TextFieldValue(text, r.selection.ui()))
    }

    LaunchedEffect(id) {
        notesModule.opened(id)
        if (value.text.isEmpty()) focus.requestFocus()
    }
    DisposableEffect(id) { onDispose { notesModule.closed(id) } }

    // text from elsewhere (another device, a widget, a captured thought): merged in like Google Docs
    LaunchedEffect(id) {
        notesModule.remote.collect { n ->
            if (n.id != id) return@collect
            val local = value.text
            if (n.deleted || n.isTrashed) { nav.popBackStack(); return@collect }
            if (n.body == local) { posted = n.body; return@collect }
            val merged = if (local == posted) n.body else TextMerge.merge(posted, local, n.body) ?: n.body
            val edits = TextMerge.edits(local, merged)
            val sel = TextMerge.map(value.sel(), edits)
            history.clear()
            value = TextFieldValue(merged, sel.ui())
            posted = n.body
            if (merged != n.body) post(merged) // keystrokes typed meanwhile go on top
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface),
                title = {},
                navigationIcon = { IconButton(onClick = { nav.popBackStack() }) { Icon(Icons.AutoMirrored.Rounded.ArrowBack, "Back") } },
                actions = {
                    if (note != null) {
                        IconButton(onClick = { scope.launch { notesModule.togglePin(id) } }) {
                            Icon(if (note.pinned) Icons.Rounded.PushPin else Icons.Outlined.PushPin, if (note.pinned) "Unpin" else "Pin",
                                 tint = if (note.pinned) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    Box {
                        IconButton(onClick = { menu = true }) { Icon(Icons.Rounded.MoreVert, "More") }
                        DropdownMenu(menu, onDismissRequest = { menu = false }) {
                            DropdownMenuItem(text = { Text("Share") }, onClick = {
                                menu = false
                                context.startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain")
                                    .putExtra(Intent.EXTRA_SUBJECT, NoteText.displayTitle(value.text)).putExtra(Intent.EXTRA_TEXT, value.text), null))
                            })
                            DropdownMenuItem(text = { Text("Copy as Markdown") }, onClick = {
                                menu = false
                                context.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("Note", value.text))
                            })
                            DropdownMenuItem(text = { Text("Info") }, onClick = { menu = false; info = true })
                            HorizontalDivider()
                            DropdownMenuItem(text = { Text("Delete", color = MaterialTheme.colorScheme.error) }, onClick = {
                                menu = false
                                scope.launch { notesModule.trash(id) }
                                nav.popBackStack()
                            })
                        }
                    }
                },
            )
        },
        bottomBar = {
            Toolbar(
                listening = dictation is DictationState.Listening,
                canUndo = history.canUndo, canRedo = history.canRedo,
                onUndo = { history.undo(value)?.let { set(it, record = false) } },
                onRedo = { history.redo(value)?.let { set(it, record = false) } },
                onTask = { applyResult(MarkdownCommands.toggleTasks(value.text, value.sel()) ?: MarkdownCommands.setBlock(value.text, value.sel(), BlockFormat.Task)) },
                onBullet = { applyResult(MarkdownCommands.setBlock(value.text, value.sel(), BlockFormat.Bullet)) },
                onHeading = {
                    val line = MarkdownCommands.line(value.selection.min, value.text)
                    val kind = MarkdownParser.parseLine(line.text(value.text), false).kind
                    val next = when ((kind as? BlockKind.Heading)?.level) { 1 -> BlockFormat.Heading(2); 2 -> BlockFormat.Heading(3); 3 -> BlockFormat.Paragraph; else -> BlockFormat.Heading(1) }
                    applyResult(MarkdownCommands.setBlock(value.text, value.sel(), next))
                },
                onInline = { f -> applyResult(MarkdownCommands.toggleInline(value.text, value.sel(), f)) },
                onLink = { applyResult(MarkdownCommands.insertLink(value.text, value.sel(), null)) },
                onExpander = { applyResult(MarkdownCommands.wrapInExpander(value.text, value.sel())) },
                onIndent = { out -> applyResult(MarkdownCommands.indent(value.text, value.sel(), out)) },
                onMic = {
                    if (dictation is DictationState.Listening) graph.dictation.stop()
                    else graph.dictation.start(DictationTarget.Editor({ spoken ->
                        val v = value
                        val before = v.text.substring(0, v.selection.min)
                        val ins = TextInserter.spaced(spoken, before, v.text.substring(v.selection.max))
                        set(TextFieldValue(before + ins + v.text.substring(v.selection.max), UiRange(before.length + ins.length)))
                    }, FieldContext(appLabel = "Bento Notes", hint = "A note in Markdown", textBefore = value.text.substring(0, value.selection.min))), handsFree = true)
                },
                onHideKeyboard = { keyboard?.hide(); focusManager.clearFocus() },
                status = when (val d = dictation) {
                    is DictationState.Listening -> d.partial.ifBlank { "Listening…" }
                    is DictationState.Processing -> "Transcribing…"
                    else -> null
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState())) {
            BasicTextField(
                value = value,
                onValueChange = { new -> handleChange(value, new, ::set, ::applyResult) },
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).focusRequester(focus),
                textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                visualTransformation = visual,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                decorationBox = { inner ->
                    Box {
                        if (value.text.isEmpty()) Text("Start typing…", style = MaterialTheme.typography.bodyLarge,
                                                       color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
                        inner()
                    }
                },
            )
        }
    }

    if (info && note != null) {
        AlertDialog(
            onDismissRequest = { info = false },
            title = { Text(NoteText.displayTitle(value.text)) },
            text = {
                Text(
                    "${NoteText.wordCount(value.text)} words · ${NoteText.characterCount(value.text)} characters\n" +
                        "Edited ${RelativeDate.short(note.updatedAt)}" + (note.device.takeIf { it.isNotBlank() }?.let { " on $it" } ?: "") + "\n" +
                        "Created ${RelativeDate.short(note.createdAt)}",
                )
            },
            confirmButton = { TextButton(onClick = { info = false }) { Text("OK") } },
        )
    }
}

/**
 * Turns raw keyboard edits into the Mac editor's Markdown behaviour: Enter continues a
 * list (or ends it on an empty item), Backspace at a list or heading marker removes the
 * marker, input rules ("[] " → task), and a tap on a `[ ]` ticks it.
 */
private fun handleChange(old: TextFieldValue, new: TextFieldValue, set: (TextFieldValue, Boolean) -> Unit, apply: (EditResult?) -> Unit) {
    val o = old.text
    val n = new.text
    if (o == n) {
        // a tap (no text change) that lands on a task's [ ] ticks it
        val caret = new.selection
        if (caret.collapsed && caret.start != old.selection.start) {
            val line = MarkdownCommands.line(caret.start, o)
            val parsed = MarkdownParser.parseLine(line.text(o), false)
            val marker = parsed.markerRange
            if (parsed.kind is BlockKind.Task && marker != null) {
                val rel = caret.start - line.range.location
                if (rel >= marker.location && rel <= marker.end) {
                    val r = MarkdownCommands.toggleTasks(o, TextRange(line.range.location, 0))
                    if (r != null) {
                        set(TextFieldValue(r.apply(o), old.selection), true)
                        return
                    }
                }
            }
        }
        set(new, false)
        return
    }
    val oldSel = old.sel()
    // a single character typed at the caret
    if (n.length == o.length + 1 - oldSel.length && new.selection.collapsed && new.selection.start == oldSel.location + 1) {
        val typed = n.substring(oldSel.location, oldSel.location + 1)
        if (n.substring(0, oldSel.location) == o.substring(0, oldSel.location) && n.substring(oldSel.location + 1) == o.substring(oldSel.end)) {
            if (typed == "\n") {
                MarkdownCommands.newline(o, oldSel)?.let { apply(it); return }
            } else {
                MarkdownCommands.inputRule(o, oldSel, typed)?.let { apply(it); return }
            }
        }
    }
    // Backspace with a collapsed caret
    if (oldSel.length == 0 && n.length == o.length - 1 && new.selection.start == oldSel.location - 1 &&
        n == o.removeRange(oldSel.location - 1, oldSel.location)) {
        MarkdownCommands.backspace(o, oldSel)?.let { apply(it); return }
    }
    set(new, true)
}

/** Undo/redo of the editor's text, grouped so a word is one step. */
private class EditHistory {
    private val undo = ArrayDeque<TextFieldValue>()
    private val redo = ArrayDeque<TextFieldValue>()
    private var lastAt = 0L
    var canUndo by mutableStateOf(false)
        private set
    var canRedo by mutableStateOf(false)
        private set

    fun record(before: TextFieldValue) {
        val now = System.currentTimeMillis()
        val boundary = before.text.lastOrNull()?.let { it.isWhitespace() || it in ".,;:!?" } ?: true
        if (undo.isEmpty() || now - lastAt > 800 || boundary) {
            undo.addLast(before)
            if (undo.size > 200) undo.removeFirst()
        }
        lastAt = now
        redo.clear()
        update()
    }

    fun undo(current: TextFieldValue): TextFieldValue? = undo.removeLastOrNull()?.also { redo.addLast(current); update() }
    fun redo(current: TextFieldValue): TextFieldValue? = redo.removeLastOrNull()?.also { undo.addLast(current); update() }
    fun clear() { undo.clear(); redo.clear(); update() }

    private fun update() { canUndo = undo.isNotEmpty(); canRedo = redo.isNotEmpty() }
}

@Composable
private fun Toolbar(
    listening: Boolean, canUndo: Boolean, canRedo: Boolean,
    onUndo: () -> Unit, onRedo: () -> Unit, onTask: () -> Unit, onBullet: () -> Unit, onHeading: () -> Unit,
    onInline: (InlineFormat) -> Unit, onLink: () -> Unit, onExpander: () -> Unit, onIndent: (Boolean) -> Unit,
    onMic: () -> Unit, onHideKeyboard: () -> Unit, status: String?,
) {
    Surface(tonalElevation = 2.dp, modifier = Modifier.imePadding()) {
        Column(Modifier.navigationBarsPadding()) {
            if (status != null) {
                Text(status, maxLines = 1, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                     modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
            }
            Row(Modifier.fillMaxWidth()) {
                Row(Modifier.weight(1f).horizontalScroll(rememberScrollState())) {
                    ToolButton(Icons.Rounded.CheckBox, "Checklist", onClick = onTask)
                    ToolButton(Icons.AutoMirrored.Rounded.FormatListBulleted, "Bulleted list", onClick = onBullet)
                    ToolButton(Icons.Rounded.Title, "Heading", onClick = onHeading)
                    ToolButton(Icons.Rounded.FormatBold, "Bold") { onInline(InlineFormat.Bold) }
                    ToolButton(Icons.Rounded.FormatItalic, "Italic") { onInline(InlineFormat.Italic) }
                    ToolButton(Icons.Rounded.FormatStrikethrough, "Strikethrough") { onInline(InlineFormat.Strike) }
                    ToolButton(Icons.Rounded.Code, "Code") { onInline(InlineFormat.Code) }
                    ToolButton(Icons.Rounded.Link, "Link", onClick = onLink)
                    ToolButton(Icons.Rounded.UnfoldMore, "Collapsible section", onClick = onExpander)
                    ToolButton(Icons.AutoMirrored.Rounded.FormatIndentIncrease, "Indent") { onIndent(false) }
                    ToolButton(Icons.AutoMirrored.Rounded.FormatIndentDecrease, "Outdent") { onIndent(true) }
                    ToolButton(Icons.AutoMirrored.Rounded.Undo, "Undo", enabled = canUndo, onClick = onUndo)
                    ToolButton(Icons.AutoMirrored.Rounded.Redo, "Redo", enabled = canRedo, onClick = onRedo)
                    ToolButton(Icons.Rounded.KeyboardArrowDown, "Hide keyboard", onClick = onHideKeyboard)
                }
                IconButton(onClick = onMic) {
                    Icon(if (listening) Icons.Rounded.Stop else Icons.Rounded.Mic, "Dictate", tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}

@Composable
private fun ToolButton(icon: ImageVector, description: String, enabled: Boolean = true, onClick: () -> Unit) {
    IconButton(onClick = onClick, enabled = enabled) { Icon(icon, description) }
}
