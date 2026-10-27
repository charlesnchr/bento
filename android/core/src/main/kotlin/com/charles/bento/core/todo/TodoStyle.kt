package com.charles.bento.core.todo

import java.util.Locale

/** An sRGB colour, components 0…1 (the Mac's values, so both apps look the same). */
data class TodoColor(val red: Double, val green: Double, val blue: Double) {
    /** 0xFFRRGGBB, for Android's `Color(argb)`. */
    val argb: Int get() = (0xFF shl 24) or (c(red) shl 16) or (c(green) shl 8) or c(blue)

    private fun c(x: Double) = Math.round(x.coerceIn(0.0, 1.0) * 255).toInt()
}

/** Todoist's colours as data: priorities, quick-add tokens, due-date states, the project palette. Port of `TodoStyle`. */
object TodoStyle {
    /** p1 red, p2 orange, p3 blue; p4 has none (use the theme's secondary text colour). */
    fun priority(p: Int): TodoColor? = when (p) {
        1 -> TodoColor(0.82, 0.27, 0.23) // #D1453B
        2 -> TodoColor(0.92, 0.54, 0.04) // #EB8909
        3 -> TodoColor(0.14, 0.44, 0.88) // #246FE0
        else -> null
    }

    fun token(kind: QuickAddResult.Token.Kind): TodoColor = when (kind) {
        QuickAddResult.Token.Kind.PROJECT -> TodoColor(0.29, 0.47, 0.85)
        QuickAddResult.Token.Kind.LABEL -> TodoColor(0.55, 0.38, 0.80)
        QuickAddResult.Token.Kind.PRIORITY -> priority(1)!!
        QuickAddResult.Token.Kind.DATE -> TodoColor(0.16, 0.60, 0.33)
    }

    /** Due label colour: overdue red, today green, tomorrow orange, this week purple, later null (secondary). */
    fun due(d: DueDate, dates: TodoDates): TodoColor? {
        if (dates.isOverdue(d)) return priority(1)
        return when (dates.days(d.date)) {
            0 -> token(QuickAddResult.Token.Kind.DATE)
            1 -> priority(2)
            in 2..6 -> TodoColor(0.55, 0.38, 0.80)
            else -> null
        }
    }

    /** Project palette (Todoist's names, which are what `color` stores). */
    val palette: List<Pair<String, TodoColor>> = listOf(
        "berry_red" to TodoColor(0.72, 0.15, 0.40),
        "red" to TodoColor(0.86, 0.25, 0.21),
        "orange" to TodoColor(1.00, 0.60, 0.20),
        "yellow" to TodoColor(0.98, 0.82, 0.20),
        "olive_green" to TodoColor(0.69, 0.71, 0.20),
        "lime_green" to TodoColor(0.49, 0.80, 0.28),
        "green" to TodoColor(0.18, 0.63, 0.30),
        "mint_green" to TodoColor(0.42, 0.80, 0.73),
        "teal" to TodoColor(0.08, 0.56, 0.62),
        "sky_blue" to TodoColor(0.08, 0.70, 0.86),
        "blue" to TodoColor(0.26, 0.44, 0.89),
        "grape" to TodoColor(0.53, 0.30, 0.82),
        "violet" to TodoColor(0.69, 0.21, 0.84),
        "magenta" to TodoColor(0.88, 0.26, 0.68),
        "salmon" to TodoColor(1.00, 0.55, 0.52),
        "charcoal" to TodoColor(0.31, 0.31, 0.31),
        "grey" to TodoColor(0.60, 0.60, 0.60),
    )

    /** A palette colour by name; unknown names are grey. */
    fun project(name: String): TodoColor = palette.firstOrNull { it.first == name }?.second ?: TodoColor(0.5, 0.5, 0.5)

    /** "berry_red" → "Berry Red". */
    fun title(name: String): String = name.split('_').filter { it.isNotEmpty() }
        .joinToString(" ") { it.take(1).uppercase(Locale.ROOT) + it.drop(1) }
}
