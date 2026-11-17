package app.lody.android.notifications

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class PushBindingTest {
    private class Device : PushDevice {
        var identity: String? = null
        var tokenGate: CompletableDeferred<String>? = null
        override fun oneSignal(userId: String?) { identity = userId }
        override suspend fun token() = tokenGate?.await() ?: "fcm-token"
    }
    private class Session(var direct: Boolean) : PushSession {
        var registration: String? = null
        var failRegister = false
        override suspend fun selfHosted() = direct
        override suspend fun register(token: String) {
            registration = token
            if (failRegister) error("response_lost")
        }
        override suspend fun unregister() { registration = null }
    }
    @Test fun `OneSignal uses the verified user ID and switching providers retires direct registration`() = runTest {
        val device = Device(); val session = Session(false); val binding = PushBinding(device)
        binding.refresh("user", session)
        assertEquals("user", device.identity)
        assertNull(session.registration)
        session.direct = true
        binding.refresh("user", session)
        assertNull(device.identity)
        assertEquals("fcm-token", session.registration)
        session.direct = false
        binding.refresh("user", session)
        assertNull(session.registration)
        assertEquals("user", device.identity)
        binding.clear()
        assertNull(device.identity)
    }
    @Test fun `direct cleanup outage does not disable the selected OneSignal provider`() = runTest {
        for (timeout in listOf(false, true)) {
            val device = Device(); val binding = PushBinding(device)
            val session = object : PushSession {
                override suspend fun selfHosted() = false
                override suspend fun register(token: String) = error("must not register direct")
                override suspend fun unregister(): Unit = if (timeout) withTimeout(15_000) { awaitCancellation() } else error("offline")
            }
            binding.refresh("user", session)
            assertEquals("user", device.identity)
            assertFalse(binding.direct)
        }
    }
    @Test fun `logout cancels pending token acquisition so it cannot bind the next account`() = runTest {
        val device = Device().apply { tokenGate = CompletableDeferred() }
        val session = Session(true); val binding = PushBinding(device)
        val registration = launch { binding.refresh("old", session) }
        yield()
        binding.detach(); registration.cancelAndJoin(); binding.clear()
        device.tokenGate!!.complete("late-token")
        assertNull(session.registration)
        assertNull(device.identity)
        assertFalse(binding.direct)
        device.tokenGate = null
        binding.refresh("new", Session(false))
        assertEquals("new", device.identity)
    }
    @Test fun `logout cleans up a registration that committed before its response was lost`() = runTest {
        val device = Device(); val session = Session(true).apply { failRegister = true }
        val binding = PushBinding(device)
        try { binding.refresh("user", session); fail("expected failure") } catch (_: IllegalStateException) { }
        assertEquals("fcm-token", session.registration)
        binding.clear()
        assertNull(session.registration)
        assertFalse(binding.direct)
    }
    @Test fun `notification navigation requires current recipient and verified workspace slug membership`() {
        val user = app.lody.android.auth.Account("user", "User", listOf(app.lody.android.auth.Workspace("workspace-id", "Team", slug = "team")))
        assertEquals(PushRoute("workspace-id", "session"), PushRoute.resolve("/team/sessions/session", "user", user))
        assertNull(PushRoute.resolve("/team/sessions/session", "previous-user", user))
        assertNull(PushRoute.resolve("/team/sessions/session", null, user))
        assertNull(PushRoute.resolve("/team/sessions/session", "", user))
        assertNull(PushRoute.resolve("/team/sessions/session", " \t\n", user))
        assertNull(PushRoute.resolve("/team/sessions/session", " user ", user))
        assertNull(PushRoute.resolve("/other-team/sessions/session", "user", user))
    }
    @Test fun `notification targets reject URLs and malformed identifiers`() {
        assertEquals(PushRoute("workspace", "session-1"), PushRoute.parse("workspace", "session-1"))
        assertNull(PushRoute.parse("https://other.example", "session"))
        assertNull(PushRoute.parse("workspace", "../session"))
        assertNull(PushRoute.parse("workspace", null))
        assertEquals(PushRoute("team-slug", "session-1"), PushRoute.fromPath("/team-slug/sessions/session-1"))
        assertNull(PushRoute.fromPath("https://lody.ai/team/sessions/session"))
        assertNull(PushRoute.fromPath("//evil/sessions/session"))
        assertNull(PushRoute.fromPath("/team/sessions/session?redirect=evil"))
    }
}
