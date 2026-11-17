package app.lody.android.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject

interface ShortcutSettingsService {
    suspend fun perform(scope: RuntimeScope, action: ShortcutSettingsAction): ShortcutSettingsResult
}
class RuntimeShortcutSettingsService(private val owner: RuntimeOwner) : ShortcutSettingsService {
    override suspend fun perform(scope: RuntimeScope, action: ShortcutSettingsAction): ShortcutSettingsResult = owner.use(scope) {
        (it.execute(RuntimeCommand.ShortcutSettings(action)) as RuntimeResult.ShortcutSettings).value
    }
}

/**
 * iOS `PromptShortcutsController`: only a live list enables adding; a save shows at once and rolls
 * back if it fails. The list and the bodies already read show at once from the
 * account/workspace settings cache (memory, then disk); a live read replaces them. A cached body
 * is display only: editing and saving always wait for a fresh body read, which is the save base.
 */
internal class ShortcutsState(private val service: ShortcutSettingsService, val scope: RuntimeScope, private val store: SettingsSnapshotStore? = null) {
    var entries by mutableStateOf(remembered?.takeIf { it.first == scope }?.second); private set
    var live by mutableStateOf(false); private set
    var busy by mutableStateOf(false); private set
    var error by mutableStateOf<String?>(null); private set
    private var version = 0
    /** Bodies by the entry JSON they were read for, so any change to the entry misses. */
    private val bodies = (rememberedBodies?.takeIf { it.first == scope }?.second ?: emptyMap()).toMutableMap()

    /** Restores the disk cache when nothing is in memory yet; never replaces a live read. */
    suspend fun restore() {
        if (store == null || (entries != null && bodies.isNotEmpty())) return
        val cached = try { store.readSettings(scope, CACHE_KIND) } catch (cancelled: CancellationException) { throw cancelled } catch (_: Exception) { null } ?: return
        try {
            val list = cached.getJSONArray("entries").let { rows -> (0 until rows.length()).map { ShortcutSettingsJson.cachedEntry(rows.getString(it)) } }
            cached.optJSONArray("bodies")?.let { rows ->
                for (index in 0 until rows.length()) rows.optJSONObject(index)?.let { bodies.putIfAbsent(it.getString("entry"), ShortcutSettingsJson.cachedBody(it.getString("body"))) }
            }
            if (entries == null && !live) entries = list
        } catch (_: Exception) { /* A malformed cache is ignored; the live read follows. */ }
    }

