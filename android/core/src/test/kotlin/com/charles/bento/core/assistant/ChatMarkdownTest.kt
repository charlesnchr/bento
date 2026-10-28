package com.charles.bento.core.assistant

import com.charles.bento.core.assistant.ChatMarkdown.Block
import com.charles.bento.core.assistant.ChatMarkdown.Style
import com.charles.bento.core.notes.InlineKind
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChatMarkdownTest {
    private fun text(b: Block) = (b as Block.Text)

    @Test fun inlineMarkersGoAndSpansFollow() {
        val b = text(ChatMarkdown.parse("Done: I used **the tool** and `code`.").single())
        assertEquals("Done: I used the tool and code.", b.text)
        val bold = b.spans.single { it.kind == InlineKind.Bold }
        assertEquals("the tool", b.text.substring(bold.start, bold.end))
        val code = b.spans.single { it.kind == InlineKind.Code }
        assertEquals("code", b.text.substring(code.start, code.end))
    }

    @Test fun linksKeepTheirTextAndUrl() {
        val b = text(ChatMarkdown.parse("See [Bento](https://github.com/charlesnchr/bento).").single())
        assertEquals("See Bento.", b.text)
        val link = b.spans.single()
        assertEquals(InlineKind.Link("https://github.com/charlesnchr/bento"), link.kind)
        assertEquals("Bento", b.text.substring(link.start, link.end))
    }

    @Test fun blocks() {
        val blocks = ChatMarkdown.parse("# Title\n\n- one\n  - two\n1. first\n- [x] done\n> quoted\n\n---\n```kotlin\nval x = 1\n\nval y = 2\n```\nafter")
        assertEquals(Style.Heading(1), text(blocks[0]).style)
        assertEquals("Title", text(blocks[0]).text)
        assertEquals(Block.Gap, blocks[1])
        assertEquals(Style.Item("•", 0), text(blocks[2]).style)
        assertEquals(Style.Item("•", 1), text(blocks[3]).style)
        assertEquals("two", text(blocks[3]).text)
        assertEquals(Style.Item("1.", 0), text(blocks[4]).style)
        assertEquals(Style.Item("☑", 0, true), text(blocks[5]).style)
        assertEquals(Style.Quote(1), text(blocks[6]).style)
        assertTrue(Block.Rule in blocks)
        assertEquals(Block.Code("kotlin", "val x = 1\n\nval y = 2"), blocks.single { it is Block.Code })
        assertEquals("after", text(blocks.last()).text)
    }

    @Test fun anUnclosedFenceStreamsAsCode() {
        assertEquals(listOf(Block.Text("Here:", emptyList()), Block.Code("", "partial")), ChatMarkdown.parse("Here:\n```\npartial"))
    }

    @Test fun nothingToShow() {
        assertEquals(emptyList(), ChatMarkdown.parse("\n\n"))
        assertEquals("Leading", text(ChatMarkdown.parse("\n\nLeading\n\n\n").single()).text)
    }
}
