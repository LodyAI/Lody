package app.lody.android

import android.app.Application
import androidx.lifecycle.ProcessLifecycleOwner
import app.lody.android.runtime.*
import app.lody.android.auth.*
import app.lody.android.catalog.CatalogRepository
import app.lody.android.catalog.AtomicCatalogStore
import kotlinx.coroutines.*
import app.lody.android.cloud.NetworkAvailability

open class LodyApplication : Application() {
    val applicationScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    lateinit var runtimeOwner: RuntimeOwner
        private set
    lateinit var account: AccountController
        private set
    lateinit var cloud: CatalogRepository
        private set
    lateinit var creation: app.lody.android.create.CreationService
    val submissions by lazy { app.lody.android.create.CreationSubmissions(applicationScope) { scope, request -> creation.create(scope, request) } }
    lateinit var pullRequests: app.lody.android.chat.PullRequestWriter
    lateinit var mergeStates: app.lody.android.chat.PullRequestMergeReader
    lateinit var attachments: app.lody.android.chat.AttachmentUploader
        private set
    lateinit var members: WorkspaceMembers
        private set
    /** The Projects tab's "+": add a local folder or a GitHub repository. */
    lateinit var projectAdding: app.lody.android.home.ProjectAdding
        private set
    lateinit var notifications: app.lody.android.notifications.PushNotifications
        private set
    /** The Schedules tab's reads and owner writes through the shared runtime. */
    lateinit var schedules: app.lody.android.schedules.ScheduleService
        private set
    private var prepared: Pair<RuntimeScope, ShortLivedGrant>? = null
    private val shortcutCloud by lazy { app.lody.android.cloud.PromptShortcutCloud() }
    protected open fun createRuntime(scope: RuntimeScope): CloudRuntime {
        val ready = prepared?.takeIf { it.first == scope }
        if (ready != null) {
            prepared = null
            return ReadOnlyCloudRuntime(this, scope, ready.second, GrantProvider { key ->
                try { account.grant(key) }
                catch (error: AuthFailure) { throw app.lody.android.runtime.RuntimeException(RuntimeFault(error.code, if (error.code == "network_unavailable") RuntimeErrorCategory.NETWORK else RuntimeErrorCategory.AUTH)) }
            }, app.lody.android.runtime.ShortcutCloudProvider { key, operation, args ->
                account.withVerifiedAccount(key) { credential -> shortcutCloud.call(credential, key.workspaceId, operation, args) }
            })
        }
        return createOfflineRuntime(scope)
    }
    protected open fun createOfflineRuntime(scope: RuntimeScope): CloudRuntime = WebViewRuntime(this, scope)
    override fun onCreate() {
        super.onCreate()
        app.lody.android.home.AvatarImages.initialize(this)
        runtimeOwner = RuntimeOwner(::createRuntime, Dispatchers.Main.immediate)
        val cache = AtomicCatalogStore(this)
        val scheduleCache = app.lody.android.schedules.ScheduleDisplayCache(cache)
        val branches = app.lody.android.create.GitHubBranches()
        creation = app.lody.android.create.CreateSessionRepository(runtimeOwner, cache) { scope, repo, page ->
            account.withVerifiedAccount(scope) { token -> branches.load(token, scope.workspaceId, repo, page) }
        }
        val writes = app.lody.android.chat.GitHubPullRequestWrites()
        pullRequests = app.lody.android.chat.PullRequestWriter { scope, repo, number, method ->
            account.withVerifiedAccount(scope) { credential ->
                if (method != null) writes.merge(credential, scope.workspaceId, repo, number, method)
                else writes.markReady(credential, scope.workspaceId, repo, number)
            }
        }
        mergeStates = app.lody.android.chat.PullRequestMergeReader { scope, repo, number ->
            account.withVerifiedAccount(scope) { credential -> writes.mergeState(credential, scope.workspaceId, repo, number) }
        }
        val uploads = app.lody.android.chat.SessionAttachmentUploads(contentResolver)
        attachments = app.lody.android.chat.AttachmentUploader { scope, sessionId, items ->
            account.withVerifiedAccount(scope) { credential -> uploads.upload(credential.token, scope.workspaceId, sessionId, items) }
        }
        account = AccountController(CloudAuthHttp(OkHttpAuthTransport()), KeystoreCredentialStore(this), applicationScope, cache) {
            if (::notifications.isInitialized) notifications.clear()
            scheduleCache.invalidate()
            prepared = null
            submissions.activate(null)
            cloud.disconnect()
        }
        account.browserStore = BrowserAuthStore(KeystoreCredentialStore(this, "browser-auth"))
        members = WorkspaceMembers(cache, account::members)
        projectAdding = app.lody.android.home.LiveProjectAdding(runtimeOwner, account, app.lody.android.chat.GitHubHttpClient())
        schedules = app.lody.android.schedules.RuntimeScheduleService(runtimeOwner, scheduleCache)
        cloud = CatalogRepository(account, runtimeOwner, applicationScope, cache) { scope, grant -> prepared = scope to grant }
        notifications = app.lody.android.notifications.PushNotifications(this, account, applicationScope)
        ProcessLifecycleOwner.get().lifecycle.addObserver(notifications)
        ProcessLifecycleOwner.get().lifecycle.addObserver(RuntimeLifecycle(runtimeOwner, applicationScope, NetworkAvailability(this).available) {
            ConnectionTrace.mark("network_validated")
            cloud.networkAvailable()
        })
    }
}
