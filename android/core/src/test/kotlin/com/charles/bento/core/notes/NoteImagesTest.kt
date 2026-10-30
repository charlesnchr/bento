package com.charles.bento.core.notes

import com.charles.bento.core.sync.SyncEndpoint
import com.charles.bento.core.sync.TestServer
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import org.junit.jupiter.api.Assumptions.assumeTrue
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class NoteImagesTest {
    private val a = "a".repeat(64)
    private val b = "0123456789abcdef".repeat(4)
    private val dirs = mutableListOf<File>()

    private fun tempDir() = kotlin.io.path.createTempDirectory("bento-images").toFile().also(dirs::add)

    @AfterTest fun cleanUp() { dirs.forEach { it.deleteRecursively() } }

    /** A tiny PNG-looking blob (the server only sniffs the signature). */
    private fun png(tag: String) = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) + tag.toByteArray()

    @Test fun imageLines() {
        assertEquals(a, NoteImage.hash("![](bento-image:$a)"))
        assertEquals(b, NoteImage.hash("  ![a cat](bento-image:$b) \t"))
        assertEquals("![](bento-image:$a)", NoteImage.markdown(a))
        assertNull(NoteImage.hash("x ![](bento-image:$a)"))
        assertNull(NoteImage.hash("![](bento-image:$a) x"))
        assertNull(NoteImage.hash("- ![](bento-image:$a)"))
        assertNull(NoteImage.hash("![](bento-image:${a.uppercase()})"))
        assertNull(NoteImage.hash("![](bento-image:${a.dropLast(1)})"))
        assertNull(NoteImage.hash("![a]b](bento-image:$a)"))
        val body = "# T\n${NoteImage.markdown(a)}\ntext\n${NoteImage.markdown(b)}\n${NoteImage.markdown(a)}"
        assertEquals(listOf(a, b), NoteImage.hashes(body))
        assertEquals(emptyList(), NoteImage.hashes("no images"))
        // in a code block it's text
        val fenced = "```\n${NoteImage.markdown(a)}\n```\n${NoteImage.markdown(b)}"
        assertEquals(listOf(b), NoteImage.hashes(fenced))
        assertNull(NoteImage.removal(fenced, a))
    }

    @Test fun insertingAndRemoving() {
        val img = NoteImage.markdown(a)
        val img2 = NoteImage.markdown(b)
        fun insert(text: String, sel: TextRange, hashes: List<String>): Pair<String, Int> =
            NoteImage.insertion(text, sel, hashes).let { it.apply(text) to it.selection.location }
        assertEquals("$img\n" to img.length + 1, insert("", TextRange(0, 0), listOf(a)))
        assertEquals("abc\n$img\n" to 4 + img.length + 1, insert("abc", TextRange(3, 0), listOf(a)))
        val (t, c) = insert("abc\ndef", TextRange(4, 0), listOf(a, b))
        assertEquals("abc\n$img\n$img2\ndef", t)
        assertEquals(t.length - 3, c)
        assertEquals("ab\n$img\ncd", insert("abXYcd", TextRange(2, 2), listOf(a)).first)

        fun remove(text: String, hash: String) = NoteImage.removal(text, hash)?.apply(text)
        assertEquals("abc\ndef", remove("abc\n$img\ndef", a))
        assertEquals("abc\ndef", remove("abc\n$img\ndef\n$img", a))
        assertEquals("abc\n$img2", remove("abc\n$img\n$img2", a))
        assertEquals("", remove(img, a))
        assertNull(remove("abc", a))
        assertNull(remove("x $img", a))
    }

    @Test fun aConflictedCopyKeepsImageOnlyText() {
        val img = NoteImage.markdown(a)
        assertEquals("Untitled (conflicted copy, Pixel)\n$img", NoteText.conflictCopyBody(img, "Pixel"))
        assertEquals("Untitled (conflicted copy)\n\n$img\n", NoteText.conflictCopyBody("\n$img\n", ""))
        assertEquals("Hi (conflicted copy, Pixel)\n$img", NoteText.conflictCopyBody("Hi\n$img", "Pixel"))
        assertNull(NoteText.conflictCopyBody("  \n", "Pixel"))
    }

    @Test fun titlesAndCountsSkipImages() {
        val body = "${NoteImage.markdown(a)}\n# Trip\nsome words"
        assertEquals("Trip", NoteText.title(body))
        assertEquals("", NoteText.title(NoteImage.markdown(a)))
        assertEquals(3, NoteText.wordCount(body))
    }

    @Test fun formats() {
        assertEquals("image/png", NoteImage.mimeType(png("x")))
        assertEquals("image/jpeg", NoteImage.mimeType(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0)))
        assertEquals("image/gif", NoteImage.mimeType("GIF89a...".toByteArray()))
        assertEquals("image/webp", NoteImage.mimeType("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray()))
        assertEquals("image/heic", NoteImage.mimeType("\u0000\u0000\u0000\u0018ftypheic".toByteArray()))
        assertNull(NoteImage.mimeType("<html>".toByteArray()))
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", NoteImage.sha256("abc".toByteArray()))
    }

    @Test fun storeKeepsImagesAndTheirUploads() {
        val store = NoteImageStore(tempDir())
        val bytes = png("one")
        val hash = store.add(bytes)!!
        assertEquals(NoteImage.sha256(bytes), hash)
        assertTrue(store.has(hash))
        assertContentEquals(bytes, store.data(hash))
        assertEquals(listOf(hash), store.pendingUploads)
        store.uploaded(hash)
        assertEquals(emptyList(), store.pendingUploads)
        val other = png("two")
        assertFalse(store.store(other, hash))
        assertTrue(store.store(other, NoteImage.sha256(other)))
        assertEquals(emptyList(), store.pendingUploads)
        assertNull(store.add("not an image".toByteArray()))
    }

    @Test fun imagesTravelThroughTheServer() = runBlocking {
        val binary = File("../../server/target/release/bento-sync").absoluteFile
        assumeTrue(binary.canExecute(), "bento-sync not built (cd server && cargo build --release)")
        val token = "test-token-0123456789"
        val server = TestServer(binary, token).also { it.start() }
        val scope = CoroutineScope(SupervisorJob())
        try {
            val http = OkHttpClient()
            val endpoint = { SyncEndpoint("http://127.0.0.1:${server.port}", token) }
            val phone = NoteImageSync(NoteImageStore(tempDir()), http, endpoint, scope)
            val mac = NoteImageSync(NoteImageStore(tempDir()), http, endpoint, scope)
            val bytes = png("photo")
            val hash = phone.store.add(bytes)!!

            // not uploaded yet: the other device gets a 404 and shows a placeholder
            assertFalse(mac.fetchNow(hash))
            assertFalse(mac.isLoading(hash))
            assertTrue(phone.uploadPendingNow())
            assertEquals(emptyList(), phone.store.pendingUploads)
            assertTrue(mac.fetchNow(hash))
            assertContentEquals(bytes, mac.store.data(hash))

            // a wrong token keeps it pending
            val other = NoteImageSync(NoteImageStore(tempDir()), http, { SyncEndpoint("http://127.0.0.1:${server.port}", "wrong-token-0123456789") }, scope)
            val h2 = other.store.add(png("other"))!!
            assertFalse(other.uploadPendingNow())
            assertEquals(listOf(h2), other.store.pendingUploads)
            // not paired: nothing happens
            val unpaired = NoteImageSync(NoteImageStore(tempDir()), http, { null }, scope)
            unpaired.store.add(png("x"))
            assertTrue(unpaired.uploadPendingNow(), "nowhere to send it: nothing to retry")
            assertEquals(1, unpaired.store.pendingUploads.size)
            assertFalse(unpaired.fetchNow(hash))
        } finally {
            scope.cancel()
            server.stop()
        }
    }
}
