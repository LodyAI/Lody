package app.lody.android.auth
import app.lody.android.runtime.*
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test
@OptIn(ExperimentalCoroutinesApi::class)
class AccountControllerTest {
 @Test fun branchReadCannotPublishAcrossLogout()=runTest {
  val controller=AccountController(Api(),Store(Credential("saved")),backgroundScope)
  controller.restore().join()
  val late=CompletableDeferred<String>()
  val result=async { try { controller.withVerifiedAccount(RuntimeScope("user","workspace")) { late.await() } } catch(e:AuthFailure) { e.code } }
  runCurrent();controller.logout().join();late.complete("stale branches")
  assertEquals("account_changed",result.await())
 }
 private class Store(var saved:Credential?=null):CredentialStore {
  override suspend fun read()=saved
  override suspend fun write(credential:Credential){saved=credential}
  override suspend fun clear(){saved=null}
 }
 private open class Api:CloudAuthApi {
  override suspend fun email(email:String,password:String):Credential=Credential("fixture-secret")
  override suspend fun account(credential:Credential)=Account("user","Fixture",listOf(Workspace("workspace","Fixture", contentMode = WorkspaceContentMode.PLAINTEXT)))
  override suspend fun grant(credential:Credential,workspaceId:String)=ShortLivedGrant("short","https://streams.lody.ai",60)
  override suspend fun signOut(credential:Credential)=Unit
 }
 @Test fun loginPersistsOnlyAfterAccountValidationAndLogoutClearsLocalState()=runTest {
  val store=Store();var cleared=0
  val controller=AccountController(Api(),store,backgroundScope){cleared++}
  val login=controller.login("a@example.com","password");advanceTimeBy(1001);runCurrent();login.join()
  assertEquals("user",controller.state.value.account?.id);assertNotNull(store.saved)
  assertFalse(controller.state.value.toString().contains("fixture-secret"))
  controller.logout().join();assertNull(store.saved);assertNull(controller.state.value.account);assertTrue(cleared>0)
 }
 @Test fun cancellationCannotPublishOrPersistLateAuthorization()=runTest {
  val store=Store();val polled=CompletableDeferred<Unit>();val late=CompletableDeferred<Credential>()
  val api=object:Api(){override suspend fun email(email:String,password:String):Credential {
   polled.complete(Unit);return withContext(NonCancellable){late.await()}
  }}
  val controller=AccountController(api,store,backgroundScope)
  controller.login("a@example.com","password");advanceTimeBy(1001);runCurrent();polled.await()
  val cancellation=controller.cancel();runCurrent();late.complete(Credential("late"));cancellation.join()
  assertNull(store.saved);assertNull(controller.state.value.account);assertNull(controller.state.value.notice)
 }
 @Test fun successorAccountSurvivesLogoutWhenAnIntermediateOperationIsCancelled()=runTest {
  for (startIntermediate in listOf(true,false)) {
   val store=Store(Credential("old"));val cache=Context()
   val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>()
   var suspendTeardown=false
   val api=object:Api(){override suspend fun account(credential:Credential)=
    Account(if(credential.token=="old") "old-user" else "successor","Fixture",listOf(Workspace("workspace","Fixture", contentMode = WorkspaceContentMode.PLAINTEXT)))}
   val controller=AccountController(api,store,backgroundScope,cache){
    if(suspendTeardown){suspendTeardown=false;entered.complete(Unit);release.await()}
   }
   controller.restore().join()
   suspendTeardown=true
   val logout=controller.logout();runCurrent();entered.await()
   val intermediate=controller.cancel()
   if(startIntermediate) runCurrent()
   val successor=controller.login("successor@example.test", "fixture-password")
   // Let a broken successor overtake the suspended logout, including Device Flow polling.
   runCurrent();advanceTimeBy(1001);runCurrent()
   release.complete(Unit)
   logout.join();intermediate.join()
   advanceTimeBy(1001);runCurrent();successor.join()
   assertEquals("successor",controller.state.value.account?.id)
   assertTrue(controller.state.value.verified)
   assertFalse(controller.state.value.busy)
   assertEquals("fixture-secret",store.saved?.token)
   assertEquals("successor",cache.saved?.account?.id)
   assertEquals("fixture-secret",controller.withVerifiedIdentity("successor"){it.token})
  }
 }
 @Test fun revokedSavedCredentialRequiresFreshAuthorization()=runTest {
  val store=Store(Credential("expired"))
  val api=object:Api(){override suspend fun account(credential:Credential):Account=throw AuthFailure("auth_expired")}
  val controller=AccountController(api,store,backgroundScope)
  controller.restore().join();assertNull(store.saved);assertNull(controller.state.value.account)
  assertEquals("auth_expired",controller.state.value.failure)
 }
 @Test fun lateMemberResponseCannotCrossLogout()=runTest {
  val pending=CompletableDeferred<List<WorkspaceMember>>()
  val api=object:Api(){override suspend fun members(credential:Credential,workspaceId:String)=pending.await()}
  val controller=AccountController(api,Store(Credential("saved")),backgroundScope)
  controller.restore().join()
  val result=async {try{controller.members(RuntimeScope("user","workspace"));"leaked"}catch(e:AuthFailure){e.code}}
  runCurrent();controller.logout().join();pending.complete(listOf(WorkspaceMember("p","Person")))
  assertEquals("account_changed",result.await())
 }
 @Test fun grantCannotCrossLogoutOrWorkspaceBoundary()=runTest {
  val pending=CompletableDeferred<ShortLivedGrant>()
  val api=object:Api(){override suspend fun grant(credential:Credential,workspaceId:String)=pending.await()}
  val controller=AccountController(api,Store(Credential("saved")),backgroundScope)
  controller.restore().join()
  val result=async {try{controller.grant(RuntimeScope("user","workspace"));"leaked"}catch(e:AuthFailure){e.code}}
  runCurrent();controller.logout().join();pending.complete(ShortLivedGrant("late","https://streams.lody.ai",60))
  assertEquals("account_changed",result.await())
 }
 @Test fun grant401InvalidatesOnlyTheMatchingAccount()=runTest {
  val store=Store(Credential("revoked"));var disconnected=0
  val api=object:Api(){override suspend fun grant(credential:Credential,workspaceId:String):ShortLivedGrant=throw AuthFailure("auth_expired")}
  val controller=AccountController(api,store,backgroundScope){disconnected++}
  controller.restore().join()
  try {controller.grant(RuntimeScope("user","workspace"));fail()} catch(_:AuthFailure){}
  runCurrent()
  assertNull(store.saved);assertNull(controller.state.value.account)
  assertEquals("auth_expired",controller.state.value.failure);assertEquals(2,disconnected)
 }
 @Test fun staleGrant401CannotInvalidateANewerCredential()=runTest {
  val store=Store(Credential("old"));val pending=CompletableDeferred<ShortLivedGrant>()
  val api=object:Api(){override suspend fun grant(credential:Credential,workspaceId:String)=pending.await()}
  val controller=AccountController(api,store,backgroundScope);controller.restore().join()
  val old=async {try{controller.grant(RuntimeScope("user","workspace"))}catch(_:AuthFailure){}}
  runCurrent();controller.logout().join();store.saved=Credential("new");controller.restore().join()
  pending.completeExceptionally(AuthFailure("auth_expired"));old.await();runCurrent()
  assertEquals("new",store.saved?.token);assertNotNull(controller.state.value.account)
 }

