package com.charles.bento.ui.notes

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.draganddrop.dragAndDropTarget
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.gestures.LocalBringIntoViewSpec
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
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
import androidx.compose.material.icons.rounded.UnfoldLess
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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draganddrop.DragAndDropEvent
import androidx.compose.ui.draganddrop.DragAndDropTarget
import androidx.compose.ui.draganddrop.mimeTypes
import androidx.compose.ui.draganddrop.toAndroidDragEvent
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.text.TextRange as UiRange
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavController
import com.charles.bento.core.notes.BlockFormat
import com.charles.bento.core.notes.BlockKind
import com.charles.bento.core.notes.EditResult
import com.charles.bento.core.notes.HeadingFolds
import com.charles.bento.core.notes.InlineFormat
import com.charles.bento.core.notes.MarkdownCommands
import com.charles.bento.core.notes.MarkdownParser
import com.charles.bento.core.notes.NoteImage
import com.charles.bento.core.notes.NoteText
import com.charles.bento.core.notes.RelativeDate
import com.charles.bento.core.notes.TextEdit
import com.charles.bento.core.notes.TextRange
import com.charles.bento.graph
import com.charles.bento.notes.EditMerge
import com.charles.bento.notes.NoteImageImport
import com.charles.bento.ui.LiveTranscript
import com.charles.bento.ui.NoteRoute
import com.charles.bento.ui.Routes
import com.charles.bento.ui.theme.LocalBentoColors
import com.charles.bento.voice.DictationState
import com.charles.bento.voice.DictationTarget
import com.charles.bento.voice.FieldContext
import com.charles.bento.voice.TextInserter
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers

