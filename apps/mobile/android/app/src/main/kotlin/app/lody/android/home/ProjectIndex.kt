package app.lody.android.home

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalAccessibilityManager
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
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.math.roundToInt

/** Indices refer to the rendered list, after family folding, including each header. */
internal fun projectIndexTargets(sections: List<HomeSection>): List<Int> {
    var index = 0
    return sections.map { section -> index.also { index += 1 + section.chats.size } }
}

/** Coordinates are local to the visible capsule, including its top padding. */
internal fun projectIndexScrubTarget(y: Float, inset: Float, pitch: Float, count: Int): Int =
    ((y - inset) / pitch.coerceAtLeast(1f)).toInt().coerceIn(0, count - 1)

/** Losing availability discards a pending linger; returning never resurrects it. */
internal data class ProjectIndexVisibility(
    val shown: Boolean = false,
    val scrolling: Boolean = false,
    val touching: Boolean = false,
) {
    val lingering: Boolean get() = shown && !scrolling && !touching
    fun update(available: Boolean, scrolling: Boolean = this.scrolling, touching: Boolean = this.touching) =
        if (!available) ProjectIndexVisibility()
        else ProjectIndexVisibility(shown || scrolling || touching, scrolling, touching)
    fun hide() = if (lingering) copy(shown = false) else this
}

