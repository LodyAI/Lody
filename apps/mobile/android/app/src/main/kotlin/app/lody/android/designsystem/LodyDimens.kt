// Imported from Lody Mobile; maintained as platform-owned appearance code.

package app.lody.android.designsystem

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing
import androidx.compose.animation.core.SpringSpec
import androidx.compose.animation.core.spring
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

object LodySpacing {
    val none = 0.dp
    val xxs = 2.dp
    val xs = 4.dp
    val sm = 8.dp
    val md = 12.dp
    val lg = 16.dp
    val xl = 20.dp
    val xxl = 24.dp
    val xxxl = 32.dp
    val huge = 48.dp

    val all: List<Pair<String, Dp>> = listOf(
        "none" to none,
        "xxs" to xxs,
        "xs" to xs,
        "sm" to sm,
        "md" to md,
        "lg" to lg,
        "xl" to xl,
        "xxl" to xxl,
        "xxxl" to xxxl,
        "huge" to huge,
    )
}

object LodyRadius {
    val none = 0.dp
    /** Inline code, small badges, checkboxes. */
    val xs = 4.dp
    /** Chips, labels, segmented items. */
    val sm = 6.dp
    /** Buttons, text fields, code blocks, menus. */
    val md = 8.dp
    /** Cards, grouped list sections. */
    val lg = 12.dp
    /** Composer, custom sheets. */
    val xl = 18.dp
    /** Pills, avatars, dots. Use the platform capsule / circle shape. */
    val full = 9999.dp

    val all: List<Pair<String, Dp>> = listOf(
        "none" to none,
        "xs" to xs,
        "sm" to sm,
        "md" to md,
        "lg" to lg,
        "xl" to xl,
        "full" to full,
    )
}

object LodyIconSize {
    val xs = 12.dp
    /** Inline with footnote / caption text, in chips and small buttons. */
    val sm = 16.dp
    /** Default: list rows, toolbars. */
    val md = 20.dp
    /** Tab bar, prominent actions. */
    val lg = 24.dp
    /** Empty states. */
    val xl = 28.dp

    val all: List<Pair<String, Dp>> = listOf(
        "xs" to xs,
        "sm" to sm,
        "md" to md,
        "lg" to lg,
        "xl" to xl,
    )
}

object LodyStroke {
    /** Outlines. List separators use the platform hairline instead. */
    val default = 1.dp
    /** Selected outlines, checkbox rings. */
    val strong = 1.5.dp
    val focus = 2.dp
    /** Icon stroke on the 24pt grid; baked into generated icons. */
    val icon = 1.75.dp

    val all: List<Pair<String, Dp>> = listOf(
        "default" to default,
        "strong" to strong,
        "focus" to focus,
        "icon" to icon,
    )
}

object LodySize {
    /** Minimum hit area. Android Material reserves 48dp; keep 44 visually and let Compose pad the hit area. */
    val touchTarget = 44.dp
    /** Inline icon buttons inside rows. */
    val controlXs = 24.dp
    /** Compact buttons, the composer send button. */
    val controlSm = 32.dp
    /** Default buttons and text fields. */
    val controlMd = 40.dp
    /** Full-width primary actions. */
    val controlLg = 48.dp
    /** Filter chips. */
    val chip = 28.dp
    /** Labels and status badges. */
    val chipSm = 22.dp
    /** Unread / count badge height (min width). */
    val badge = 18.dp
    /** Unread and presence dots. */
    val dot = 8.dp
    /** Linear progress track height. */
    val progress = 4.dp
    /** Single-line row minimum height. */
    val listRow = 44.dp
    /** Title + subtitle row minimum height. */
    val listRowTwoLine = 60.dp
    val sectionHeader = 36.dp
    val avatarXs = 16.dp
    val avatarSm = 20.dp
    val avatarMd = 28.dp
    val avatarLg = 40.dp
    val avatarXl = 56.dp
    val composerMin = 48.dp

