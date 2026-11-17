package app.lody.android.chat

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.Orientation
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.draggable
import androidx.compose.foundation.gestures.rememberDraggableState
import androidx.compose.foundation.gestures.rememberTransformableState
import androidx.compose.foundation.gestures.transformable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.min
import androidx.compose.ui.zIndex
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import app.lody.android.R
import app.lody.android.designsystem.LodyIconButton
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTheme
import app.lody.android.runtime.TurnImage
import app.lody.android.runtime.TurnItem
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File
import kotlin.math.abs

/**
 * Images an agent sent in one turn (iOS `ChatImageCell` / `ChatImageStackCell`). One image is a
 * card at its own aspect ratio; several fan into a stack: swiping the top card left sends it to the
 * back, swiping right brings the previous one back, and a tap opens the full-screen viewer.
 */
@Composable
internal fun TurnImages(item: TurnItem.Images, modifier: Modifier = Modifier) {
    var viewer by rememberSaveable(item.id) { mutableStateOf<Int?>(null) }
    var top by rememberSaveable(item.id) { mutableIntStateOf(0) }
    Box(modifier.fillMaxWidth().padding(horizontal = TranscriptMargin, vertical = LodySpacing.sm)) {
        if (item.images.size == 1) SingleImage(item.images.first()) { viewer = 0 }
        else ImageStack(item.images, top.coerceIn(0, item.images.lastIndex), { top = it }) { viewer = it }
    }
    viewer?.let { start ->
        ImageViewer(item.images, start.coerceIn(0, item.images.lastIndex)) { last ->
            // The stack keeps the image the reader ended on at its top, like iOS.
            if (item.images.size > 1) top = last
            viewer = null
        }
    }
}

private val CardShape = RoundedCornerShape(16.dp)

@Composable
private fun SingleImage(image: TurnImage, onOpen: () -> Unit) {
    BoxWithConstraints {
        val ratio = ((image.width ?: 4).toFloat() / (image.height ?: 3).toFloat()).coerceIn(0.1f, 10f)
        val side = min(240.dp, maxWidth * 0.84f)
        val size = if (ratio >= 1) Modifier.width(side).aspectRatio(ratio) else Modifier.width(side * ratio).aspectRatio(ratio)
        val label = stringResource(R.string.chat_image_label, image.fileName)
        val open = stringResource(R.string.chat_image_open)
        ImageCard(image, load = true, ContentScale.Fit, size
            .clickable(onClickLabel = open, role = Role.Image, onClick = onOpen)
            .semantics { contentDescription = label })
    }
}

/** How many cards of a stack are drawn; the rest wait behind, loaded as they come up. */
private const val VisibleDepth = 3

