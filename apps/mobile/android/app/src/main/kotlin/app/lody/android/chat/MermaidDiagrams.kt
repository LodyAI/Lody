package app.lody.android.chat

import android.content.Context
import android.graphics.Picture
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import app.lody.android.R
import app.lody.android.designsystem.LodyColors
import app.lody.android.designsystem.LodyIconButton
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTheme
import com.caverock.androidsvg.SVG
import com.dokar.quickjs.QuickJs
import kotlin.math.ceil
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

/** A transcript block that is exactly one closed ```mermaid fence: its source, else null. */
internal fun mermaidSource(block: String): String? =
    MermaidFence.matchEntire(block.trim())?.groupValues?.get(2)?.takeIf { it.isNotBlank() }

private val MermaidFence = Regex("^(`{3,}|~{3,})[ \\t]*mermaid[ \\t]*\\n([\\s\\S]*?)\\n?\\1[`~]*[ \\t]*$", RegexOption.IGNORE_CASE)

/** One diagram drawn as a vector [Picture] in SVG pixels (1 px = 1 dp). */
internal class MermaidDiagram(val picture: Picture, val width: Float, val height: Float, val source: String)

/**
 * Renders Mermaid with Pele (the renderer web uses), bundled as the `markdown/MermaidRender.js`
 * asset and run in its own QuickJS engine (no host bindings or network), then draws the SVG with
 * AndroidSVG. Every failure returns null so the block stays a code fence. One engine per process.
 */
internal class MermaidDiagrams(private val loadScript: () -> String) {
    private val setup = Mutex()
    private var engine: QuickJs? = null
    private var unavailable = false
    private val diagrams = LruCache<String, MermaidDiagram>(32)
    private val failures = LruCache<String, Unit>(64)

    fun cached(source: String, palette: MermaidPalette): MermaidDiagram? = diagrams.get(palette.key + source)

    suspend fun render(source: String, palette: MermaidPalette): MermaidDiagram? {
        val key = palette.key + source
        diagrams.get(key)?.let { return it }
        // Bound model-generated input before Pele's parser and layout (iOS uses the same limits).
        if (failures.get(key) != null || source.length > MAX_SOURCE_CHARS || source.lines().size > MAX_SOURCE_LINES) return null
        val js = engine() ?: return null
        val diagram = try {
            // JSON strings and objects are valid JS literals, so neither needs other escaping.
            val svg = js.evaluate<String>("renderMermaid(${JSONObject.quote(source)}, ${palette.json})", "mermaid.js")
            withContext(Dispatchers.Default) { draw(svg, source) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            null
        }
        if (diagram == null) failures.put(key, Unit) else diagrams.put(key, diagram)
        return diagram
    }

    private fun draw(svg: String, source: String): MermaidDiagram? {
        val document = SVG.getFromString(svg)
        val width = document.documentWidth
        val height = document.documentHeight
        if (!(width > 0f && height > 0f && width <= MAX_SIZE && height <= MAX_SIZE)) return null
        val picture = document.renderToPicture(ceil(width).toInt(), ceil(height).toInt())
        return MermaidDiagram(picture, picture.width.toFloat(), picture.height.toFloat(), source)
    }

    private suspend fun engine(): QuickJs? = setup.withLock {
        engine?.let { return it }
        if (unavailable) return null
        var created: QuickJs? = null
        try {
            created = QuickJs.create(Dispatchers.Default)
            created.memoryLimit = MEMORY_LIMIT_BYTES
            created.evaluate<Any?>(loadScript(), ASSET)
            engine = created
            created
        } catch (cancelled: CancellationException) {
            created?.close()
            throw cancelled
        } catch (error: Throwable) {
            created?.close()
            // Missing native library, missing asset or a bad bundle: diagrams stay code.
            unavailable = true
            null
        }
    }

    companion object {
        const val ASSET = "markdown/MermaidRender.js"
        private const val MEMORY_LIMIT_BYTES = 64L shl 20
        private const val MAX_SOURCE_CHARS = 12 * 1024
        private const val MAX_SOURCE_LINES = 128
        private const val MAX_SIZE = 8192f

        @Volatile private var shared: MermaidDiagrams? = null

        fun get(context: Context): MermaidDiagrams = shared ?: synchronized(this) {
            shared ?: context.applicationContext.let { app ->
                MermaidDiagrams { app.assets.open(ASSET).bufferedReader().use { it.readText() } }
            }.also { shared = it }
        }
    }
}

/** The app palette Pele colours a diagram with, as opaque colours over the page. */
internal class MermaidPalette(values: Map<String, Color>, background: Color) {
    private val hex = values.mapValues { (_, color) -> "#%06X".format(color.compositeOver(background).toArgb() and 0xFFFFFF) }
    val json: String = JSONObject(hex).toString()
    val key: String = json + "\n"