    val all: List<Pair<String, Dp>> = listOf(
        "touchTarget" to touchTarget,
        "controlXs" to controlXs,
        "controlSm" to controlSm,
        "controlMd" to controlMd,
        "controlLg" to controlLg,
        "chip" to chip,
        "chipSm" to chipSm,
        "badge" to badge,
        "dot" to dot,
        "progress" to progress,
        "listRow" to listRow,
        "listRowTwoLine" to listRowTwoLine,
        "sectionHeader" to sectionHeader,
        "avatarXs" to avatarXs,
        "avatarSm" to avatarSm,
        "avatarMd" to avatarMd,
        "avatarLg" to avatarLg,
        "avatarXl" to avatarXl,
        "composerMin" to composerMin,
    )
}

object LodyLayout {
    /** Horizontal content inset on phones. */
    val screenPaddingX = 16.dp
    val listRowPaddingX = 16.dp
    val listRowPaddingY = 10.dp
    /** Leading icon to title. */
    val listRowGap = 12.dp
    /** Leading inset of rows nested under a group header, so their text aligns with the header title (screenPaddingX + iconSize.md + listRowGap). The gutter holds status glyphs. */
    val childIndent = 48.dp
    /** Between grouped sections / cards. */
    val sectionGap = 24.dp
    /** Max width of trailing metadata in a row (e.g. a chat's project name); the title keeps the rest. */
    val trailingMetaMaxWidth = 128.dp
    /** Between controls inside a card. */
    val stackGap = 12.dp
    /** Max text column width on tablets / foldables. */
    val readableMaxWidth = 680.dp

    val all: List<Pair<String, Dp>> = listOf(
        "screenPaddingX" to screenPaddingX,
        "listRowPaddingX" to listRowPaddingX,
        "listRowPaddingY" to listRowPaddingY,
        "listRowGap" to listRowGap,
        "childIndent" to childIndent,
        "sectionGap" to sectionGap,
        "trailingMetaMaxWidth" to trailingMetaMaxWidth,
        "stackGap" to stackGap,
        "readableMaxWidth" to readableMaxWidth,
    )
}

object LodyBreakpoint {
    /** Two-pane layouts become possible (foldables, iPad split view). */
    val medium = 600.dp
    /** Persistent sidebar. */
    val expanded = 840.dp

    val all: List<Pair<String, Dp>> = listOf(
        "medium" to medium,
        "expanded" to expanded,
    )
}

object LodyOpacity {
    /** Icon-only buttons while pressed (iOS). */
    const val pressed = 0.7f
    /** De-emphasized media, archived rows. */
    const val muted = 0.6f
}

object LodyMotion {
    /** Color / opacity feedback. */
    const val instantMillis = 80
    /** Press feedback, toggles. */
    const val fastMillis = 120
    /** Expand / collapse, fades. */
    const val baseMillis = 200
    /** Large content changes. */
    const val slowMillis = 320
    /** Full-screen transitions of custom views. */
    const val slowerMillis = 480

    val standard: Easing = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val emphasized: Easing = CubicBezierEasing(0.3f, 0f, 0f, 1f)
    val decelerate: Easing = CubicBezierEasing(0f, 0f, 0f, 1f)
    val accelerate: Easing = CubicBezierEasing(0.3f, 0f, 1f, 1f)
}

/** Springs matching iOS `LodySpring` (SwiftUI duration / bounce converted to stiffness / damping). */
object LodySpring {
    /** Default for interactive movement. SwiftUI: duration 0.4s, bounce 0. */
    fun <T> smooth(): SpringSpec<T> = spring(dampingRatio = 1f, stiffness = 246.7f)
    /** Small controls, selection changes. SwiftUI: duration 0.3s, bounce 0.12. */
    fun <T> snappy(): SpringSpec<T> = spring(dampingRatio = 0.88f, stiffness = 438.6f)
    /** Playful confirmations. Use sparingly. SwiftUI: duration 0.5s, bounce 0.3. */
    fun <T> bouncy(): SpringSpec<T> = spring(dampingRatio = 0.7f, stiffness = 157.9f)
}
