package com.charles.bento.ui.theme

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.core.view.WindowCompat
import com.charles.bento.R

/** Bento's own colours, beside the Material scheme: the box red, priority colours, code. */
data class BentoColors(
    val accent: Color,
    val priority: List<Color>, // p1…p4
    val codeBackground: Color,
    val marker: Color,
    val isDark: Boolean,
)

val LocalBentoColors = staticCompositionLocalOf {
    BentoColors(BentoRed, PriorityColors, Color(0x14000000), Color(0x59000000), false)
}

/** The lacquered box on the icon. */
val BentoRed = Color(0xFFD9443D)
/** Todoist-like priority flags, p1 → p4. */
val PriorityColors = listOf(Color(0xFFD1453B), Color(0xFFEB8909), Color(0xFF246FE0), Color(0xFF8A8A8A))

private fun flex(weight: Int) = Font(
    R.font.google_sans_flex,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

val SansFlex = FontFamily(flex(400), flex(500), flex(600), flex(700))
val SansCode = FontFamily(
    Font(R.font.google_sans_code, FontWeight.Normal, variationSettings = FontVariation.Settings(FontVariation.weight(400))),
    Font(R.font.google_sans_code, FontWeight.Medium, variationSettings = FontVariation.Settings(FontVariation.weight(500))),
)

private val BentoTypography = Typography().let { t ->
    fun TextStyle.flex() = copy(fontFamily = SansFlex)
    Typography(
        displayLarge = t.displayLarge.flex(), displayMedium = t.displayMedium.flex(), displaySmall = t.displaySmall.flex(),
        headlineLarge = t.headlineLarge.flex(), headlineMedium = t.headlineMedium.flex(),
        headlineSmall = t.headlineSmall.flex().copy(fontWeight = FontWeight.SemiBold),
        titleLarge = t.titleLarge.flex().copy(fontWeight = FontWeight.SemiBold), titleMedium = t.titleMedium.flex(), titleSmall = t.titleSmall.flex(),
        bodyLarge = t.bodyLarge.flex().copy(fontSize = 16.sp, lineHeight = 24.sp), bodyMedium = t.bodyMedium.flex(), bodySmall = t.bodySmall.flex(),
        labelLarge = t.labelLarge.flex(), labelMedium = t.labelMedium.flex(), labelSmall = t.labelSmall.flex(),
    )
}

/** Graphite: near-black and high contrast, dark even in light mode (as on the Mac). */
private val Graphite = darkColorScheme(
    primary = Color(0xFFFF6B63), onPrimary = Color(0xFF2B0000),
    primaryContainer = Color(0xFF5A1814), onPrimaryContainer = Color(0xFFFFDAD6),
    secondary = Color(0xFFE6E1E5), onSecondary = Color(0xFF1C1B1F),
    secondaryContainer = Color(0xFF2E2E31), onSecondaryContainer = Color(0xFFEDEDED),
    tertiary = Color(0xFFFFC94D),
    background = Color(0xFF0B0B0C), onBackground = Color(0xFFF2F2F2),
    surface = Color(0xFF0B0B0C), onSurface = Color(0xFFF2F2F2),
    surfaceVariant = Color(0xFF1F1F22), onSurfaceVariant = Color(0xFFC9C9CF),
    surfaceContainerLowest = Color(0xFF000000), surfaceContainerLow = Color(0xFF121214),
    surfaceContainer = Color(0xFF17171A), surfaceContainerHigh = Color(0xFF1E1E21), surfaceContainerHighest = Color(0xFF262629),
    outline = Color(0xFF5C5C63), outlineVariant = Color(0xFF2E2E33),
)

/** Paper: warm off-white, light even in dark mode. */
private val Paper = lightColorScheme(
    primary = Color(0xFFB3322C), onPrimary = Color.White,
    primaryContainer = Color(0xFFFFDAD5), onPrimaryContainer = Color(0xFF410001),
    secondary = Color(0xFF5E5A52), onSecondary = Color.White,
    secondaryContainer = Color(0xFFEAE3D6), onSecondaryContainer = Color(0xFF1F1B14),
    tertiary = Color(0xFF8A6A12),
    background = Color(0xFFF7F2E8), onBackground = Color(0xFF221F1A),
    surface = Color(0xFFF7F2E8), onSurface = Color(0xFF221F1A),
    surfaceVariant = Color(0xFFECE5D8), onSurfaceVariant = Color(0xFF4D483F),
    surfaceContainerLowest = Color(0xFFFFFCF6), surfaceContainerLow = Color(0xFFF3EDE2),
    surfaceContainer = Color(0xFFEFE8DC), surfaceContainerHigh = Color(0xFFE9E2D5), surfaceContainerHighest = Color(0xFFE3DBCD),
    outline = Color(0xFF7F786C), outlineVariant = Color(0xFFD5CDBF),
)

fun colorSchemeFor(theme: String, dark: Boolean, context: android.content.Context): ColorScheme = when (theme) {
    "graphite" -> Graphite
    "paper" -> Paper
    else -> if (dark) dynamicDarkColorScheme(context) else dynamicLightColorScheme(context)
}

fun isDarkTheme(theme: String, systemDark: Boolean) = when (theme) {
    "graphite" -> true
    "paper" -> false
    else -> systemDark
}

@Composable
fun BentoTheme(theme: String, content: @Composable () -> Unit) {
    val dark = isDarkTheme(theme, isSystemInDarkTheme())
    val scheme = colorSchemeFor(theme, dark, LocalContext.current)
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }
    val bento = BentoColors(
        accent = scheme.primary,
        priority = PriorityColors,
        codeBackground = scheme.onSurface.copy(alpha = if (dark) 0.10f else 0.07f),
        marker = scheme.onSurface.copy(alpha = 0.35f),
        isDark = dark,
    )
    androidx.compose.runtime.CompositionLocalProvider(LocalBentoColors provides bento) {
        MaterialTheme(colorScheme = scheme, typography = BentoTypography, content = content)
    }
}
