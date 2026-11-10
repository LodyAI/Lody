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
 private val user=Account("u","User",listOf(Workspace("w","Work"),Workspace("x","Other")))
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
  assertEquals(2,runtimes.size);assertEquals(RuntimePhase.STOPPED,old.state.value.phase)
  assertEquals(1,repo.state.value.projects);assertTrue(repo.state.value.cached)
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

 private suspend fun MutableSharedFlow<RuntimeEmission>.emit(event: RuntimeEvent) { emit(RuntimeEmission(1, event)) }

}