    suspend fun refresh() {
        val id = ++version
        busy = true
        try {
            val result = service.perform(scope, ShortcutSettingsAction.List) as? ShortcutSettingsResult.Listed ?: throw IllegalStateException("invalid_shortcut")
            if (id == version) accept(result.entries)
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { if (id == version) error = "shortcut_load_failed" }
        finally { if (id == version) busy = false }
    }

    /** The last body read for exactly this entry, for display while a fresh read runs. */
    fun cachedBody(entry: ShortcutEntry): ShortcutBody? = bodies[entry.raw]

    /** A fresh body for the editor; null when it changed or access was revoked. */
    suspend fun read(entry: ShortcutEntry): ShortcutBody? = try {
        (service.perform(scope, ShortcutSettingsAction.Read(entry)) as? ShortcutSettingsResult.Read)?.body?.also { keepBody(entry, it) }
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { null }

    /**
     * Reads, one at a time, the bodies of listed entries that are not cached yet, so later opens
     * show their prompt at once. Reads only; stops at [limit].
     */
    suspend fun prefetch(limit: Int = 20) {
        entries.orEmpty().filter { it.raw !in bodies }.take(limit).forEach { entry ->
            if (entries?.any { it.raw == entry.raw } != true) return@forEach
            read(entry)
        }
    }

    /** Returns null on success, else the failure code; [preview] shows until the reply or a rollback. */
    suspend fun save(action: ShortcutSettingsAction.Save, preview: ShortcutEntry): String? {
        val previous = entries
        version++
        entries = (previous.orEmpty().filterNot { it.id == preview.id } + preview).sortedBy { it.name.lowercase() }
        busy = true
        return try {
            service.perform(scope, action)
            busy = false
            refresh()
            null
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Exception) {
            entries = previous
            busy = false
            (failure as? app.lody.android.runtime.RuntimeException)?.fault?.code ?: "shortcut_write_unknown"
        }
    }

    private suspend fun accept(next: List<ShortcutEntry>) {
        entries = next; live = true; error = null
        remembered = scope to next
        // Bodies of entries that changed or went away are dropped.
        val current = next.mapTo(mutableSetOf()) { it.raw }
        bodies.keys.retainAll(current)
        persist()
    }

    private suspend fun keepBody(entry: ShortcutEntry, body: ShortcutBody) {
        bodies[entry.raw] = body
        persist()
    }

    private suspend fun persist() {
        rememberedBodies = scope to bodies.toMap()
        val list = entries ?: return
        if (store == null || !live) return
        // The newest list and at most [BODY_LIMIT] bodies (prompts are up to 16k characters).
        val kept = bodies.entries.filter { (raw, _) -> list.any { it.raw == raw } }.take(BODY_LIMIT)
        val value = JSONObject()
            .put("entries", JSONArray(list.map { it.raw }))
            .put("bodies", JSONArray(kept.map { (raw, body) -> JSONObject().put("entry", raw).put("body", body.raw) }))
        try { store.writeSettings(scope, CACHE_KIND, value) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { /* Only the cache is lost. */ }
    }

    private companion object {
        const val CACHE_KIND = "prompt-shortcuts"
        const val BODY_LIMIT = 64
        /** Process memory (one scope), ahead of the disk cache. */
        @Volatile var remembered: Pair<RuntimeScope, List<ShortcutEntry>>? = null
        @Volatile var rememberedBodies: Pair<RuntimeScope, Map<String, ShortcutBody>>? = null
    }
}

/** [cached] is the last body read for [base], shown read only until the fresh [body] arrives. */
private data class ShortcutDraft(val base: ShortcutEntry?, val body: ShortcutBody?, val cached: ShortcutBody? = null)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ShortcutsScreen(home: ChatListUiState, service: ShortcutSettingsService?, scope: RuntimeScope?, store: SettingsSnapshotStore? = null, onBack: () -> Unit) {
    val state = remember(service, scope, store) { if (service != null && scope != null) ShortcutsState(service, scope, store) else null }
    val tasks = rememberCoroutineScope()
    var draft by remember(scope) { mutableStateOf<ShortcutDraft?>(null) }
    var opening by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val changed = stringResource(R.string.shortcuts_changed)
    LaunchedEffect(state) {
        state ?: return@LaunchedEffect
        state.restore()
        state.refresh()
        // Fill the body cache in the background while the page is open; opening never waits on it.
        state.prefetch()
    }
    BackHandler { if (draft != null) draft = null else onBack() }
    val editing = draft
    if (editing != null && state != null) {
        ShortcutEditor(state, editing, home.userId.orEmpty(), onClose = { draft = null })
        return
    }
    Scaffold(containerColor = LodyTheme.colors.bgBase, snackbarHost = { SnackbarHost(snackbar) }, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(LodyIcons.Back, stringResource(R.string.settings_agent_back)) }
            Text(stringResource(R.string.settings_shortcuts), Modifier.weight(1f), style = LodyTheme.typography.headline, color = LodyTheme.colors.textPrimary)
            IconButton(onClick = { draft = ShortcutDraft(null, null) }, enabled = state != null && state.live) {
                Icon(LodyIcons.Plus, stringResource(R.string.shortcuts_add))
            }
        }
    }) { padding ->
        val entries = state?.entries.orEmpty()
        LazyColumn(Modifier.fillMaxSize(), contentPadding = padding) {
            if (state?.busy == true || opening) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (state?.error != null) item { ShortcutNotice(stringResource(R.string.shortcuts_load_failed)) }
            if (state?.entries != null && entries.isEmpty()) item { ShortcutNotice(stringResource(R.string.shortcuts_empty)) }
            for ((shared, title) in listOf(false to R.string.shortcuts_private, true to R.string.shortcuts_workspace)) {
                val group = entries.filter { it.shared == shared }
                if (group.isEmpty()) continue
                item(key = "header-$shared") { SettingsHeading(stringResource(title)) }
                items(group, key = { "shortcut-${it.id}" }) { entry ->
                    val viewOnly = entry.ownerUserId != home.userId || !entry.simple
                    SettingsLine(entry.name, LodyIcons.File, "/${entry.slug}", onClick = {
                        if (state == null) return@SettingsLine
                        // Open at once from the list entry; the body fills in when its read returns
                        // and saving waits for it (iOS #2531).
                        val opened = ShortcutDraft(entry, null, state.cachedBody(entry))
                        draft = opened
                        opening = true
                        tasks.launch {
                            val body = state.read(entry)
                            opening = false
                            if (draft !== opened) return@launch
                            if (body == null) { draft = null; snackbar.showSnackbar(changed); state.refresh() } else draft = ShortcutDraft(entry, body)
                        }
                    }, leading = {
                        val glyph = entry.emoji
                        if (glyph != null) Text(glyph, style = LodyTheme.typography.body)
                        else Icon(LodyIcons.File, null, Modifier.size(LodyIconSize.md), tint = LodyTheme.colors.textSecondary)
                    }, trailing = {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                            if (viewOnly) Icon(LodyIcons.Eye, stringResource(R.string.shortcuts_view_only), Modifier.size(LodyIconSize.sm), tint = LodyTheme.colors.textSecondary)
                            Icon(LodyIcons.Forward, null, Modifier.size(LodyIconSize.sm), tint = LodyTheme.colors.textSecondary)
                        }
                    })
                }
            }
            if (entries.isNotEmpty()) item { ShortcutNotice(stringResource(R.string.shortcuts_hint)) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ShortcutEditor(state: ShortcutsState, draft: ShortcutDraft, userId: String, onClose: () -> Unit) {
    val base = draft.base
    val body = draft.body
    // An existing shortcut opens before its body is read; nothing is editable until it arrives.
    val loading = base != null && body == null
    val readOnly = base != null && !loading && (base.ownerUserId != userId || !base.simple || body?.simple != true || body.prompt.length > ShortcutSettingsJson.PROMPT_LIMIT)
    var name by remember(base?.id) { mutableStateOf(base?.name.orEmpty()) }
    var slug by remember(base?.id) { mutableStateOf(base?.slug.orEmpty()) }
    var prompt by remember(base?.id) { mutableStateOf((body ?: draft.cached)?.prompt.orEmpty()) }
    LaunchedEffect(base?.id, body) { if (body != null) prompt = body.prompt }
    var shared by remember(base?.id) { mutableStateOf(base?.shared == true) }
    // A save of unknown outcome is held unchanged so a retry can only repeat that same save.
    var attempt by remember(base?.id) { mutableStateOf<ShortcutSettingsAction.Save?>(null) }
    var failure by remember(base?.id) { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val tasks = rememberCoroutineScope()
    val editable = !loading && !readOnly && !saving && attempt == null
    val valid = name.isNotBlank() && prompt.isNotBlank() && ShortcutSettingsJson.validSlug(slug) && prompt.length <= ShortcutSettingsJson.PROMPT_LIMIT
    val save = {
        val action = attempt ?: ShortcutSettingsJson.save(state.scope, base, body, ShortcutFields(name, slug, prompt, shared))
        val preview = ShortcutEntry(action.id, userId, base?.shared ?: shared, name.trim(), base?.emoji, slug, true)
        saving = true; failure = null
        tasks.launch {
            val code = state.save(action, preview)
            saving = false
            if (code == null) onClose()
            else {
                failure = code
                // Only an uncertain outcome holds the attempt; a refusal lets the reader edit again.
                attempt = action.takeIf { code == "shortcut_write_unknown" }
            }
        }
        Unit
    }
    Scaffold(containerColor = LodyTheme.colors.bgBase, topBar = {
        Row(Modifier.fillMaxWidth().statusBarsPadding().padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onClose, enabled = !saving) { Icon(LodyIcons.Close, stringResource(R.string.settings_agent_cancel)) }
            Text(stringResource(if (base == null) R.string.shortcuts_add else R.string.settings_shortcuts), Modifier.weight(1f),
                style = LodyTheme.typography.headline, color = LodyTheme.colors.textPrimary)
            if (!readOnly) IconButton(onClick = save, enabled = !loading && !saving && (attempt != null || valid)) {
                Icon(if (attempt != null) LodyIcons.Refresh else LodyIcons.Check, stringResource(if (attempt != null) R.string.shortcuts_retry else R.string.settings_agent_save))
            }
        }
    }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding).verticalScroll(rememberScrollState()).imePadding()) {
            if (saving || loading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (readOnly) ShortcutNotice(stringResource(R.string.shortcuts_read_only))
            failure?.let { ShortcutNotice(stringResource(if (it == "shortcut_write_unknown") R.string.shortcuts_save_unknown else R.string.shortcuts_save_failed), danger = true) }
            Column(Modifier.padding(horizontal = LodySpacing.lg, vertical = LodySpacing.md), verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
                OutlinedTextField(name, { if (it.length <= 60) name = it }, Modifier.fillMaxWidth(), enabled = editable, singleLine = true,
                    label = { Text(stringResource(R.string.roles_name)) })
                OutlinedTextField(slug, { value -> slug = value.lowercase().filter { it.isLetterOrDigit() || it == '-' }.take(40) }, Modifier.fillMaxWidth(),
                    enabled = editable, singleLine = true, prefix = { Text("/") },
                    label = { Text(stringResource(R.string.shortcuts_slug)) },
                    supportingText = { Text(stringResource(R.string.shortcuts_slug_hint)) },
                    textStyle = LodyTheme.typography.body.copy(fontFamily = FontFamily.Monospace),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false))
            }
            SettingsGroup(stringResource(R.string.shortcuts_prompt)) {
                OutlinedTextField(prompt, { if (it.length <= ShortcutSettingsJson.PROMPT_LIMIT) prompt = it },
                    Modifier.fillMaxWidth().heightIn(min = 180.dp).padding(horizontal = LodySpacing.sm), enabled = editable)
            }
            SettingsGroup {
                SettingsLine(stringResource(R.string.shortcuts_workspace_toggle), LodyIcons.Share, stringResource(R.string.shortcuts_visibility_hint), trailing = {
                    Switch(shared, { shared = it }, enabled = editable && base == null)
                })
            }
            Spacer(Modifier.height(LodySpacing.xxl))
        }
    }
}

@Composable
private fun ShortcutNotice(text: String, danger: Boolean = false) {
    Text(text, Modifier.fillMaxWidth().padding(horizontal = LodySpacing.xxl, vertical = LodySpacing.md), style = LodyTheme.typography.footnote,
        color = if (danger) LodyTheme.colors.dangerDefault else LodyTheme.colors.textSecondary)
}
