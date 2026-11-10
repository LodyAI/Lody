package app.lody.android.auth
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
class CloudAuthHttpTest {
 @Test fun membersUseUserIdsAndFollowPagination()=runTest {
  var calls=0
  val api=CloudAuthHttp {path,_,_->
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
  val api=CloudAuthHttp {path,credential,body->
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
  val api=CloudAuthHttp {path,_,body->
   assertEquals("/api/auth/sign-in/social",path)
   val data=JSONObject(body!!);assertEquals("google",data.getString("provider"))
   assertEquals("nonce",data.getJSONObject("idToken").getString("nonce"))
   assertEquals("google-token",data.getJSONObject("idToken").getString("token"))
   HttpReply(200,"""{"token":"native"}""")
  }
  assertEquals("native",api.google("google-token","nonce").token)
 }
 @Test fun verificationRequiredRegistrationDoesNotInventSession()=runTest {
  val api=CloudAuthHttp {_,_,_->HttpReply(200,"""{"token":null,"user":{"id":"u"}}""")}
  assertNull(api.register("Name","person@example.com","password"))
 }
 @Test fun credentialErrorsAreSafeCodesNeverServerMessages()=runTest {
  val api=CloudAuthHttp {_,_,_->HttpReply(401,"""{"code":"INVALID_EMAIL_OR_PASSWORD","message":"private details"}""")}
  try{api.email("person@example.com","wrong");fail()}catch(e:AuthFailure){assertEquals("invalid_credentials",e.code)}
  val expired=CloudAuthHttp {_,_,_->HttpReply(401,"private server details")}
  try{expired.account(Credential("fixture"));fail()}catch(e:AuthFailure){assertEquals("auth_expired",e.code)}
 }
 @Test fun parsesHttpsAvatarsOnly()=runTest {
  val api=CloudAuthHttp {path,_,_-> when(path) {
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
  val api=CloudAuthHttp {path,credential,body->
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
  val api=CloudAuthHttp {_,_,_-> error("Nonproduction reset must never send a request") }
  try { api.requestReset("person@example.com"); fail("Reset must be unsupported") }
  catch (error: AuthFailure) { assertEquals("unsupported_local_reset",error.code) }
 }
 @Test fun passwordResetRequestsKeepBearerCapabilityOnTheHttpsWebsite()=runTest {
  org.junit.Assume.assumeTrue(app.lody.android.BackendEnvironment.site == "https://backend.lody.ai")
  val api=CloudAuthHttp {path,credential,body->
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
