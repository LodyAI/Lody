package app.lody.android.chat

import app.lody.android.designsystem.LodyIconButton as IconButton

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.MentionCandidate
import app.lody.android.runtime.MentionCatalogPage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/** One level of the mention panel: the categories (or typed matches), one category, or a folder. */
sealed interface MentionLevel {
    data object Root : MentionLevel
    data class Category(val category: String) : MentionLevel
    data class Directory(val path: String) : MentionLevel
}

/**
 * The composer's @ references, after iOS `ChatMentionPanel` (Notion-style): typing a trigger
 * (`@`, `$` for skills, `/` for commands at the start) opens a panel docked on the keyboard
 * under the prompt; the text after the trigger filters the visible level.
 */
object Mentions {
    /** What the runtime lists (`mentionCatalog` categories). */
    val categories = listOf("file", "skill", "session", "role", "issue", "pr", "cmd")
    /** What the panel shows: prompt shortcuts split from the agent's commands (web). */
    val shownCategories = listOf("file", "skill", "session", "role", "issue", "pr", "shortcut", "cmd")

    /** Whether a trigger's scope includes an item: `/` offers shortcuts and commands (web). */
    private fun inScope(item: MentionCandidate, scoped: String?) =
        scoped == null || item.category == scoped || (scoped == "cmd" && item.category == "shortcut")

    /** The trigger the caret is in: where it starts, the query after it, and its scope. */
    data class Trigger(val start: Int, val end: Int, val query: String, val scoped: String?)

    private val token = Regex("(?:^|\\s)([@$][^\\s@$]*)$|^(/[^\\s/]*)$")

    fun trigger(value: TextFieldValue): Trigger? {
        val selection = value.selection
        // Keyboards compose Latin words too (Gboard), so a composing query still filters.
        if (!selection.collapsed) return null
        val caret = selection.start
        if (caret <= 0 || caret > value.text.length) return null
        val match = token.find(value.text.substring(0, caret)) ?: return null
        val group = match.groups[1] ?: match.groups[2] ?: return null
        var query = group.value.drop(1)
        var scoped: String? = when (group.value.first()) {
            '$' -> "skill"
            '/' -> "cmd"
            else -> null
        }
        val colon = query.indexOf(':')
        if (scoped == null && colon > 0 && query.substring(0, colon) in categories) {
            scoped = query.substring(0, colon)
            query = query.substring(colon + 1)
        }
        return Trigger(group.range.first, caret, query, scoped)
    }

    private fun parent(path: String) = path.substringBeforeLast('/', "")

    private fun matches(item: MentionCandidate, query: String) =
        query.isEmpty() || "${item.name} ${item.path} ${item.subtitle}".contains(query, ignoreCase = true)

    /** The rows one level shows; root categories are `kind = "category"` with `path` = category. */
    fun rows(level: MentionLevel, catalogs: Map<String, MentionCatalogPage>, trigger: Trigger): List<MentionCandidate> {
        val items = categories.flatMap { catalogs[it]?.items.orEmpty() }
        val query = trigger.query
        return when (level) {
            MentionLevel.Root ->
                if (query.isEmpty() && trigger.scoped == null) {
                    shownCategories.filter { category -> category == "file" || category == "skill" || category == "session" || items.any { it.category == category } }
                        .map { MentionCandidate(it, it, "category") }
                } else items.filter { inScope(it, trigger.scoped) && matches(it, query) }.let { found ->
                    // `/` leads with prompt shortcuts, then the agent's commands (web's category order).
                    if (trigger.scoped == "cmd") found.filter { it.category == "shortcut" } + found.filter { it.category != "shortcut" } else found
                }
            is MentionLevel.Category -> {
                val scoped = items.filter { it.category == level.category }
                if (level.category == "file" && query.isEmpty()) scoped.filter { parent(it.path).isEmpty() }
                else scoped.filter { matches(it, query) }
            }
            is MentionLevel.Directory -> {
                val files = items.filter { it.category == "file" }
                if (query.isEmpty()) files.filter { parent(it.path) == level.path }
                else files.filter { it.path.startsWith(level.path + "/") && matches(it, query) }
            }
        }.distinctBy { it.path to it.kind }
    }

    /** Replaces the trigger with the reference and a trailing space, caret after it. */
    fun insert(value: TextFieldValue, trigger: Trigger, item: MentionCandidate): TextFieldValue =
        insertText(value, trigger, token(item))

    /** Replaces the trigger with [text] and a trailing space, caret after it. */
    fun insertText(value: TextFieldValue, trigger: Trigger, text: String): TextFieldValue {
        val written = "$text "
        val next = value.text.replaceRange(trigger.start, trigger.end, written)
        return TextFieldValue(next, TextRange(trigger.start + written.length))
    }