@Composable
private fun ImageStack(images: List<TurnImage>, top: Int, onTop: (Int) -> Unit, onOpen: (Int) -> Unit) {
    val density = LocalDensity.current
    val haptics = LocalHapticFeedback.current
    val coroutines = rememberCoroutineScope()
    val count = images.size
    // Each card's own horizontal offset: the dragged top card, one leaving to the back, or the
    // previous one sliding back in from the right.
    val offsets = remember(images.map { it.id }) { images.associate { it.id to Animatable(0f) } }
    fun depth(index: Int) = (index - top + count) % count
    BoxWithConstraints {
        val cardWidth = min(220.dp, maxWidth * 0.7f)
        val portrait = images.count { (it.height ?: 3) > (it.width ?: 4) } * 2 > count
        val widthPx = with(density) { cardWidth.toPx() }
        val label = stringResource(R.string.chat_image_label, images[top].fileName)
        val page = stringResource(R.string.chat_image_page, top + 1, count)
        val next = stringResource(R.string.chat_image_next)
        val previous = stringResource(R.string.chat_image_previous)
        val open = stringResource(R.string.chat_image_open)
        fun move(delta: Int) {
            val leaving = images[top].id
            val target = (top + delta + count) % count
            val arriving = images[target].id
            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
            coroutines.launch {
                if (delta > 0) {
                    // Thrown left: off the stack, then tucked in behind the rest.
                    offsets.getValue(leaving).animateTo(-widthPx * 1.1f, tween(140))
                    onTop(target)
                    offsets.getValue(leaving).animateTo(0f, spring(dampingRatio = 0.82f, stiffness = 300f))
                } else {
                    // Pulled right: the previous image slides back in over the stack.
                    onTop(target)
                    launch { offsets.getValue(leaving).animateTo(0f, spring(dampingRatio = 0.82f, stiffness = 300f)) }
                    offsets.getValue(arriving).snapTo(widthPx * 1.1f)
                    offsets.getValue(arriving).animateTo(0f, spring(dampingRatio = 0.82f, stiffness = 300f))
                }
            }
        }
        Column {
            Box(
                Modifier.padding(horizontal = 18.dp, vertical = 14.dp).width(cardWidth).aspectRatio(if (portrait) 3f / 4f else 4f / 3f)
                    .pointerInput(images.size, top) {
                        val tracker = VelocityTracker()
                        val card = offsets.getValue(images[top].id)
                        detectHorizontalDragGestures(
                            onDragStart = { tracker.resetTracking() },
                            onDragEnd = {
                                val velocity = tracker.calculateVelocity().x
                                val x = card.value
                                val commits = abs(x) > widthPx * 0.28f || abs(velocity) > 1200f
                                if (commits) move(if ((if (abs(velocity) > 1200f) velocity else x) < 0) 1 else -1)
                                else coroutines.launch { card.animateTo(0f, spring(dampingRatio = 0.82f, stiffness = 400f)) }
                            },
                            onDragCancel = { coroutines.launch { card.animateTo(0f) } },
                        ) { change, dx ->
                            change.consume()
                            tracker.addPosition(change.uptimeMillis, change.position)
                            coroutines.launch { card.snapTo(card.value + dx) }
                        }
                    }
                    .clickable(onClickLabel = open, role = Role.Image) { onOpen(top) }
                    .semantics {
                        contentDescription = label
                        stateDescription = page
                        customActions = listOf(
                            CustomAccessibilityAction(next) { move(1); true },
                            CustomAccessibilityAction(previous) { move(-1); true },
                        )
                    },
            ) {
                for ((index, image) in images.withIndex()) {
                    val depth = depth(index)
                    key(image.id) {
                        val animated by animateFloatAsState(depth.toFloat().coerceAtMost(VisibleDepth.toFloat()), spring(dampingRatio = 0.82f, stiffness = 300f), label = "depth")
                        val offset = offsets.getValue(image.id)
                        ImageCard(
                            image,
                            // Visible cards and the previous one load; deeper ones wait.
                            load = depth < VisibleDepth || depth == count - 1,
                            ContentScale.Crop,
                            Modifier.matchParentSize()
                                .zIndex(-depth.toFloat())
                                .graphicsLayer {
                                    val side = if (depth % 2 == 1) 1f else -1f
                                    val fan = animated
                                    translationX = side * fan * 9.dp.toPx() + offset.value
                                    translationY = fan * 2.dp.toPx() + abs(offset.value) * 0.06f
                                    rotationZ = side * fan * 4.5f + offset.value / widthPx * 12f
                                    val scale = 1f - fan * 0.04f
                                    scaleX = scale
                                    scaleY = scale
                                    alpha = if (depth < VisibleDepth || offset.value != 0f) 1f else (VisibleDepth - animated).coerceIn(0f, 1f)
                                },
                        )
                    }
                }
            }
            Text(
                page,
                modifier = Modifier.width(cardWidth + 36.dp),
                style = LodyTheme.typography.caption,
                color = LodyTheme.colors.textSecondary,
                textAlign = TextAlign.Center,
            )
        }
    }
}

/** A rounded card that loads one thumbnail; a failed load offers a retry. */
@Composable
private fun ImageCard(image: TurnImage, load: Boolean, scale: ContentScale, modifier: Modifier) {
    val source = LocalSessionImages.current
    val colors = LodyTheme.colors
    var bitmap by remember(image.id) { mutableStateOf(source?.cached(image, full = false)) }
    var failed by remember(image.id) { mutableStateOf(source == null) }
    var attempt by remember(image.id) { mutableIntStateOf(0) }
    LaunchedEffect(image.id, load, attempt, source) {
        if (!load || bitmap != null || source == null) return@LaunchedEffect
        failed = false
        bitmap = try { source.bitmap(image, full = false) } catch (error: CancellationException) { throw error } catch (_: Exception) { failed = true; null }
    }
    Box(
        modifier.shadow(3.dp, CardShape, clip = false).clip(CardShape).background(colors.bgSunken).border(0.5.dp, colors.borderSubtle, CardShape),
        contentAlignment = Alignment.Center,
    ) {
        bitmap?.let { Image(it, contentDescription = null, modifier = Modifier.fillMaxSize(), contentScale = scale) }
        if (bitmap == null && !failed && load) CircularProgressIndicator(Modifier.size(LodyIconSize.md), strokeWidth = 2.dp, color = colors.iconSecondary)
        if (failed) {
            Text(
                stringResource(R.string.chat_image_failed),
                modifier = Modifier.padding(LodySpacing.sm).clickable(enabled = source != null) { attempt += 1 },
                style = LodyTheme.typography.caption, color = colors.textSecondary, textAlign = TextAlign.Center,
            )
        }
    }
}

