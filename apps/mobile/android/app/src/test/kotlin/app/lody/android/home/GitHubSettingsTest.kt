package app.lody.android.home

import app.lody.android.runtime.RuntimeScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class GitHubSettingsTest {
    private val scope = RuntimeScope("account", "workspace")

    /** A synthetic workspace behind the four `github:*` functions. */
    private class Backend(var authorization: String = "authorized", var personal: Boolean = false) {
        val repos = linkedMapOf("zeta/tools" to false, "LodyAI/Lody" to true)
        var dropRepoWrite = false
        val writes = mutableListOf<String>()
        suspend fun call(kind: String, path: String, args: JSONObject): Any? {
            assertEquals("workspace", args.getString("workspaceId"))
            return when (path) {
                "github:listWorkspaceReposWithStatus" -> JSONArray(repos.map { (name, enabled) ->
                    JSONObject().put("repoFullName", name).put("name", name.substringAfter('/')).put("repositoryId", 1).put("private", name.startsWith("zeta")).put("enabled", enabled)
                })
                "github:getPersonalOperationSettings" -> JSONObject().put("enabled", personal).put("authorization",
                    JSONObject().put("state", authorization).put("githubAccountId", "42").put("profile", JSONObject().put("login", "octo")))
                "github:setRepoEnabled" -> {
                    writes += "repo:${args.getString("repoFullName")}=${args.getBoolean("enabled")}"
                    if (!dropRepoWrite) repos[args.getString("repoFullName")] = args.getBoolean("enabled")
                    JSONObject().put("updated", true)
                }
                "github:setPersonalOperationPreference" -> { writes += "personal=${args.getBoolean("enabled")}"; personal = args.getBoolean("enabled"); null }
                "github:createGitHubInstallState" -> { assertEquals("action", kind); JSONObject().put("state", "s t") }
                else -> error("unexpected $path")
            }
        }
    }

    private class Service(val backend: Backend, val role: String? = "admin") : GitHubSettingsService {
        var gate: CompletableDeferred<Unit>? = null
        override suspend fun perform(scope: RuntimeScope, action: GitHubSettingsAction): GitHubSettingsData {
            gate?.await()
            return GitHubSettingsCloud.run(action, scope.workspaceId, role, backend::call) as GitHubSettingsData
        }
        override suspend fun installUrl(scope: RuntimeScope) = GitHubSettingsCloud.run(GitHubSettingsAction.Install, scope.workspaceId, role, backend::call) as String
    }

    @Test fun readsRepositoriesAndIdentityWithTheWorkspaceRole() = runTest {
        val member = GitHubSettingsCloud.run(GitHubSettingsAction.List, "workspace", "member", Backend()::call) as GitHubSettingsData
        assertFalse(member.canManage)
        assertTrue(member.roleKnown)
        assertEquals(GitHubIdentity("authorized", "octo"), member.personal?.identity)
        val unknown = GitHubSettingsCloud.run(GitHubSettingsAction.List, "workspace", null, Backend()::call) as GitHubSettingsData
        assertFalse(unknown.roleKnown || unknown.canManage)
        assertTrue(GitHubSettingsCloud.run(GitHubSettingsAction.List, "workspace", "member, owner", Backend()::call).let { (it as GitHubSettingsData).canManage })
    }

    @Test fun membersCannotWriteRepositoriesOrOpenTheInstallPage() = runTest {
        val backend = Backend()
        runCatching { GitHubSettingsCloud.run(GitHubSettingsAction.Repository("zeta/tools", true), "workspace", "member", backend::call) }
            .onSuccess { fail("member write accepted") }
        runCatching { GitHubSettingsCloud.run(GitHubSettingsAction.Install, "workspace", "member", backend::call) }
            .onSuccess { fail("member install accepted") }
        assertTrue(backend.writes.isEmpty())
        assertEquals("https://github.com/apps/lodyai/installations/new?state=s+t", Service(backend).installUrl(scope))
    }

    @Test fun switchShowsAtOnceAndKeepsTheReadValueOnlyAfterReadback() = runTest {
        val backend = Backend()
        val service = Service(backend)
        val state = GitHubSettingsState(service, scope)
        state.refresh()
        assertEquals(listOf("LodyAI/Lody", "zeta/tools"), GitHubSettingsModel.repositories(state.shown, "").map { it.fullName })
        service.gate = CompletableDeferred()
        val write = async { state.setRepository("zeta/tools", true) }
        testScheduler.runCurrent()
        assertTrue("switch moves before the reply", state.shown!!.repositories!!.first { it.fullName == "zeta/tools" }.enabled)
        assertFalse("other switches lock while writing", state.editable)
        service.gate!!.complete(Unit)
        write.await()
        assertTrue(state.data!!.repositories!!.first { it.fullName == "zeta/tools" }.enabled)
        assertTrue(state.editable)
    }

    @Test fun unconfirmedWriteRollsBackLocksAndIsNeverReplayed() = runTest {
        val backend = Backend().apply { dropRepoWrite = true }
        val state = GitHubSettingsState(Service(backend), scope)
        state.refresh()
        state.setRepository("LodyAI/Lody", false)
        assertTrue(state.unconfirmed)
        assertTrue("rolled back to the read value", state.shown!!.repositories!!.first { it.fullName == "LodyAI/Lody" }.enabled)
        state.setRepository("LodyAI/Lody", false)
        assertEquals("locked until a fresh read", 1, backend.writes.size)
        backend.dropRepoWrite = false
        state.refresh()
        assertFalse(state.unconfirmed)
        state.setRepository("LodyAI/Lody", false)
        assertFalse(state.data!!.repositories!!.first { it.fullName == "LodyAI/Lody" }.enabled)
    }

    @Test fun personalIdentityTurnsOnOnlyWhileAuthorized() = runTest {
        val backend = Backend(authorization = "expired")
        val state = GitHubSettingsState(Service(backend, role = "member"), scope)
        state.refresh()
        assertFalse(GitHubSettingsModel.personalEditable(state.data!!.personal))
        state.setPersonal(true)
        assertTrue(backend.writes.isEmpty())
        backend.authorization = "authorized"
        state.refresh()
        state.setPersonal(true)
        assertEquals(listOf("personal=true"), backend.writes)
        assertTrue(state.data!!.personal!!.enabled)
        backend.authorization = "expired"
        state.refresh()
        assertTrue("an expired identity can still be turned off", GitHubSettingsModel.personalEditable(state.data!!.personal))
    }

    @Test fun searchMatchesFullNamesAndAvatarsNeedAPlainLogin() {
        val data = GitHubSettingsData(true, true, listOf(
            GitHubSettingsRepo("zeta/tools", "tools", true, false),
            GitHubSettingsRepo("LodyAI/Lody", "Lody", false, true),
        ), null)
        assertEquals(listOf("zeta/tools"), GitHubSettingsModel.repositories(data, "  ZETA ").map { it.fullName })
        assertTrue(GitHubSettingsModel.repositories(data, "absent").isEmpty())
        assertEquals("https://avatars.githubusercontent.com/octo-cat?size=96", GitHubSettingsModel.avatarUrl("octo-cat"))
        assertNull(GitHubSettingsModel.avatarUrl("../x"))
    }
}
