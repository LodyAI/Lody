// Hand-written runtime component. iOS counterpart: runtime/ios/LodyWorkingGrid.swift.

package app.lody.android.designsystem

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.withFrameMillis
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import kotlin.math.PI
import kotlin.math.cos

private const val PERIOD_MS = 1600
private const val FRAME_INTERVAL_MS = 50L
private const val GAP = 0.18f
private const val CORNER = 0.4f
private const val STEP = 0.12f

/**
 * The web "working" mark (`ui/working-grid.tsx`): a 3×3 grid of rounded tiles rising and
 * sinking in a diagonal wave. Geometry follows the web defaults: tile gap 0.18 and corner
 * radius 0.4 of a tile edge, scale 0.9 → 0.3, opacity 1 → 0.25.
 */
@Composable
fun LodyWorkingGrid(modifier: Modifier = Modifier, size: Dp = LodyIconSize.xs, color: Color = LodyTheme.colors.accentDefault) {
    val time by produceState(0f) {
        while (isActive) {
            // Read Compose's frame clock so updates pause when the host is stopped.
            // Absolute time keeps separately mounted rows on the same 20 Hz cadence;
            // delayed frames skip ahead rather than replaying missed animation steps.
            val frameMillis = withFrameMillis { it }
            value = (frameMillis % PERIOD_MS).toFloat() / PERIOD_MS
            delay(FRAME_INTERVAL_MS - frameMillis % FRAME_INTERVAL_MS)
        }
    }
    Canvas(modifier.size(size)) {
        val tile = this.size.width / (3 + 2 * GAP)
        for (row in 0 until 3) {
            for (column in 0 until 3) {
                val height = 0.5f + 0.5f * cos(2 * PI.toFloat() * (time - (row + column) * STEP))
                val edge = tile * (0.3f + 0.6f * height)
                val centerX = column * tile * (1 + GAP) + tile / 2
                val centerY = row * tile * (1 + GAP) + tile / 2
                drawRoundRect(
                    color = color,
                    topLeft = Offset(centerX - edge / 2, centerY - edge / 2),
                    size = Size(edge, edge),
                    cornerRadius = CornerRadius(edge * CORNER),
                    alpha = 0.25f + 0.75f * height,
                )
            }
        }
    }
}
