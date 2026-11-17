package app.lody.android.catalog
import app.lody.android.auth.*
import app.lody.android.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CatalogRepositoryTest {
 private var user=Account("u","User",listOf(Workspace("w","Work", contentMode = WorkspaceContentMode.PLAINTEXT),Workspace("x","Other", contentMode = WorkspaceContentMode.PLAINTEXT)))
 private val key=RuntimeScope("u","w")
 private val snapshot=CatalogSnapshot(50,listOf(CatalogProject("p","m","Cached project","/fixture")),emptyList(),listOf("m"))
 private class Store(var context:AccountContext?, val values:MutableMap<RuntimeScope,SavedCatalog> = mutableMapOf()):CatalogStore {
  var failWrite=false
  var blockedWrite:CompletableDeferred<Unit>?=null
  override suspend fun readContext()=context
  override suspend fun saveAccount(account:Account){context=AccountContext(account,context?.workspaceId)}
  override suspend fun select(scope:RuntimeScope){context=context?.copy(workspaceId=scope.workspaceId)}
  override suspend fun read(scope:RuntimeScope)=values[scope]
  override suspend fun write(scope:RuntimeScope,catalog:SavedCatalog){if(failWrite)error("disk full");blockedWrite?.await();values[scope]=catalog}
  override suspend fun clear(){context=null;values.clear()}
 }
 private class Runtime(override val scope:RuntimeScope):CloudRuntime {
  val status=MutableStateFlow(RuntimeStatus());override val state:StateFlow<RuntimeStatus> =status
  val source=MutableSharedFlow<RuntimeEmission>(extraBufferCapacity=64);override val events:Flow<RuntimeEmission> =source
  override suspend fun start(){status.value=RuntimeStatus(RuntimePhase.READY,1)}
  override suspend fun stop(){status.value=RuntimeStatus(RuntimePhase.STOPPED,2)}
  override suspend fun setActive(active:Boolean)=Unit
  override suspend fun execute(command:RuntimeCommand)=RuntimeResult.Pong(true)
 }
 private fun account(tasks:CoroutineScope,store:Store,grant: suspend ()->ShortLivedGrant):AccountController {
  val api=object:CloudAuthApi {
   override suspend fun account(credential:Credential)=user
   override suspend fun grant(credential:Credential,workspaceId:String)=grant()
   override suspend fun signOut(credential:Credential)=Unit
  }
  val credentials=object:CredentialStore {
   override suspend fun read()=Credential("fixture")
   override suspend fun write(credential:Credential)=Unit
   override suspend fun clear()=Unit
  }
  return AccountController(api,credentials,tasks,store)
 }
 @Test fun cachedSelectionAppearsBeforeGrantAndOnlySyncedSnapshotsReplaceIt()=runTest {
  val store=Store(AccountContext(user,"w"),mutableMapOf(key to SavedCatalog(snapshot,123)))
  val grant=CompletableDeferred<ShortLivedGrant>();val account=account(backgroundScope,store){grant.await()}
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->}
  account.restore().join();runCurrent()
  assertEquals("Work",repo.state.value.workspace?.name);assertEquals(1,repo.state.value.projects)
  assertTrue(repo.state.value.cached);assertNotEquals(ConnectionPhase.LIVE,repo.state.value.phase)
  grant.complete(ShortLivedGrant("short","https://streams.example.org",60));runCurrent()
  val fresh=snapshot.copy(revision=1,projects=emptyList())
  runtimes.last().source.emit(RuntimeEvent.CatalogUpdated(fresh));runCurrent()
  assertEquals(50L,store.values[key]!!.snapshot.revision)
  runtimes.last().source.emit(RuntimeEvent.Synced(1,1));runCurrent()
  assertEquals(ConnectionPhase.LIVE,repo.state.value.phase);assertFalse(repo.state.value.cached)
  assertEquals(1L,store.values[key]!!.snapshot.revision);assertEquals(0,repo.state.value.projects)
  repo.disconnect()
 }
 @Test fun cacheWriteFailureDoesNotHideLiveDataAndOldWorkspaceEventsAreRejected()=runTest {
  val store=Store(AccountContext(user));val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->};runCurrent()
  repo.select(user.workspaces[0]).join();runCurrent();val old=runtimes.last()
  store.failWrite=true
  old.source.emit(RuntimeEvent.CatalogUpdated(snapshot));old.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  assertEquals(ConnectionPhase.LIVE,repo.state.value.phase);assertTrue(repo.state.value.cacheFailure)
  repo.select(user.workspaces[1]).join();runCurrent()
  old.source.emit(RuntimeEvent.CatalogUpdated(snapshot));old.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  assertEquals("Other",repo.state.value.workspace?.name);assertEquals(0,repo.state.value.projects)
  repo.disconnect();assertNull(repo.state.value.snapshot)
 }
 @Test fun validatedNetworkRecoveryReplacesFailedReadLeaseButNotHealthyLease()=runTest {
  val store=Store(AccountContext(user));val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->};runCurrent()
  repo.select(user.workspaces[0]).join();runCurrent();val old=runtimes.last()
  old.source.emit(RuntimeEvent.CatalogUpdated(snapshot));old.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  repo.networkAvailable();runCurrent();assertEquals(1,runtimes.size)
  old.source.emit(RuntimeEvent.SyncFailed("network_unavailable"));runCurrent()
  repo.networkAvailable();runCurrent()
  assertEquals(1,runtimes.size);assertEquals("network_unavailable",repo.state.value.failure)
  old.status.value=RuntimeStatus(RuntimePhase.FAILED,1);runCurrent()
  repo.networkAvailable();runCurrent()
  assertEquals(2,runtimes.size);assertEquals(RuntimePhase.STOPPED,old.state.value.phase)
  assertEquals(1,repo.state.value.projects);assertTrue(repo.state.value.cached)
  repo.disconnect()
 }

 @Test fun networkHintsPreserveRecoveringLeaseAndReplaceUnavailableLeaseWithoutOwner()=runTest {
  val store=Store(AccountContext(user));val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->};runCurrent()
  repo.select(user.workspaces[0]).join();runCurrent();val runtime=runtimes.last()
  for (phase in listOf(RuntimePhase.STARTING,RuntimePhase.SUSPENDED,RuntimePhase.READY)) {
   runtime.status.value=RuntimeStatus(phase,1);runCurrent()
   runtime.source.emit(RuntimeEvent.SyncFailed("grant_unavailable"));runCurrent()
   repo.networkAvailable();runCurrent()
   assertEquals(1,runtimes.size);assertEquals(key,owner.state.value.scope)
   assertEquals(phase,owner.state.value.status.phase)
  }
  owner.clear();runCurrent()
  assertEquals(ConnectionPhase.UNAVAILABLE,repo.state.value.phase)
  repo.networkAvailable();runCurrent()
  assertEquals(2,runtimes.size);assertEquals(key,owner.state.value.scope)
  repo.disconnect()
 }

 @Test fun networkHintRestartsTerminalCatalogWatcherAndRequiresNewLeaseSyncPair()=runTest {
  val store=Store(AccountContext(user));val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->};runCurrent()
  repo.select(user.workspaces[0]).join();runCurrent();val old=runtimes.last()
  old.source.emit(RuntimeEvent.CatalogUpdated(snapshot));old.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  val saved=store.values[key]
  old.source.emit(RuntimeEvent.SyncFailed("catalog_limit"));runCurrent()
  old.status.value=RuntimeStatus(RuntimePhase.SUSPENDED,1);runCurrent()
  old.source.emit(RuntimeEvent.SyncFailed("network_or_auth"));runCurrent()
  assertEquals(ConnectionPhase.PAUSED,repo.state.value.phase)
  assertEquals("catalog_limit",repo.state.value.failure)
  old.status.value=RuntimeStatus(RuntimePhase.READY,1);runCurrent()
  assertEquals("catalog_limit",repo.state.value.failure)
  assertEquals(RuntimePhase.READY,owner.state.value.status.phase)
  assertEquals(ConnectionPhase.UNAVAILABLE,repo.state.value.phase)
  repo.networkAvailable();runCurrent()
  assertEquals(2,runtimes.size);assertEquals(RuntimePhase.STOPPED,old.state.value.phase)
  val replacement=runtimes.last()
  assertEquals(ConnectionPhase.SYNCING,repo.state.value.phase)
  assertEquals(snapshot,repo.state.value.snapshot);assertTrue(repo.state.value.cached)
  // Both runtime instances use generation 1; only the replacement's own pair counts.
  old.source.emit(RuntimeEvent.CatalogUpdated(snapshot.copy(projects=emptyList())))
  old.source.emit(RuntimeEvent.Synced(50,1))
  replacement.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  assertEquals(ConnectionPhase.SYNCING,repo.state.value.phase)
  assertTrue(repo.state.value.cached);assertSame(saved,store.values[key])
  val fresh=snapshot.copy(projects=emptyList())
  replacement.source.emit(RuntimeEvent.CatalogUpdated(fresh));runCurrent()
  assertEquals(snapshot,repo.state.value.snapshot)
  replacement.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  assertEquals(ConnectionPhase.LIVE,repo.state.value.phase);assertFalse(repo.state.value.cached)
  assertEquals(fresh,repo.state.value.snapshot);assertEquals(fresh,store.values[key]!!.snapshot)
  repo.disconnect()
 }

 @Test fun bufferedOldGenerationCannotBecomeLiveWhileCacheWriteSuspends()=runTest {
  val store=Store(AccountContext(user));val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->};runCurrent()
  repo.select(user.workspaces[0]).join();runCurrent();val runtime=runtimes.last()
  val blocked=CompletableDeferred<Unit>();store.blockedWrite=blocked
  runtime.source.emit(RuntimeEvent.CatalogUpdated(snapshot));runtime.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  runtime.source.emit(RuntimeEvent.CatalogUpdated(snapshot.copy(revision=51)));runtime.source.emit(RuntimeEvent.Synced(51,1))
  runtime.status.value=RuntimeStatus(RuntimePhase.READY,2);runCurrent()
  blocked.complete(Unit);runCurrent()
  assertNotEquals(ConnectionPhase.LIVE,repo.state.value.phase)
  assertEquals(50L,store.values[key]!!.snapshot.revision)
  repo.disconnect()
 }

 @Test fun slowDiskCannotDelayLiveCatalogOrConnectionFailureEvents()=runTest {
  val store=Store(AccountContext(user));val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->};runCurrent()
  repo.select(user.workspaces[0]).join();runCurrent();val runtime=runtimes.last()
  val blocked=CompletableDeferred<Unit>();store.blockedWrite=blocked
  runtime.source.emit(RuntimeEvent.CatalogUpdated(snapshot));runtime.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  runtime.source.emit(RuntimeEvent.CatalogUpdated(snapshot.copy(revision=51)));runtime.source.emit(RuntimeEvent.Synced(51,1));runCurrent()
  assertEquals(51L,repo.state.value.revision)
  runtime.source.emit(RuntimeEvent.SyncFailed("network_unavailable"));runCurrent()
  assertEquals(ConnectionPhase.UNAVAILABLE,repo.state.value.phase)
  blocked.complete(Unit);runCurrent();assertEquals(51L,store.values[key]!!.snapshot.revision)
  repo.disconnect()
 }

 @Test fun encryptedAndUnknownSelectionRetirePlaintextRuntimeAndNeverExposeCachedContent()=runTest {
  user = user.copy(workspaces = user.workspaces + listOf(Workspace("secret", "Secret", contentMode = WorkspaceContentMode.E2EE), Workspace("unknown", "Unknown")))
  val store=Store(AccountContext(user))
  val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val owner=RuntimeOwner({Runtime(it)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->}
  repo.select(user.workspaces.first()).join();runCurrent()
  assertEquals(key,owner.state.value.scope)
  for(workspace in user.workspaces.takeLast(2)) {
   store.values[RuntimeScope("u",workspace.id)] = SavedCatalog(snapshot,123)
   repo.select(workspace).join();runCurrent()
   assertNull(owner.state.value.scope)
   assertNull(repo.state.value.snapshot)
   assertEquals(ConnectionPhase.UNAVAILABLE,repo.state.value.phase)
   assertEquals(if(workspace.contentMode == WorkspaceContentMode.E2EE) "workspace_e2ee_unsupported" else "workspace_mode_unconfirmed",repo.state.value.failure)
  }
  repo.disconnect()
 }

 @Test fun modeRetryKeepsAccountConnectionAndNewSelectionAcrossOfflineFailure()=runTest {
  var rows=listOf(Workspace("w","Work",contentMode=WorkspaceContentMode.PLAINTEXT),Workspace("target","Target"))
  var offline=false
  val refreshEntered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
  val api=object:CloudAuthApi {
   override suspend fun account(credential:Credential)=Account("u","User",rows)
   override suspend fun workspaceModes(credential:Credential, workspaces:List<Workspace>):List<Workspace> {
    if(offline) throw java.io.IOException("offline")
    refreshEntered.complete(Unit);release.await()
    rows=rows.map {it.copy(contentMode=WorkspaceContentMode.PLAINTEXT)}
    return rows
   }
   override suspend fun grant(credential:Credential,workspaceId:String)=ShortLivedGrant("short","https://streams.example.org",60)
   override suspend fun signOut(credential:Credential)=Unit
  }
  val credentials=object:CredentialStore {
   override suspend fun read()=Credential("fixture")
   override suspend fun write(credential:Credential)=Unit
   override suspend fun clear()=error("A retry must never clear credentials")
  }
  val store=Store(AccountContext(Account("u","User",rows)))
  val account=AccountController(api,credentials,backgroundScope,store)
  account.restore().join()
  val owner=RuntimeOwner({Runtime(it)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->}
  repo.select(rows.first()).join();runCurrent()
  val generation=owner.state.value.status.generation
  offline=true
  account.refreshWorkspaceModes().join();runCurrent()
  assertTrue(account.state.value.verified);assertFalse(account.state.value.busy)
  assertEquals(key,owner.state.value.scope);assertEquals(generation,owner.state.value.status.generation)
  repo.select(rows.last()).join();runCurrent()
  assertEquals("target",store.context?.workspaceId)
  offline=false
  val retry=account.refreshWorkspaceModes();refreshEntered.await()
  assertEquals("target",repo.state.value.workspace?.id);assertTrue(account.state.value.verified)
  release.complete(Unit);retry.join();runCurrent()
  assertEquals("target",repo.state.value.workspace?.id)
  assertEquals(RuntimeScope("u","target"),owner.state.value.scope)
  assertEquals("target",store.context?.workspaceId)
  repo.disconnect()
 }

 @Test fun confirmedCatalogSurvivesResumeAndHeartbeatWithoutRewritingCache()=runTest {
  val store=Store(AccountContext(user));val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->};runCurrent()
  repo.select(user.workspaces[0]).join();runCurrent();val runtime=runtimes.last()
  runtime.source.emit(RuntimeEvent.CatalogUpdated(snapshot));runtime.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  val saved=store.values[key]
  runtime.status.value=RuntimeStatus(RuntimePhase.SUSPENDED,1);runCurrent()
  assertEquals(ConnectionPhase.PAUSED,repo.state.value.phase)
  runtime.source.emit(RuntimeEvent.Synced(50,2));runCurrent()
  assertEquals(ConnectionPhase.PAUSED,repo.state.value.phase)
  assertEquals(2,repo.state.value.streams)
  // A redundant heartbeat must not turn an already saved catalog into a disk failure.
  store.failWrite=true
  runtime.status.value=RuntimeStatus(RuntimePhase.READY,1);runCurrent()
  runtime.source.emit(RuntimeEvent.Synced(50,2));runCurrent()
  assertEquals(ConnectionPhase.LIVE,repo.state.value.phase)
  assertNull(repo.state.value.failure);assertFalse(repo.state.value.cacheFailure)
  assertEquals(saved,store.values[key]);assertEquals(saved?.syncedAt,repo.state.value.syncedAt)
  repo.disconnect()
 }

 @Test fun syncFailureSurvivesSameGenerationResumeUntilMatchingSyncRecoversIt()=runTest {
  val store=Store(AccountContext(user));val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->};runCurrent()
  repo.select(user.workspaces[0]).join();runCurrent();val runtime=runtimes.last()
  runtime.source.emit(RuntimeEvent.CatalogUpdated(snapshot));runtime.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  runtime.source.emit(RuntimeEvent.SyncFailed("network_unavailable"));runCurrent()
  runtime.status.value=RuntimeStatus(RuntimePhase.SUSPENDED,1);runCurrent()
  runtime.source.emit(RuntimeEvent.SyncFailed("network_unavailable"));runCurrent()
  assertEquals(ConnectionPhase.PAUSED,repo.state.value.phase)
  runtime.status.value=RuntimeStatus(RuntimePhase.READY,1);runCurrent()
  assertEquals(ConnectionPhase.UNAVAILABLE,repo.state.value.phase)
  assertEquals("network_unavailable",repo.state.value.failure)
  runtime.source.emit(RuntimeEvent.Synced(51,1));runCurrent()
  assertEquals(ConnectionPhase.UNAVAILABLE,repo.state.value.phase)
  runtime.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  assertEquals(ConnectionPhase.LIVE,repo.state.value.phase);assertNull(repo.state.value.failure)
  repo.disconnect()
 }

 @Test fun replacementGenerationRequiresItsOwnMatchingCatalogEvenWithRepeatedRevision()=runTest {
  val store=Store(AccountContext(user));val account=account(backgroundScope,store){ShortLivedGrant("short","https://streams.example.org",60)}
  account.restore().join()
  val runtimes=mutableListOf<Runtime>();val owner=RuntimeOwner({Runtime(it).also(runtimes::add)},StandardTestDispatcher(testScheduler))
  val repo=CatalogRepository(account,owner,backgroundScope,store){_,_->};runCurrent()
  repo.select(user.workspaces[0]).join();runCurrent();val runtime=runtimes.last()
  runtime.source.emit(RuntimeEvent.CatalogUpdated(snapshot));runtime.source.emit(RuntimeEvent.Synced(50,1));runCurrent()
  val saved=store.values[key]
  runtime.status.value=RuntimeStatus(RuntimePhase.READY,2);runCurrent()
  assertEquals(ConnectionPhase.SYNCING,repo.state.value.phase)
  runtime.source.emit(RuntimeEmission(2,RuntimeEvent.Synced(50,1)));runCurrent()
  runtime.source.emit(RuntimeEmission(1,RuntimeEvent.CatalogUpdated(snapshot)));runCurrent()
  runtime.source.emit(RuntimeEmission(2,RuntimeEvent.Synced(50,1)));runCurrent()
  assertEquals(ConnectionPhase.SYNCING,repo.state.value.phase);assertSame(saved,store.values[key])
  runtime.source.emit(RuntimeEmission(2,RuntimeEvent.CatalogUpdated(snapshot.copy(projects=emptyList()))));runCurrent()
  runtime.source.emit(RuntimeEmission(2,RuntimeEvent.Synced(51,1)));runCurrent()
  assertEquals(ConnectionPhase.SYNCING,repo.state.value.phase)
  runtime.status.value=RuntimeStatus(RuntimePhase.SUSPENDED,2);runCurrent()
  runtime.source.emit(RuntimeEmission(2,RuntimeEvent.Synced(50,1)));runCurrent()
  assertEquals(ConnectionPhase.PAUSED,repo.state.value.phase);assertEquals(0,repo.state.value.projects)
  assertEquals(0,store.values[key]!!.snapshot.projects.size)
  runtime.status.value=RuntimeStatus(RuntimePhase.READY,2);runCurrent()
  assertEquals(ConnectionPhase.LIVE,repo.state.value.phase)
  repo.disconnect()
 }

 private suspend fun MutableSharedFlow<RuntimeEmission>.emit(event: RuntimeEvent) { emit(RuntimeEmission(1, event)) }

}