/** App-owned media backdrop: the soft dark canvas, never pure black. */
private val ViewerCanvas = Color(0xFF111113)

/**
 * Full-screen viewer (iOS `ChatImagePreview`): pages through the turn's images, pinch and
 * double-tap zoom, a tap toggles the controls, swiping down (or up) closes it, and a long press
 * offers Copy, Save and Share for the original image. [onDismiss] receives the last page.
 */
@Composable
private fun ImageViewer(images: List<TurnImage>, start: Int, onDismiss: (Int) -> Unit) {
    val pager = rememberPagerState(initialPage = start) { images.size }
    Dialog(
        onDismissRequest = { onDismiss(pager.currentPage) },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val context = LocalContext.current
        val source = LocalSessionImages.current
        val coroutines = rememberCoroutineScope()
        val density = LocalDensity.current
        var chrome by remember { mutableStateOf(true) }
        var zoomed by remember { mutableStateOf(false) }
        var menuAt by remember { mutableStateOf<Offset?>(null) }
        val dragY = remember { Animatable(0f) }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val heightPx = with(density) { maxHeight.toPx() }
            val progress = (abs(dragY.value) / (heightPx * 0.5f)).coerceIn(0f, 1f)
            val closeThreshold = with(density) { 100.dp.toPx() }
            Box(
                Modifier.fillMaxSize().background(ViewerCanvas.copy(alpha = 1f - progress))
                    .draggable(
                        rememberDraggableState { delta -> coroutines.launch { dragY.snapTo(dragY.value + delta) } },
                        Orientation.Vertical,
                        enabled = !zoomed,
                        onDragStopped = { velocity ->
                            coroutines.launch {
                                if (abs(dragY.value) > closeThreshold || abs(velocity) > 1500f) {
                                    dragY.animateTo(if (dragY.value + velocity * 0.05f >= 0) heightPx else -heightPx, tween(180))
                                    onDismiss(pager.currentPage)
                                } else {
                                    dragY.animateTo(0f, spring(dampingRatio = 0.85f, stiffness = 500f))
                                }
                            }
                        },
                    ),
            ) {
                HorizontalPager(
                    pager,
                    Modifier.fillMaxSize().graphicsLayer {
                        translationY = dragY.value
                        val scale = 1f - progress * 0.3f
                        scaleX = scale
                        scaleY = scale
                    },
                    beyondViewportPageCount = 1,
                    userScrollEnabled = !zoomed,
                    pageSpacing = 16.dp,
                    key = { images[it].id },
                ) { page ->
                    ZoomablePage(
                        images[page],
                        current = page == pager.currentPage,
                        onZoom = { if (page == pager.currentPage) zoomed = it },
                        onTap = { chrome = !chrome },
                        onLongPress = { menuAt = it },
                    )
                }
                AnimatedVisibility(chrome && progress == 0f, enter = fadeIn(), exit = fadeOut(), modifier = Modifier.align(Alignment.TopCenter)) {
                    Row(
                        Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = LodySpacing.sm, vertical = LodySpacing.xs),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        ViewerButton(LodyIcons.Close, stringResource(R.string.chat_image_close)) { onDismiss(pager.currentPage) }
                        Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
                            if (images.size > 1) {
                                Text(
                                    stringResource(R.string.chat_image_page, pager.currentPage + 1, images.size),
                                    modifier = Modifier.clip(CircleShape).background(Color.Black.copy(alpha = 0.45f))
                                        .padding(horizontal = LodySpacing.md, vertical = LodySpacing.xs),
                                    style = LodyTheme.typography.footnote, color = Color.White,
                                )
                            }
                        }
                        ViewerButton(LodyIcons.Share, stringResource(R.string.chat_image_share)) {
                            ImageActions.run(context, source, images[pager.currentPage], ImageActions.Kind.SHARE, coroutines)
                        }
                    }
                }
                // Long-press menu, anchored where the finger was.
                val at = menuAt
                Box(Modifier.offset { IntOffset(at?.x?.toInt() ?: 0, at?.y?.toInt() ?: 0) }.size(1.dp)) {
                    DropdownMenu(expanded = at != null, onDismissRequest = { menuAt = null }, offset = DpOffset(0.dp, 0.dp)) {
                        val image = images[pager.currentPage]
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_image_copy)) },
                            leadingIcon = { Icon(LodyIcons.Copy, contentDescription = null, modifier = Modifier.size(LodyIconSize.md)) },
                            onClick = { menuAt = null; ImageActions.run(context, source, image, ImageActions.Kind.COPY, coroutines) },
                        )
                        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.chat_image_save)) },
                                leadingIcon = { Icon(LodyIcons.Download, contentDescription = null, modifier = Modifier.size(LodyIconSize.md)) },
                                onClick = { menuAt = null; ImageActions.run(context, source, image, ImageActions.Kind.SAVE, coroutines) },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.chat_image_share)) },
                            leadingIcon = { Icon(LodyIcons.Share, contentDescription = null, modifier = Modifier.size(LodyIconSize.md)) },
                            onClick = { menuAt = null; ImageActions.run(context, source, image, ImageActions.Kind.SHARE, coroutines) },
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ViewerButton(icon: androidx.compose.ui.graphics.vector.ImageVector, label: String, onClick: () -> Unit) {
    LodyIconButton(onClick = onClick) {
        Box(Modifier.size(40.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = label, tint = Color.White, modifier = Modifier.size(LodyIconSize.md))
        }
    }
}

