package com.charles.bento.core.voice.format

/**
 * What smart transcription took out: the words that were said (the last interim
 * hypothesis) split into kept and cut runs, aligned against the cleaned final text.
 * For the "sentence visibly becomes the polished one" animation.
 */
object TranscriptDiff {
    data class Segment(val text: String, val isCut: Boolean)

    /**
     * Splits `verbatim` into kept and cut runs, aligned against `cleaned`. Returns a
     * single kept segment when there is nothing useful to show (no overlap at all, or
     * an empty side): a diff marking the whole sentence as removed is a bug, not an insight.
     */
    fun segments(verbatim: String, cleaned: String): List<Segment> {
        val said = tokenize(verbatim)
        val kept = tokenize(cleaned)
        if (said.isEmpty() || kept.isEmpty()) {
            return if (verbatim.isEmpty()) emptyList() else listOf(Segment(verbatim, false))
        }
        val flags = matchFlags(said, kept)
        if (!flags.contains(true)) return listOf(Segment(verbatim, false))

        // Coalesce adjacent tokens of the same kind so the UI animates a few runs.
        val segments = ArrayList<Segment>()
        val current = StringBuilder()
        var currentIsCut = !flags[0]
        for ((index, token) in said.withIndex()) {
            val isCut = !flags[index]
            if (isCut == currentIsCut) {
                current.append(token.raw)
            } else {
                if (current.isNotEmpty()) segments.add(Segment(current.toString(), currentIsCut))
                current.setLength(0)
                current.append(token.raw)
                currentIsCut = isCut
            }
        }
        if (current.isNotEmpty()) segments.add(Segment(current.toString(), currentIsCut))
        return segments
    }

    /** A word plus the whitespace after it (so joining raws reproduces the input), and its comparison key. */
    internal data class Token(val raw: String, val key: String)

    internal fun tokenize(text: String): List<Token> {
        val tokens = ArrayList<Token>()
        val word = StringBuilder()
        val trailing = StringBuilder()
        var i = 0
        while (i < text.length) {
            val cp = text.codePointAt(i)
            i += Character.charCount(cp)
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                trailing.appendCodePoint(cp)
                continue
            }
            if (trailing.isNotEmpty()) {
                if (word.isNotEmpty()) {
                    tokens.add(Token(word.toString() + trailing, normalize(word.toString())))
                    word.setLength(0)
                } else if (tokens.isNotEmpty()) {
                    val last = tokens.removeAt(tokens.size - 1)
                    tokens.add(Token(last.raw + trailing, last.key))
                } else {
                    // Leading whitespace: carried by the first word's token below.
                    word.append(trailing)
                    trailing.setLength(0)
                    word.appendCodePoint(cp)
                    continue
                }
                trailing.setLength(0)
            }
            word.appendCodePoint(cp)
        }
        if (word.isNotEmpty() || trailing.isNotEmpty()) {
            tokens.add(Token(word.toString() + trailing, normalize(word.toString())))
        }
        return tokens.filter { it.raw.isNotEmpty() }
    }

    internal fun normalize(word: String): String {
        val sb = StringBuilder()
        // Letters and numbers only: smart mode adds punctuation and capitals, which must not read as edits.
        word.lowercase().codePoints().forEach { if (ValidationGate.isAlphanumeric(it) && !isMark(it)) sb.appendCodePoint(it) }
        return sb.toString()
    }

    private fun isMark(cp: Int): Boolean = when (Character.getType(cp).toByte()) {
        Character.NON_SPACING_MARK, Character.ENCLOSING_MARK, Character.COMBINING_SPACING_MARK -> true
        else -> false
    }

    /**
     * Longest common subsequence over the normalized keys: every said token on the LCS
     * is kept, everything else was removed. Order matters ("meet at 1pm, no, 2pm").
     */
    internal fun matchFlags(said: List<Token>, kept: List<Token>): BooleanArray {
        val n = said.size
        val m = kept.size
        val table = Array(n + 1) { IntArray(m + 1) }
        for (i in n - 1 downTo 0) {
            for (j in m - 1 downTo 0) {
                table[i][j] = if (said[i].key == kept[j].key && said[i].key.isNotEmpty()) {
                    table[i + 1][j + 1] + 1
                } else {
                    maxOf(table[i + 1][j], table[i][j + 1])
                }
            }
        }
        val flags = BooleanArray(n)
        var i = 0
        var j = 0
        while (i < n && j < m) {
            if (said[i].key == kept[j].key && said[i].key.isNotEmpty()) {
                flags[i] = true
                i++; j++
            } else if (table[i + 1][j] >= table[i][j + 1]) {
                i++
            } else {
                j++
            }
        }
        return flags
    }
}

private fun BooleanArray.contains(value: Boolean): Boolean = any { it == value }
