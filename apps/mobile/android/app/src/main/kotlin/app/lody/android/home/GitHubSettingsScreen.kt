package app.lody.android.home

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.RuntimeScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * Settings › GitHub (iOS `GitHubSettingsController`): who acts on GitHub for you, the workspace's
 * GitHub App, then its repositories as Material switches with the owner's logo, filtered by the
 * search field above the list. Members see the switches but only owners and admins change them.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun GitHubSettingsScreen(service: GitHubSettingsService?, scope: RuntimeScope?, onBack: () -> Unit) {
    val state = remember(service, scope) { if (service != null && scope != null) GitHubSettingsState(service, scope) else null }
    val colors = LodyTheme.colors
    val tasks = rememberCoroutineScope()
    val uriHandler = LocalUriHandler.current
    val snackbar = remember { SnackbarHostState() }
    var query by rememberSaveable(scope) { mutableStateOf("") }
    var pulling by remember { mutableStateOf(false) }
    var opened by remember { mutableStateOf(false) }
    val installFailed = stringResource(R.string.github_settings_install_failed)
    LaunchedEffect(state) { state?.refresh() }
    // Returning from the GitHub App's page re-reads, as iOS does on becoming active.
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, state) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME && opened) { opened = false; tasks.launch { state?.refresh() } }
        }
        lifecycle.addObserver(observer)
        onDispose { lifecycle.removeObserver(observer) }
    }
    BackHandler(onBack = onBack)
    Scaffold(containerColor = colors.bgBase, snackbarHost = { SnackbarHost(snackbar) }, topBar = {
        Column(Modifier.fillMaxWidth().statusBarsPadding()) {
            Row(Modifier.fillMaxWidth().padding(horizontal = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = onBack) { Icon(LodyIcons.Back, stringResource(R.string.settings_agent_back)) }
                Text(stringResource(R.string.settings_github), Modifier.weight(1f), style = LodyTheme.typography.headline, color = colors.textPrimary)
            }
            if (!state?.data?.repositories.isNullOrEmpty()) SearchField(query) { query = it }
        }
    }) { padding ->
        PullToRefreshBox(
            isRefreshing = pulling,
            onRefresh = { tasks.launch { pulling = true; try { state?.refresh() } finally { pulling = false } } },
            modifier = Modifier.fillMaxSize().padding(top = padding.calculateTopPadding()),
        ) {
            val data = state?.shown
            val editable = state?.editable == true
            LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = padding.calculateBottomPadding() + LodySpacing.xxl)) {
                if (state?.loading == true && state.data == null && !pulling) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
                state?.let { current ->
                    val notice = when {
                        current.unconfirmed -> R.string.github_settings_unconfirmed
                        current.failed && current.data == null -> R.string.github_settings_load_failed
                        current.failed -> R.string.github_settings_stale
                        current.data?.errors?.isNotEmpty() == true -> R.string.github_settings_partial
                        else -> null
                    }
                    if (notice != null) item(key = "notice") {
                        Notice(stringResource(notice)) { tasks.launch { current.refresh() } }
                    }
                }
                if (data == null) return@LazyColumn
                val searching = query.isNotBlank()
                val repositories = GitHubSettingsModel.repositories(data, query)
                if (!searching) {
                    item(key = "personal") {
                        SettingsGroup(stringResource(R.string.github_settings_personal)) {
                            IdentityLine(data.personal)
                            data.personal?.let { personal ->
                                SwitchLine(
                                    stringResource(R.string.github_settings_act_as_you), null, personal.enabled,
                                    enabled = editable && GitHubSettingsModel.personalEditable(personal),
                                    leading = { Icon(LodyIcons.User, null, Modifier.size(LodyIconSize.md), tint = colors.textSecondary) },
                                ) { tasks.launch { state?.setPersonal(it) } }
                            }
                            Hint(stringResource(R.string.github_settings_personal_hint))
                        }
                    }
                    if (data.canManage) item(key = "install") {
                        SettingsGroup(stringResource(R.string.github_settings_app)) {
                            SettingsLine(stringResource(R.string.github_settings_manage_app), LodyIcons.Github, onClick = {
                                val current = state
                                if (!editable || current == null) return@SettingsLine
                                tasks.launch {
                                    try { val url = current.installUrl(); opened = true; uriHandler.openUri(url) }
                                    catch (cancelled: CancellationException) { throw cancelled }
                                    catch (_: Exception) { snackbar.showSnackbar(installFailed) }
                                }
                            }, trailing = { Icon(LodyIcons.ExternalLink, null, Modifier.size(LodyIconSize.sm), tint = colors.textSecondary) })
                            Hint(stringResource(R.string.github_settings_browser_hint))
                        }
                    }
                }
                item(key = "repositories-header") {
                    val all = data.repositories
                    val count = if (all.isNullOrEmpty()) null else stringResource(R.string.github_settings_enabled_count, all.count { it.enabled }, all.size)
                    Row(Modifier.fillMaxWidth().padding(start = LodySpacing.lg + LodySpacing.sm, end = LodySpacing.xxl, top = LodySpacing.md, bottom = LodySpacing.sm)) {
                        Text(stringResource(R.string.github_settings_repositories), Modifier.weight(1f), style = LodyTheme.typography.footnote, color = colors.textSecondary)
                        if (count != null) Text(count, style = LodyTheme.typography.footnote, color = colors.textSecondary)
                    }
                }
                when {
                    data.repositories == null -> item(key = "repositories-unavailable") { Hint(stringResource(R.string.github_settings_repositories_unavailable)) }
                    searching && repositories.isEmpty() -> item(key = "no-match") { Hint(stringResource(R.string.github_settings_no_match, query.trim())) }
                    else -> items(repositories, key = { "repo:${it.fullName}" }) { repo ->
                        Box(Modifier.padding(horizontal = LodySpacing.lg)) {
                            SwitchLine(
                                repo.name, listOf(repo.owner, stringResource(if (repo.private) R.string.github_settings_private else R.string.github_settings_public)).joinToString(" · "),
                                repo.enabled, enabled = editable && data.canManage,
                                leading = { RepositoryIcon(repo.fullName, LodyIconSize.lg, opacity = 0.8f) },
                            ) { tasks.launch { state?.setRepository(repo.fullName, it) } }
                        }
                    }
                }
                if (!searching && data.repositories != null) item(key = "repositories-hint") {
                    val hint = when {
                        !data.roleKnown -> R.string.github_settings_role_unknown
                        data.canManage -> R.string.github_settings_repositories_hint
                        else -> R.string.github_settings_read_only
                    }
                    Column(Modifier.padding(horizontal = LodySpacing.lg)) {
                        if (data.repositories.isEmpty()) Hint(stringResource(R.string.github_settings_empty))
                        Hint(stringResource(hint))
                    }
                }
            }
        }
    }
}

