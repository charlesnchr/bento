package com.charles.bento.notes

import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import com.charles.bento.core.notes.NoteImage
import java.io.ByteArrayOutputStream

/** Images picked, pasted or dropped into a note, as bytes the sync server takes. */
object NoteImageImport {
    /**
     * The image at `uri`, kept as it is when the server takes it (PNG, JPEG, GIF, WebP, HEIC
     * up to 10 MB and 4096 px), otherwise decoded, scaled down and re-encoded (PNG when it
     * has transparency, else JPEG). Null when it can't be read. Blocking: call off the main thread.
     */
    fun read(context: Context, uri: Uri): ByteArray? = runCatching {
        val raw = context.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return null
        if (NoteImage.mimeType(raw) != null && raw.size <= NoteImage.MAX_BYTES) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(raw, 0, raw.size, bounds)
            // 0: not measurable here (some HEIC), kept as it is
            if (maxOf(bounds.outWidth, bounds.outHeight) <= NoteImage.MAX_PIXELS) return raw
        }
        for (side in intArrayOf(NoteImage.MAX_PIXELS, 2048, 1024)) {
            val bitmap = ImageDecoder.decodeBitmap(ImageDecoder.createSource(java.nio.ByteBuffer.wrap(raw))) { decoder, info, _ ->
                val longest = maxOf(info.size.width, info.size.height)
                if (longest > side) decoder.setTargetSize(info.size.width * side / longest, info.size.height * side / longest)
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }
            val out = ByteArrayOutputStream()
            if (bitmap.hasAlpha()) bitmap.compress(Bitmap.CompressFormat.PNG, 100, out) else bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
            bitmap.recycle()
            if (out.size() <= NoteImage.MAX_BYTES) return out.toByteArray()
        }
        null
    }.getOrNull()

    /** Image URIs on the clipboard (a copied picture), empty when there are none. */
    fun clipboardImages(context: Context): List<Uri> {
        val clip = context.getSystemService(ClipboardManager::class.java)?.primaryClip ?: return emptyList()
        val desc = clip.description
        val images = (0 until desc.mimeTypeCount).any { desc.getMimeType(it).startsWith("image/") }
        if (!images) return emptyList()
        return (0 until clip.itemCount).mapNotNull { clip.getItemAt(it).uri }
    }
}
