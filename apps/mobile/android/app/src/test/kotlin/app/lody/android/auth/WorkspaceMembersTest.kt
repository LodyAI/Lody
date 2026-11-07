package app.lody.android.auth

import app.lody.android.runtime.RuntimeScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class WorkspaceMembersTest {
    private val scope = RuntimeScope("u", "w")
    private class Store : WorkspaceMemberStore {
        var value = listOf(WorkspaceMember("person", "Cached"))
        val events = mutableListOf<String>()
        override suspend fun readMembers(scope: RuntimeScope): List<WorkspaceMember> { events += "cache"; return value }
        override suspend fun writeMembers(scope: RuntimeScope, members: List<WorkspaceMember>) { events += "save"; value = members }
    }
    @Test fun emitsCacheBeforeNetworkThenReplacesAndPersists() = runTest {
        val store = Store()
        val values = WorkspaceMembers(store) { store.events += "network"; listOf(WorkspaceMember("person", "Fresh")) }.observe(scope).toList()
        assertEquals(listOf("Cached", "Fresh"), values.map { it.getValue("person").name })
        assertEquals(listOf("cache", "network", "save"), store.events)
        assertEquals("Fresh", store.value.single().name)
    }
    @Test fun failureRetainsCacheAndDoesNotOverwriteIt() = runTest {
        val store = Store()
        val values = WorkspaceMembers(store) { throw AuthFailure("offline") }.observe(scope).toList()
        assertEquals("Cached", values.single().getValue("person").name)
        assertEquals(listOf("cache"), store.events)
    }
    @Test fun cancellationNeverPersistsLateResults() = runTest {
        val store = Store()
        try { WorkspaceMembers(store) { throw CancellationException() }.observe(scope).toList(); fail() }
        catch (_: CancellationException) { }
        assertEquals(listOf("cache"), store.events)
    }
}
