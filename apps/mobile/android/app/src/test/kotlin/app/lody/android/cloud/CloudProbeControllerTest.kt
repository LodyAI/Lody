package app.lody.android.cloud
import app.lody.android.auth.*
import app.lody.android.catalog.*
import app.lody.android.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CatalogConnectionTest {
 private class Cache:CatalogStore {
  override suspend fun readContext():AccountContext?=null
  override suspend fun saveAccount(account:Account)=Unit
  override suspend fun clear()=Unit
  override suspend fun select(scope:RuntimeScope)=Unit
  override suspend fun read(scope:RuntimeScope):SavedCatalog?=null
  override suspend fun write(scope:RuntimeScope,catalog:SavedCatalog)=Unit
 }
 private class Fake(override val scope:RuntimeScope):CloudRuntime {
  val status=MutableStateFlow(RuntimeStatus());override val state:StateFlow<RuntimeStatus> =status
  val emitted=MutableSharedFlow<RuntimeEmission>();override val events:Flow<RuntimeEmission> =emitted
  override suspend fun start(){status.value=RuntimeStatus(RuntimePhase.READY,1)}
  override suspend fun stop(){status.value=RuntimeStatus(RuntimePhase.STOPPED,2)}
  override suspend fun setActive(active:Boolean)=Unit
  override suspend fun execute(command:RuntimeCommand)=RuntimeResult.Pong(true)
 }
 @Test fun disconnectWhileGrantPendingCannotStartAnOldWorkspace()=runTest {
  val instances=mutableListOf<Fake>();val grant=CompletableDeferred<ShortLivedGrant>()
  val api=object:CloudAuthApi {
   override suspend fun account(credential:Credential)=Account("u","User",listOf(Workspace("w","Work")))
   override suspend fun grant(credential:Credential,workspaceId:String)=withContext(NonCancellable){grant.await()}
   override suspend fun signOut(credential:Credential)=Unit
  }
  val store=object:CredentialStore {
   override suspend fun read()=Credential("fixture")
   override suspend fun write(credential:Credential)=Unit
   override suspend fun clear()=Unit
  }
  val account=AccountController(api,store,backgroundScope);account.restore().join()
  val owner=RuntimeOwner({Fake(it).also(instances::add)},StandardTestDispatcher(testScheduler))
  val probe=CatalogRepository(account,owner,backgroundScope,Cache()){_,_->}
  probe.select(Workspace("w","Work"));runCurrent()
  val disconnected=launch{probe.disconnect()};runCurrent()
  grant.complete(ShortLivedGrant("short","https://streams.example.org",60));disconnected.join()
  assertTrue(instances.isEmpty());assertEquals(ConnectionPhase.DISCONNECTED,probe.state.value.phase)
 }
 @Test fun changedGrantOriginReplacesPermissionAndRejectsOldCatalogEvents()=runTest {
  val instances=mutableListOf<Fake>();val origins=mutableListOf<String>();var grants=0
  val api=object:CloudAuthApi {
   override suspend fun account(credential:Credential)=Account("u","User",listOf(Workspace("w","Work")))
   override suspend fun grant(credential:Credential,workspaceId:String)=ShortLivedGrant("fixture","https://gateway${++grants}.example.org",60)
   override suspend fun signOut(credential:Credential)=Unit
  }
  val store=object:CredentialStore {
   override suspend fun read()=Credential("fixture")
   override suspend fun write(credential:Credential)=Unit
   override suspend fun clear()=Unit
  }
  val account=AccountController(api,store,backgroundScope);account.restore().join()
  val owner=RuntimeOwner({Fake(it).also(instances::add)},StandardTestDispatcher(testScheduler))
  val probe=CatalogRepository(account,owner,backgroundScope,Cache()){_,grant->origins.add(grant.gatewayBaseUrl)}
  probe.select(Workspace("w","Work")).join();runCurrent()
  val old=instances.single();old.emitted.emit(RuntimeEvent.SyncFailed("grant_endpoint_changed"));runCurrent()
  assertEquals(listOf("https://gateway1.example.org","https://gateway2.example.org"),origins)
  assertEquals(2,instances.size);assertEquals(RuntimePhase.STOPPED,old.state.value.phase)
  old.emitted.emit(RuntimeEvent.Synced(99,99));runCurrent();assertEquals(0,probe.state.value.streams)
  instances.last().emitted.emit(RuntimeEvent.CatalogUpdated(CatalogSnapshot(1,emptyList(),emptyList(),emptyList())));instances.last().emitted.emit(RuntimeEvent.Synced(1,2));runCurrent();assertEquals(ConnectionPhase.LIVE,probe.state.value.phase)
  probe.disconnect()
 }

 private suspend fun MutableSharedFlow<RuntimeEmission>.emit(event: RuntimeEvent) { emit(RuntimeEmission(1, event)) }

}