    /** What the prompt shows for a reference: an Agent Role reads as its emoji and name (web). */
    fun shown(item: MentionCandidate): String =
        if (item.kind == "role") roleLabel(item.emoji, item.name) else if (item.kind == "session") "@${item.name}" else item.insertText ?: "@${item.path}"

    fun token(item: MentionCandidate): String = item.insertText ?: "@${item.path}"

    fun roleLabel(emoji: String?, name: String) = listOf(emoji?.takeIf { it.isNotEmpty() } ?: "🪼", name).joinToString(" ")

    /**
     * A prompt shortcut's body as prompt text (web `prepareShortcutSelection`): each reference
     * becomes its token — files `@path`, skills `$name`, issues and pull requests `#number` — and
     * an Agent Role its emoji and name, reported through [role] so it sends `@role:<id>`.
     */
    fun shortcutText(body: org.json.JSONObject, catalogs: Map<String, MentionCatalogPage>, role: (label: String, token: String) -> Unit): String {
        val prompt = body.optString("prompt")
        val list = body.optJSONArray("mentions") ?: org.json.JSONArray()
        val mentions = (0 until list.length()).map { list.getJSONObject(it) }.sortedBy { it.optInt("start") }
        val roles = catalogs["role"]?.items.orEmpty()
        val out = StringBuilder()
        var cursor = 0
        for (mention in mentions) {
            val start = mention.optInt("start", -1)
            val end = mention.optInt("end", -1)
            if (start < cursor || end <= start || end > prompt.length) continue
            out.append(prompt, cursor, start)
            val label = prompt.substring(start, end)
            val target = mention.optJSONObject("target") ?: org.json.JSONObject()
            out.append(
                when (target.optString("kind")) {
                    "file" -> "@" + target.optString("path")
                    "skill" -> if (label.startsWith("$")) label else "$$label"
                    "issue", "pull_request" -> "#" + target.optInt("number")
                    "agent_role" -> {
                        val id = target.optString("agentRoleId")
                        val item = roles.firstOrNull { it.path == id || it.path.startsWith("$id@") }
                        val shown = item?.let { roleLabel(it.emoji, it.name) } ?: label
                        item?.let { token(it) } ?: "@role:$id"
                    }
                    else -> label
                },
            )
            cursor = end
        }
        if (cursor < prompt.length) out.append(prompt, cursor, prompt.length)
        return out.toString()
    }

    fun label(category: String): Int = when (category) {
        "file" -> R.string.mention_files
        "skill" -> R.string.mention_skills
        "session" -> R.string.mention_sessions
        "role" -> R.string.mention_roles
        "issue" -> R.string.mention_issues
        "pr" -> R.string.mention_prs
        "shortcut" -> R.string.mention_shortcuts
        else -> R.string.mention_commands
    }

    fun icon(kind: String): ImageVector = when (kind) {
        "directory", "file" -> if (kind == "directory") LodyIcons.Folder else LodyIcons.File
        "skill" -> LodyIcons.Sparkles
        "session" -> LodyIcons.Sessions
        "role" -> LodyIcons.User
        "issue" -> LodyIcons.Alert
        "pr" -> LodyIcons.PullRequest
        "cmd" -> LodyIcons.Terminal
        "shortcut" -> LodyIcons.Star
        else -> LodyIcons.File
    }
}

/**
 * The panel itself, docked between the prompt and the keyboard. It never takes focus, so the
 * keyboard stays up; categories and folders push the next level, sliding in from the end (back
 * slides it away), with a header carrying back and the level's title.
 */