 private class Context(var saved:AccountContext? = AccountContext(Account("user","Cached",listOf(Workspace("workspace","Work", contentMode = WorkspaceContentMode.PLAINTEXT))),"workspace")):AccountContextStore {
  override suspend fun readContext()=saved
  override suspend fun saveAccount(account:Account){saved=AccountContext(account,saved?.workspaceId)}
  override suspend fun clear(){saved=null}
 }
 @Test fun offlineRestoreShowsCachedContextButCannotAuthorizeAGrant()=runTest {
  val response=CompletableDeferred<Account>();val cache=Context()
  val controller=AccountController(object:Api(){override suspend fun account(credential:Credential)=response.await()},Store(Credential("saved")),backgroundScope,cache)
  val restoring=controller.restore();runCurrent()
  assertEquals("Cached",controller.state.value.account?.name)
  assertFalse(controller.state.value.verified)
  try{controller.grant(RuntimeScope("user","workspace"));fail("cached identity authorized a grant")}catch(_:AuthFailure){}
  response.completeExceptionally(AuthFailure("network_unavailable"));restoring.join()
  assertEquals("Cached",controller.state.value.account?.name);assertFalse(controller.state.value.verified)
  assertNotNull(cache.saved)
  controller.logout().join();assertNull(cache.saved);assertNull(controller.state.value.account)
 }
 @Test fun missingOrRevokedCredentialsClearDisplayContext()=runTest {
  val cache=Context();val controller=AccountController(Api(),Store(),backgroundScope,cache)
  controller.restore().join();assertNull(cache.saved)
  val revoked=Context();val c=AccountController(object:Api(){override suspend fun account(credential:Credential):Account=throw AuthFailure("auth_expired")},Store(Credential("revoked")),backgroundScope,revoked)
  c.restore().join();assertNull(revoked.saved);assertNull(c.state.value.account)
 }

