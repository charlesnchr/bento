package com.charles.bento.ui.assistant

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.charles.bento.core.assistant.ChatMarkdown
import com.charles.bento.core.assistant.ChatMarkdown.Block
import com.charles.bento.core.assistant.ChatMarkdown.Style
import com.charles.bento.core.notes.InlineKind
import com.charles.bento.ui.theme.LocalBentoColors
import com.charles.bento.ui.theme.SansCode

/** A reply's Markdown, drawn as text: headings, lists, quotes, code blocks, emphasis and tappable links. */
@Composable
fun ChatMarkdownText(markdown: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onSurface) {
    val blocks = remember(markdown) { ChatMarkdown.parse(markdown) }
    val bento = LocalBentoColors.current
    val accent = MaterialTheme.colorScheme.primary
    val base = MaterialTheme.typography.bodyLarge.copy(color = color)
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        for (b in blocks) when (b) {
            Block.Gap -> Spacer(Modifier.height(6.dp))
            Block.Rule -> HorizontalDivider(Modifier.padding(vertical = 8.dp))
            is Block.Code -> Surface(shape = RoundedCornerShape(10.dp), color = bento.codeBackground, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                Text(
                    b.text, style = base.copy(fontFamily = SansCode, fontSize = 13.sp, lineHeight = 18.sp),
                    softWrap = false, modifier = Modifier.horizontalScroll(rememberScrollState()).padding(12.dp),
                )
            }
            is Block.Text -> {
                val text = styled(b, accent, bento.codeBackground)
                when (val s = b.style) {
                    is Style.Heading -> Text(text, style = base.copy(
                        fontSize = when (s.level) { 1 -> 22.sp; 2 -> 19.sp; else -> 17.sp },
                        lineHeight = when (s.level) { 1 -> 28.sp; 2 -> 25.sp; else -> 23.sp },
                        fontWeight = FontWeight.SemiBold,
                    ), modifier = Modifier.padding(top = 6.dp))
                    is Style.Item -> Row(Modifier.padding(start = (s.level * 16).dp)) {
                        Text(s.marker, style = base.copy(color = if (s.checked == true) accent else bento.marker), modifier = Modifier.width(22.dp))
                        Text(text, style = if (s.checked == true) base.copy(textDecoration = TextDecoration.LineThrough, color = bento.marker) else base)
                    }
                    is Style.Quote -> Row {
                        Box(Modifier.width(3.dp).height(22.dp).background(bento.marker, RoundedCornerShape(2.dp)))
                        Spacer(Modifier.width(10.dp))
                        Text(text, style = base.copy(fontStyle = FontStyle.Italic, color = MaterialTheme.colorScheme.onSurfaceVariant))
                    }
                    Style.Paragraph -> Text(text, style = base)
                }
            }
        }
    }
}

private fun styled(b: Block.Text, accent: Color, code: Color): AnnotatedString = buildAnnotatedString {
    append(b.text)
    for (s in b.spans) {
        val a = s.start.coerceIn(0, b.text.length)
        val e = s.end.coerceIn(a, b.text.length)
        if (e <= a) continue
        when (val k = s.kind) {
            InlineKind.Bold -> addStyle(SpanStyle(fontWeight = FontWeight.Bold), a, e)
            InlineKind.Italic -> addStyle(SpanStyle(fontStyle = FontStyle.Italic), a, e)
            InlineKind.BoldItalic -> addStyle(SpanStyle(fontWeight = FontWeight.Bold, fontStyle = FontStyle.Italic), a, e)
            InlineKind.Strike -> addStyle(SpanStyle(textDecoration = TextDecoration.LineThrough), a, e)
            InlineKind.Underline -> addStyle(SpanStyle(textDecoration = TextDecoration.Underline), a, e)
            InlineKind.Code -> addStyle(SpanStyle(fontFamily = SansCode, background = code, fontSize = 14.sp), a, e)
            is InlineKind.Link -> link(k.url, a, e, accent)
            is InlineKind.Autolink -> link(k.url, a, e, accent)
        }
    }
}

private fun AnnotatedString.Builder.link(url: String, start: Int, end: Int, accent: Color) {
    val target = if ("://" in url || url.startsWith("mailto:")) url else "https://$url"
    if (!target.startsWith("https://") && !target.startsWith("http://") && !target.startsWith("mailto:")) return
    addLink(LinkAnnotation.Url(target, TextLinkStyles(SpanStyle(color = accent, textDecoration = TextDecoration.Underline))), start, end)
}
