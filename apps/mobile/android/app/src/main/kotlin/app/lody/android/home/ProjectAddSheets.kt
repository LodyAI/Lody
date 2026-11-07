package app.lody.android.home

import app.lody.android.designsystem.LodyIconButton as IconButton
import app.lody.android.designsystem.LodyTextButton as TextButton
import app.lody.android.designsystem.LodyButton as Button

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.dropShadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import app.lody.android.R
import app.lody.android.designsystem.*
import app.lody.android.runtime.RuntimeScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/**
 * The Projects tab's "+", opened (iOS `ProjectAddMenu`): two capsules spring up from the
 * bottom-end button over a soft scrim — Add GitHub repository above Add local folder. A tap on
 * the scrim, the button again, or Back folds them.
 */
@Composable
fun ProjectAddMenu(open: Boolean, bottomInset: androidx.compose.ui.unit.Dp, onDismiss: () -> Unit, onLocal: () -> Unit, onGitHub: () -> Unit) {
    val colors = LodyTheme.colors
    BackHandler(enabled = open, onBack = onDismiss)
    AnimatedVisibility(open, enter = fadeIn(tween(LodyMotion.fastMillis)), exit = fadeOut(tween(LodyMotion.fastMillis))) {
        Box(
            Modifier.fillMaxSize().background(Color.Black.copy(alpha = 0.18f))
                .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = onDismiss),
        )
    }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.BottomEnd) {
        Column(
            Modifier.navigationBarsPadding().padding(end = LodyLayout.screenPaddingX, bottom = bottomInset),
            horizontalAlignment = Alignment.End,
            verticalArrangement = Arrangement.spacedBy(LodySpacing.sm),
        ) {
            listOf(
                Triple(R.string.projects_add_github, LodyIcons.Github, onGitHub),
                Triple(R.string.projects_add_local, LodyIcons.Folder, onLocal),
            ).forEachIndexed { index, (label, icon, action) ->
                // The capsule nearest the button opens first.
                val delay = (1 - index) * 45
                AnimatedVisibility(
                    open,
                    enter = fadeIn(tween(160, delayMillis = delay)) +
                        scaleIn(spring(dampingRatio = 0.72f, stiffness = 520f), initialScale = 0.6f, transformOrigin = TransformOrigin(1f, 1f)) +
                        slideInVertically(spring(dampingRatio = 0.8f, stiffness = 520f)) { it / 2 },
                    exit = fadeOut(tween(120)) + scaleOut(tween(140), targetScale = 0.7f, transformOrigin = TransformOrigin(1f, 1f)) +
                        slideOutVertically(tween(140)) { it / 3 },
                ) {
                    AddCapsule(stringResource(label), icon) { action() }
                }
            }
        }
    }
}

@Composable
private fun AddCapsule(label: String, icon: ImageVector, onClick: () -> Unit) {
    val colors = LodyTheme.colors
    Row(
        Modifier
            .dropShadow(CircleShape, LodyElevations.md.shadow())
            .clip(CircleShape)
            .background(colors.bgOverlay)
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = LodySize.controlLg)
            .padding(horizontal = LodySpacing.lg),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
    ) {
        Icon(icon, contentDescription = null, tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md))
        Text(label, style = LodyTheme.typography.bodyEmphasis, color = colors.textPrimary)
    }
}

