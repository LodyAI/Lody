package app.lody.android.designsystem

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp

/**
 * The sign-in page's palette: web `/login` (`login-page.tsx` on `@lody/ui` tokens). Dark values
 * are measured from the shipped web page, light values come from the same product palette's light
 * theme. Kept in step with iOS `Onboarding/LoginAppearance.swift` (`LoginPalette`).
 */
data class LodyLoginColors(
    val page: Color,
    /** The visual's paper: a step off the page. */
    val visualPaper: Color,
    /** The visual's ink: the page's ink, dimmed toward black in dark mode. */
    val visualInk: Color,
    val label: Color,
    val secondaryLabel: Color,
    val tertiaryLabel: Color,
    val separator: Color,
    /** `Button` secondary: the raised surface, lit from above. */
    val raisedTop: Color,
    val raisedBottom: Color,
    val raisedEdge: Color,
    val raisedSheen: Color,
    val pressedFill: Color,
    /** `Badge` neutral: a film over whatever holds it. */
    val badgeFill: Color,
    /** The one recessed well every value holder uses. */
    val well: Color,
    val wellEdge: Color,
    val danger: Color,
    val raisedShadow: Color,
)

val LodyLoginLight = LodyLoginColors(
    page = Color(0xFFF9F9FA),
    visualPaper = Color(0xFFEEEEEF),
    visualInk = Color(0xFF1C1C1C),
    label = Color(0xFF1C1C1C),
    secondaryLabel = Color(0xFF6B6B6B),
    tertiaryLabel = Color(0xFF949495),
    separator = Color(0xFFDBDBDB),
    raisedTop = Color(0xFFFFFFFF),
    raisedBottom = Color(0xFFFCFCFC),
    raisedEdge = Color(0x12000000),
    raisedSheen = Color(0x00FFFFFF),
    pressedFill = Color(0x0F1C1C1C),
    badgeFill = Color(0x121C1C1C),
    well = Color(0x0A1C1C1C),
    wellEdge = Color(0x1A1C1C1C),
    danger = Color(0xFFD93025),
    raisedShadow = Color(0x0F000000),
)

val LodyLoginDark = LodyLoginColors(
    page = Color(0xFF131416),
    visualPaper = Color(0xFF1B1C1E),
    visualInk = Color(0xFFB5B6B7),
    label = Color(0xFFD7D8D9),
    secondaryLabel = Color(0xFF9C9FA3),
    tertiaryLabel = Color(0xFF6F7174),
    separator = Color(0xFF2B2D31),
    raisedTop = Color(0xFF25272A),
    raisedBottom = Color(0xFF1D1F22),
    raisedEdge = Color(0x12FFFFFF),
    raisedSheen = Color(0x14FFFFFF),
    pressedFill = Color(0x0FD7D8D9),
    badgeFill = Color(0x12D7D8D9),
    well = Color(0x0AD7D8D9),
    wellEdge = Color(0x1AD7D8D9),
    danger = Color(0xFFFF6B60),
    raisedShadow = Color(0x59000000),
)

/** The sign-in palette for the theme in force. */
val LodyTheme.login: LodyLoginColors
    @Composable @ReadOnlyComposable get() = if (colors === LodyDarkColors) LodyLoginDark else LodyLoginLight

/** Web `/login` geometry, in dp, shared by the sign-in page's parts. */
object LodyLoginMetrics {
    /** Page inset (web `paddingInline: 12px`) and the column's own inset on top of it. */
    val pageInset = 12.dp
    val columnInset = 20.dp
    val columnTop = 24.dp
    /** Gap between header, error, panel and legal notice (web `space[6]`). */
    val sceneGap = 24.dp
    val providerGap = 8.dp
    val methodGap = 12.dp
    val fieldGap = 12.dp
    /** Web `Button` large is 36 px; native keeps the 44 dp touch target. */
    val control = 44.dp
    val controlRadius = 10.dp
    val controlInset = 14.dp
    val mark = 18.dp
    /** Between a method's mark and its label. */
    val markGap = 10.dp
    val fieldLabelGap = 6.dp
    val badgeInset = 6.dp
    val visualRadius = 14.dp
    val visualMin = 200.dp
    val visualMax = 360.dp
    const val visualFraction = 0.42f
    val badgeHeight = 20.dp
    val badgeRadius = 5.dp
    val errorRadius = 8.dp
    val verificationMark = 48.dp
    const val transitionMillis = 320
    /** Web `LOGIN_TRANSITION`: cubic-bezier(0.4, 0, 0.2, 1). */
    val transitionEasing = androidx.compose.animation.core.CubicBezierEasing(0.4f, 0f, 0.2f, 1f)
}
