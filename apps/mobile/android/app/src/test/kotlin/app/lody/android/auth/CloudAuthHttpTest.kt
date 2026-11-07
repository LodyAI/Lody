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

 @Test fun deviceFlowUsesRegisteredClientAndTrustedBrowserAddress()=runTest {
  val api=CloudAuthHttp {path,credential,body->
   assertEquals("/api/auth/device/code",path);assertNull(credential)
   assertEquals("lody-cli",JSONObject(body!!).getString("client_id"))
   HttpReply(200,"""{"device_code":"private","user_code":"ABCD","verification_uri_complete":"https://backend.lody.ai/device?user_code=ABCD","expires_in":600,"interval":5}""")
  }
  val code=api.authorize();assertEquals("https://lody.ai/device?user_code=ABCD",code.verificationUrl)
  assertFalse(code.toString().contains("private"))
 }
 @Test fun rejectsUntrustedBrowserTargetsAndAuthExpiry()=runTest {
  val bad=CloudAuthHttp {_,_,_->HttpReply(200,"""{"device_code":"d","user_code":"u","verification_uri_complete":"https://evil.example/device","expires_in":600,"interval":5}""")}
  try {bad.authorize();fail()} catch(e:AuthFailure){assertEquals("invalid_auth_response",e.code)}
  val expired=CloudAuthHttp {_,_,_->HttpReply(401,"private server details")}
  try {expired.account(Credential("fixture"));fail()} catch(e:AuthFailure){assertEquals("auth_expired",e.code)}
 }
 @Test fun parsesTokenPendingAndAccountWithoutExposingCredentials()=runTest {
  val api=CloudAuthHttp {path,_,_-> when(path) {
   "/api/auth/device/token"->HttpReply(400,"""{"error":"authorization_pending"}""")
   "/api/auth/get-session"->HttpReply(200,"""{"user":{"id":"u","name":"Fixture"}}""")
   else->HttpReply(200,"""[{"id":"w","name":"Workspace"}]""")
  }}
  assertEquals(TokenPoll.Pending,api.poll(DeviceAuthorization("d","u","https://lody.ai",60,2)))
  assertEquals(Account("u","Fixture",listOf(Workspace("w","Workspace"))),api.account(Credential("secret")))
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
}
