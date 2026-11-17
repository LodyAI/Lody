package app.lody.android.auth
import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class CloudAuthHttpTest {
 @Test fun legacyAdmissionIsCompatibleButNeverOverridesEncryptedOrPartialDescriptors()=runTest {
  val pins = WorkspaceModePins()
  pins.observe("secret", WorkspaceContentMode.E2EE)
  pins.observe("crypto", WorkspaceContentMode.PLAINTEXT)
  var jwtRequests = 0
  val api = CloudAuthHttp(pins) { path, _, body ->
   if (path.endsWith("convex/token")) { jwtRequests++; HttpReply(200, """{"token":"jwt"}""") }
   else {
    val id = JSONObject(body!!).getJSONArray("args").getJSONObject(0).getString("workspaceId")
    check(id != "secret") { "Pinned encryption must not query the server" }
    val value = JSONObject().put("workspaceId", id).put("admission", "legacy-unclassified")
    when(id) {
     "genesis" -> value.put("genesisHash", JSONObject.NULL)
     "crypto" -> value.put("cryptoOrgId", "untrusted")
     "mode" -> value.put("contentMode", "plaintext")
     "version" -> value.put("contentModeVersion", 1)
    }
    HttpReply(200, JSONObject().put("status", "success").put("value", value).toString())
   }
  }
  val rows = api.workspaceModes(Credential("fixture"), listOf("legacy","genesis","crypto","mode","version","secret").map { Workspace(it,it) })
  assertEquals(listOf(WorkspaceContentMode.PLAINTEXT,WorkspaceContentMode.UNKNOWN,WorkspaceContentMode.UNKNOWN,WorkspaceContentMode.UNKNOWN,WorkspaceContentMode.UNKNOWN,WorkspaceContentMode.E2EE), rows.map { it.contentMode })
  assertEquals(1,jwtRequests)
 }
 @Test fun modeQueriesHaveFourSlotsAndOneDeadlineWithoutRevokingCompletedAdmission()=runTest {
  var active=0;var maximum=0;var jwtRequests=0
  val api=CloudAuthHttp(WorkspaceModePins()) { path,_,body ->
   if(path.endsWith("convex/token")) { jwtRequests++;HttpReply(200,"""{"token":"jwt"}""") }
   else {
    active++;maximum=maxOf(maximum,active)
    try {
     val id=JSONObject(body!!).getJSONArray("args").getJSONObject(0).getString("workspaceId")
     if(id != "fast") awaitCancellation()
     HttpReply(200,"""{"status":"success","value":{"workspaceId":"fast","admission":"legacy-unclassified"}}""")
    } finally { active-- }
   }
  }
  val rows=api.workspaceModes(Credential("fixture"),(listOf("fast")+(1..11).map { "slow$it" }).map { Workspace(it,it) })
  assertEquals(WorkspaceContentMode.PLAINTEXT,rows.first().contentMode)
  assertTrue(rows.drop(1).all { it.contentMode == WorkspaceContentMode.UNKNOWN })
  assertEquals(4,maximum);assertEquals(0,active);assertEquals(1,jwtRequests)
  assertEquals(6000L,testScheduler.currentTime)
 }
 @Test fun plaintextDiskFailureAndOrphanCacheDoNotBlockOnlineLogin()=runTest {
  val directory=java.nio.file.Files.createTempDirectory("mode-io-failure").toFile()
  try {
   val file=java.io.File(directory,"pins.json")
   java.io.File(file.path+".pending").writeText("interrupted plaintext cache")
   val pins=WorkspaceModePins(file) { _,_->throw java.io.IOException("disk full") }
   val api=CloudAuthHttp(pins) { path,_,_->when(path) {
    "/api/auth/get-session"->HttpReply(200,"""{"user":{"id":"u","name":"User"}}""")
    "/api/auth/organization/list"->HttpReply(200,"""[{"id":"plain","name":"Plain"}]""")
    "/api/auth/convex/token"->HttpReply(200,"""{"token":"jwt"}""")
    else->HttpReply(200,"""{"status":"success","value":{"workspaceId":"plain","admission":"legacy-unclassified"}}""")
   } }
   assertEquals(WorkspaceContentMode.PLAINTEXT,api.account(Credential("fixture")).workspaces.single().contentMode)
   assertEquals(WorkspaceContentMode.PLAINTEXT,pins.mode("plain"))
   assertEquals(WorkspaceContentMode.UNKNOWN,WorkspaceModePins(file).mode("plain"))
   try { pins.observe("secret",WorkspaceContentMode.E2EE);fail("Encrypted evidence must report durable write failure") } catch (_: java.io.IOException) {}
   assertEquals(WorkspaceContentMode.E2EE,pins.observe("secret",WorkspaceContentMode.PLAINTEXT))
  } finally {directory.deleteRecursively()}
 }

 @Test fun workspaceModesPersistAndRejectDowngradeAndUnknownGrant()=runTest {
  val directory = java.nio.file.Files.createTempDirectory("workspace-mode-test").toFile()
  try {
   val file = java.io.File(directory, "pins.json")
   val pins = WorkspaceModePins(file)
   var descriptor = "e2ee"
   var failMode = false
   val transport = AuthTransport { path, _, body -> when(path) {
    "/api/auth/get-session" -> HttpReply(200, """{"user":{"id":"u","name":"User"}}""")
    "/api/auth/organization/list" -> HttpReply(200, """[{"id":"w","name":"Work"},{"id":"new","name":"New"}]""")
    "/api/auth/convex/token" -> HttpReply(200, """{"token":"jwt"}""")
    "/api/query" -> {
     val id = JSONObject(body!!).getJSONArray("args").getJSONObject(0).getString("workspaceId")
     if(failMode || id == "new") HttpReply(503, "{}")
     else HttpReply(200, """{"status":"success","value":{"workspaceId":"w","contentMode":"$descriptor","contentModeVersion":1}}""")
    }
    "/api/loro-streams/token" -> HttpReply(200, """{"token":"grant","gatewayBaseUrl":"https://streams.example","expiresIn":60}""")
    else -> error("Unexpected auth request")
   } }
   var api = CloudAuthHttp(pins, transport)
   assertEquals(listOf(WorkspaceContentMode.E2EE, WorkspaceContentMode.UNKNOWN), api.account(Credential("fixture")).workspaces.map { it.contentMode })
   descriptor = "plaintext"
   api = CloudAuthHttp(WorkspaceModePins(file), transport)
   assertEquals(WorkspaceContentMode.E2EE, api.account(Credential("fixture")).workspaces.first().contentMode)
   for(id in listOf("w", "new")) {
    try { api.grant(Credential("fixture"), id); fail("Encrypted/unknown workspace must not receive a grant") }
    catch(error: AuthFailure) { assertEquals("workspace_mode_unconfirmed", error.code) }
   }
   val plainFile = java.io.File(directory, "plain.json")
   api = CloudAuthHttp(WorkspaceModePins(plainFile), transport)
   assertEquals(WorkspaceContentMode.PLAINTEXT, api.account(Credential("fixture")).workspaces.first().contentMode)
   assertEquals("grant", api.grant(Credential("fixture"), "w").token)
   failMode = true
   api = CloudAuthHttp(WorkspaceModePins(plainFile), transport)
   assertEquals(listOf(WorkspaceContentMode.PLAINTEXT, WorkspaceContentMode.UNKNOWN), api.account(Credential("fixture")).workspaces.map { it.contentMode })
   java.io.File(plainFile.path + ".pending").writeText("incomplete")
   assertEquals(WorkspaceContentMode.PLAINTEXT, CloudAuthHttp(WorkspaceModePins(plainFile), transport).workspaceMode("w"))
  } finally { directory.deleteRecursively() }
 }

 @Test fun membersUseUserIdsAndFollowPagination()=runTest {
  var calls=0
  val api=CloudAuthHttp(WorkspaceModePins()) {path,_,_->
   assertTrue(path.contains("organizationId=w")); assertTrue(path.contains("offset=${calls}"))
   calls++
   HttpReply(200,"""{"total":2,"members":[{"id":"membership-$calls","userId":"u$calls","user":{"id":"u$calls","name":"Person $calls","image":"http://unsafe/avatar"}}]}""")
  }
  val members=api.members(Credential("fixture"),"w")
  assertEquals(listOf("u1","u2"), members.map { it.id })
  assertNull(members.first().image)
  assertEquals(2,calls)
 }

 @Test fun nativeEmailUsesBetterAuthAndReturnsOnlyNativeCredential()=runTest {
  val api=CloudAuthHttp(WorkspaceModePins()) {path,credential,body->
   assertEquals("/api/auth/sign-in/email",path);assertNull(credential)
   assertEquals("person@example.com",JSONObject(body!!).getString("email"))
   assertEquals("password",JSONObject(body).getString("password"))
   assertEquals("${app.lody.android.BackendEnvironment.site}/api/auth/mobile/email-verified",JSONObject(body).getString("callbackURL"))
   HttpReply(200,"""{"token":"native-secret"}""")
  }
  val credential=api.email("person@example.com","password")
  assertEquals("native-secret",credential.token);assertFalse(credential.toString().contains("native-secret"))
 }
 @Test fun googleIdTokenAndNonceUseSocialEndpointWithoutRedirect()=runTest {
  val api=CloudAuthHttp(WorkspaceModePins()) {path,_,body->
   assertEquals("/api/auth/sign-in/social",path)
   val data=JSONObject(body!!);assertEquals("google",data.getString("provider"))
   assertEquals("nonce",data.getJSONObject("idToken").getString("nonce"))
   assertEquals("google-token",data.getJSONObject("idToken").getString("token"))
   HttpReply(200,"""{"token":"native"}""")
  }
  assertEquals("native",api.google("google-token","nonce").token)
 }
 @Test fun verificationRequiredRegistrationDoesNotInventSession()=runTest {
  val api=CloudAuthHttp(WorkspaceModePins()) {_,_,_->HttpReply(200,"""{"token":null,"user":{"id":"u"}}""")}
  assertNull(api.register("Name","person@example.com","password"))
 }
 @Test fun credentialErrorsAreSafeCodesNeverServerMessages()=runTest {
  val api=CloudAuthHttp(WorkspaceModePins()) {_,_,_->HttpReply(401,"""{"code":"INVALID_EMAIL_OR_PASSWORD","message":"private details"}""")}
  try{api.email("person@example.com","wrong");fail()}catch(e:AuthFailure){assertEquals("invalid_credentials",e.code)}
  val expired=CloudAuthHttp(WorkspaceModePins()) {_,_,_->HttpReply(401,"private server details")}
  try{expired.account(Credential("fixture"));fail()}catch(e:AuthFailure){assertEquals("auth_expired",e.code)}
 }
 @Test fun parsesHttpsAvatarsOnly()=runTest {
  val api=CloudAuthHttp(WorkspaceModePins()) {path,_,_-> when(path) {
   "/api/auth/get-session"->HttpReply(200,"""{"user":{"id":"u","name":"Fixture","image":"https://avatars.example/u.png"}}""")
   else->HttpReply(200,"""[{"id":"w","name":"Work","logo":"https://cdn.example/w.png"},{"id":"x","name":"Other","logo":"http://insecure/x.png"}]""")
  }}
  val account=api.account(Credential("secret"))
  assertEquals("https://avatars.example/u.png",account.image)
  assertEquals(listOf("https://cdn.example/w.png",null),account.workspaces.map { it.image })
 }
 @Test fun browserExchangeSendsVerifierOnlyToFixedBackendAndNeverBrowser()=runTest {
  val flow=PendingBrowserAuth.create(1000)
  val url=java.net.URI(flow.startUrl(BrowserProvider.GitHub))
  assertEquals(java.net.URI(app.lody.android.BackendEnvironment.site).host,url.host);assertEquals("/api/auth/mobile/start",url.path)
  assertFalse(url.toString().contains(flow.verifier))
  val expected=java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(flow.verifier.toByteArray()))
  assertTrue(url.rawQuery.contains("code_challenge=$expected"))
  val api=CloudAuthHttp(WorkspaceModePins()) {path,credential,body->
   assertEquals("/api/auth/mobile/exchange",path);assertNull(credential)
   val data=JSONObject(body!!);assertEquals(flow.verifier,data.getString("code_verifier"));assertEquals(NATIVE_CALLBACK,data.getString("redirect_uri"))
   HttpReply(200,"""{"token":"native"}""")
  }
  assertEquals("native",api.exchange("code",flow.verifier).token)
 }
 @Test fun onlyExactSingleCodeCallbackIsAcceptedAndBearerLinksAreRejected() {
  val query="state=${"s".repeat(43)}&code=${"c".repeat(43)}"
  assertNotNull(BrowserCallback.parse("$NATIVE_CALLBACK?$query"))
  for(url in listOf(
   "lody://evil/mobile-callback?$query", "lody://auth:80/mobile-callback?$query", "lody://user@auth/mobile-callback?$query",
   "lody://auth/mobile-callback/extra?$query", "lody://auth/mobile-callback/?$query", "lody://auth/%6dobile-callback?$query",
   "$NATIVE_CALLBACK?$query#fragment", "$NATIVE_CALLBACK?$query&code=${"c".repeat(43)}", "$NATIVE_CALLBACK?$query&token=secret",
   "$NATIVE_CALLBACK?state=${"s".repeat(43)}&token=secret", "$NATIVE_CALLBACK?$query&error=oauth_failed",
   "$NATIVE_CALLBACK?state=${"s".repeat(43)}&code=short", "LODY://auth/mobile-callback?$query"
  )) assertNull(url,BrowserCallback.parse(url))
 }

 @Test fun nonproductionPasswordResetIsRejectedBeforeAnyRequest()=runTest {
  org.junit.Assume.assumeTrue(app.lody.android.BackendEnvironment.site != "https://backend.lody.ai")
  val api=CloudAuthHttp(WorkspaceModePins()) {_,_,_-> error("Nonproduction reset must never send a request") }
  try { api.requestReset("person@example.com"); fail("Reset must be unsupported") }
  catch (error: AuthFailure) { assertEquals("unsupported_local_reset",error.code) }
 }
 @Test fun passwordResetRequestsKeepBearerCapabilityOnTheHttpsWebsite()=runTest {
  org.junit.Assume.assumeTrue(app.lody.android.BackendEnvironment.site == "https://backend.lody.ai")
  val api=CloudAuthHttp(WorkspaceModePins()) {path,credential,body->
   assertEquals("/api/auth/request-password-reset",path);assertNull(credential)
   val data=JSONObject(body!!)
   assertEquals("https://lody.ai/reset-password",data.getString("redirectTo"))
   assertEquals("person@example.com",data.getString("email"))
   HttpReply(200,"""{"status":true}""")
  }
  api.requestReset("person@example.com")
  assertNull(BrowserCallback.parse("lody://auth/reset-password?token=${"r".repeat(24)}"))
 }
}
