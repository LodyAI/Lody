package app.lody.android.catalog

import app.lody.android.auth.*
import app.lody.android.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.channels.Channel

enum class ConnectionPhase { DISCONNECTED, CONNECTING, SYNCING, LIVE, PAUSED, UNAVAILABLE }
data class CatalogState(
 val workspace: Workspace? = null, val phase: ConnectionPhase = ConnectionPhase.DISCONNECTED,
 val snapshot: CatalogSnapshot? = null, val syncedAt: Long? = null, val cached: Boolean = false,
 val streams: Int = 0, val failure: String? = null, val cacheFailure: Boolean = false,
) {
 val projects get() = snapshot?.projects?.size ?: 0
 val sessions get() = snapshot?.sessions?.size ?: 0
 val revision get() = snapshot?.revision ?: 0
}
/** One owner of the selected display projection; storage and runtime are replaceable ports. */
class CatalogRepository(private val account: AccountController, private val owner: RuntimeOwner,
 private val tasks: CoroutineScope, private val store: CatalogStore, private val prepare: (RuntimeScope, ShortLivedGrant) -> Unit) {
 private val mutable = MutableStateFlow(CatalogState())
 val state: StateFlow<CatalogState> = mutable.asStateFlow()
 private var selection: Job? = null
 private var subscription: Job? = null
 private var epoch = 0L
 init {
  tasks.launch {
   account.state.map { it.account to it.verified }.distinctUntilChanged().collectLatest { (user, _) ->
    if (user == null) {
     if (mutable.value.workspace != null) disconnect()
    } else {
     val context = cached { store.readContext() }
     val selected = mutable.value.workspace?.id ?: context?.takeIf { it.account.id == user.id }?.workspaceId
     val workspace = user.workspaces.firstOrNull { it.id == selected }
     if (workspace != null) select(workspace)
     else if (mutable.value.workspace != null) disconnect()
    }
   }
  }
 }
 fun select(workspace: Workspace): Job {
  val previous = selection
  previous?.cancel()
  val identity = ++epoch
  mutable.value = CatalogState(workspace, ConnectionPhase.CONNECTING)
  return tasks.launch {
   previous?.join()
   subscription?.cancelAndJoin(); subscription = null
   if (identity != epoch) return@launch
   owner.clear()
   val user = account.state.value.account ?: return@launch
   if (user.workspaces.none { it.id == workspace.id }) return@launch
   val scope = RuntimeScope(user.id, workspace.id)
   val saved = cached { store.read(scope) }
   ensureActive()
   if (identity != epoch) return@launch
   mutable.value = mutable.value.copy(snapshot = saved?.snapshot, syncedAt = saved?.syncedAt, cached = saved != null)
   cached { store.select(scope) }
   if (!account.state.value.verified) {
    mutable.value = mutable.value.copy(phase = ConnectionPhase.DISCONNECTED)
    return@launch
   }
   try {
    val grant = account.grant(scope)
    ensureActive()
    if (identity != epoch) return@launch
    app.lody.android.cloud.StreamAccess(scope.workspaceId, grant.gatewayBaseUrl)
    prepare(scope, grant)
    observe(scope, identity)
    owner.activate(scope)
   } catch (cancelled: CancellationException) { throw cancelled }
   catch (error: Exception) {
    if (identity == epoch) mutable.value = mutable.value.copy(phase = ConnectionPhase.UNAVAILABLE, failure = (error as? AuthFailure)?.code ?: "connection_failed")
   }
  }.also { selection = it }
 }
 private fun observe(scope: RuntimeScope, identity: Long) {
  subscription = tasks.launch(start = CoroutineStart.UNDISPATCHED) {
   val writes = Channel<SavedCatalog>(Channel.CONFLATED)
   launch {
    try {
     for (saved in writes) {
      try { store.write(scope, saved); if (identity == epoch) mutable.value = mutable.value.copy(cacheFailure = false) }
      catch (cancelled: CancellationException) { throw cancelled }
      catch (_: Exception) { if (identity == epoch) mutable.value = mutable.value.copy(cacheFailure = true) }
     }
    } finally { writes.cancel() }
   }
   var pending: CatalogSnapshot? = null
   var pendingGeneration = -1L
   launch(start = CoroutineStart.UNDISPATCHED) {
    owner.events.collect { scoped ->
     if (identity != epoch || scoped.scope != scope || scoped.generation != owner.state.value.status.generation) return@collect
     when (val event = scoped.event) {
      is RuntimeEvent.CatalogUpdated -> { pending = event.snapshot; pendingGeneration = scoped.generation }
      is RuntimeEvent.Synced -> {
       val snapshot = pending
       if (snapshot == null || snapshot.revision != event.revision || pendingGeneration != owner.state.value.status.generation) return@collect
       val saved = SavedCatalog(snapshot, System.currentTimeMillis())
       mutable.value = mutable.value.copy(snapshot = snapshot, syncedAt = saved.syncedAt, cached = false, phase = ConnectionPhase.LIVE, streams = event.streams, failure = null)
       writes.trySend(saved)
      }
      is RuntimeEvent.SyncFailed -> {
       if (event.reason == "grant_endpoint_changed") mutable.value.workspace?.let { select(it) }
       else mutable.value = mutable.value.copy(phase = ConnectionPhase.UNAVAILABLE, failure = event.reason)
      }
      is RuntimeEvent.SessionUpdated -> Unit
      is RuntimeEvent.CreationChanged -> Unit
      is RuntimeEvent.ProviderProgress -> Unit
      is RuntimeEvent.ProvidersChanged -> Unit
      RuntimeEvent.GrantRequested -> Unit
      is RuntimeEvent.ShortcutCloudRequested -> Unit
     }
    }
   }
   launch {
    owner.state.map { Triple(it.scope, it.status.phase, it.status.generation) }.distinctUntilChanged().collect { (current, phase, _) ->
     if (identity != epoch || current != scope) return@collect
     val next = when (phase) {
      RuntimePhase.STARTING -> ConnectionPhase.CONNECTING
      RuntimePhase.READY -> ConnectionPhase.SYNCING
      RuntimePhase.SUSPENDED -> ConnectionPhase.PAUSED
      RuntimePhase.FAILED -> ConnectionPhase.UNAVAILABLE
      RuntimePhase.STOPPED -> ConnectionPhase.DISCONNECTED
     }
     mutable.value = mutable.value.copy(phase = next)
    }
   }
  }
 }
 fun networkAvailable() {
  val auth = account.state.value
  if (!auth.verified) {
   if (auth.account != null && !auth.busy) account.restore()
  } else if (mutable.value.phase == ConnectionPhase.UNAVAILABLE) {
   mutable.value.workspace?.let { select(it) }
  }
 }
 suspend fun disconnect() {
  ++epoch
  selection?.cancelAndJoin(); selection = null
  subscription?.cancelAndJoin(); subscription = null
  owner.clear(); mutable.value = CatalogState()
 }
 private suspend fun <T> cached(block: suspend () -> T): T? = try { block() }
 catch (cancelled: CancellationException) { throw cancelled }
 catch (_: Exception) { mutable.value = mutable.value.copy(cacheFailure = true); null }
}