/** The list keeps its full width. Only the visible capsule owns direct index gestures. */
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
    val lingerMillis = LocalAccessibilityManager.current?.calculateRecommendedTimeoutMillis(
        originalTimeoutMillis = 800L, containsIcons = true, containsControls = true,
    ) ?: 800L
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    var foreground by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
    val targets = remember(sections) { projectIndexTargets(sections) }
    val identities = sections.map { it.id }
    var visibility by remember(identities) { mutableStateOf(ProjectIndexVisibility()) }
    var interaction by remember(identities) { mutableIntStateOf(0) }
    var selected by remember(identities) { mutableIntStateOf(0) }
    var jumpJob by remember { mutableStateOf<Job?>(null) }
    DisposableEffect(lifecycle, identities) {
        val observer = LifecycleEventObserver { _, _ ->
            foreground = lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
            if (!foreground) {
                visibility = ProjectIndexVisibility()
                jumpJob?.cancel()
            }
        }
        lifecycle.addObserver(observer)
        onDispose {
            lifecycle.removeObserver(observer)
            jumpJob?.cancel()
        }
    }
    val colors = LodyTheme.colors
    val label = stringResource(R.string.home_project_index)
    BoxWithConstraints(modifier) {
        val height = with(density) { (maxHeight - bottom).toPx().coerceAtLeast(0f) }
        val width = with(density) { maxWidth.toPx() }
        val inset = with(density) { LodySpacing.xs.toPx() }
        val wide = with(density) { LodySize.touchTarget.toPx() }
        val pitch = with(density) { LodySize.controlSm.toPx() }.coerceAtMost(
            ((height - inset * 2) / sections.size).coerceAtLeast(0f),
        )
        val capsuleHeight = pitch * sections.size + inset * 2
        val available = foreground && pitch > 0 && (state.canScrollForward || state.canScrollBackward)
        val scrolling = state.isScrollInProgress
        LaunchedEffect(available, scrolling, identities) {
            visibility = visibility.update(available, scrolling = scrolling)
            if (!available) jumpJob?.cancel()
        }
        LaunchedEffect(visibility, available, lingerMillis, interaction) {
            if (available && visibility.lingering) {
                delay(lingerMillis)
                visibility = visibility.hide()
            }
        }
        val current = targets.indexOfLast { it <= state.firstVisibleItemIndex }.coerceAtLeast(0)
        fun select(index: Int) {
            if (!available || !visibility.shown || !lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return
            if (index != selected) haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
            selected = index
            interaction++
            jumpJob?.cancel()
            jumpJob = scope.launch { state.scrollToItem(targets[index]) }
        }
        val latestSelect by rememberUpdatedState<(Int) -> Unit> { select(it) }
        Box(Modifier.fillMaxSize().clipToBounds()) {
            content()
            // Availability loss removes the overlay immediately; ordinary linger expiry slides
            // an opaque surface away, without retaining pointer or accessibility targets.
            if (available) AnimatedVisibility(
                visible = visibility.shown,
                modifier = Modifier.offset {
                    IntOffset((width - inset - wide).roundToInt(), ((height - capsuleHeight) / 2).roundToInt())
                }.then(if (visibility.shown) Modifier else Modifier.clearAndSetSemantics {}),
                enter = slideInHorizontally(tween(180, easing = FastOutSlowInEasing)) { it + inset.roundToInt() },
                exit = slideOutHorizontally(tween(140, easing = FastOutSlowInEasing)) { it + inset.roundToInt() },
            ) {
                Box(
                    Modifier.size(LodySize.touchTarget, with(density) { capsuleHeight.toDp() })
                        .clip(CircleShape)
                        .background(colors.bgOverlay)
                        .semantics { contentDescription = label }
                        .then(if (!visibility.shown) Modifier else Modifier.pointerInput(identities, pitch, inset) {
                            awaitEachGesture {
                                val down = awaitFirstDown()
                                // Compose can expand minimum touch bounds; reject anything outside
                                // the actual visible index before consuming or selecting.
                                if (down.position.x !in 0f..size.width.toFloat() ||
                                    down.position.y !in 0f..size.height.toFloat()) return@awaitEachGesture
                                down.consume()
                                visibility = visibility.update(true, touching = true)
                                var last = projectIndexScrubTarget(down.position.y, inset, pitch, sections.size)
                                latestSelect(last)
                                try {
                                    while (true) {
                                        val event = awaitPointerEvent()
                                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                                        change.consume()
                                        if (!change.pressed) break
                                        val index = projectIndexScrubTarget(change.position.y, inset, pitch, sections.size)
                                        if (index != last) { latestSelect(index); last = index }
                                    }
                                } finally {
                                    visibility = visibility.update(
                                        lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED), touching = false,
                                    )
                                }
                            }
                        }),
                ) {
                    Column(Modifier.fillMaxWidth().padding(vertical = LodySpacing.xs)) {
                        sections.forEachIndexed { index, section ->
                            val title = titles.getValue(section.id)
                            val highlighted = if (visibility.touching) selected else current
                            Box(Modifier.fillMaxWidth().height(with(density) { pitch.toDp() }).clipToBounds()
                                .semantics(mergeDescendants = true) {
                                    contentDescription = title
                                    role = Role.Button
                                    this.selected = index == highlighted
                                    onClick { select(index); true }
                                }, contentAlignment = Alignment.Center) {
                                Box(Modifier.size(LodySize.chip.coerceAtMost(with(density) { pitch.toDp() }))
                                    .background(if (index == highlighted) colors.accentSubtle else androidx.compose.ui.graphics.Color.Transparent, CircleShape),
                                    contentAlignment = Alignment.Center) {
                                    val repository = section.repository
                                    when (section.header) {
                                        HomeSection.Header.Pinned -> Icon(LodyIcons.Pin, null, Modifier.size(LodyIconSize.sm), colors.iconSecondary)
                                        HomeSection.Header.Chats -> Icon(LodyIcons.Session, null, Modifier.size(LodyIconSize.sm), colors.iconSecondary)
                                        else -> if (repository != null) RepositoryIcon(repository, LodyIconSize.sm, opacity = 1f)
                                            else if (title.isNotBlank()) Text(title.take(1).uppercase(), style = LodyTheme.typography.caption, color = colors.textSecondary)
                                            else Icon(LodyIcons.Folder, null, Modifier.size(LodyIconSize.sm), colors.iconSecondary)
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
