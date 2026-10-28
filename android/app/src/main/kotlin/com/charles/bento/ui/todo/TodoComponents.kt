package com.charles.bento.ui.todo

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Event
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.charles.bento.core.fielddoc.FieldDoc
import com.charles.bento.core.todo.QuickAddResult
import com.charles.bento.core.todo.TodoColor
import com.charles.bento.core.todo.TodoDates
import com.charles.bento.core.todo.TodoStyle
import com.charles.bento.core.todo.due
import com.charles.bento.core.todo.isCompleted
import com.charles.bento.core.todo.labels
import com.charles.bento.core.todo.notes
import com.charles.bento.core.todo.priority
import com.charles.bento.core.todo.title

fun TodoColor.compose() = Color(argb)

/** Todoist's round checkbox: tinted and filled by priority, a tick when done. */
@Composable
fun PriorityCircle(priority: Int, completed: Boolean, onToggle: () -> Unit, modifier: Modifier = Modifier) {
    val color = TodoStyle.priority(priority)?.compose() ?: MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
    val scale by animateFloatAsState(if (completed) 1.08f else 1f, label = "check")
    Box(
        modifier.size(40.dp).clip(CircleShape).clickable(onClick = onToggle),
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier.size(22.dp).scale(scale).clip(CircleShape)
                .background(if (completed) color else color.copy(alpha = if (priority < 4) 0.12f else 0f))
                .border(1.6.dp, color, CircleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (completed) Icon(Icons.Rounded.Check, "Completed", tint = Color.White, modifier = Modifier.size(15.dp))
        }
    }
}

@Composable
fun TaskRow(
    task: FieldDoc,
    dates: TodoDates,
    projectLabel: Pair<String, Color>?,
    onToggle: () -> Unit,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val done = task.isCompleted
    Row(
        modifier.fillMaxWidth().clickable(onClick = onOpen).padding(start = 8.dp, end = 16.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.Top,
    ) {
        PriorityCircle(task.priority, done, onToggle)
        Column(Modifier.weight(1f).padding(top = 9.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(
                task.title, style = MaterialTheme.typography.bodyLarge,
                color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                textDecoration = if (done) TextDecoration.LineThrough else null,
            )
            val notes = task.notes.lineSequence().firstOrNull { it.isNotBlank() }
            if (notes != null) {
                Text(notes, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                     maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            val due = task.due
            if (due != null || task.labels.isNotEmpty() || projectLabel != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    if (due != null) {
                        val c = TodoStyle.due(due, dates)?.compose() ?: MaterialTheme.colorScheme.onSurfaceVariant
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Rounded.Event, null, tint = c, modifier = Modifier.size(13.dp))
                            Spacer(Modifier.width(3.dp))
                            Text(dates.label(due), style = MaterialTheme.typography.labelMedium, color = c)
                        }
                    }
                    task.labels.take(3).forEach { l ->
                        Text("@$l", style = MaterialTheme.typography.labelMedium,
                             color = TodoStyle.token(QuickAddResult.Token.Kind.LABEL).compose(), maxLines = 1)
                    }
                    Spacer(Modifier.weight(1f))
                    if (projectLabel != null) {
                        Text(projectLabel.first, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                             maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Spacer(Modifier.width(4.dp))
                        Box(Modifier.size(8.dp).clip(CircleShape).background(projectLabel.second))
                    }
                }
            }
        }
    }
}

@Composable
fun GroupHeader(title: String, subtitle: String?, overdue: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(start = 20.dp, end = 16.dp, top = 18.dp, bottom = 4.dp), verticalAlignment = Alignment.Bottom) {
        Text(title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
             color = if (overdue) TodoStyle.priority(1)!!.compose() else MaterialTheme.colorScheme.onSurface)
        if (subtitle != null) {
            Spacer(Modifier.width(8.dp))
            Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

fun projectColor(name: String): Color =
    (TodoStyle.palette.firstOrNull { it.first == name }?.second ?: TodoColor(0.6, 0.6, 0.6)).compose()

/** Colours the quick-add tokens (#project, @label, p1, dates) as you type, like the Mac. */
class TokenHighlight(private val parse: (String) -> QuickAddResult) : VisualTransformation {
    override fun filter(text: AnnotatedString): TransformedText {
        val tokens = runCatching { parse(text.text).tokens }.getOrDefault(emptyList())
        val styled = buildAnnotatedString {
            append(text.text)
            for (t in tokens) {
                val start = t.range.start.coerceIn(0, text.length)
                val end = t.range.end.coerceIn(start, text.length)
                addStyle(SpanStyle(color = TodoStyle.token(t.kind).compose(), fontWeight = FontWeight.Medium,
                                   background = TodoStyle.token(t.kind).compose().copy(alpha = 0.12f)), start, end)
            }
        }
        return TransformedText(styled, OffsetMapping.Identity)
    }
}