private fun TextFieldValue.sel() = TextRange(selection.min, selection.max - selection.min)
private fun TextRange.ui() = UiRange(location, end)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
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
    // which heading sections are folded (captured thoughts start folded), kept through rotation
    val foldsHolder = rememberSaveable(id, saver = EditorFolds.Saver) { EditorFolds(null) }
    var folds by foldsHolder.state(id, note?.body.orEmpty())
    var value by remember(id) {
        val end = TextRange(folds.text.length, 0)
        mutableStateOf(TextFieldValue(folds.text, folds.caret(end, end).ui()))
    }
    var synced by remember(id) { mutableStateOf(note?.body.orEmpty()) } // the text the module has (or will have, once it has caught up)
    val history = remember(id) { EditHistory() }
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val haptics = LocalHapticFeedback.current
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
    val visual = remember(colors, folds) { FoldingVisual(MarkdownVisual(colors), folds, colors.marker) }
    var layout by remember { mutableStateOf<TextLayoutResult?>(null) }
    val scroll = rememberScrollState()
    val baseSpec = LocalBringIntoViewSpec.current
    val anchor = remember(id, baseSpec) { FoldAnchor(scroll, baseSpec) }
    anchor.Effects()
    val imageHashes = remember(value.text) { NoteImage.hashes(value.text) }
    var viewing by remember { mutableStateOf<String?>(null) }

    fun post(text: String) {
        notesModule.edited(id, synced, text)
        synced = text
    }

    /**
     * A change made here; folds follow the text. `user`: typing, a command or dictation, which
     * is refused when it would change part of a folded section's hidden text (a selection
     * covering all of it is fine); not for undo/redo or the fold-aware edits of Enter,
     * Backspace and Delete next to a fold. `edits`: what it replaced, when known. The caret
     * never stays in hidden text.
     */
    fun set(v: TextFieldValue, record: Boolean = true, edits: List<TextEdit>? = null, user: Boolean = true) {
        if (v.text == value.text) { value = v; return }
        val known = edits ?: if (user) HeadingFolds.change(value.text, v.text) else null
        if (user && !folds.allows(known!!)) {
            haptics.performHapticFeedback(HapticFeedbackType.Reject)
            return
        }
        if (record) history.record(value)
        var f = folds.edited(v.text, local = true, known)
        if (user) f = f.revealing(v.sel())
        val sel = f.caret(v.sel(), v.sel())
        folds = f
        value = if (sel == v.sel()) v else v.copy(selection = sel.ui())
        post(v.text)
    }

    fun applyResult(r: EditResult?, user: Boolean = true) {
        r ?: return
        val text = r.apply(value.text)
        set(TextFieldValue(text, r.selection.ui()), edits = r.edits, user = user)
    }

    /**
     * Images picked, pasted or dropped: stored, then each on its own line where the selection
     * was when they came, or, if the text changed meanwhile, after the current selection.
     */
    fun insertImages(uris: List<Uri>) {
        val before = value.text
        val selection = value.sel()
        scope.launch {
            val hashes = withContext(Dispatchers.IO) { notesModule.addImages(uris.mapNotNull { NoteImageImport.read(context, it) }) }
            if (hashes.isEmpty()) { haptics.performHapticFeedback(HapticFeedbackType.Reject); return@launch }
            val at = if (value.text == before) selection else TextRange(value.selection.max, 0)
            applyResult(NoteImage.insertion(value.text, at, hashes))
        }
    }
    val pickImages = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { if (it.isNotEmpty()) insertImages(it) }
    val dropTarget = remember {
        object : DragAndDropTarget {
            override fun onDrop(event: DragAndDropEvent): Boolean {
                val e = event.toAndroidDragEvent()
                context.activity()?.requestDragAndDropPermissions(e)
                val uris = (0 until (e.clipData?.itemCount ?: 0)).mapNotNull { e.clipData.getItemAt(it).uri }
                if (uris.isNotEmpty()) insertImages(uris)
                return uris.isNotEmpty()
            }
        }
    }

    /** Folds or opens a heading's section; a selection in a section that folds goes to its heading's end. */
    fun toggleFold(lineStart: Int) {
        folds = folds.toggled(lineStart)
        val f = folds.folds.firstOrNull { it.lineStart == lineStart } ?: return
        if (value.selection.max > f.start && value.selection.min <= f.end) value = value.copy(selection = UiRange(f.start))
    }

    /** A tap on a heading's chevron or " ⋯": the heading stays where it is on screen. */
    fun toggleFoldInPlace(lineStart: Int) {
        anchor.toggling(layout?.size?.height ?: 0)
        toggleFold(lineStart)
    }

    LaunchedEffect(id) {
        notesModule.opened(id)
        if (value.text.isEmpty()) focus.requestFocus()
    }
    var micTarget by remember(id) { mutableStateOf<DictationTarget.Editor?>(null) }
    // a dictation this screen started that failed (no key, no microphone…) says why, for a while
    LaunchedEffect(dictation) { if (dictation is DictationState.Failed && micTarget != null) { delay(6_000); graph.dictation.dismiss() } }
    DisposableEffect(id) {
        onDispose {
            micTarget?.closed = true
            EditorFolds.leaving(id, folds)
            notesModule.closed(id)
        }
    }

    // text from elsewhere (another device, a widget, a captured thought): merged in like Google Docs.
    // What's been typed since the store had `before` goes on top; the module merges those
    // keystrokes the same way (when both touch the same text, the typing wins there too).
    fun mergeIn(body: String, before: String) {
        val local = value.text
        val merged = EditMerge.remote(local, before, body)
        synced = merged
        if (merged == local) return
        history.clear()
        // folds stay as they are (a captured thought arriving starts folded)
        val (f, sel) = folds.merged(merged, value.sel())
        folds = f
        value = TextFieldValue(merged, sel.ui())
    }
    LaunchedEffect(id) {
        // a change that landed before this started listening
        notesModule.notes.value.firstOrNull { it.id == id }?.let { if (it.body != synced) mergeIn(it.body, synced) }
        notesModule.remote.collect { (n, before) ->
            if (n.id != id) return@collect
            if (n.deleted || n.isTrashed) { nav.popBackStack(); return@collect }
            mergeIn(n.body, before)
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
                onUndo = { history.undo(value)?.let { set(it, record = false, user = false) } },
                onRedo = { history.redo(value)?.let { set(it, record = false, user = false) } },
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
                onIndent = { out -> applyResult(MarkdownCommands.indent(value.text, value.sel(), out)) },
                onFold = { folds.sectionAt(value.selection.start)?.let { toggleFold(it.lineStart) } },
                onPickImages = { pickImages.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                onPasteImages = ::insertImages,
                onMic = {
                    if (dictation is DictationState.Listening) graph.dictation.stop()
                    else DictationTarget.Editor({ spoken ->
                        val v = value
                        val before = v.text.substring(0, v.selection.min)
                        val ins = TextInserter.spaced(spoken, before, v.text.substring(v.selection.max))
                        set(TextFieldValue(before + ins + v.text.substring(v.selection.max), UiRange(before.length + ins.length)))
                    }, FieldContext(appLabel = "Bento Notes", hint = "A note in Markdown", textBefore = value.text.substring(0, value.selection.min)))
                        .also { micTarget = it }.let { graph.dictation.start(it, handsFree = true) }
                },
                onHideKeyboard = { keyboard?.hide(); focusManager.clearFocus() },
                status = when (val d = dictation) {
                    is DictationState.Listening -> d.partial.ifBlank { "Listening…" }
                    is DictationState.Processing -> "Transcribing…"
                    is DictationState.Failed -> d.message.takeIf { micTarget != null }
                    else -> null
                },
            )
        },
    ) { padding ->
        CompositionLocalProvider(LocalBringIntoViewSpec provides anchor) {
            Column(Modifier.fillMaxSize().padding(padding).verticalScroll(scroll)
                       .dragAndDropTarget(shouldStartDragAndDrop = { e -> e.mimeTypes().any { it.startsWith("image/") } }, target = dropTarget)) {
                if (imageHashes.isNotEmpty()) {
                    NoteImageStrip(imageHashes, notesModule.images, onOpen = { viewing = it }, Modifier.padding(start = FoldGutter, end = 20.dp, top = 8.dp))
                }
                Box {
                    BasicTextField(
                        value = value,
                        onValueChange = { new ->
                            if (new.text == value.text) {
                                // a tap or caret move: never into a folded section's hidden text
                                val sel = folds.caret(new.sel(), value.sel())
                                handleChange(value, if (sel == new.sel()) new else new.copy(selection = sel.ui()), { v, r -> set(v, r) }, { applyResult(it) })
                                return@BasicTextField
                            }
                            // Enter, Backspace and Delete next to a folded section have their own edits, which
                            // keep it folded and leave its hidden text alone (or are refused)
                            val r = folds.keyboard(value.sel(), new.text, new.sel())
                            when {
                                r == null -> handleChange(value, new, { v, rec -> set(v, rec) }, { applyResult(it) })
                                r.edits.isEmpty() -> haptics.performHapticFeedback(HapticFeedbackType.Reject)
                                else -> applyResult(r, user = false)
                            }
                        },
                        modifier = Modifier.fillMaxWidth().padding(start = FoldGutter, end = 20.dp, top = 8.dp, bottom = 8.dp).focusRequester(focus)
                            .onPreviewKeyEvent { e ->
                                // → at a folded heading's end steps over the fold
                                if (e.type != KeyEventType.KeyDown || e.key != Key.DirectionRight || !value.selection.collapsed) return@onPreviewKeyEvent false
                                val at = value.selection.start
                                val sel = folds.caret(TextRange(at + 1, 0), TextRange(at, 0))
                                if (sel.location == at + 1) return@onPreviewKeyEvent false
                                value = value.copy(selection = sel.ui())
                                true
                            },
                        readOnly = note == null, // not on this phone (yet): typing would have nowhere to go
                        textStyle = MaterialTheme.typography.bodyLarge.copy(color = MaterialTheme.colorScheme.onSurface),
                        cursorBrush = SolidColor(MaterialTheme.colorScheme.primary),
                        visualTransformation = visual,
                        onTextLayout = { layout = it },
                        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                        decorationBox = { inner ->
                            Box {
                                if (value.text.isEmpty()) Text("Start typing…", style = MaterialTheme.typography.bodyLarge,
                                                               color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f))
                                inner()
                            }
                        },
                    )
                    // fold chevrons beside the headings, and the " ⋯" of folded ones, over the text
                    FoldControls(folds, layout, textStart = FoldGutter, textTop = 8.dp, color = MaterialTheme.colorScheme.onSurfaceVariant, onToggle = ::toggleFoldInPlace)
                }
                Spacer(Modifier.height(with(LocalDensity.current) { anchor.tail.toDp() }))
            }
        }
    }

    viewing?.let { hash ->
        NoteImageViewer(hash, notesModule.images, onDismiss = { viewing = null }, onRemove = {
            viewing = null
            NoteImage.removal(value.text, hash)?.let { applyResult(it) }
        })
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
    onInline: (InlineFormat) -> Unit, onLink: () -> Unit, onIndent: (Boolean) -> Unit, onFold: () -> Unit,
    onPickImages: () -> Unit, onPasteImages: (List<Uri>) -> Unit, onMic: () -> Unit, onHideKeyboard: () -> Unit, status: String?,
) {
    Surface(tonalElevation = 2.dp, modifier = Modifier.imePadding()) {
        Column(Modifier.navigationBarsPadding()) {
            if (status != null) {
                LiveTranscript(status, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), maxHeight = 72.dp,
                               style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(Modifier.fillMaxWidth()) {
                Row(Modifier.weight(1f).horizontalScroll(rememberScrollState())) {
                    ToolButton(Icons.Rounded.CheckBox, "Checklist", onClick = onTask)
                    ToolButton(Icons.AutoMirrored.Rounded.FormatListBulleted, "Bulleted list", onClick = onBullet)
                    ToolButton(Icons.Rounded.Title, "Heading", onClick = onHeading)
                    ImageToolButton(onPickImages, onPasteImages)
                    ToolButton(Icons.Rounded.FormatBold, "Bold") { onInline(InlineFormat.Bold) }
                    ToolButton(Icons.Rounded.FormatItalic, "Italic") { onInline(InlineFormat.Italic) }
                    ToolButton(Icons.Rounded.FormatStrikethrough, "Strikethrough") { onInline(InlineFormat.Strike) }
                    ToolButton(Icons.Rounded.Code, "Code") { onInline(InlineFormat.Code) }
                    ToolButton(Icons.Rounded.Link, "Link", onClick = onLink)
                    ToolButton(Icons.AutoMirrored.Rounded.FormatIndentIncrease, "Indent") { onIndent(false) }
                    ToolButton(Icons.AutoMirrored.Rounded.FormatIndentDecrease, "Outdent") { onIndent(true) }
                    ToolButton(Icons.Rounded.UnfoldLess, "Fold or unfold this section", onClick = onFold)
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