/** One viewer page: the thumbnail at once, then the original; zoom 1–5×, panning only when zoomed. */
@Composable
private fun ZoomablePage(image: TurnImage, current: Boolean, onZoom: (Boolean) -> Unit, onTap: () -> Unit, onLongPress: (Offset) -> Unit) {
    val source = LocalSessionImages.current
    var bitmap by remember(image.id) { mutableStateOf<ImageBitmap?>(source?.cached(image, full = true) ?: source?.cached(image, full = false)) }
    var full by remember(image.id) { mutableStateOf(source?.cached(image, full = true) != null) }
    var failed by remember(image.id) { mutableStateOf(source == null) }
    var attempt by remember(image.id) { mutableIntStateOf(0) }
    LaunchedEffect(image.id, attempt, source) {
        if (source == null || full) return@LaunchedEffect
        failed = false
        try {
            if (bitmap == null) bitmap = source.bitmap(image, full = false)
            bitmap = source.bitmap(image, full = true)
            full = true
        } catch (error: CancellationException) {
            throw error
        } catch (_: Exception) {
            failed = bitmap == null
        }
    }
    var scale by remember(image.id) { mutableFloatStateOf(1f) }
    var offset by remember(image.id) { mutableStateOf(Offset.Zero) }
    LaunchedEffect(current) { if (!current) { scale = 1f; offset = Offset.Zero } }
    LaunchedEffect(scale > 1.01f) { onZoom(scale > 1.01f) }
    BoxWithConstraints(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val width = constraints.maxWidth.toFloat()
        val height = constraints.maxHeight.toFloat()
        fun clamp(value: Offset, zoom: Float) = Offset(
            value.x.coerceIn(-width * (zoom - 1) / 2, width * (zoom - 1) / 2),
            value.y.coerceIn(-height * (zoom - 1) / 2, height * (zoom - 1) / 2),
        )
        val transform = rememberTransformableState { zoom, pan, _ ->
            scale = (scale * zoom).coerceIn(1f, 5f)
            offset = if (scale > 1.01f) clamp(offset + pan * scale, scale) else Offset.Zero
        }
        Box(
            Modifier.fillMaxSize()
                .pointerInput(image.id) {
                    detectTapGestures(
                        onDoubleTap = { point ->
                            if (scale > 1.01f) { scale = 1f; offset = Offset.Zero }
                            else { scale = 2.5f; offset = clamp((Offset(width / 2, height / 2) - point) * 1.5f, 2.5f) }
                        },
                        onTap = { onTap() },
                        onLongPress = { point -> if (bitmap != null) onLongPress(point) },
                    )
                }
                .transformable(transform, canPan = { scale > 1.01f }),
            contentAlignment = Alignment.Center,
        ) {
            bitmap?.let {
                Image(
                    it, contentDescription = image.fileName,
                    modifier = Modifier.fillMaxSize().graphicsLayer {
                        scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y
                    },
                    contentScale = ContentScale.Fit,
                )
            }
            if (bitmap == null && !failed) CircularProgressIndicator(color = Color.White)
            if (failed) {
                Text(
                    stringResource(R.string.chat_image_failed),
                    modifier = Modifier.clip(RoundedCornerShape(LodyRadius.lg)).clickable { attempt += 1 }.padding(LodySpacing.lg),
                    style = LodyTheme.typography.body, color = Color.White,
                )
            }
        }
    }
}