 @Test fun cancellingCredentialReadDoesNotDeleteCachedContext()=runTest {
  val cache=Context();val credentials=object:CredentialStore {
   override suspend fun read():Credential?=awaitCancellation()
   override suspend fun write(credential:Credential)=Unit
   override suspend fun clear()=Unit
  }
  val controller=AccountController(Api(),credentials,backgroundScope,cache)
  val restore=controller.restore();runCurrent();restore.cancelAndJoin()
  assertNotNull(cache.saved)
 }
 @Test fun revokedAccountIsHiddenEvenWhenCacheDeletionFails()=runTest {
  val cache=object:AccountContextStore {
   override suspend fun readContext()=AccountContext(Account("user","Cached",listOf(Workspace("workspace","Work", contentMode = WorkspaceContentMode.PLAINTEXT))))
   override suspend fun saveAccount(account:Account)=Unit
   override suspend fun clear():Unit=throw java.io.IOException("disk")
  }
  val controller=AccountController(object:Api(){override suspend fun account(credential:Credential):Account=throw AuthFailure("auth_expired")},Store(Credential("expired")),backgroundScope,cache)
  controller.restore().join();assertNull(controller.state.value.account)
 }

 @Test fun browserLoginRecoversPendingPkceAfterProcessRestartAndConsumesItOnce()=runTest {
  val encrypted=Store();val credentials=Store();val pending=BrowserAuthStore(encrypted)
  val first=AccountController(Api(),credentials,backgroundScope).also{it.browserStore=pending;it.now={1000}}
  first.browser(BrowserProvider.GitHub){}.join()
  val flow=pending.read()!!
  assertTrue(first.state.value.browserPending)
  val api=object:Api(){override suspend fun exchange(code:String,verifier:String):Credential {
   assertEquals(flow.verifier,verifier);return Credential("native")
  }}
  val recovered=AccountController(api,credentials,backgroundScope).also{it.browserStore=BrowserAuthStore(encrypted);it.now={2000}}
  recovered.restore().join();assertTrue(recovered.state.value.browserPending)
  val url="lody://auth/mobile-callback?state=${flow.state}&code=${"c".repeat(43)}"
  recovered.browserCallback(url).join()
  assertEquals("user",recovered.state.value.account?.id);assertTrue(recovered.state.value.verified)
  assertEquals("native",credentials.saved?.token);assertNull(pending.read())
  recovered.logout().join();recovered.browserCallback(url).join()
  assertNull(credentials.saved);assertNull(recovered.state.value.account)
 }
 @Test fun cancelledBrowserAttemptCannotReturnAfterRestart()=runTest {
  for(logout in listOf(false,true)) {
   val encrypted=Store();val pending=BrowserAuthStore(encrypted);val credentials=Store()
   val c=AccountController(Api(),credentials,backgroundScope).also{it.browserStore=pending;it.now={1000}}
   c.browser(BrowserProvider.Discord){}.join();val flow=pending.read()!!
   if(logout)c.logout().join() else c.cancel().join()
   val next=AccountController(Api(),credentials,backgroundScope).also{it.browserStore=BrowserAuthStore(encrypted);it.now={2000}}
   next.browserCallback("lody://auth/mobile-callback?state=${flow.state}&code=${"c".repeat(43)}").join()
   assertNull(next.state.value.account);assertNull(credentials.saved);assertNull(pending.read())
  }
 }
 @Test fun staleOrMalformedCallbackDoesNotCancelTheCurrentEmailLogin()=runTest {
  val response=CompletableDeferred<Credential>();val credentials=Store()
  val c=AccountController(object:Api(){override suspend fun email(email:String,password:String)=response.await()},credentials,backgroundScope)
  val login=c.login("a@example.com","password");runCurrent()
  c.browserCallback("lody://auth/mobile-callback?token=secret").join()
  val stale=c.browserCallback("lody://auth/mobile-callback?state=${"s".repeat(43)}&code=${"c".repeat(43)}")
  runCurrent();assertTrue(login.isActive)
  response.complete(Credential("new"));login.join();stale.join()
  assertEquals("new",credentials.saved?.token);assertTrue(c.state.value.verified)
 }
 @Test fun mismatchedAndExpiredBrowserCallbacksCannotAuthorize()=runTest {
  val pending=BrowserAuthStore(Store());val credentials=Store()
  val c=AccountController(Api(),credentials,backgroundScope).also{it.browserStore=pending;it.now={1000}}
  c.browser(BrowserProvider.Apple){}.join();val flow=pending.read()!!
  c.browserCallback("lody://auth/mobile-callback?state=${"x".repeat(43)}&code=${"c".repeat(43)}").join()
  assertNotNull(pending.read());assertTrue(c.state.value.browserPending)
  c.now={601000}
  c.browserCallback("lody://auth/mobile-callback?state=${flow.state}&code=${"c".repeat(43)}").join()
  assertNull(pending.read());assertNull(credentials.saved);assertEquals("auth_expired",c.state.value.failure)
 }
 @Test fun logoutFencesAnUncooperativeBrowserExchange()=runTest {
  val pending=BrowserAuthStore(Store());val credentials=Store();val response=CompletableDeferred<Credential>();val entered=CompletableDeferred<Unit>()
  val c=AccountController(object:Api(){override suspend fun exchange(code:String,verifier:String):Credential {
   entered.complete(Unit);return withContext(NonCancellable){response.await()}
  }},credentials,backgroundScope).also{it.browserStore=pending;it.now={1000}}
  c.browser(BrowserProvider.GitHub){}.join();val flow=pending.read()!!
  val callback=c.browserCallback("lody://auth/mobile-callback?state=${flow.state}&code=${"c".repeat(43)}")
  entered.await();val logout=c.logout();runCurrent();response.complete(Credential("late"));logout.join();callback.join()
  assertNull(credentials.saved);assertNull(pending.read());assertNull(c.state.value.account)
 }
 @Test fun registrationWithoutSessionNeverPersistsOrVerifiesAnAccount()=runTest {
  val credentials=Store();val c=AccountController(object:Api(){override suspend fun register(name:String,email:String,password:String):Credential?=null},credentials,backgroundScope)
  c.register("Name","a@example.com","password").join()
  assertNull(credentials.saved);assertNull(c.state.value.account);assertFalse(c.state.value.verified);assertEquals("verify_email",c.state.value.notice)
 }

