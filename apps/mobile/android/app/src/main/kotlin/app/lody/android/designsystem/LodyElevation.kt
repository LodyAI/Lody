// Imported from Lody Mobile; maintained as platform-owned appearance code.

package app.lody.android.designsystem

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Shadow for custom floating surfaces. Apply with
 * `Modifier.dropShadow(shape, LodyElevations.md.shadow())`.
 * [blur] is in Figma / CSS terms; [color] resolves against the active [LodyColors].
 */
@Immutable
class LodyElevation(val blur: Dp, val y: Dp, val color: (LodyColors) -> Color)

object LodyElevations {
    /** Floating chips, the composer when content scrolls under it. */
    val sm = LodyElevation(blur = 3.dp, y = 1.dp) { it.shadowSm }
    /** Menus, popovers, toasts. */
    val md = LodyElevation(blur = 16.dp, y = 4.dp) { it.shadowMd }
    /** Custom sheets and dialogs. */
    val lg = LodyElevation(blur = 32.dp, y = 12.dp) { it.shadowLg }
}
