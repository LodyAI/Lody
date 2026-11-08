package app.lody.android.home

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.awaitLongPressOrCancellation
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.IntOffset
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.lody.android.R
import app.lody.android.designsystem.*
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** Indices refer to the rendered list, after family folding, including each header. */
internal fun projectIndexTargets(sections: List<HomeSection>): List<Int> {
    var index = 0
    return sections.map { section -> index.also { index += 1 + section.chats.size } }
}

/** Only the thumb's vertical neighborhood activates the index, not the trailing rail. */
internal fun projectIndexTouchBounds(thumb: Rect, width: Float, touchTarget: Float): Rect {
    val halfHeight = maxOf(thumb.height, touchTarget) / 2
    return Rect((width - touchTarget).coerceAtLeast(0f), thumb.center.y - halfHeight,
        width, thumb.center.y + halfHeight)
}

/** Scrubbing stays anchored to the selected cell even when the capsule is clamped at an edge. */
internal fun projectIndexScrubTarget(originIndex: Int, deltaY: Float, pitch: Float, count: Int): Int =
    (originIndex + 0.5f + deltaY / pitch.coerceAtLeast(1f)).toInt().coerceIn(0, count - 1)

/** Parent gesture observer leaves the list's ordinary drag/tap handling intact until long press. */
@Composable
internal fun ProjectIndexList(
    sections: List<HomeSection>,
    titles: Map<String, String>,
    state: LazyListState,
    enabled: Boolean,
    bottom: androidx.compose.ui.unit.Dp,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    if (!enabled || sections.size < 2) {
        Box(modifier) { content() }
        return
    }
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    val targets = remember(sections) { projectIndexTargets(sections) }
    var active by remember(sections, enabled) { mutableStateOf(false) }
    var selected by remember(sections) { mutableIntStateOf(0) }
    var capsuleTop by remember { mutableFloatStateOf(0f) }
    var jumpJob by remember { mutableStateOf<Job?>(null) }
    DisposableEffect(lifecycle, sections, enabled) {
        val observer = LifecycleEventObserver { _, _ ->
            foreground = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            if (!foreground) {
                active = false
                jumpJob?.cancel()
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            active = false
            jumpJob?.cancel()
        }
    }
    val expansion by animateFloatAsState(if (active) 1f else 0f, label = "project-index-morph")
    val colors = LodyTheme.colors
    val label = stringResource(R.string.home_project_index)
    val hint = stringResource(R.string.home_project_index_hold)
    BoxWithConstraints(modifier) {
        val height = with(density) { (maxHeight - bottom).toPx().coerceAtLeast(0f) }
        val width = with(density) { maxWidth.toPx() }
        val inset = with(density) { LodySpacing.xs.toPx() }
        val slim = with(density) { LodySize.progress.toPx() }
        val wide = with(density) { LodySize.touchTarget.toPx() }
        val thumbHeight = with(density) { LodySize.controlMd.toPx() }.coerceAtMost(height)
        val pitch = with(density) { LodySize.controlSm.toPx() }.coerceAtMost(
            ((height - inset * 2) / sections.size.coerceAtLeast(1)).coerceAtLeast(0f),
        )
        val capsuleHeight = pitch * sections.size + inset * 2
        val layout = state.layoutInfo
        val first = layout.visibleItemsInfo.firstOrNull { it.index == state.firstVisibleItemIndex }
        val fraction = state.firstVisibleItemIndex + state.firstVisibleItemScrollOffset.toFloat() / (first?.size ?: 1).coerceAtLeast(1)
        val visible = layout.visibleItemsInfo.count { it.offset >= layout.viewportStartOffset && it.offset < layout.viewportEndOffset }.coerceAtLeast(1)
        val progress = if (!state.canScrollForward) 1f else (fraction / (layout.totalItemsCount - visible).coerceAtLeast(1)).coerceIn(0f, 1f)
        val thumbTop = (height - thumbHeight).coerceAtLeast(0f) * progress
        val thumb = Rect(width - inset - slim, thumbTop, width - inset, thumbTop + thumbHeight)
        val available = foreground && enabled && sections.size > 1 && height > 0 && (state.canScrollForward || state.canScrollBackward)
        SideEffect {
            if (!available) {
                active = false
                jumpJob?.cancel()
            }
        }
        val current = targets.indexOfLast { it <= state.firstVisibleItemIndex }.coerceAtLeast(0)
        fun select(index: Int) {
            if (!available || !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
            if (index != selected) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            selected = index
            jumpJob?.cancel()
            jumpJob = scope.launch { state.scrollToItem(targets[index]) }
        }
        // Geometry is read at DOWN; scrolling must not restart an in-flight gesture.
        val latestThumb by rememberUpdatedState(projectIndexTouchBounds(thumb, width, wide))
        val latestAvailable by rememberUpdatedState(available)
        val latestCurrent by rememberUpdatedState(current)
        Box(Modifier.fillMaxSize().pointerInput(sections, available, height, width) {
            awaitEachGesture {
                val down = awaitFirstDown(requireUnconsumed = false)
                if (!latestAvailable || !latestThumb.contains(down.position)) return@awaitEachGesture
                val held = awaitLongPressOrCancellation(down.id) ?: return@awaitEachGesture
                if (!latestAvailable || !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return@awaitEachGesture
                val originIndex = latestCurrent
                val originY = held.position.y
                selected = originIndex
                capsuleTop = (held.position.y - inset - (selected + 0.5f) * pitch)
                    .coerceIn(0f, (height - capsuleHeight).coerceAtLeast(0f))
                active = true
                haptics.performHapticFeedback(HapticFeedbackType.LongPress)
                // ChatRow uses clickable (no competing long-press timer). Do not consume DOWN:
                // native scrolling must still win before activation. Consume subsequent events
                // in Initial, including UP, before the row can dispatch its click.
                held.consume()
                try {
                    while (true) {
                        // Consume release before row click handlers see it, even without a scrub.
                        val event = awaitPointerEvent(PointerEventPass.Initial)
                        val change = event.changes.firstOrNull { it.id == held.id }
                        event.changes.forEach { it.consume() }
                        if (change == null || !change.pressed) break
                        val index = projectIndexScrubTarget(originIndex, change.position.y - originY, pitch, sections.size)
                        if (index != selected) select(index)
                    }
                } finally {
                    active = false
                }
            }
        }) {
            content()
            if (available || expansion > 0f) {
                val top = thumbTop + (capsuleTop - thumbTop) * expansion
                val panelWidth = slim + (wide - slim) * expansion
                val panelHeight = thumbHeight + (capsuleHeight - thumbHeight) * expansion
                Box(
                    Modifier.offset { IntOffset((width - inset - panelWidth).roundToInt(), top.roundToInt()) }
                        .size(with(density) { panelWidth.toDp() }, with(density) { panelHeight.toDp() })
                        .clip(CircleShape)
                        .background(if (active || expansion > 0f) colors.bgOverlay else colors.iconTertiary)
                        .semantics {
                            contentDescription = label
                            customActions = listOf(CustomAccessibilityAction(hint) {
                                if (!available || !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return@CustomAccessibilityAction false
                                selected = current
                                capsuleTop = ((height - capsuleHeight) / 2).coerceAtLeast(0f)
                                active = !active
                                true
                            })
                        },
                ) {
                    if (expansion > 0f) Column(Modifier.width(LodySize.touchTarget).padding(vertical = LodySpacing.xs).alpha(expansion)) {
                        sections.forEachIndexed { index, section ->
                            val title = titles.getValue(section.id)
                            Box(Modifier.fillMaxWidth().height(with(density) { pitch.toDp() })
                                .semantics(mergeDescendants = true) {
                                    contentDescription = title
                                    this.selected = index == if (active) selected else current
                                    onClick { select(index); active = false; true }
                                }, contentAlignment = Alignment.Center) {
                                Box(Modifier.size(LodySize.chip.coerceAtMost(with(density) { pitch.toDp() }))
                                    .background(if (index == if (active) selected else current) colors.accentSubtle else androidx.compose.ui.graphics.Color.Transparent, CircleShape),
                                    contentAlignment = Alignment.Center) {
                                    val repository = section.chats.firstOrNull { it.nestedUnder == null }?.repository
                                    when (section.header) {
                                        HomeSection.Header.Pinned -> Icon(LodyIcons.Pin, null, Modifier.size(LodyIconSize.sm), colors.iconSecondary)
                                        HomeSection.Header.Chats -> Icon(LodyIcons.Session, null, Modifier.size(LodyIconSize.sm), colors.iconSecondary)
                                        else -> if (repository != null) RepositoryIcon(repository, LodyIconSize.sm, opacity = 0.8f)
                                            else Text(title.take(1).uppercase(), style = LodyTheme.typography.caption, color = colors.textSecondary)
                                    }
                                    val attention = section.chats.any { it.attention != null || it.childAttention != null }
                                    if (attention) Box(Modifier.align(Alignment.TopEnd).size(LodySize.dot).background(
                                        if (section.chats.any { it.attention in setOf(ChatAttention.Failed, ChatAttention.Waiting) || it.childAttention in setOf(ChatAttention.Failed, ChatAttention.Waiting) }) colors.warningDefault else colors.accentDefault,
                                        CircleShape,
                                    ))
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