@Composable
private fun SearchField(query: String, onChange: (String) -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    Row(
        Modifier.padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.xs).fillMaxWidth()
            .clip(CircleShape).background(colors.fillSecondary).heightIn(min = LodySize.controlMd).padding(horizontal = LodySpacing.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
    ) {
        Icon(LodyIcons.Search, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.sm))
        Box(Modifier.weight(1f)) {
            if (query.isEmpty()) Text(stringResource(R.string.github_settings_search), style = type.body, color = colors.textPlaceholder)
            BasicTextField(query, onChange, singleLine = true, textStyle = type.body.copy(color = colors.textPrimary),
                cursorBrush = SolidColor(colors.accentDefault), modifier = Modifier.fillMaxWidth())
        }
        if (query.isNotEmpty()) IconButton(onClick = { onChange("") }, Modifier.size(LodySize.controlMd)) {
            Icon(LodyIcons.Close, stringResource(R.string.github_settings_search_clear), Modifier.size(LodyIconSize.sm), tint = colors.iconTertiary)
        }
    }
}

@Composable
private fun IdentityLine(personal: GitHubPersonalSettings?) {
    val identity = personal?.identity
    val login = identity?.login?.takeIf { identity.state == "authorized" }
    val title = login ?: stringResource(when (identity?.state) {
        "missing" -> R.string.github_settings_identity_missing
        "expired" -> R.string.github_settings_identity_expired
        "authorized" -> R.string.github_settings_identity_authorized
        else -> R.string.github_settings_identity_unknown
    })
    val subtitle = when {
        identity == null -> null
        login != null -> stringResource(R.string.github_settings_identity_authorized)
        identity.state == "expired" -> stringResource(R.string.github_settings_identity_expired_hint)
        identity.state == "missing" -> stringResource(R.string.github_settings_identity_missing_hint)
        else -> null
    }
    val avatar = GitHubSettingsModel.avatarUrl(login)
    val leading: (@Composable () -> Unit)? = if (avatar == null) null else { { Avatar(avatar, login.orEmpty(), LodySize.avatarMd) } }
    SettingsLine(title, LodyIcons.Github, subtitle, leading = leading)
}

@Composable
private fun SwitchLine(title: String, subtitle: String?, checked: Boolean, enabled: Boolean, leading: @Composable () -> Unit, onChange: (Boolean) -> Unit) {
    val colors = LodyTheme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = if (subtitle == null) LodySize.controlLg else LodySize.listRowTwoLine)
            .toggleable(checked, enabled = enabled, role = Role.Switch, onValueChange = onChange)
            .padding(horizontal = LodySpacing.lg, vertical = LodySpacing.sm),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
    ) {
        leading()
        Column(Modifier.weight(1f)) {
            Text(title, style = LodyTheme.typography.body, color = if (enabled || checked) colors.textPrimary else colors.textSecondary)
            if (!subtitle.isNullOrBlank()) Text(subtitle, style = LodyTheme.typography.footnote, color = colors.textSecondary)
        }
        // The row owns the toggle so the whole line is one target; the switch only draws it.
        Switch(checked = checked, onCheckedChange = null, enabled = enabled)
    }
}

@Composable
private fun Hint(text: String) {
    Text(text, style = LodyTheme.typography.footnote, color = LodyTheme.colors.textSecondary,
        modifier = Modifier.padding(horizontal = LodySpacing.lg, vertical = LodySpacing.sm))
}

@Composable
private fun Notice(text: String, onRetry: () -> Unit) {
    val colors = LodyTheme.colors
    Row(Modifier.fillMaxWidth().padding(horizontal = LodySpacing.lg, vertical = LodySpacing.sm), verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
        Icon(LodyIcons.Alert, null, Modifier.size(LodyIconSize.md), tint = colors.textSecondary)
        Text(text, Modifier.weight(1f), style = LodyTheme.typography.footnote, color = colors.textSecondary)
        TextButton(onClick = onRetry) { Text(stringResource(R.string.chat_retry)) }
    }
}
