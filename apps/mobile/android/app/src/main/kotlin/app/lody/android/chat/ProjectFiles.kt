package app.lody.android.chat

import app.lody.android.designsystem.LodyIconButton as IconButton
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.lody.android.R
import app.lody.android.designsystem.LodyIconSize
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyLoadingIndicator
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTheme
import app.lody.android.runtime.CatalogSession
import app.lody.android.runtime.DirectoryListing
import app.lody.android.runtime.FileContent
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Browse files (conversation More, iOS `FilesController` / `FileContentController`): the
 * session's local project folder by folder, and a Markdown file rendered (with a Source toggle).
 * Other files are listed but not opened yet. Pure path rules live here and are unit tested.
 */
internal object ProjectFiles {
    private val markdownExtensions = setOf("md", "markdown", "mdx")

    /** Only a live local-project conversation can be browsed: `listDir` lists the local project. */
    fun browsable(session: CatalogSession?, creating: Boolean): Boolean =
        session != null && !creating && !session.archived && session.projectId.substringAfter(":local:", "").isNotEmpty() &&
            session.projectId.substringBefore(":local:").isNotEmpty()

    fun isMarkdown(path: String): Boolean = path.substringAfterLast('/').substringAfterLast('.', "").lowercase() in markdownExtensions

    fun join(folder: String, name: String): String = if (folder.isEmpty()) name else "$folder/$name"

    /**
     * A link in [from] resolved to a project-relative Markdown path, as iOS `openLink`: relative
     * links only (no scheme, not absolute), query and fragment dropped, `.` / `..` applied; a link
     * leaving the project or naming a non-Markdown file is null.
     */
    fun linkedMarkdown(from: String, href: String): String? {
        val target = href.substringBefore('#').substringBefore('?')
        if (target.isEmpty() || target.startsWith('/') || target.startsWith('\\') || Regex("^[A-Za-z][A-Za-z0-9+.-]*:").containsMatchIn(target)) return null
        val decoded = try { java.net.URLDecoder.decode(target.replace("+", "%2B"), "UTF-8") } catch (_: IllegalArgumentException) { target }
        val parts = from.split('/').dropLast(1).toMutableList()
        for (part in decoded.split('/')) when (part) {
            "", "." -> Unit
            ".." -> if (parts.isEmpty()) return null else parts.removeAt(parts.lastIndex)
            else -> parts += part
        }
        return parts.joinToString("/").takeIf { it.isNotEmpty() && isMarkdown(it) }
    }
}

private sealed interface FilesPage {
    val path: String
    data class Folder(override val path: String) : FilesPage
    data class File(override val path: String) : FilesPage
}

