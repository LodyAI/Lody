package app.lody.android.home

import app.lody.android.BackendEnvironment

import app.lody.android.auth.WorkspaceMember

import android.content.Intent
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
import app.lody.android.auth.NativeSignInScreen
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
    private var pushIntent by mutableStateOf<Intent?>(null)
    private val notificationPermission = registerForActivityResult(androidx.activity.result.contract.ActivityResultContracts.RequestPermission()) {
        (application as LodyApplication).notifications.refresh()
    }
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pushIntent = intent
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        pushIntent = intent
        val app = application as LodyApplication
        val auth = app.account.state.value
        if (savedInstanceState == null && auth.account == null && !auth.busy && auth.failure == null && auth.notice == null) app.account.restore()
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
                    val prefs = getSharedPreferences("tab-browsing-v1" + BackendEnvironment.storageSuffix, MODE_PRIVATE)
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
                val pushClick by app.notifications.click.collectAsState()
                LaunchedEffect(account.verified, pushIntent) {
                    if (account.verified) {
                        pushIntent?.let {
                            app.notifications.acceptClick(it.getStringExtra("route"), it.getStringExtra("recipientUserId"))
                            it.removeExtra("route"); it.removeExtra("recipientUserId")
                        }
                        pushIntent = null
                        if (android.os.Build.VERSION.SDK_INT >= 33) {
                            val prefs = getSharedPreferences("push-permission-v1", MODE_PRIVATE)
                            if (!prefs.getBoolean("requested", false)) {
                                prefs.edit().putBoolean("requested", true).apply()
                                notificationPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
                            }
                        }
                    }
                }
                var selectedId by rememberSaveable(user?.id, catalog.workspace?.id) { mutableStateOf<String?>(null) }
                var selectedTitle by rememberSaveable(user?.id, catalog.workspace?.id) { mutableStateOf("") }
                var creating by rememberSaveable(user?.id, catalog.workspace?.id) { mutableStateOf(false) }
                LaunchedEffect(pushClick, account.verified, catalog.workspace?.id, catalog.snapshot) {
                    val target = pushClick ?: return@LaunchedEffect
                    if (!account.verified) return@LaunchedEffect
                    val workspace = user?.workspaces?.firstOrNull { it.id == target.workspaceId } ?: return@LaunchedEffect
                    if (catalog.workspace?.id != workspace.id) { app.cloud.select(workspace); return@LaunchedEffect }
                    if (catalog.snapshot?.sessions?.any { it.id == target.sessionId } == true) {
                        selectedId = target.sessionId; selectedTitle = ""; creating = false
                        app.notifications.consumeClick()
                    }
                }
                val repository = remember { ChatRepository(app.runtimeOwner, app.pullRequests, app.attachments, app.mergeStates, app.branches) }
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
                    NativeSignInScreen(account, app.account, this@HomeActivity)
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
                                schedules = app.schedules,
                                creation = creator,
                                agentProviders = remember { RuntimeAgentProviderService(app.runtimeOwner) },
                                roleSettings = remember { RuntimeRoleSettingsService(app.runtimeOwner) },
                                shortcutSettings = remember { RuntimeShortcutSettingsService(app.runtimeOwner) },
                                githubSettings = remember { LiveGitHubSettingsService(app.account) },
                                scope = workspace?.let { RuntimeScope(user.id, it.id) },
                                onOpenSession = { id -> selectedId = id; selectedTitle = "" },
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
        accountEmail = user?.email.orEmpty(),
        timeline = snapshot?.let { ChatListModel.timeline(it) }.orEmpty(),
        snapshot = snapshot,
        userId = user?.id,
        projects = snapshot?.let(ChatListModel::groups).orEmpty(),
        placeholder = placeholder,
        workspaces = user?.workspaces.orEmpty(),
        workspaceId = workspace?.id,
    )
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
        relatedSessions = snapshot?.sessions.orEmpty(),
        closedTabs = session?.let { app.lody.android.chat.DirectoryTabs.closed(it, snapshot.sessions) }.orEmpty(),
        tabs = session?.let { app.lody.android.chat.DirectoryTabs.sessions(it, snapshot.sessions) }.orEmpty(),
        repository = repository.orEmpty(),
        machineName = session?.let { snapshot?.machineNames?.get(it.machineId) }.orEmpty(),
        machineKind = snapshot?.let { app.lody.android.create.CreateSessionModel.machineKind(it, session?.machineId) }
            ?: app.lody.android.create.CreateSessionModel.MachineKind.Laptop,
    )
}
