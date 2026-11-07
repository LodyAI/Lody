package app.lody.android.auth

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import app.lody.android.runtime.*

data class AuthState(val account: Account? = null, val notice: String? = null, val busy: Boolean = false, val failure: String? = null, val verified: Boolean = false, val browserPending: Boolean = false)

/** One serialized account operation. UI state never contains either kind of token. */
class AccountController(private val api: CloudAuthApi, private val store: CredentialStore, private val tasks: CoroutineScope, private val context: AccountContextStore? = null, private val beforeAccountChange: suspend () -> Unit = {}) {
    private val mutable = MutableStateFlow(AuthState())
    val state: StateFlow<AuthState> = mutable.asStateFlow()
    private var pending: Job? = null
    private var epoch = 0L
    private var credential: Credential? = null
    internal var browserStore: BrowserAuthStore? = null
    internal var now: () -> Long = System::currentTimeMillis
    fun browser(provider: BrowserProvider, open: (String) -> Unit): Job = operation {
        beforeAccountChange(); credential = null; clearLocal()
        val store = browserStore ?: throw AuthFailure("not_configured")
        val flow = PendingBrowserAuth.create(now())
        try {
            withContext(NonCancellable) { store.write(flow) }
            currentCoroutineContext().ensureActive()
            open(flow.startUrl(provider))
            mutable.value = AuthState(browserPending = true)
        } catch (error: Exception) {
            withContext(NonCancellable) { store.clear() }
            throw error
        }
    }
    /** Invalid or stale callbacks cannot cancel/replace an active account operation. */
    fun browserCallback(raw: String): Job = tasks.launch {
        val callback = BrowserCallback.parse(raw) ?: return@launch
        val identity = epoch
        pending?.join()
        if (identity != epoch || state.value.account != null) return@launch
        val store = browserStore ?: return@launch
        val flow = try { store.read() } catch (_: Exception) { return@launch } ?: return@launch
        if (identity != epoch || callback.state != flow.state) return@launch
        operation {
            // Consume before exchange: no replay on process death or unknown network outcome.
            withContext(NonCancellable) { store.clear() }
            if (!flow.valid(now())) throw AuthFailure("auth_expired")
            val code = callback.code ?: throw AuthFailure("access_denied")
            val token = api.exchange(code, flow.verifier)
            currentCoroutineContext().ensureActive()
            accept(token)
        }.join()
    }
    private fun operation(block: suspend () -> Unit): Job {
        val previous = pending
        previous?.cancel()
        val identity = ++epoch
        mutable.value = AuthState(busy = true)
        return tasks.launch {
            previous?.join()
            if (identity != epoch) return@launch
            try { block() }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) {
                if (identity == epoch) mutable.value = mutable.value.copy(failure = (error as? AuthFailure)?.code ?: "account_unavailable")
            } finally {
                if (identity == epoch) mutable.value = mutable.value.copy(busy = false)
            }
        }.also { pending = it }
    }
    fun login(email: String, password: String): Job = authenticate { api.email(email.trim(), password) }
    fun register(name: String, email: String, password: String): Job = authenticate {
        api.register(name.trim(), email.trim(), password)
    }
    /** SDK interaction runs inside the same cancellable serialized login operation. */
    fun google(acquire: suspend (String) -> String): Job = authenticate {
        val nonce = java.util.UUID.randomUUID().toString()
        val idToken = acquire(nonce)
        currentCoroutineContext().ensureActive()
        api.google(idToken, nonce)
    }
    fun sendVerification(email: String): Job = operation {
        browserStore?.clear()
        api.sendVerification(email.trim()); currentCoroutineContext().ensureActive(); mutable.value = AuthState(notice = "email_sent")
    }
    fun requestReset(email: String): Job = operation {
        browserStore?.clear()
        api.requestReset(email.trim()); currentCoroutineContext().ensureActive(); mutable.value = AuthState(notice = "email_sent")
    }
    private fun authenticate(acquire: suspend () -> Credential?): Job = operation {
        beforeAccountChange(); credential = null; clearLocal()
        val token = acquire()
        currentCoroutineContext().ensureActive()
        if (token == null) { mutable.value = AuthState(notice = "verify_email"); return@operation }
        accept(token)
    }
    private suspend fun accept(token: Credential) {
        val account = api.account(token)
        currentCoroutineContext().ensureActive()
        var persisted = false
        try {
            withContext(NonCancellable) { store.write(token); persisted = true; cache { context?.saveAccount(account) } }
            currentCoroutineContext().ensureActive()
            credential = token
            mutable.value = AuthState(account = account, verified = true)
        } catch (error: CancellationException) {
            if (persisted) withContext(NonCancellable) { clearLocal() }
            throw error
        }
    }
    fun cancel(): Job = operation { beforeAccountChange(); credential = null; clearLocal(); mutable.value = AuthState() }
    fun restore(): Job = operation {
        beforeAccountChange(); credential = null
        val saved = try { store.read() } catch (cancelled: CancellationException) { throw cancelled } catch (error: Exception) { context?.clear(); throw error }
        if (saved == null) {
            context?.clear()
            val flow = browserStore?.read()
            if (flow != null && flow.valid(now())) mutable.value = AuthState(browserPending = true)
            else browserStore?.clear()
            return@operation
        }
        val cached = cache { context?.readContext() }
        if (cached != null) mutable.value = AuthState(account = cached.account, busy = true)

        try {
            val account = api.account(saved)
            currentCoroutineContext().ensureActive()
            cache { context?.saveAccount(account) }
            currentCoroutineContext().ensureActive()
            credential = saved; mutable.value = AuthState(account = account, verified = true)
        } catch (error: AuthFailure) {
            if (error.code == "auth_expired") { mutable.value = AuthState(); clearLocal() }
            throw error
        }
    }
    fun logout(): Job = operation {
        val old = credential
        credential = null
        withContext(NonCancellable) { try { beforeAccountChange() } finally { clearLocal() } }
        mutable.value = AuthState()
        if (old != null) try { api.signOut(old) } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { mutable.value = AuthState(failure = "local_logout_complete_server_unavailable") }
    }
    suspend fun grant(scope: RuntimeScope): ShortLivedGrant {
        val identity = epoch
        val account = state.value.account
        val token = credential
        if (!state.value.verified || account?.id != scope.accountId || account.workspaces.none { it.id == scope.workspaceId } || token == null) throw AuthFailure("account_changed")
        val result = try { api.grant(token, scope.workspaceId) }
        catch (error: AuthFailure) {
            if (error.code == "auth_expired" && epoch == identity && credential === token) {
                // Do not await this job: teardown cancels the runtime that requested the grant.
                operation {
                    credential = null
                    withContext(NonCancellable) { try { beforeAccountChange() } finally { clearLocal() } }
                    mutable.value = AuthState(failure = "auth_expired")
                }
            }
            throw error
        }
        currentCoroutineContext().ensureActive()
        if (epoch != identity || credential !== token) throw AuthFailure("account_changed")
        return result
    }
    suspend fun members(scope: RuntimeScope): List<WorkspaceMember> = withVerifiedAccount(scope) { api.members(it, scope.workspaceId) }
    internal suspend fun <T> withVerifiedAccount(scope: RuntimeScope, block: suspend (Credential) -> T): T {
        val identity = epoch
        val token = credential ?: throw AuthFailure("account_changed")
        val account = state.value.account
        if (!state.value.verified || account?.id != scope.accountId || account.workspaces.none { it.id == scope.workspaceId }) throw AuthFailure("account_changed")
        val result = block(token)
        currentCoroutineContext().ensureActive()
        if (epoch != identity || credential !== token) throw AuthFailure("account_changed")
        return result
    }
    private suspend fun clearLocal() {
        try { browserStore?.clear() } finally { try { store.clear() } finally { context?.clear() } }
    }
    private suspend fun <T> cache(block: suspend () -> T): T? = try { block() }
    catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { null }

}
