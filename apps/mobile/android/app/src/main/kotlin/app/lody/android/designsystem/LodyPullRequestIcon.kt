package app.lody.android.designsystem

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.unit.Dp

/** Web SessionPrIcon / MaskedPrCiIcon: 14px base, 10px verdict, transparent cutout. */
@Composable
fun LodyPullRequestIcon(status: String, ci: String? = null, modifier: Modifier = Modifier, size: Dp = LodyIconSize.sm) {
    val colors = LodyTheme.colors
    val (icon, tint) = when (status) {
        "merged" -> LodyIcons.Merge to colors.prMerged
        "closed" -> LodyIcons.PullRequestClosed to colors.prClosed
        "draft" -> LodyIcons.PullRequestDraft to colors.prDraft
        else -> LodyIcons.PullRequest to colors.prOpen
    }
    val verdict = when (ci) {
        "s", "pass" -> "pass"
        "f", "e", "fail" -> "fail"
        "p", "pending" -> "pending"
        "x", "expected" -> "expected"
        else -> ""
    }
    Box(modifier.size(size)) {
        Box(Modifier.size(size).graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }.drawWithContent {
            drawContent()
            if (verdict.isNotEmpty()) {
                val unit = this.size.width / 16
                drawCircle(Color.Black, (if (verdict == "pending") 3.75f else 5f) * unit, Offset(12 * unit, 12 * unit), blendMode = BlendMode.Clear)
            }
        }) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(size * 14 / 16))
        }
        Canvas(Modifier.size(size)) {
            val unit = this.size.width / 16
            val center = Offset(12 * unit, 12 * unit)
            val stroke = Stroke(3f * 10 / 24 * unit, cap = StrokeCap.Round, join = StrokeJoin.Round)
            when (verdict) {
                "pending" -> drawCircle(colors.warningDefault, 2.5f * unit, center)
                "expected" -> {
                    drawCircle(colors.warningDefault, 10f * 10 / 24 * unit, center, style = stroke)
                    drawCircle(colors.warningDefault, 10f / 24 * unit, center, style = stroke)
                }
                "pass", "fail" -> {
                    fun x(value: Float) = (7 + value * 10 / 24) * unit
                    val path = Path().apply {
                        if (verdict == "pass") {
                            moveTo(x(20f), x(6f)); lineTo(x(9f), x(17f)); lineTo(x(4f), x(12f))
                        } else {
                            moveTo(x(18f), x(6f)); lineTo(x(6f), x(18f))
                            moveTo(x(6f), x(6f)); lineTo(x(18f), x(18f))
                        }
                    }
                    drawPath(path, if (verdict == "pass") colors.successDefault else colors.dangerDefault, style = stroke)
                }
            }
        }
    }
}
