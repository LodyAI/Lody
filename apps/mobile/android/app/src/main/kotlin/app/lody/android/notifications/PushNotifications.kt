package app.lody.android.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import app.lody.android.BuildConfig
import app.lody.android.auth.AccountController
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import com.google.firebase.messaging.FirebaseMessaging
import com.onesignal.OneSignal
import com.onesignal.debug.LogLevel
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.util.Locale
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Application-owned; auth teardown joins registration before dropping its native credential. */
class PushNotifications(private val context: Context, private val account: AccountController, private val scope: CoroutineScope) : DefaultLifecycleObserver {
    private val prefs = context.getSharedPreferences("push-installation-v1", Context.MODE_PRIVATE)
    private val installation = prefs.getString("id", null) ?: UUID.randomUUID().toString().also { prefs.edit().putString("id", it).commit() }
    private val cloud = PushCloud(installation, { Locale.getDefault().toLanguageTag() })
    private var pending: Job? = null
    private val mutableStatus = MutableStateFlow("idle")
    val status = mutableStatus.asStateFlow()
    private val mutableClick = MutableStateFlow<PushRoute?>(null)
    val click = mutableClick.asStateFlow()
    private val binding = PushBinding(object : PushDevice {
        override fun oneSignal(userId: String?) {
            if (userId == null) { OneSignal.User.pushSubscription.optOut(); OneSignal.logout() }
            else {
                OneSignal.login(userId)
                // Home owns the one-time OS prompt; SDK optIn must not re-prompt denial.
                if (OneSignal.Notifications.permission) OneSignal.User.pushSubscription.optIn()
            }
        }
        override suspend fun token(): String {
            check(FirebaseApp.getApps(context).any { it.name == FirebaseApp.DEFAULT_APP_NAME }) { "firebase_not_configured" }
            return withTimeout(15_000) {
                suspendCancellableCoroutine { continuation ->
                    FirebaseMessaging.getInstance().token.addOnCompleteListener { task ->
                        if (continuation.isActive) {
                            if (task.isSuccessful) continuation.resume(task.result)
                            else continuation.resumeWithException(IllegalStateException("push_token_unavailable"))
                        }
                    }
                }
            }
        }
    })
    init {
        // Configure the default Firebase app at process start for background FCM delivery.
        // Auto-init remains disabled: obtaining a token happens only after verified opt-in.
        if (FirebaseApp.getApps(context).none { it.name == FirebaseApp.DEFAULT_APP_NAME } &&
            listOf(BuildConfig.FIREBASE_APP_ID, BuildConfig.FIREBASE_API_KEY, BuildConfig.FIREBASE_PROJECT_ID, BuildConfig.FIREBASE_SENDER_ID).all { it.isNotBlank() }) {
            FirebaseApp.initializeApp(context, FirebaseOptions.Builder()
                .setApplicationId(BuildConfig.FIREBASE_APP_ID).setApiKey(BuildConfig.FIREBASE_API_KEY)
                .setProjectId(BuildConfig.FIREBASE_PROJECT_ID).setGcmSenderId(BuildConfig.FIREBASE_SENDER_ID).build())
        }
        context.getSystemService(NotificationManager::class.java).createNotificationChannel(NotificationChannel("lody", "Lody", NotificationManager.IMPORTANCE_DEFAULT))
        OneSignal.Debug.logLevel = LogLevel.NONE
        OneSignal.initWithContext(context, BuildConfig.ONESIGNAL_APP_ID)
        binding.detach() // Never retain the previous process's identity before auth restoration.
        OneSignal.Notifications.addForegroundLifecycleListener(object : com.onesignal.notifications.INotificationLifecycleListener {
            override fun onWillDisplay(event: com.onesignal.notifications.INotificationWillDisplayEvent) {
                // Suppress synchronously, then evaluate account/provider state on its owner dispatcher.
                event.preventDefault()
                scope.launch {
                    val state = account.state.value
                    val recipient = event.notification.additionalData?.opt("recipientUserId") as? String
                    if (!state.verified || binding.direct || recipient.isNullOrBlank() || recipient != state.account?.id) return@launch
                    event.notification.display()
                }
            }
        })
        OneSignal.Notifications.addClickListener(object : com.onesignal.notifications.INotificationClickListener {
            override fun onClick(event: com.onesignal.notifications.INotificationClickEvent) {
                val data = event.notification.additionalData
                val route = data?.optString("route") ?: return
                val recipient = data.opt("recipientUserId") as? String ?: return
                if (recipient.isBlank() || PushRoute.fromPath(route) == null) return
                context.startActivity(android.content.Intent(context, app.lody.android.home.HomeActivity::class.java)
                    .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TOP or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP)
                    .putExtra("route", route).putExtra("recipientUserId", recipient))
            }
        })
        scope.launch {
            account.state.map { if (it.verified) it.account?.id else null }.distinctUntilChanged().collect { user ->
                if (user != null) refresh()
            }
        }
    }
    override fun onStart(owner: LifecycleOwner) { refresh() }
    fun refresh() {
        val user = account.state.value.takeIf { it.verified }?.account?.id ?: return
        val old = pending
        old?.cancel()
        pending = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            // Keep predecessor ownership through cancellation of an intermediate refresh.
            withContext(NonCancellable) { old?.join() }
            currentCoroutineContext().ensureActive()
            try {
                account.withVerifiedIdentity(user) { credential ->
                    binding.refresh(user, cloud.session(credential))
                }
                mutableStatus.value = if (binding.direct) "self_hosted" else "onesignal"
            } catch (_: TimeoutCancellationException) {
                currentCoroutineContext().ensureActive()
                mutableStatus.value = "unavailable"
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { mutableStatus.value = "unavailable" }
        }
    }
    suspend fun clear() {
        binding.detach()
        mutableClick.value = null
        pending?.cancelAndJoin(); pending = null
        withContext(NonCancellable) {
            try { binding.clear(); mutableStatus.value = "idle" }
            catch (_: Exception) { mutableStatus.value = "cleanup_unconfirmed" }
        }
        context.getSystemService(NotificationManager::class.java).cancelAll()
    }
    fun acceptClick(path: String?, recipient: String?) {
        val user = account.state.value.takeIf { it.verified }?.account ?: return
        mutableClick.value = PushRoute.resolve(path, recipient, user) ?: return
    }
    fun consumeClick() { mutableClick.value = null }
    fun canDisplayDirect() = binding.direct && account.state.value.verified

}

data class PushRoute(val workspaceId: String, val sessionId: String) {
    companion object {
        fun resolve(path: String?, recipient: String?, user: app.lody.android.auth.Account): PushRoute? {
            if (recipient.isNullOrBlank() || recipient != user.id) return null
            val route = fromPath(path) ?: return null
            val workspace = user.workspaces.firstOrNull { it.slug == route.workspaceId } ?: return null
            return route.copy(workspaceId = workspace.id)
        }
        /** Backend route is /<workspace slug>/sessions/<session id>, never a URL. */
        fun fromPath(path: String?): PushRoute? {
            if (path == null || path.length > 2048) return null
            val parts = path.split('/')
            if (parts.size != 4 || parts[0].isNotEmpty() || parts[2] != "sessions") return null
            return parse(parts[1], parts[3])
        }
        fun parse(workspace: String?, session: String?): PushRoute? {
            val id = Regex("[A-Za-z0-9_-]{1,200}")
            return if (workspace != null && session != null && id.matches(workspace) && id.matches(session)) PushRoute(workspace, session) else null
        }
    }
}