@Composable
fun MentionPanel(
    stack: List<MentionLevel>,
    rowsFor: (MentionLevel) -> List<MentionCandidate>,
    loading: (MentionLevel) -> Boolean,
    onPush: (MentionLevel) -> Unit,
    onPop: () -> Unit,
    onInsert: (MentionCandidate) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val haptics = LocalHapticFeedback.current
    BackHandler(enabled = stack.size > 1, onBack = onPop)
    Column(
        modifier
            .fillMaxWidth()
            .height(MentionPanelHeight)
            .clip(RoundedCornerShape(topStart = LodyRadius.xl, topEnd = LodyRadius.xl))
            .background(colors.bgRaised),
    ) {
        HorizontalDivider(color = colors.borderSubtle, thickness = 0.5.dp)
        AnimatedContent(
            targetState = stack,
            transitionSpec = {
                val forward = targetState.size >= initialState.size
                val duration = 280
                if (forward) {
                    (slideInHorizontally(tween(duration)) { it } + fadeIn(tween(duration)))
                        .togetherWith(slideOutHorizontally(tween(duration)) { -it / 4 } + fadeOut(tween(duration)))
                } else {
                    (slideInHorizontally(tween(duration)) { -it / 4 } + fadeIn(tween(duration)))
                        .togetherWith(slideOutHorizontally(tween(duration)) { it } + fadeOut(tween(duration)))
                }.using(SizeTransform(clip = true))
            },
            contentKey = { it.size to it.lastOrNull() },
            label = "mention-level",
        ) { levels ->
            val level = levels.last()
            Column(Modifier.fillMaxSize()) {
                if (levels.size > 1) {
                    val back = stringResource(R.string.mention_back)
                    Row(Modifier.fillMaxWidth().heightIn(min = LodySize.controlLg), verticalAlignment = Alignment.CenterVertically) {
                        IconButton(onClick = onPop, modifier = Modifier.semantics { contentDescription = back }) {
                            Icon(LodyIcons.Back, contentDescription = null, tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
                        }
                        Text(
                            when (level) {
                                is MentionLevel.Category -> stringResource(Mentions.label(level.category))
                                is MentionLevel.Directory -> level.path.substringAfterLast('/')
                                MentionLevel.Root -> ""
                            },
                            style = type.headline, color = colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    }
                    HorizontalDivider(color = colors.borderSubtle, thickness = 0.5.dp)
                }
                val rows = rowsFor(level)
                LazyColumn(Modifier.fillMaxSize()) {
                    if (level is MentionLevel.Directory) {
                        item(key = "use-directory") {
                            MentionRow(
                                icon = LodyIcons.Folder, title = stringResource(R.string.mention_directory, level.path.substringAfterLast('/')),
                                subtitle = "", accent = true, disclosure = false,
                            ) { haptics.performHapticFeedback(HapticFeedbackType.Confirm); onInsert(MentionCandidate(level.path, level.path.substringAfterLast('/'), "directory")) }
                        }
                    }
                    items(rows, key = { it.kind + "\n" + it.path }) { item ->
                        val browse = item.kind == "category" || item.kind == "directory"
                        val title = when (item.kind) {
                            "category" -> stringResource(Mentions.label(item.path))
                            "file", "directory" -> item.path.substringAfterLast('/')
                            "skill", "cmd" -> item.insertText ?: item.name
                            else -> item.name
                        }
                        val subtitle = when (item.kind) {
                            "file", "directory" -> item.path.substringBeforeLast('/', "")
                            else -> item.subtitle
                        }
                        MentionRow(
                            icon = Mentions.icon(if (item.kind == "category") item.path else if (item.category == "shortcut") "shortcut" else item.kind),
                            title = title, subtitle = subtitle, accent = false, disclosure = browse,
                            emoji = if (item.kind == "role") item.emoji ?: "🪼" else null,
                        ) {
                            when (item.kind) {
                                "category" -> { haptics.performHapticFeedback(HapticFeedbackType.SegmentTick); onPush(MentionLevel.Category(item.path)) }
                                "directory" -> { haptics.performHapticFeedback(HapticFeedbackType.SegmentTick); onPush(MentionLevel.Directory(item.path)) }
                                else -> { haptics.performHapticFeedback(HapticFeedbackType.Confirm); onInsert(item) }
                            }
                        }
                    }
                    if (rows.isEmpty() && level !is MentionLevel.Directory) {
                        item(key = "empty") {
                            Box(Modifier.fillMaxWidth().padding(vertical = LodySpacing.xl), contentAlignment = Alignment.Center) {
                                Text(
                                    stringResource(if (loading(level)) R.string.mention_loading else R.string.mention_empty),
                                    style = type.subhead, color = colors.textSecondary,
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

/** The panel's height while shown; the keyboard sits right below it. */
val MentionPanelHeight = 280.dp

/** One composer's references: the catalogs read for it and the panel's level stack. */
@Stable
class MentionState {
    var catalogs by mutableStateOf(emptyMap<String, MentionCatalogPage>())
    var pending by mutableStateOf(Mentions.categories.toSet())
    var stack by mutableStateOf(listOf<MentionLevel>(MentionLevel.Root))
    /** Agent Role labels in the prompt ("🧪 Reviewer") to the token they send (`@role:<id>`). */
    var labels by mutableStateOf(emptyMap<String, String>())

    /** The text to send: each Role label back to its token, label by label in order. */
    fun resolve(text: String): String {
        if (labels.isEmpty()) return text
        var result = text
        var cursor = 0
        // Earliest label first, so repeated Roles resolve in place.
        while (true) {
            val next = labels.keys.mapNotNull { label -> result.indexOf(label, cursor).takeIf { it >= 0 }?.let { it to label } }.minByOrNull { it.first } ?: break
            val token = labels.getValue(next.second)
            result = result.replaceRange(next.first, next.first + next.second.length, token)
            cursor = next.first + token.length
        }
        return result
    }

    internal fun presentation(color: androidx.compose.ui.graphics.Color, background: androidx.compose.ui.graphics.Color = androidx.compose.ui.graphics.Color.Unspecified) =
        MentionPresentation(catalogs.values.flatMap { it.items }, color, background, labels.keys)

    /** Reads every category in parallel; a category that fails stays empty. */
    suspend fun load(fetch: suspend (String) -> MentionCatalogPage) = coroutineScope {
        pending = Mentions.categories.toSet()
        Mentions.categories.forEach { category ->
            launch {
                try {
                    val page = fetch(category)
                    catalogs = catalogs + (category to page)
                } catch (cancelled: CancellationException) { throw cancelled }
                catch (_: Exception) { /* The other categories still work. */ }
                finally { pending = pending - category }
            }
        }
    }
}

@Composable
fun rememberMentionState(vararg keys: Any?): MentionState = remember(*keys) { MentionState() }

/**
 * The panel as a composer host places it: right below the composer, at the bottom of a column
 * that already sits on the keyboard (`imePadding`). Shown while [active] (the prompt focused and
 * able to send) and the caret is in a trigger; choosing a row writes the reference into the field.
 */
@Composable
fun MentionDock(
    state: MentionState,
    field: TextFieldValue,
    active: Boolean,
    /** Reads a prompt shortcut's body by id; without it the `/shortcut:<slug>` token goes in. */
    loadShortcut: (suspend (String) -> org.json.JSONObject)? = null,
    onFieldChange: (TextFieldValue) -> Unit,
) {
    val loads = androidx.compose.runtime.rememberCoroutineScope()
    val latest by androidx.compose.runtime.rememberUpdatedState(field)
    val trigger = if (active) Mentions.trigger(field) else null
    // Leaving the trigger (sent, deleted, caret moved) starts the next one at the categories.
    LaunchedEffect(trigger == null) { if (trigger == null) state.stack = listOf(MentionLevel.Root) }
    val show = trigger != null &&
        (state.stack.size > 1 || Mentions.rows(MentionLevel.Root, state.catalogs, trigger).isNotEmpty())
    AnimatedVisibility(
        show,
        enter = expandVertically(expandFrom = Alignment.Top) + fadeIn(),
        exit = shrinkVertically(shrinkTowards = Alignment.Top) + fadeOut(),
    ) {
        MentionPanel(
            stack = state.stack,
            rowsFor = { level -> if (trigger == null) emptyList() else Mentions.rows(level, state.catalogs, trigger) },
            loading = { level ->
                when (level) {
                    // Prompt shortcuts arrive with the commands.
                    is MentionLevel.Category -> (if (level.category == "shortcut") "cmd" else level.category) in state.pending
                    is MentionLevel.Directory -> "file" in state.pending
                    MentionLevel.Root -> state.pending.isNotEmpty()
                }
            },
            onPush = { state.stack = state.stack + it },
            onPop = { if (state.stack.size > 1) state.stack = state.stack.dropLast(1) },
            onInsert = { item ->
                val current = Mentions.trigger(field)
                if (current != null && item.category == "shortcut" && loadShortcut != null) {
                    // Write the shortcut's body (web) once read, if the prompt has not moved on.
                    val before = field
                    loads.launch {
                        val body = try { loadShortcut(item.path) } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null }
                        if (latest.text != before.text) return@launch
                        if (body == null) {
                            val next = Mentions.insert(before, current, item)
                            if (next.text.length <= 32000) onFieldChange(next)
                            return@launch
                        }
                        val roles = mutableMapOf<String, String>()
                        val text = Mentions.shortcutText(body, state.catalogs) { label, token -> roles[label] = token }
                        val next = Mentions.insertText(before, current, text)
                        if (next.text.length <= 32000) {
                            state.labels = state.labels + roles
                            onFieldChange(next)
                        }
                    }
                } else if (current != null) {
                    val next = Mentions.insert(field, current, item)
                    if (next.text.length <= 32000) {
                        onFieldChange(next)
                    }
                }
                state.stack = listOf(MentionLevel.Root)
            },
        )
    }
}

@Composable
private fun MentionRow(
    icon: ImageVector, title: String, subtitle: String, accent: Boolean, disclosure: Boolean,
    emoji: String? = null, onClick: () -> Unit,
) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = LodySize.listRow)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
    ) {
        if (emoji != null) {
            Box(Modifier.size(LodyIconSize.md), contentAlignment = Alignment.Center) {
                Text(emoji, fontSize = with(LocalDensity.current) { (LodyIconSize.md * 0.85f).toSp() })
            }
        } else {
            Icon(icon, contentDescription = null, tint = if (accent) colors.accentFg else colors.iconSecondary, modifier = Modifier.size(LodyIconSize.md))
        }
        Column(Modifier.weight(1f)) {
            Text(title, style = type.body, color = if (accent) colors.accentFg else colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (subtitle.isNotEmpty()) {
                Text(subtitle, style = type.footnote, color = colors.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
        if (disclosure) Icon(LodyIcons.Forward, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.sm))
    }
}