 @Test fun replacingBrowserLoginRejectsOldStateWithoutConsumingNewAttempt()=runTest {
  val pending=BrowserAuthStore(Store());val credentials=Store()
  val c=AccountController(object:Api(){override suspend fun exchange(code:String,verifier:String)=Credential("new")},credentials,backgroundScope).also{it.browserStore=pending;it.now={1000}}
  c.browser(BrowserProvider.GitHub){}.join();val old=pending.read()!!
  c.browser(BrowserProvider.Discord){}.join();val fresh=pending.read()!!
  c.browserCallback("lody://auth/mobile-callback?state=${old.state}&code=${"c".repeat(43)}").join()
  assertEquals(fresh.state,pending.read()?.state);assertNull(credentials.saved)
  c.browserCallback("lody://auth/mobile-callback?state=${fresh.state}&code=${"c".repeat(43)}").join()
  assertEquals("new",credentials.saved?.token);assertNull(pending.read())
 }
 @Test fun cancelledGoogleSheetCannotExchangeALateSdkToken()=runTest {
  val response=CompletableDeferred<String>();val entered=CompletableDeferred<Unit>();val credentials=Store()
  val c=AccountController(object:Api(){override suspend fun google(idToken:String,nonce:String):Credential {
   fail("cancelled SDK result reached backend exchange");return Credential("invalid")
  }},credentials,backgroundScope)
  c.google{entered.complete(Unit);withContext(NonCancellable){response.await()}}
  entered.await();val cancel=c.cancel();runCurrent();response.complete("late-id-token");cancel.join()
  assertNull(credentials.saved);assertNull(c.state.value.account)
 }


}
