package com.charles.bento.ui

import androidx.compose.foundation.gestures.ScrollableState
import androidx.compose.foundation.interaction.DragInteraction
import androidx.compose.foundation.interaction.InteractionSource
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.isSpecified
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * The words heard so far while dictating: grows with the text up to [maxHeight], then
 * scrolls, staying on the latest words. Nothing is cut off; drag up to reread the start
 * (it stays there until dragged back to the end).
 */
@Composable
fun LiveTranscript(
    text: String,
    modifier: Modifier = Modifier,
    maxHeight: Dp = 220.dp,
    style: TextStyle = LocalTextStyle.current,
    color: Color = Color.Unspecified,
    textAlign: TextAlign? = null,
) {
    val scroll = rememberScrollState()
    FollowEnd(scroll, scroll.interactionSource, atEnd = { scroll.value >= scroll.maxValue - 1 }, toEnd = { scroll.scrollTo(scroll.maxValue) }, grows = { scroll.maxValue })
    Text(
        text, style = style, color = color, textAlign = textAlign,
        modifier = modifier.fillMaxWidth().heightIn(max = maxHeight).verticalScroll(scroll),
    )
}

/**
 * Keeps a scrolling view on its end as content arrives, until the user drags away from it;
 * following resumes when a drag (and its fling) ends back at the end. Only drags count, not
 * this function's own scrolling. [grows] changes whenever there's more to show.
 */
@Composable
fun FollowEnd(scroll: ScrollableState, interactions: InteractionSource, atEnd: () -> Boolean, toEnd: suspend () -> Unit, grows: () -> Any?) {
    var follow by remember { mutableStateOf(true) }
    LaunchedEffect(scroll) {
        launch {
            interactions.interactions.collect { i ->
                when (i) {
                    is DragInteraction.Start -> follow = false
                    is DragInteraction.Stop, is DragInteraction.Cancel -> {
                        snapshotFlow { scroll.isScrollInProgress }.first { !it } // the fling, if any
                        follow = atEnd()
                    }
                }
            }
        }
        snapshotFlow { grows() }.collect { if (follow) toEnd() }
    }
}

/** The height of [lines] lines of [style], so a fixed viewport shows whole lines at any font scale. */
@Composable
fun linesHeight(style: TextStyle, lines: Int): Dp = with(LocalDensity.current) {
    val line = if (style.lineHeight.isSpecified) style.lineHeight else style.fontSize * 1.25f
    (line * lines).toDp()
}
