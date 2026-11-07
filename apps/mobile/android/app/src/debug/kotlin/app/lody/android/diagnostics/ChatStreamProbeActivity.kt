package app.lody.android.diagnostics

import android.os.Bundle
import android.view.Choreographer
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import app.lody.android.chat.TurnIdentity
import app.lody.android.chat.ChatEntry
import app.lody.android.chat.ChatTranscript
import app.lody.android.chat.MarkdownBlocks
import app.lody.android.chat.MarkdownRepair
import app.lody.android.chat.MessageText
import app.lody.android.chat.QuickJsMarkdownRepair
import app.lody.android.chat.renderMarkdown
import app.lody.android.designsystem.LodyLayout
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTheme
import kotlin.random.Random
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.onEach

/**
 * Debug-only spike for the chat transcript: replays a recorded agent reply as a token
 * stream through the production pipeline (QuickJS remend repair → block split → per-block
 * Markdown) and shows repair / split cost and long frames. Toggles compare repair and
 * frame coalescing on and off.
 *
 * adb shell am start -n app.lody.android/app.lody.android.diagnostics.ChatStreamProbeActivity
 */
class ChatStreamProbeActivity : ComponentActivity() {
    private val repair by lazy { QuickJsMarkdownRepair.fromAssets(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val fixture = assets.open("chat/fixture.md").bufferedReader().use { it.readText() }
        setContent { LodyTheme { ProbeScreen(fixture, repair) } }
    }

    override fun onDestroy() {
        super.onDestroy()
        repair.close()
    }
}

private enum class Speed(val label: String, val interval: Duration, val maxChunk: Int) {
    Slow("slow", 60.milliseconds, 4),
    Normal("normal", 30.milliseconds, 8),
    Fast("fast", 12.milliseconds, 16),
    Burst("burst", 4.milliseconds, 32),
}

/** Collects per-render costs and long frames for one run. */
private class Metrics {
    val repair = mutableListOf<Long>()
    val split = mutableListOf<Long>()
    var renders by mutableIntStateOf(0)
    var frames by mutableIntStateOf(0)
    var longFrames by mutableIntStateOf(0)
    var worstFrameMs by mutableIntStateOf(0)

    fun record(blocks: MarkdownBlocks) {
        repair += blocks.repairMicros
        split += blocks.splitMicros
        renders++
    }

    fun frame(nanos: Long) {
        frames++
        val ms = (nanos / 1_000_000).toInt()
        if (ms > LONG_FRAME_MS) longFrames++
        if (ms > worstFrameMs) worstFrameMs = ms
    }

    fun summary(values: List<Long>): String {
        if (values.isEmpty()) return "–"
        val sorted = values.sorted()
        val p50 = sorted[sorted.size / 2]
        val p95 = sorted[((sorted.size - 1) * 0.95).toInt()]
        return "p50 ${p50}µs · p95 ${p95}µs"
    }

    companion object {
        const val LONG_FRAME_MS = 25
    }
}

private fun tokenStream(text: String, speed: Speed, seed: Int): Flow<MessageText> = flow {
    val random = Random(seed)
    var end = 0
    while (end < text.length) {
        end = minOf(text.length, end + 1 + random.nextInt(speed.maxChunk))
        emit(MessageText(text.substring(0, end), streaming = true))
        delay(speed.interval)
    }
    emit(MessageText(text, streaming = false))
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProbeScreen(fixture: String, quickJs: MarkdownRepair) {
    val colors = LodyTheme.colors
    var run by remember { mutableIntStateOf(0) }
    var speed by remember { mutableStateOf(Speed.Normal) }
    var repeat by remember { mutableIntStateOf(1) }
    var repairOn by remember { mutableStateOf(true) }
    var coalesce by remember { mutableStateOf(true) }
    val metrics = remember(run, speed, repeat, repairOn, coalesce) { Metrics() }
    val text = remember(fixture, repeat) { List(repeat) { fixture }.joinToString("\n\n---\n\n") }
    val markdown by remember(metrics) {
        tokenStream(text, speed, seed = run)
            .renderMarkdown(
                repair = if (repairOn) quickJs else MarkdownRepair.None,
                frame = if (coalesce) 33.milliseconds else Duration.ZERO,
            )
            .onEach { metrics.record(it) }
    }.collectAsState(MarkdownBlocks(emptyList(), streaming = true))

    // Frame pacing while this screen is visible.
    DisposableEffect(metrics) {
        val choreographer = Choreographer.getInstance()
        var last = 0L
        var active = true
        val callback = object : Choreographer.FrameCallback {
            override fun doFrame(frameTimeNanos: Long) {
                if (!active) return
                if (last != 0L) metrics.frame(frameTimeNanos - last)
                last = frameTimeNanos
                choreographer.postFrameCallback(this)
            }
        }
        choreographer.postFrameCallback(callback)
        onDispose { active = false; choreographer.removeFrameCallback(callback) }
    }

    Column(Modifier.fillMaxSize().background(colors.bgBase)) {
        Column(
            Modifier
                .fillMaxWidth()
                .background(colors.bgGrouped)
                .statusBarsPadding()
                .padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.sm),
            verticalArrangement = Arrangement.spacedBy(LodySpacing.xs),
        ) {
            val type = LodyTheme.typography
            Text("Chat stream probe", style = type.headline, color = colors.textPrimary)
            Text(
                "${if (markdown.streaming) "streaming" else "done"} · ${markdown.blocks.size} blocks · ${metrics.renders} renders · ${text.length} chars",
                style = type.footnote,
                color = colors.textSecondary,
            )
            Text("repair ${metrics.summary(metrics.repair)}   split ${metrics.summary(metrics.split)}", style = type.codeSmall, color = colors.textSecondary)
            Text(
                "frames ${metrics.frames} · >${Metrics.LONG_FRAME_MS}ms ${metrics.longFrames} · worst ${metrics.worstFrameMs}ms",
                style = type.codeSmall,
                color = if (metrics.longFrames > 0) colors.warningDefault else colors.textSecondary,
            )
            FlowRow(horizontalArrangement = Arrangement.spacedBy(LodySpacing.xs), verticalArrangement = Arrangement.spacedBy(LodySpacing.xs)) {
                Chip("replay", selected = false) { run++ }
                Speed.entries.forEach { Chip(it.label, speed == it) { speed = it } }
                listOf(1, 4, 12).forEach { n -> Chip("×$n", repeat == n) { repeat = n } }
                Chip("repair", repairOn) { repairOn = !repairOn }
                Chip("coalesce", coalesce) { coalesce = !coalesce }
            }
        }
        ChatTranscript(
            entries = listOf(
                ChatEntry.User("user", "为什么移动端刷新一直停在 Syncing？给出修复方案。", TurnIdentity("User")),
                ChatEntry.Assistant.prose("reply-$run", markdown, TurnIdentity("Assistant")),
            ),
            modifier = Modifier.weight(1f).navigationBarsPadding(),
            contentPadding = PaddingValues(vertical = LodySpacing.md),
        )
    }
}

@Composable
private fun Chip(label: String, selected: Boolean, onClick: () -> Unit) {
    val colors = LodyTheme.colors
    Row(
        Modifier
            .clip(RoundedCornerShape(LodyRadius.sm))
            .background(if (selected) colors.accentSubtle else colors.fillSecondary)
            .clickable(onClick = onClick)
            .padding(horizontal = LodySpacing.sm, vertical = LodySpacing.xs),
    ) {
        Text(label, style = LodyTheme.typography.caption, color = if (selected) colors.accentOnSubtle else colors.textPrimary)
    }
}