    override fun equals(other: Any?) = other is MermaidPalette && other.json == json
    override fun hashCode() = json.hashCode()
}

private fun mermaidPalette(colors: LodyColors) = MermaidPalette(
    mapOf(
        "pele-bg" to colors.bgBase,
        "pele-fg" to colors.textPrimary,
        "pele-muted" to colors.textSecondary,
        "pele-line" to colors.textSecondary,
        "pele-surface" to colors.fillTertiary,
        "pele-surface-alt" to colors.fillSecondary,
        "pele-border" to colors.borderDefault,
        "pele-accent" to colors.accentDefault,
    ),
    colors.bgBase,
)

/**
 * A ```mermaid block drawn as its diagram, fitted to the message width and never upscaled.
 * A tap opens it full screen; a long press copies the source. Until the diagram is ready, or
 * when it cannot be drawn, [fallback] shows the block as code.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun MermaidBlock(source: String, modifier: Modifier = Modifier, fallback: @Composable () -> Unit) {
    val context = LocalContext.current
    val diagrams = remember { MermaidDiagrams.get(context) }
    val colors = LodyTheme.colors
    val palette = remember(colors) { mermaidPalette(colors) }
    // Not keyed by source: a streaming diagram keeps its last drawing while the next renders.
    var diagram by remember { mutableStateOf(diagrams.cached(source, palette)) }
    LaunchedEffect(source, palette) { diagram = diagrams.render(source, palette) }
    val shown = diagram
    if (shown == null) {
        fallback()
        return
    }
    var open by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    val clipboard = LocalClipboardManager.current
    val openLabel = stringResource(R.string.chat_mermaid_open)
    BoxWithConstraints(modifier.fillMaxWidth()) {
        val width = min(maxWidth, shown.width.dp)
        Box {
            DiagramCanvas(
                shown,
                Modifier.size(width, width * (shown.height / shown.width))
                    .semantics { contentDescription = "Mermaid" }
                    .combinedClickable(
                        onClickLabel = openLabel,
                        role = Role.Image,
                        onLongClick = { menu = true },
                        onClick = { open = true },
                    ),
            )
            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                DropdownMenuItem(
                    text = { Text(openLabel) },
                    leadingIcon = { Icon(LodyIcons.Expand, contentDescription = null, modifier = Modifier.size(LodyIconSize.md)) },
                    onClick = { menu = false; open = true },
                )
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.chat_image_copy)) },
                    leadingIcon = { Icon(LodyIcons.Copy, contentDescription = null, modifier = Modifier.size(LodyIconSize.md)) },
                    onClick = { menu = false; clipboard.setText(AnnotatedString(shown.source)) },
                )
            }
        }
    }
    if (open) MermaidViewer(shown) { open = false }
}

@Composable
private fun DiagramCanvas(diagram: MermaidDiagram, modifier: Modifier) {
    Canvas(modifier) {
        drawIntoCanvas { canvas ->
            val native = canvas.nativeCanvas
            val saved = native.save()
            native.scale(size.width / diagram.width, size.height / diagram.height)
            native.drawPicture(diagram.picture)
            native.restoreToCount(saved)
        }
    }
}

/** Full screen on the page background: fitted to the screen, pinch 1–5×, pan while zoomed, double tap to toggle. */
@Composable
private fun MermaidViewer(diagram: MermaidDiagram, onDismiss: () -> Unit) {
    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val colors = LodyTheme.colors
        var scale by remember { mutableFloatStateOf(1f) }
        var offset by remember { mutableStateOf(Offset.Zero) }
        BoxWithConstraints(Modifier.fillMaxSize().background(colors.bgBase), contentAlignment = Alignment.Center) {
            val width = constraints.maxWidth.toFloat()
            val height = constraints.maxHeight.toFloat()
            fun clamp(value: Offset, zoom: Float) = Offset(
                value.x.coerceIn(-width * (zoom - 1) / 2, width * (zoom - 1) / 2),
                value.y.coerceIn(-height * (zoom - 1) / 2, height * (zoom - 1) / 2),
            )
            val transform = rememberTransformableState { zoom, pan, _ ->
                scale = (scale * zoom).coerceIn(1f, MAX_ZOOM)
                offset = if (scale > 1.01f) clamp(offset + pan * scale, scale) else Offset.Zero
            }
            val inset = LodySpacing.lg
            val fit = kotlin.math.min(
                (maxWidth - inset * 2).value / diagram.width,
                (maxHeight - inset * 2 - VIEWER_CHROME).value / diagram.height,
            )
            Box(
                Modifier.fillMaxSize()
                    .pointerInput(Unit) {
                        detectTapGestures(onDoubleTap = { point ->
                            if (scale > 1.01f) { scale = 1f; offset = Offset.Zero }
                            else { scale = DOUBLE_TAP_ZOOM; offset = clamp((Offset(width / 2, height / 2) - point) * (DOUBLE_TAP_ZOOM - 1), DOUBLE_TAP_ZOOM) }
                        })
                    }
                    .transformable(transform, canPan = { scale > 1.01f }),
                contentAlignment = Alignment.Center,
            ) {
                DiagramCanvas(
                    diagram,
                    Modifier.size((diagram.width * fit).dp, (diagram.height * fit).dp)
                        .semantics { contentDescription = "Mermaid" }
                        .graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
                )
            }
            Box(Modifier.align(Alignment.TopStart).statusBarsPadding().padding(horizontal = LodySpacing.sm, vertical = LodySpacing.xs)) {
                LodyIconButton(onClick = onDismiss) {
                    Box(Modifier.size(40.dp).clip(CircleShape).background(colors.fillSecondary), contentAlignment = Alignment.Center) {
                        Icon(LodyIcons.Close, contentDescription = stringResource(R.string.chat_mermaid_close), tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
                    }
                }
            }
        }
    }
}

private const val MAX_ZOOM = 5f
private const val DOUBLE_TAP_ZOOM = 2.5f
// The close button's row plus the status bar, kept clear of the fitted diagram.
private val VIEWER_CHROME = 112.dp
