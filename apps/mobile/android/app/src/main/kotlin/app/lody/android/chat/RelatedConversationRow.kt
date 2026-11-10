package app.lody.android.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.semantics.selected
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.CompositingStrategy
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.lody.android.designsystem.*
import app.lody.android.home.AgentMark
import app.lody.android.home.AttentionGlyph
import app.lody.android.home.ChatAttention
import app.lody.android.runtime.CatalogSession

/** One exact conversation target, with supporting content and independent reply actions. */
@Composable
internal fun RelatedConversationRow(
    session: CatalogSession?, title: String, status: String?, attention: ChatAttention?,
    enabled: Boolean, isCurrent: Boolean = false,
    onClick: () -> Unit, content: @Composable ColumnScope.() -> Unit = {},
) {
    val colors = LodyTheme.colors
    Column {
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp)
            .background(if (isCurrent) colors.fillSelected else Color.Transparent, RoundedCornerShape(LodyRadius.sm))
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .semantics { selected = isCurrent; if (status != null) stateDescription = status }
            .padding(vertical = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
            AgentMark(session?.cliType, session?.agentType, colors.textSecondary, Modifier.size(LodyIconSize.md))
            Text(title, Modifier.weight(1f), style = LodyTheme.typography.callout, color = colors.textPrimary, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (attention != null) AttentionGlyph(attention)
        }
        Column(Modifier.padding(start = LodyIconSize.md + LodySpacing.sm), content = content)
    }
}

@Composable
internal fun ConversationBranch(depth: Int, continuing: Set<Int>, content: @Composable () -> Unit) {
    val colors = LodyTheme.colors
    val level = LodyLayout.childIndent - LodyLayout.screenPaddingX
    val indent = level * depth.coerceAtMost(8)
    Column(Modifier.fillMaxWidth().drawBehind {
        val step = level.toPx()
        val turn = 24.dp.toPx()
        val stroke = Stroke((LodySpacing.xxs / 2).toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round)
        for (i in 1..depth.coerceAtMost(8)) {
            val x = (i - 1) * step + LodySpacing.xs.toPx()
            val path = Path()
            if (i == depth.coerceAtMost(8)) {
                val fork = maxOf(0f, turn - LodySpacing.md.toPx())
                path.moveTo(x, 0f)
                path.lineTo(x, fork)
                path.cubicTo(x, turn - LodyRadius.sm.toPx(), x + LodySpacing.xs.toPx(), turn, i * step - LodySpacing.xs.toPx(), turn)
            }
            if (i in continuing) { path.moveTo(x, 0f); path.lineTo(x, size.height) }
            drawPath(path, colors.borderDefault, style = stroke)
        }
    }.padding(start = indent)) {
        content()
    }
}

/** Tabs share a horizontal viewport. Compose scroll semantics remain available without a scrollbar. */
@Composable
internal fun ConversationTabStrip(count: Int, content: @Composable (Int) -> Unit) {
    val scroll = rememberScrollState()
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val cellWidth = if (count == 1) maxWidth else maxWidth * 0.85f
        Row(Modifier.fillMaxWidth().clipToBounds()
            .graphicsLayer { compositingStrategy = CompositingStrategy.Offscreen }
            .drawWithContent {
                drawContent()
                val fade = LodySpacing.md.toPx().coerceAtMost(size.width / 2)
                val left = if (rtl) scroll.canScrollForward else scroll.canScrollBackward
                val right = if (rtl) scroll.canScrollBackward else scroll.canScrollForward
                if (left) drawRect(Brush.horizontalGradient(listOf(Color.Transparent, Color.Black), 0f, fade), size = Size(fade, size.height), blendMode = BlendMode.DstIn)
                if (right) drawRect(Brush.horizontalGradient(listOf(Color.Black, Color.Transparent), size.width - fade, size.width), topLeft = Offset(size.width - fade, 0f), size = Size(fade, size.height), blendMode = BlendMode.DstIn)
            }.horizontalScroll(scroll), horizontalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
            repeat(count) { index -> Box(Modifier.width(cellWidth)) { content(index) } }
        }
    }
}