/**
 * Add a local folder (web's add-local-project flow, mobile-shaped): pick the computer (skipped
 * when there is one), browse from home — the path bar goes up a level or takes a typed path —
 * and add the folder that is open. A folder that is already a project comes back as it is.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LocalFolderSheet(service: ProjectAdding, scope: RuntimeScope, onDismiss: () -> Unit, onAdded: (String) -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val browser = remember { ProjectAdding.browserId() }
    val coroutines = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var machines by remember { mutableStateOf<List<AddMachine>?>(null) }
    var machine by remember { mutableStateOf<AddMachine?>(null) }
    var listing by remember { mutableStateOf<FolderListing?>(null) }
    var loading by remember { mutableStateOf(true) }
    var adding by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var editing by remember { mutableStateOf(false) }
    var typed by remember { mutableStateOf("") }
    val readFailed = stringResource(R.string.projects_local_read_failed)
    val machinesFailed = stringResource(R.string.projects_local_machines_failed)
    val addFailed = stringResource(R.string.projects_local_add_failed)

    fun open(target: AddMachine, path: String?) {
        loading = true
        error = null
        coroutines.launch {
            try { listing = service.browse(scope, browser, target.id, path) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { error = readFailed }
            finally { loading = false }
        }
    }
    LaunchedEffect(Unit) {
        try {
            val list = service.machines(scope, browser)
            machines = list
            if (list.size == 1) { machine = list[0]; open(list[0], null) } else loading = false
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { error = machinesFailed; loading = false }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = colors.bgBase) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
            Text(
                stringResource(R.string.projects_add_local), style = type.headline, color = colors.textPrimary,
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = LodySpacing.sm),
            )
            val current = machine
            val folder = listing
            if (current == null) {
                // Computers first, when there is more than one.
                LazyColumn(Modifier.weight(1f)) {
                    items(machines.orEmpty(), key = { it.id }) { item ->
                        SheetRow(LodyIcons.Machine, item.name, null, chevron = true) { machine = item; open(item, null) }
                    }
                }
            } else {
                // The path bar: up a level, the path (tap to type one), the computer.
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = LodyLayout.screenPaddingX).heightIn(min = LodySize.controlLg),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
                ) {
                    val up = stringResource(R.string.projects_local_up)
                    IconButton(
                        onClick = { folder?.parent?.let { open(current, it) } },
                        enabled = folder?.parent != null && !loading,
                        modifier = Modifier.semantics { contentDescription = up },
                    ) { Icon(LodyIcons.Back, contentDescription = null, tint = colors.iconPrimary, modifier = Modifier.size(LodyIconSize.md)) }
                    if (editing) {
                        BasicTextField(
                            typed, { typed = it }, singleLine = true,
                            textStyle = type.subhead.copy(color = colors.textPrimary), cursorBrush = SolidColor(colors.accentDefault),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Go),
                            keyboardActions = KeyboardActions(onGo = { editing = false; typed.trim().takeIf { it.isNotEmpty() }?.let { open(current, it) } }),
                            modifier = Modifier.weight(1f).clip(RoundedCornerShape(LodyRadius.md)).background(colors.fillSecondary).padding(LodySpacing.sm),
                        )
                    } else {
                        Text(
                            folder?.path ?: current.name, style = type.subhead, color = colors.textSecondary, maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f).clip(RoundedCornerShape(LodyRadius.md))
                                .clickable(enabled = folder != null) { typed = folder?.path.orEmpty(); editing = true }.padding(LodySpacing.sm),
                        )
                    }
                }
                HorizontalDivider(color = colors.borderSubtle, thickness = androidx.compose.ui.unit.Dp.Hairline)
                Box(Modifier.weight(1f)) {
                    when {
                        loading && folder == null -> app.lody.android.designsystem.LodyLoadingIndicator(Modifier.align(Alignment.Center).size(LodyIconSize.lg))
                        folder != null -> LazyColumn(Modifier.fillMaxSize()) {
                            if (folder.entries.isEmpty()) item {
                                Text(stringResource(R.string.projects_local_empty), style = type.subhead, color = colors.textTertiary,
                                    textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(LodySpacing.xl))
                            }
                            items(folder.entries, key = { it.path }) { entry ->
                                SheetRow(LodyIcons.Folder, entry.name, null, chevron = !entry.unreadable, dim = entry.unreadable) {
                                    if (!entry.unreadable && !loading) open(current, entry.path)
                                }
                            }
                            folder.next?.let { cursor ->
                                item {
                                    TextButton(onClick = {
                                        loading = true
                                        coroutines.launch {
                                            try {
                                                val more = service.browse(scope, browser, current.id, folder.path, cursor)
                                                val known = folder.entries.map { it.path }.toSet()
                                                if (listing?.path == folder.path) listing = more.copy(entries = folder.entries + more.entries.filter { it.path !in known })
                                            } catch (cancelled: CancellationException) { throw cancelled }
                                            catch (_: Exception) { error = readFailed }
                                            finally { loading = false }
                                        }
                                    }, enabled = !loading, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.projects_local_more)) }
                                }
                            }
                        }
                    }
                }
            }
            error?.let { Text(it, style = type.footnote, color = colors.dangerDefault, modifier = Modifier.padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.xs)) }
            // The one action: add the folder that is open.
            if (current != null) {
                Button(
                    onClick = {
                        listing?.let { target ->
                            adding = true
                            error = null
                            coroutines.launch {
                                try {
                                    val name = service.add(scope, browser, current.id, target.path)
                                    haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                                    onAdded(name)
                                } catch (cancelled: CancellationException) { throw cancelled }
                                catch (_: Exception) { error = addFailed; haptics.performHapticFeedback(HapticFeedbackType.Reject) }
                                finally { adding = false }
                            }
                        }
                    },
                    enabled = listing != null && !loading && !adding,
                    modifier = Modifier.fillMaxWidth().padding(LodyLayout.screenPaddingX).heightIn(min = LodySize.controlLg),
                ) {
                    if (adding) app.lody.android.designsystem.LodyLoadingIndicator(Modifier.size(LodyIconSize.sm), color = colors.textOnAccent)
                    else Text(stringResource(R.string.projects_local_add, listing?.path?.substringAfterLast('/')?.substringAfterLast('\\')?.ifEmpty { listing?.path } ?: ""))
                }
            }
        }
    }
}

/**
 * Add a GitHub repository (iOS `GitHubRepositoryPicker`): the repositories the workspace's Lody
 * GitHub App can reach, searchable, the ones not added yet first. Adding enables it for the
 * workspace (admins and owners); a missing repository is granted on GitHub.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GitHubRepoSheet(service: ProjectAdding, scope: RuntimeScope, onDismiss: () -> Unit, onAdded: (String) -> Unit, onOpenUrl: (String) -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    val coroutines = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var list by remember { mutableStateOf<GitHubRepoList?>(null) }
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    var query by remember { mutableStateOf("") }
    var adding by remember { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val addFailed = stringResource(R.string.projects_github_add_failed)
    val installFailed = stringResource(R.string.projects_github_install_failed)
    LaunchedEffect(attempt) {
        failed = false
        try { list = service.repositories(scope) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { failed = true }
    }
    val install = {
        coroutines.launch {
            try { onOpenUrl(service.installUrl(scope)) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { error = installFailed }
        }
        Unit
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = colors.bgBase) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(0.92f)) {
            Text(
                stringResource(R.string.projects_add_github), style = type.headline, color = colors.textPrimary,
                modifier = Modifier.align(Alignment.CenterHorizontally).padding(bottom = LodySpacing.sm),
            )
            Row(
                Modifier.padding(horizontal = LodyLayout.screenPaddingX, vertical = LodySpacing.xs).fillMaxWidth()
                    .clip(CircleShape).background(colors.fillSecondary).heightIn(min = LodySize.controlMd).padding(horizontal = LodySpacing.md),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(LodySpacing.sm),
            ) {
                Icon(LodyIcons.Search, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.sm))
                Box(Modifier.weight(1f)) {
                    if (query.isEmpty()) Text(stringResource(R.string.projects_github_search), style = type.body, color = colors.textPlaceholder)
                    BasicTextField(query, { query = it }, singleLine = true, textStyle = type.body.copy(color = colors.textPrimary),
                        cursorBrush = SolidColor(colors.accentDefault), modifier = Modifier.fillMaxWidth())
                }
            }
            val current = list
            Box(Modifier.weight(1f)) {
                when {
                    failed -> Message(stringResource(R.string.projects_github_load_failed)) { TextButton(onClick = { attempt++ }) { Text(stringResource(R.string.chat_retry)) } }
                    current == null -> app.lody.android.designsystem.LodyLoadingIndicator(Modifier.align(Alignment.Center).size(LodyIconSize.lg))
                    current.repositories.isNullOrEmpty() -> Message(stringResource(if (current.canManage) R.string.projects_github_none else R.string.projects_github_none_member)) {
                        if (current.canManage) TextButton(onClick = install) { Text(stringResource(R.string.projects_github_install)) }
                    }
                    else -> {
                        val term = query.trim()
                        val rows = current.repositories.orEmpty().filter { term.isEmpty() || it.fullName.contains(term, ignoreCase = true) }
                            .sortedWith(compareBy<GitHubRepo> { it.enabled }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.fullName })
                        LazyColumn(Modifier.fillMaxSize()) {
                            items(rows, key = { it.fullName }) { repo ->
                                val trailing = when {
                                    adding == repo.fullName -> "…"
                                    repo.enabled -> stringResource(R.string.projects_github_added)
                                    else -> null
                                }
                                Row(
                                    Modifier.fillMaxWidth().heightIn(min = LodySize.listRowTwoLine)
                                        .clickable(enabled = current.canManage && !repo.enabled && adding == null, role = Role.Button) {
                                            adding = repo.fullName
                                            error = null
                                            coroutines.launch {
                                                try {
                                                    service.enable(scope, repo.fullName)
                                                    haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                                                    onAdded(repo.fullName)
                                                } catch (cancelled: CancellationException) { throw cancelled }
                                                catch (_: Exception) { error = addFailed; haptics.performHapticFeedback(HapticFeedbackType.Reject) }
                                                finally { adding = null }
                                            }
                                        }
                                        .padding(horizontal = LodyLayout.screenPaddingX),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
                                ) {
                                    RepositoryIcon(repo.fullName, LodySize.avatarMd, opacity = 0.8f)
                                    Column(Modifier.weight(1f)) {
                                        Text(repo.fullName, style = type.body, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                            color = if (repo.enabled || !current.canManage) colors.textSecondary else colors.textPrimary)
                                        if (repo.private) Text(stringResource(R.string.projects_github_private), style = type.footnote, color = colors.textTertiary)
                                    }
                                    when {
                                        trailing != null -> Text(trailing, style = type.footnote, color = colors.textTertiary)
                                        current.canManage -> Icon(LodyIcons.Plus, contentDescription = null, tint = colors.accentFg, modifier = Modifier.size(LodyIconSize.sm))
                                    }
                                }
                            }
                            item {
                                Column(Modifier.padding(LodyLayout.screenPaddingX), verticalArrangement = Arrangement.spacedBy(LodySpacing.sm)) {
                                    error?.let { Text(it, style = type.footnote, color = colors.dangerDefault) }
                                    if (current.canManage) {
                                        Text(stringResource(R.string.projects_github_missing), style = type.footnote, color = colors.textTertiary)
                                        TextButton(onClick = install) { Text(stringResource(R.string.projects_github_install)) }
                                    } else {
                                        Text(stringResource(R.string.projects_github_member_note), style = type.footnote, color = colors.textTertiary)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun BoxScope.Message(text: String, action: @Composable () -> Unit) {
    Column(Modifier.align(Alignment.Center).padding(LodySpacing.xl), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
        Text(text, style = LodyTheme.typography.body, color = LodyTheme.colors.textSecondary, textAlign = TextAlign.Center)
        action()
    }
}

@Composable
private fun SheetRow(icon: ImageVector, title: String, subtitle: String?, chevron: Boolean, dim: Boolean = false, onClick: () -> Unit) {
    val colors = LodyTheme.colors
    Row(
        Modifier.fillMaxWidth().heightIn(min = LodySize.listRow).clickable(enabled = !dim, role = Role.Button, onClick = onClick)
            .padding(horizontal = LodyLayout.screenPaddingX),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(LodySpacing.md),
    ) {
        Icon(icon, contentDescription = null, tint = if (dim) colors.iconTertiary else colors.iconSecondary, modifier = Modifier.size(LodyIconSize.md))
        Column(Modifier.weight(1f)) {
            Text(title, style = LodyTheme.typography.body, color = if (dim) colors.textTertiary else colors.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrEmpty()) Text(subtitle, style = LodyTheme.typography.footnote, color = colors.textTertiary)
        }
        if (chevron) Icon(LodyIcons.Forward, contentDescription = null, tint = colors.iconTertiary, modifier = Modifier.size(LodyIconSize.sm))
    }
}