/**
 * A near full-screen sheet, the same shape as [FilesSheet]: a folder lists its folders and files
 * as one card of ruled rows; a folder or Markdown file slides in, the back arrow or system Back
 * slides back. Links in a rendered file open other Markdown files here and web links in the browser.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ProjectFilesSheet(
    listDir: suspend (relativePath: String) -> DirectoryListing,
    readFile: suspend (path: String) -> FileContent,
    openExternal: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = LodyTheme.colors
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    var stack by remember { mutableStateOf(listOf<FilesPage>(FilesPage.Folder(""))) }
    BackHandler(enabled = stack.size > 1) { stack = stack.dropLast(1) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, containerColor = colors.bgBase) {
        AnimatedContent(
            targetState = stack,
            transitionSpec = {
                val forward = targetState.size >= initialState.size
                (slideInHorizontally { width -> if (forward) width / 3 else -width / 3 } + fadeIn())
                    .togetherWith(slideOutHorizontally { width -> if (forward) -width / 3 else width / 3 } + fadeOut())
            },
            contentKey = { it.size to it.last() },
            label = "project-files",
        ) { pages ->
            val page = pages.last()
            val back: (() -> Unit)? = if (pages.size > 1) ({ stack = pages.dropLast(1) }) else null
            Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
                when (page) {
                    is FilesPage.Folder -> FolderPage(page.path, listDir, back) { stack = pages + it }
                    is FilesPage.File -> FilePage(page.path, readFile, back, openExternal) { stack = pages + FilesPage.File(it) }
                }
            }
        }
    }
}

private sealed interface Loaded<out T> {
    data object Loading : Loaded<Nothing>
    data object Failed : Loaded<Nothing>
    data class Ready<T>(val value: T) : Loaded<T>
}

@Composable
private fun PageHeader(title: String, subtitle: String, back: (() -> Unit)?, trailing: @Composable () -> Unit = {}) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    Row(
        Modifier.fillMaxWidth().padding(start = if (back == null) TranscriptMargin else 0.dp, end = TranscriptMargin, bottom = LodySpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (back != null) IconButton(onClick = back) {
            Icon(LodyIcons.Back, contentDescription = stringResource(R.string.chat_files_back), tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = type.headline, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            if (subtitle.isNotEmpty()) Text(subtitle, style = type.caption, color = colors.textTertiary, maxLines = 1, overflow = TextOverflow.StartEllipsis)
        }
        trailing()
    }
}

@Composable
private fun Centered(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().padding(LodySpacing.xl), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun Notice(text: String, retry: (() -> Unit)?) {
    Column(Modifier.fillMaxWidth().padding(horizontal = TranscriptMargin, vertical = LodySpacing.lg), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
        Text(text, style = LodyTheme.typography.subhead, color = LodyTheme.colors.textSecondary)
        if (retry != null) TextButton(onClick = retry) { Text(stringResource(R.string.files_retry)) }
    }
}

@Composable
private fun FolderPage(path: String, listDir: suspend (String) -> DirectoryListing, back: (() -> Unit)?, open: (FilesPage) -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    var attempt by remember(path) { mutableIntStateOf(0) }
    var state by remember(path) { mutableStateOf<Loaded<DirectoryListing>>(Loaded.Loading) }
    LaunchedEffect(path, attempt) {
        state = Loaded.Loading
        state = try { Loaded.Ready(listDir(path)) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { Loaded.Failed }
    }
    val title = if (path.isEmpty()) stringResource(R.string.files_title) else path.substringAfterLast('/')
    PageHeader(title, path.substringBeforeLast('/', ""), back)
    when (val current = state) {
        Loaded.Loading -> Centered { LodyLoadingIndicator(Modifier.size(LodyIconSize.md), color = colors.iconTertiary) }
        Loaded.Failed -> Notice(stringResource(R.string.files_error_folder)) { attempt++ }
        is Loaded.Ready -> {
            val entries = current.value.entries
            if (entries.isEmpty()) { Notice(stringResource(R.string.files_empty_folder), null); return }
            LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(bottom = LodySpacing.xl)) {
                itemsIndexed(entries, key = { _, entry -> (if (entry.directory) "d:" else "f:") + entry.name }) { index, entry ->
                    val segment = when {
                        entries.size == 1 -> Segment.Only
                        index == 0 -> Segment.First
                        index == entries.lastIndex -> Segment.Last
                        else -> Segment.Middle
                    }
                    val target = ProjectFiles.join(path, entry.name)
                    val opens = entry.directory || ProjectFiles.isMarkdown(entry.name)
                    Row(
                        Modifier.cardSegment(segment).fillMaxWidth().heightIn(min = 48.dp)
                            .then(if (opens) Modifier.clickable(role = Role.Button) { open(if (entry.directory) FilesPage.Folder(target) else FilesPage.File(target)) } else Modifier)
                            .padding(horizontal = LodySpacing.md, vertical = LodySpacing.sm),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
                    ) {
                        val ink = if (opens) colors.textPrimary else colors.textTertiary
                        Icon(if (entry.directory) LodyIcons.Folder else LodyIcons.File, contentDescription = null,
                            tint = if (opens) colors.iconSecondary else colors.iconTertiary, modifier = Modifier.size(LodyIconSize.sm))
                        Text(entry.name, style = type.subhead, color = ink, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.weight(1f))
                        if (opens) Icon(LodyIcons.Forward, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.xs))
                    }
                }
                item(key = "footer") {
                    val notes = listOfNotNull(
                        stringResource(R.string.files_truncated).takeIf { current.value.truncated },
                        stringResource(R.string.files_markdown_only).takeIf { entries.any { !it.directory && !ProjectFiles.isMarkdown(it.name) } },
                    )
                    if (notes.isNotEmpty()) Text(notes.joinToString("\n"), style = type.caption, color = colors.textTertiary,
                        modifier = Modifier.padding(horizontal = TranscriptMargin + LodySpacing.md, vertical = LodySpacing.sm))
                }
            }
        }
    }
}

private val fileErrors = mapOf(
    "too_large" to R.string.files_error_too_large,
    "file_not_found" to R.string.files_error_not_found,
    "permission_denied" to R.string.files_error_permission,
    "path_not_allowed" to R.string.files_error_path,
)

private data class MarkdownFile(val blocks: List<String>, val lines: List<String>)

@Composable
private fun FilePage(path: String, readFile: suspend (String) -> FileContent, back: (() -> Unit)?, openExternal: (String) -> Unit, openFile: (String) -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    var attempt by remember(path) { mutableIntStateOf(0) }
    var source by remember(path) { mutableStateOf(false) }
    var state by remember(path) { mutableStateOf<Loaded<MarkdownFile>>(Loaded.Loading) }
    var error by remember(path) { mutableStateOf<Int?>(null) }
    LaunchedEffect(path, attempt) {
        state = Loaded.Loading
        error = null
        state = try {
            when (val file = readFile(path)) {
                is FileContent.Text -> Loaded.Ready(withContext(Dispatchers.Default) {
                    MarkdownFile(MarkdownBlockSplitter.split(file.text), file.text.lines())
                })
                is FileContent.Binary -> { error = R.string.files_error_binary; Loaded.Failed }
                is FileContent.Failed -> { error = fileErrors[file.code] ?: R.string.files_error_read; Loaded.Failed }
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { error = R.string.files_error_read; Loaded.Failed }
    }
    PageHeader(path.substringAfterLast('/'), path.substringBeforeLast('/', ""), back) {
        if (state is Loaded.Ready) TextButton(onClick = { source = !source }) {
            Text(stringResource(if (source) R.string.files_preview else R.string.files_source))
        }
    }
    val links = remember(path, openExternal, openFile) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val linked = ProjectFiles.linkedMarkdown(path, uri)
                when {
                    linked != null -> openFile(linked)
                    Regex("^(https?|mailto):", RegexOption.IGNORE_CASE).containsMatchIn(uri) -> openExternal(uri)
                }
            }
        }
    }
    when (val current = state) {
        Loaded.Loading -> Centered { LodyLoadingIndicator(Modifier.size(LodyIconSize.md), color = colors.iconTertiary) }
        Loaded.Failed -> Notice(stringResource(error ?: R.string.files_error_read)) { attempt++ }
        is Loaded.Ready -> if (source) {
            val code = type.footnote.copy(fontFamily = type.code.fontFamily)
            SelectionContainer {
                LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(start = TranscriptMargin, end = TranscriptMargin, bottom = LodySpacing.xl)) {
                    itemsIndexed(current.value.lines) { _, line -> Text(line, style = code, color = colors.textPrimary) }
                }
            }
        } else if (current.value.blocks.isEmpty()) {
            Notice(stringResource(R.string.files_empty_file), null)
        } else CompositionLocalProvider(LocalUriHandler provides links) {
            SelectionContainer {
                LazyColumn(
                    Modifier.fillMaxWidth(),
                    contentPadding = PaddingValues(start = TranscriptMargin, end = TranscriptMargin, bottom = LodySpacing.xl),
                    verticalArrangement = Arrangement.spacedBy(LodySpacing.sm),
                ) {
                    itemsIndexed(current.value.blocks) { _, block -> MarkdownBlock(block) }
                }
            }
        }
    }
}
