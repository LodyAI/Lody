package app.lody.android.home

import app.lody.android.auth.WorkspaceMember

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import app.lody.android.chat.TabBrowsing
import app.lody.android.chat.ChatRepository
import app.lody.android.chat.ChatScreen
import app.lody.android.create.CreateSessionScreen
import androidx.compose.animation.*
import androidx.compose.animation.core.tween
import androidx.activity.compose.BackHandler
import app.lody.android.runtime.RuntimeScope
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import app.lody.android.LodyApplication
import app.lody.android.R
import app.lody.android.auth.AuthState
import app.lody.android.catalog.CatalogState
import app.lody.android.catalog.ConnectionPhase
import app.lody.android.designsystem.LodyMotion
import app.lody.android.designsystem.LodyLayout
import app.lody.android.designsystem.LodyRadius
import app.lody.android.designsystem.LodySize
import app.lody.android.designsystem.LodySpacing
import app.lody.android.designsystem.LodyTheme

/** Launcher: sign-in when there is no account, otherwise the Home chat list. Reads app-owned state only. */
class HomeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        val app = application as LodyApplication
        val auth = app.account.state.value
        if (savedInstanceState == null && auth.account == null && !auth.busy) app.account.restore()
        setContent {
            LodyTheme {
                val account by app.account.state.collectAsState()
                val remoteCatalog by app.cloud.state.collectAsState()
                val submissions by app.submissions.state.collectAsState()
                val activeScope = account.account?.id?.let { userId -> remoteCatalog.workspace?.id?.let { RuntimeScope(userId, it) } }
                LaunchedEffect(activeScope) { app.submissions.activate(activeScope) }
                var members by remember(activeScope) { mutableStateOf(emptyMap<String, WorkspaceMember>()) }
                LaunchedEffect(activeScope) {
                    activeScope?.let { scope -> app.members.observe(scope).collect { members = it } }
                }
                val browsing = remember {
                    val prefs = getSharedPreferences("tab-browsing-v1", MODE_PRIVATE)
                    TabBrowsing({ prefs.getString(it, null) }) { key, value -> prefs.edit().putString(key, value).apply() }
                }
                val browsingRevision by browsing.revision.collectAsState()
                var resumed by remember { mutableStateOf(lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)) }
                DisposableEffect(Unit) {
                    val observer = androidx.lifecycle.LifecycleEventObserver { _, _ ->
                        resumed = lifecycle.currentState.isAtLeast(androidx.lifecycle.Lifecycle.State.RESUMED)
                    }
                    lifecycle.addObserver(observer)
                    onDispose { lifecycle.removeObserver(observer) }
                }
                val pending = submissions.values.filter { it.scope == activeScope }
                val catalog = remember(remoteCatalog, pending, activeScope, browsingRevision) {
                    remoteCatalog.copy(snapshot = remoteCatalog.snapshot?.let { snapshot ->
                        val rows = snapshot.sessions + pending.map { it.session }.filter { local -> snapshot.sessions.none { it.id == local.id } }
                        snapshot.copy(sessions = rows.map { session -> activeScope?.let { browsing.viewed(it, session) } ?: session })
                    })
                }
                val user = account.account
                var selectedId by rememberSaveable(user?.id, catalog.workspace?.id) { mutableStateOf<String?>(null) }
                var selectedTitle by rememberSaveable(user?.id, catalog.workspace?.id) { mutableStateOf("") }
                var creating by rememberSaveable(user?.id, catalog.workspace?.id) { mutableStateOf(false) }
                val repository = remember { ChatRepository(app.runtimeOwner, app.pullRequests, app.attachments) }
                val selectedSession = catalog.snapshot?.sessions?.firstOrNull { it.id == selectedId }
                LaunchedEffect(selectedSession, activeScope, resumed) {
                    if (resumed && activeScope != null && selectedSession != null) {
                        browsing.visit(activeScope, selectedSession, catalog.snapshot?.sessions.orEmpty())
                    }
                }
                val creator = app.creation
                val screens = rememberSaveableStateHolder()
                // The repository restores the cached workspace; a first sign-in picks the first one.
                LaunchedEffect(user, catalog.workspace) {
                    val first = user?.workspaces?.firstOrNull()
                    if (first != null && catalog.workspace == null && !account.busy) app.cloud.select(first)
                }
                if (user == null) {
                    SignInScreen(
                        state = account,
                        onSignIn = { app.account.login() },
                        onOpen = { url -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) },
                        onCancel = { app.account.cancel() },
                    )
                } else {
                    val workspace = catalog.workspace
                    val route = selectedId ?: if (creating) "create" else "home"
                    AnimatedContent(
                        targetState = route, modifier = Modifier.fillMaxSize(),
                        transitionSpec = {
                            val motion = tween<androidx.compose.ui.unit.IntOffset>(LodyMotion.slowMillis)
                            if (targetState == "home") {
                                (slideInHorizontally(motion) { -it / 4 } + fadeIn(tween(LodyMotion.baseMillis))) togetherWith
                                    slideOutHorizontally(motion) { it }
                            } else {
                                slideInHorizontally(motion) { it } togetherWith
                                    (slideOutHorizontally(motion) { -it / 4 } + fadeOut(tween(LodyMotion.baseMillis)))
                            }.using(null) // Full-screen pages; IME resizing must not animate the route's size again.
                        }, label = "session-navigation",
                    ) { destination ->
                        val id = destination.takeUnless { it == "create" || it == "home" }
                        if (id != null && workspace != null) {
                            ChatScreen(repository, RuntimeScope(user.id, workspace.id), id, chatContext(catalog, id, selectedTitle, user), onBack = { selectedId = null }, onSelectTab = { selectedId = it; selectedTitle = "" }, creation = submissions[id]?.takeIf { it.scope == activeScope })
                        } else if (destination == "create" && workspace != null) {
                            // Like web, new session is its own full screen over Home; back returns.
                            BackHandler { creating = false }
                            CreateSessionScreen(catalog.snapshot, creator, RuntimeScope(user.id, workspace.id), onSubmit = { request -> app.submissions.submit(RuntimeScope(user.id, workspace.id), request); selectedId = request.sessionId; selectedTitle = request.text.take(200); creating = false }, onBack = { creating = false })
                        } else screens.SaveableStateProvider("list/${user.id}/${workspace?.id}") {
                            ChatListScreen(
                                state = uiState(account, catalog).copy(members = members + listOfNotNull(user?.let { it.id to (members[it.id] ?: WorkspaceMember(it.id, it.name, it.image)) }).toMap()),
                                onSelectWorkspace = { app.cloud.select(it) },
                                onSignOut = { app.account.logout() },
                                onOpenChat = { row ->
                                    val session = catalog.snapshot?.sessions?.firstOrNull { it.id == row.id }
                                    selectedId = if (activeScope != null && session != null) browsing.resolve(activeScope, session, catalog.snapshot?.sessions.orEmpty()) else row.id
                                    selectedTitle = if (selectedId == row.id) row.title else ""
                                },
                                onNewChat = { creating = true },
                                projects = app.projectAdding,
                                scope = workspace?.let { RuntimeScope(user.id, it.id) },
                                onOpenUrl = { url -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun uiState(auth: AuthState, catalog: CatalogState): ChatListUiState {
    val user = auth.account
    val workspace = catalog.workspace
    val snapshot = catalog.snapshot
    // Only actionable connection state reaches the sync pill; a live list shows none.
    val sync = when (catalog.phase) {
        ConnectionPhase.CONNECTING, ConnectionPhase.SYNCING -> HomeSyncState.Syncing
        ConnectionPhase.UNAVAILABLE, ConnectionPhase.PAUSED -> HomeSyncState.Offline
        else -> HomeSyncState.Live
    }
    val placeholder = when {
        snapshot == null && catalog.phase in setOf(ConnectionPhase.UNAVAILABLE, ConnectionPhase.PAUSED) -> stringResource(R.string.home_offline)
        snapshot == null && user?.workspaces?.isEmpty() == true -> stringResource(R.string.home_no_workspaces)
        snapshot == null -> stringResource(R.string.home_loading)
        else -> stringResource(R.string.home_empty)
    }
    val name = workspace?.name ?: stringResource(R.string.app_name)
    return ChatListUiState(
        workspaceName = name,
        initial = name.take(1).uppercase(),
        // The selected workspace's logo comes from the account's list (the catalog may hold an older copy).
        workspaceImage = user?.workspaces?.firstOrNull { it.id == workspace?.id }?.image ?: workspace?.image,
        accountImage = user?.image,
        sync = sync,
        accountName = user?.name.orEmpty(),
        timeline = snapshot?.let { ChatListModel.timeline(it) }.orEmpty(),
        snapshot = snapshot,
        userId = user?.id,
        projects = snapshot?.let(ChatListModel::groups).orEmpty(),
        placeholder = placeholder,
        workspaces = user?.workspaces.orEmpty(),
        workspaceId = workspace?.id,
    )
}

@Composable
private fun SignInScreen(state: AuthState, onSignIn: () -> Unit, onOpen: (String) -> Unit, onCancel: () -> Unit) {
    val colors = LodyTheme.colors
    val type = LodyTheme.typography
    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(colors.bgBase)
            .safeDrawingPadding()
            .padding(horizontal = LodyLayout.screenPaddingX * 2),
        contentAlignment = Alignment.Center,
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(LodySpacing.md)) {
            Text(stringResource(R.string.sign_in_title), style = type.title, color = colors.textPrimary, textAlign = TextAlign.Center)
            val verification = state.verification
            if (verification == null) {
                Text(stringResource(R.string.sign_in_body), style = type.body, color = colors.textSecondary, textAlign = TextAlign.Center)
                PrimaryButton(
                    label = stringResource(if (state.busy) R.string.sign_in_connecting else R.string.sign_in_action),
                    enabled = !state.busy,
                    onClick = onSignIn,
                )
            } else {
                Text(stringResource(R.string.sign_in_code), style = type.subhead, color = colors.textTertiary)
                Text(verification.userCode, style = type.title.copy(fontFamily = type.code.fontFamily), color = colors.textPrimary)
                Text(
                    stringResource(R.string.sign_in_code_hint, verification.expiresIn / 60),
                    style = type.footnote,
                    color = colors.textSecondary,
                    textAlign = TextAlign.Center,
                )
                PrimaryButton(stringResource(R.string.sign_in_open), enabled = true) { onOpen(verification.url) }
                Text(
                    stringResource(R.string.sign_in_cancel),
                    style = type.subhead,
                    color = colors.textLink,
                    modifier = Modifier
                        .clip(RoundedCornerShape(LodyRadius.md))
                        .clickable(role = Role.Button, onClick = onCancel)
                        .padding(horizontal = LodySpacing.lg, vertical = LodySpacing.md),
                )
            }
            state.failure?.let { Text(it, style = type.footnote, color = colors.dangerDefault, textAlign = TextAlign.Center) }
        }
    }
}

@Composable
private fun PrimaryButton(label: String, enabled: Boolean, onClick: () -> Unit) {
    val colors = LodyTheme.colors
    val shape = RoundedCornerShape(LodyRadius.md)
    app.lody.android.designsystem.LodyButton(
        onClick = onClick,
        enabled = enabled,
        modifier = Modifier.fillMaxWidth().height(LodySize.controlLg),
        shape = shape,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(),
        colors = androidx.compose.material3.ButtonDefaults.buttonColors(
            containerColor = colors.accentSolid, contentColor = colors.textOnAccent,
            disabledContainerColor = colors.fillDisabled, disabledContentColor = colors.textDisabled,
        ),
    ) {
        Text(label, style = LodyTheme.typography.subhead)
    }
}

/** The conversation's header and sending context from the catalog (title, project · branch). */
private fun chatContext(catalog: CatalogState, id: String, title: String, user: app.lody.android.auth.Account): app.lody.android.chat.ChatContext {
    val snapshot = catalog.snapshot
    val session = snapshot?.sessions?.firstOrNull { it.id == id }
    val project = snapshot?.projects?.firstOrNull { it.id == session?.projectId && !it.id.endsWith(":unassigned") }
    val subtitle = listOfNotNull(project?.name, session?.branchName).joinToString(" · ")
    val repository = project?.repoFullName ?: session?.projectId?.removePrefix("github:")?.takeIf { session.projectId.startsWith("github:") }
    return app.lody.android.chat.ChatContext(
        session?.title?.ifBlank { null } ?: title, subtitle, session, user,
        closedTabs = session?.let { app.lody.android.chat.DirectoryTabs.closed(it, snapshot.sessions) }.orEmpty(),
        tabs = session?.let { app.lody.android.chat.DirectoryTabs.sessions(it, snapshot.sessions) }.orEmpty(),
        repository = repository.orEmpty(),
        machineName = session?.let { snapshot?.machineNames?.get(it.machineId) }.orEmpty(),
        machineKind = snapshot?.let { app.lody.android.create.CreateSessionModel.machineKind(it, session?.machineId) }
            ?: app.lody.android.create.CreateSessionModel.MachineKind.Laptop,
    )
}
