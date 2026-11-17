package app.lody.android.notifications

import app.lody.android.auth.Credential
import app.lody.android.chat.GitHubHttp
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** Contract fixtures are synthetic; no real auth or Firebase credential enters tests. */
class PushCloudTest {
    private val installation = "00000000-0000-0000-0000-000000000001"
    private class Backend : GitHubHttp {
        var configuration = """{"selfHostedEnabled":true}"""
        var queryFails = false
        var sessionLive = true
        var registered: JSONObject? = null
        override suspend fun request(method: String, url: String, token: String, body: JSONObject?): Pair<Int, String> {
            if (url == "https://backend.lody.ai/api/auth/convex/token") {
                assertEquals("GET", method)
                assertNull(body)
                if (token != "better-auth-session" || !sessionLive) return 401 to "{}"
                return 200 to """{"token":"session-bound-convex-jwt"}"""
            }
            // Neither the long-lived session credential nor a CLI API key may reach Convex.
            assertEquals("session-bound-convex-jwt", token)
            assertEquals("POST", method)
            assertEquals("convex_encoded_json", body!!.getString("format"))
            assertEquals(1, body.getJSONArray("args").length())
            val args = body.getJSONArray("args").getJSONObject(0)
            when (body.getString("path")) {
                "pushSubscriptions:configuration" -> {
                    assertEquals("https://convex.lody.ai/api/query", url)
                    assertEquals(0, args.length())
                    return if (queryFails) 503 to "{}" else 200 to """{"status":"success","value":$configuration}"""
                }
                "pushSubscriptions:register" -> {
                    assertEquals("https://convex.lody.ai/api/mutation", url)
                    registered = args
                }
                "pushSubscriptions:unregister" -> {
                    assertEquals("https://convex.lody.ai/api/mutation", url)
                    assertEquals(setOf("installationId"), args.keys().asSequence().toSet())
                    if (registered?.getString("installationId") == args.getString("installationId")) registered = null
                }
                else -> error("unexpected protocol operation")
            }
            return 200 to """{"status":"success","value":null}"""
        }
    }
    @Test fun `Android registration exchanges the BetterAuth session for JWT and uses the exact public DTO`() = runTest {
        val backend = Backend()
        val session = PushCloud(installation, { "zh-Hans" }, backend).session(Credential("better-auth-session"))
        assertTrue(session.selfHosted())
        session.register("synthetic-fcm-token")
        val row = backend.registered!!
        assertEquals(setOf("installationId", "platform", "purpose", "token", "language"), row.keys().asSequence().toSet())
        assertEquals(installation, row.getString("installationId"))
        assertEquals("android", row.getString("platform"))
        assertEquals("notification", row.getString("purpose"))
        assertEquals("synthetic-fcm-token", row.getString("token"))
        assertEquals("zh-Hans", row.getString("language"))
        session.unregister()
        assertNull(backend.registered)
    }
    @Test fun `bare CLI credentials and expired sessions cannot register a push installation`() = runTest {
        val backend = Backend()
        val cloud = PushCloud(installation, { "en" }, backend)
        for (credential in listOf("cli-api-key", "better-auth-session")) {
            if (credential == "better-auth-session") backend.sessionLive = false
            try { cloud.session(Credential(credential)).register("token"); fail("must reject invalid session") }
            catch (_: IllegalStateException) { }
            assertNull(backend.registered)
        }
    }
    @Test fun `failed or malformed provider queries preserve direct selection rather than falling back to OneSignal`() = runTest {
        val backend = Backend()
        var identity: String? = null
        val device = object : PushDevice {
            override fun oneSignal(userId: String?) { identity = userId }
            override suspend fun token() = "synthetic-fcm-token"
        }
        val binding = PushBinding(device)
        val session = PushCloud(installation, { "en" }, backend).session(Credential("better-auth-session"))
        binding.refresh("user", session)
        for (config in listOf("{}", "null", """{"selfHostedEnabled":"false"}""", """{"selfHostedEnabled":false}""")) {
            backend.configuration = config
            backend.queryFails = config == """{"selfHostedEnabled":false}"""
            try { binding.refresh("user", session); fail("must reject uncertain provider") }
            catch (_: IllegalStateException) { }
            assertTrue(binding.direct)
            assertNull(identity)
            assertNotNull(backend.registered)
        }
        backend.queryFails = false
        binding.refresh("user", session)
        assertFalse(binding.direct)
        assertEquals("user", identity)
        assertNull(backend.registered)
    }
}
