package app.lody.android.notifications

import app.lody.android.auth.Credential
import app.lody.android.chat.GitHubHttp
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import org.junit.Assert.*
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class PushMutationOrderingTest {
    @Test fun `logout during submitted registration waits for its commit before unregistering`() = runTest {
        val submitted = CompletableDeferred<Unit>()
        val response = CompletableDeferred<Unit>()
        var registration: String? = null
        val http = GitHubHttp { _, url, _, body ->
            if (url.endsWith("/convex/token")) 200 to """{"token":"fixture-jwt"}"""
            else when (body!!.getString("path")) {
                "pushSubscriptions:configuration" -> 200 to """{"status":"success","value":{"selfHostedEnabled":true}}"""
                "pushSubscriptions:register" -> {
                    submitted.complete(Unit)
                    response.await()
                    registration = body.getJSONArray("args").getJSONObject(0).getString("token")
                    200 to """{"status":"success","value":null}"""
                }
                else -> { registration = null; 200 to """{"status":"success","value":null}""" }
            }
        }
        val session = PushCloud("00000000-0000-0000-0000-000000000001", { "en" }, http).session(Credential("session"))
        var currentToken = "old-account-token"
        val binding = PushBinding(object : PushDevice {
            override fun oneSignal(userId: String?) = Unit
            override suspend fun token() = currentToken
        })
        val refresh = launch { binding.refresh("old", session) }
        submitted.await()
        refresh.cancel()
        val logout = launch { refresh.join(); binding.clear() }
        runCurrent()
        assertFalse(logout.isCompleted)
        response.complete(Unit)
        logout.join()
        assertNull(registration)
        currentToken = "next-account-token"
        binding.refresh("next", session)
        assertEquals("next-account-token", registration)
    }

    @Test fun `registration timeout is bounded but cannot prove absence of a later remote commit`() = runTest {
        val submitted = CompletableDeferred<Unit>()
        val remoteCommit = CompletableDeferred<Unit>()
        var registration: String? = null
        var timedOut = false
        // The server's lifetime is independent of the client's HTTP response waiter.
        val server = launch { remoteCommit.await(); registration = "old-token" }
        val http = GitHubHttp { _, url, _, body ->
            if (url.endsWith("/convex/token")) 200 to """{"token":"fixture-jwt"}"""
            else if (body!!.getString("path") == "pushSubscriptions:register") {
                submitted.complete(Unit)
                awaitCancellation()
            } else {
                registration = null
                200 to """{"status":"success","value":null}"""
            }
        }
        val session = PushCloud("00000000-0000-0000-0000-000000000001", { "en" }, http).session(Credential("session"))
        val registrationWait = launch {
            try { session.register("old-token") }
            catch (_: TimeoutCancellationException) { timedOut = true }
        }
        submitted.await()
        advanceTimeBy(15_000); runCurrent()
        registrationWait.join()
        assertTrue(timedOut)
        session.unregister()
        assertNull(registration)
        remoteCommit.complete(Unit); server.join()
        assertEquals("old-token", registration)
    }
}
