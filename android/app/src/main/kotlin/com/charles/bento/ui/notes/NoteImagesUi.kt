package com.charles.bento.ui.notes

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.BitmapFactory
import android.net.Uri
import android.util.LruCache
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Image
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import com.charles.bento.core.notes.NoteImageSync
import com.charles.bento.notes.NoteImageImport
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Decoded note images by hash and size, shared by the strip and the viewer. */
private val decoded = object : LruCache<String, ImageBitmap>(48 * 1024 * 1024) {
    override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
}

/** Decodes a stored image at most about `maxPx` on its longest side. */
private fun decode(sync: NoteImageSync, hash: String, maxPx: Int): ImageBitmap? {
    val file = sync.store.path(hash) ?: return null
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(file.path, bounds)
    var sample = 1
    while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxPx) sample *= 2
    return BitmapFactory.decodeFile(file.path, BitmapFactory.Options().apply { inSampleSize = sample })?.asImageBitmap()
}

/** A note image, fetched from the server when it isn't here (null until then). */
@Composable
fun rememberNoteImage(sync: NoteImageSync, hash: String, maxPx: Int): ImageBitmap? {
    val key = "$hash@$maxPx"
    var image by remember(key) { mutableStateOf(decoded.get(key)) }
    var version by remember(hash) { mutableIntStateOf(0) }
    LaunchedEffect(hash) { sync.changed.collect { if (it == hash) version++ } }
    LaunchedEffect(key, version) {
        if (image != null) return@LaunchedEffect
        image = withContext(Dispatchers.IO) { decode(sync, hash, maxPx) }?.also { decoded.put(key, it) }
        if (image == null) sync.fetch(hash)
    }
    return image
}

/**
 * The note's images above its text, like Google Keep: one fills the width, several scroll
 * sideways. A tap opens one.
 */
@Composable
fun NoteImageStrip(hashes: List<String>, sync: NoteImageSync, onOpen: (String) -> Unit, modifier: Modifier = Modifier) {
    if (hashes.size == 1) {
        NoteImageTile(hashes[0], sync, onOpen, Modifier.fillMaxWidth().heightIn(max = 300.dp), single = true, modifier = modifier)
        return
    }
    LazyRow(modifier, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        items(hashes, key = { it }) { h -> NoteImageTile(h, sync, onOpen, Modifier.height(160.dp), single = false) }
    }
}

@Composable
private fun NoteImageTile(hash: String, sync: NoteImageSync, onOpen: (String) -> Unit, size: Modifier, single: Boolean, modifier: Modifier = Modifier) {
    val image = rememberNoteImage(sync, hash, 1080)
    val shape = RoundedCornerShape(10.dp)
    Box(modifier.clip(shape).clickable { onOpen(hash) }) {
        if (image != null) {
            val aspect = image.width.toFloat() / image.height.coerceAtLeast(1)
            val shaped = if (single) size else size.width((160 * aspect).coerceIn(80f, 320f).dp)
            Image(image, contentDescription = "Image", modifier = shaped, contentScale = if (single) ContentScale.FillWidth else ContentScale.Crop,
                  alignment = Alignment.TopStart)
        } else {
            Box(size.then(if (single) Modifier.height(96.dp) else Modifier.width(160.dp)).background(MaterialTheme.colorScheme.surfaceVariant),
                contentAlignment = Alignment.Center) {
                Text(if (sync.isLoading(hash)) "Loading image…" else "Image not available",
                     style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** One image full screen, with Remove (takes its line out of the note). */
@Composable
fun NoteImageViewer(hash: String, sync: NoteImageSync, onDismiss: () -> Unit, onRemove: () -> Unit) {
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black).clickable(onClick = onDismiss)) {
            val image = rememberNoteImage(sync, hash, 2048)
            if (image != null) {
                Image(image, contentDescription = "Image", modifier = Modifier.fillMaxSize(), contentScale = ContentScale.Fit)
            } else {
                Text(if (sync.isLoading(hash)) "Loading image…" else "Image not available", color = Color.White, modifier = Modifier.align(Alignment.Center))
            }
            Row(Modifier.fillMaxWidth().statusBarsPadding().padding(8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                IconButton(onClick = onDismiss) { Icon(Icons.Rounded.Close, "Close", tint = Color.White) }
                IconButton(onClick = onRemove) { Icon(Icons.Rounded.Delete, "Remove from note", tint = Color.White) }
            }
        }
    }
}

/** The toolbar's image button: choose photos, or paste a copied image. */
@Composable
fun ImageToolButton(onPick: () -> Unit, onPaste: (List<Uri>) -> Unit) {
    val context = LocalContext.current
    var open by remember { mutableStateOf(false) }
    var clipboard by remember { mutableStateOf(emptyList<Uri>()) }
    Box {
        IconButton(onClick = { clipboard = NoteImageImport.clipboardImages(context); open = true }) { Icon(Icons.Rounded.Image, "Insert image") }
        DropdownMenu(open, onDismissRequest = { open = false }) {
            DropdownMenuItem(text = { Text("Choose photos") }, onClick = { open = false; onPick() })
            DropdownMenuItem(text = { Text("Paste image") }, enabled = clipboard.isNotEmpty(), onClick = { open = false; onPaste(clipboard) })
        }
    }
}

/** The activity behind a Compose context (drag and drop asks it for permission to read the dropped items). */
tailrec fun Context.activity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.activity()
    else -> null
}
