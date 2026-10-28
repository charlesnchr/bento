package com.charles.bento.ui

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The words heard so far while dictating: grows with the text up to [maxHeight], then
 * scrolls, staying on the latest words. Nothing is cut off; drag up to reread the start.
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
    // follow the end as it grows (maxValue changes after layout), unless a finger is on it
    LaunchedEffect(scroll) {
        snapshotFlow { scroll.maxValue }.collect { end -> if (!scroll.isScrollInProgress) scroll.scrollTo(end) }
    }
    Text(
        text, style = style, color = color, textAlign = textAlign,
        modifier = modifier.fillMaxWidth().heightIn(max = maxHeight).verticalScroll(scroll),
    )
}