/** Copy, save and share always use the original bytes, shared through the app's FileProvider. */
internal object ImageActions {
    enum class Kind { COPY, SAVE, SHARE }

    fun run(context: Context, source: SessionImageSource?, image: TurnImage, kind: Kind, scope: kotlinx.coroutines.CoroutineScope) {
        if (source == null) { toast(context, R.string.chat_image_unavailable); return }
        scope.launch {
            val bytes = try { source.original(image) } catch (error: CancellationException) { throw error } catch (_: Exception) { null }
            if (bytes == null) { toast(context, R.string.chat_image_unavailable); return@launch }
            val mime = mime(bytes)
            when (kind) {
                Kind.COPY -> {
                    val uri = withContext(Dispatchers.IO) { file(context, image, bytes, mime) }
                    val clipboard = context.getSystemService(ClipboardManager::class.java)
                    clipboard.setPrimaryClip(ClipData.newUri(context.contentResolver, image.fileName, uri))
                    // Android 13+ confirms clipboard writes itself.
                    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) toast(context, R.string.chat_image_copied)
                }
                Kind.SAVE -> {
                    val saved = withContext(Dispatchers.IO) { save(context, image, bytes, mime) }
                    toast(context, if (saved) R.string.chat_image_saved else R.string.chat_image_save_failed)
                }
                Kind.SHARE -> {
                    val uri = withContext(Dispatchers.IO) { file(context, image, bytes, mime) }
                    val send = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                        .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    send.clipData = ClipData.newRawUri(image.fileName, uri)
                    context.startActivity(Intent.createChooser(send, null))
                }
            }
        }
    }

    private fun toast(context: Context, text: Int) = Toast.makeText(context, text, Toast.LENGTH_SHORT).show()

    private fun mime(bytes: ByteArray): String {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        return bounds.outMimeType ?: "image/png"
    }

    private fun name(image: TurnImage, mime: String): String {
        val extension = when (mime) { "image/jpeg" -> "jpg"; "image/webp" -> "webp"; "image/gif" -> "gif"; else -> "png" }
        val base = image.fileName.substringBeforeLast('.').replace(Regex("[^A-Za-z0-9._-]"), "_").take(64).ifBlank { "image" }
        return "$base.$extension"
    }

    /** A private cache copy behind `res/xml/shared_images.xml`; replaced on every action. */
    private fun file(context: Context, image: TurnImage, bytes: ByteArray, mime: String): Uri {
        val directory = File(context.cacheDir, "shared-images").apply { mkdirs() }
        directory.listFiles()?.forEach { it.delete() }
        val file = File(directory, name(image, mime))
        file.writeBytes(bytes)
        return FileProvider.getUriForFile(context, "${context.packageName}.images", file)
    }

    /** Android 10+: MediaStore needs no storage permission for the app's own new images. */
    private fun save(context: Context, image: TurnImage, bytes: ByteArray, mime: String): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        val resolver = context.contentResolver
        val values = ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, name(image, mime))
            put(MediaStore.Images.Media.MIME_TYPE, mime)
            put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/Lody")
            put(MediaStore.Images.Media.IS_PENDING, 1)
        }
        val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: return false
        return try {
            resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: throw java.io.IOException("stream")
            resolver.update(uri, ContentValues().apply { put(MediaStore.Images.Media.IS_PENDING, 0) }, null, null)
            true
        } catch (_: Exception) {
            resolver.delete(uri, null, null)
            false
        }
    }
}
