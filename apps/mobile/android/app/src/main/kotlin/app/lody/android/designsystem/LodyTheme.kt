// Hand-written runtime for the generated Lody* token files. Edit freely.

package app.lody.android.designsystem

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.LocalTextSelectionColors
import androidx.compose.foundation.text.selection.TextSelectionColors
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.shadow.Shadow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp

private val LocalLodyColors = staticCompositionLocalOf { LodyLightColors }
private val LocalLodyTypography = staticCompositionLocalOf { LodyDefaultTypography }

object LodyTheme {
    val colors: LodyColors
        @Composable @ReadOnlyComposable get() = LocalLodyColors.current

    val typography: LodyTypography
        @Composable @ReadOnlyComposable get() = LocalLodyTypography.current
}

/**
 * Provides Lody tokens and maps them onto MaterialExpressiveTheme, so native Material 3
 * components (switches, text fields, top app bars) pick up the same palette,
 * type and corner radii. Dynamic color is intentionally off: iOS has no
 * equivalent and the two apps must look the same.
 */
@Composable
fun LodyTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) LodyDarkColors else LodyLightColors
    CompositionLocalProvider(
        LocalLodyColors provides colors,
        LocalLodyTypography provides LodyDefaultTypography,
    ) {
        MaterialExpressiveTheme(
            colorScheme = colors.toMaterial(darkTheme),
            typography = LodyDefaultTypography.toMaterial(),
            shapes = LodyShapes,
            motionScheme = MotionScheme.expressive(),
        ) {
            // MaterialTheme derives selection colors from primary; use the Lody tokens instead.
            CompositionLocalProvider(
                LocalTextSelectionColors provides TextSelectionColors(
                    handleColor = colors.selectionHandle,
                    backgroundColor = colors.selectionText,
                ),
                content = content,
            )
        }
    }
}

private fun LodyColors.toMaterial(dark: Boolean): ColorScheme =
    (if (dark) darkColorScheme() else lightColorScheme()).copy(
        primary = accentSolid,
        onPrimary = textOnAccent,
        primaryContainer = accentSubtle,
        onPrimaryContainer = accentOnSubtle,
        inversePrimary = accentFg,
        secondary = textSecondary,
        onSecondary = textInverse,
        secondaryContainer = fillSecondary,
        onSecondaryContainer = textPrimary,
        tertiary = stateMerged,
        onTertiary = textOnAccent,
        background = bgBase,
        onBackground = textPrimary,
        surface = bgBase,
        onSurface = textPrimary,
        surfaceVariant = fillSecondary,
        onSurfaceVariant = textSecondary,
        // Flat design: no tonal elevation tint.
        surfaceTint = bgBase,
        surfaceBright = bgRaised,
        surfaceDim = bgGrouped,
        surfaceContainerLowest = bgBase,
        surfaceContainerLow = bgRaised,
        surfaceContainer = bgRaised,
        surfaceContainerHigh = bgOverlay,
        surfaceContainerHighest = fillSecondary,
        inverseSurface = bgInverse,
        inverseOnSurface = textInverse,
        outline = borderStrong,
        outlineVariant = borderSubtle,
        error = dangerDefault,
        onError = textOnDanger,
        errorContainer = dangerSubtle,
        onErrorContainer = dangerOnSubtle,
        scrim = overlayScrim,
    )

// LargeTopAppBar renders headlineMedium expanded and titleLarge collapsed, which
// mirrors the iOS large title (largeTitle) collapsing into the bar title (headline).
private fun LodyTypography.toMaterial(): Typography =
    Typography(
        displayLarge = largeTitle,
        displayMedium = largeTitle,
        displaySmall = largeTitle,
        headlineLarge = largeTitle,
        headlineMedium = largeTitle,
        headlineSmall = title,
        titleLarge = headline,
        titleMedium = headline,
        titleSmall = subhead,
        bodyLarge = body,
        bodyMedium = body,
        bodySmall = footnote,
        labelLarge = subhead,
        labelMedium = caption,
        labelSmall = micro,
    )

private val LodyShapes = Shapes(
    extraSmall = RoundedCornerShape(LodyRadius.xs),
    small = RoundedCornerShape(LodyRadius.sm),
    medium = RoundedCornerShape(LodyRadius.md),
    large = RoundedCornerShape(LodyRadius.lg),
    extraLarge = RoundedCornerShape(LodyRadius.xl),
)

/**
 * Resolves an elevation level against the active colors, for
 * `Modifier.dropShadow(shape, LodyElevations.md.shadow())`.
 */
@Composable
@ReadOnlyComposable
fun LodyElevation.shadow(): Shadow =
    // Compose's radius is roughly half the Figma / CSS blur, like SwiftUI's.
    Shadow(radius = blur / 2, color = color(LodyTheme.colors), offset = DpOffset(0.dp, y))
