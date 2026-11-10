package app.lody.android.home

import app.lody.android.auth.AccountController
import app.lody.android.auth.Credential
import app.lody.android.chat.GitHubHttp
import app.lody.android.runtime.RuntimeCommand
import app.lody.android.runtime.RuntimeOwner
import app.lody.android.runtime.RuntimeResult
import app.lody.android.runtime.RuntimeScope
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder
import java.util.UUID

data class AddMachine(val id: String, val name: String)
data class FolderEntry(val name: String, val path: String, val unreadable: Boolean)
data class FolderListing(val path: String, val parent: String?, val entries: List<FolderEntry>, val next: String?)
data class GitHubRepo(val fullName: String, val private: Boolean, val enabled: Boolean)

/** The workspace's GitHub App repositories; [canManage] (admin / owner) may add them. Null: not installed. */
data class GitHubRepoList(val canManage: Boolean, val repositories: List<GitHubRepo>?)

class ProjectAddFailure(val code: String) : Exception(code)

/**
 * The Projects tab's "+" (iOS `ProjectAddMenu`): add a local folder or a GitHub repository.
 * Local folders go through the shared runtime's `localProjects` (the computer derives the
 * project id from the path, so a folder that is already a project comes back as it is); GitHub
 * repositories are enabled for the workspace (`github:setRepoEnabled`), which is all web's
 * "add" is. Credentials stay native.
 */
interface ProjectAdding {
    suspend fun machines(scope: RuntimeScope, browser: String): List<AddMachine>
    suspend fun browse(scope: RuntimeScope, browser: String, machineId: String, path: String?, cursor: String? = null): FolderListing
    /** Registers [path] as a project and returns its name. A write: never retried. */
    suspend fun add(scope: RuntimeScope, browser: String, machineId: String, path: String): String
    suspend fun cancel(scope: RuntimeScope, browser: String)
    suspend fun repositories(scope: RuntimeScope): GitHubRepoList
    suspend fun enable(scope: RuntimeScope, repo: String)
    /** The GitHub App's install / configure page, carrying a workspace state token. */
    suspend fun installUrl(scope: RuntimeScope): String

    companion object {
        fun browserId(): String = "android-projects-${System.currentTimeMillis()}-${UUID.randomUUID()}"
    }
}

internal class LiveProjectAdding(
    private val owner: RuntimeOwner,
    private val account: AccountController,
    private val http: GitHubHttp,
) : ProjectAdding {
    private suspend fun local(scope: RuntimeScope, command: RuntimeCommand.LocalProjects): JSONObject =
        owner.use(scope) { (it.execute(command) as RuntimeResult.LocalProjects).value }

    override suspend fun machines(scope: RuntimeScope, browser: String): List<AddMachine> {
        val rows = local(scope, RuntimeCommand.LocalProjects("machines", browser)).optJSONArray("machines") ?: JSONArray()
        return (0 until rows.length()).map { rows.getJSONObject(it) }.map { AddMachine(it.getString("id"), it.optString("name").ifBlank { it.getString("id") }) }
    }

    override suspend fun browse(scope: RuntimeScope, browser: String, machineId: String, path: String?, cursor: String?): FolderListing {
        val value = local(scope, RuntimeCommand.LocalProjects("browse", browser, machineId, path, cursor))
        if (value.optString("outcome") != "directory") throw ProjectAddFailure("read_failed")
        val rows = value.optJSONArray("entries") ?: JSONArray()
        return FolderListing(
            value.getString("path"),
            value.optString("parentPath").takeIf { !value.isNull("parentPath") && it.isNotEmpty() },
            (0 until rows.length()).map { rows.getJSONObject(it) }.map { FolderEntry(it.getString("name"), it.getString("absolutePath"), it.has("error")) },
            value.optString("nextCursor").ifEmpty { null },
        )
    }

    override suspend fun add(scope: RuntimeScope, browser: String, machineId: String, path: String): String {
        val value = local(scope, RuntimeCommand.LocalProjects("add", browser, machineId, path))
        val project = value.optJSONObject("project") ?: throw ProjectAddFailure("register_failed")
        return project.optString("name").ifBlank { path.substringAfterLast('/').substringAfterLast('\\') }
    }

    override suspend fun cancel(scope: RuntimeScope, browser: String) {
        runCatching { local(scope, RuntimeCommand.LocalProjects("cancel", browser)) }
    }

    private suspend fun <T> withAccount(scope: RuntimeScope, block: suspend (Credential) -> T): T = account.withVerifiedAccount(scope, block)

    override suspend fun repositories(scope: RuntimeScope): GitHubRepoList = withAccount(scope) { credential ->
        val manage = canManage(credential, scope.workspaceId)
        val raw = convex(credential, "query", "github:listWorkspaceReposWithStatus", JSONObject().put("workspaceId", scope.workspaceId))
        val rows = raw as? JSONArray
        GitHubRepoList(manage, rows?.let { list ->
            (0 until list.length()).map { list.getJSONObject(it) }.mapNotNull { row ->
                val name = row.optString("repoFullName")
                if (!validRepository(name)) null else GitHubRepo(name, row.optBoolean("private"), row.optBoolean("enabled"))
            }
        })
    }

    override suspend fun enable(scope: RuntimeScope, repo: String) {
        if (!validRepository(repo)) throw ProjectAddFailure("invalid_request")
        withAccount(scope) { credential ->
            if (!canManage(credential, scope.workspaceId)) throw ProjectAddFailure("forbidden")
            val args = JSONObject().put("workspaceId", scope.workspaceId)
            val current = convex(credential, "query", "github:listWorkspaceReposWithStatus", args) as? JSONArray
            if (current == null || (0 until current.length()).none { current.getJSONObject(it).optString("repoFullName") == repo }) throw ProjectAddFailure("not_found")
            convex(credential, "mutation", "github:setRepoEnabled", JSONObject().put("workspaceId", scope.workspaceId).put("repoFullName", repo).put("enabled", true))
            // Read back, as iOS: the write counts only once the workspace lists it enabled.
            val readback = convex(credential, "query", "github:listWorkspaceReposWithStatus", args) as? JSONArray
            if (readback == null || (0 until readback.length()).none { readback.getJSONObject(it).let { row -> row.optString("repoFullName") == repo && row.optBoolean("enabled") } }) {
                throw ProjectAddFailure("add_unknown")
            }
        }
    }

    override suspend fun installUrl(scope: RuntimeScope): String = withAccount(scope) { credential ->
        if (!canManage(credential, scope.workspaceId)) throw ProjectAddFailure("forbidden")
        val result = convex(credential, "action", "github:createGitHubInstallState", JSONObject().put("workspaceId", scope.workspaceId).put("returnTarget", "web")) as? JSONObject
        val state = result?.optString("state").orEmpty()
        if (state.isEmpty() || state.length > 4096) throw ProjectAddFailure("install_failed")
        "https://github.com/apps/lodyai/installations/new?state=" + URLEncoder.encode(state, "UTF-8")
    }

    /** Admins and owners manage the workspace's GitHub (iOS `WorkspaceSettingsCloud.github`). */
    private suspend fun canManage(credential: Credential, workspace: String): Boolean {
        val session = JSONObject(expect(http.request("GET", "${app.lody.android.BackendEnvironment.site}/api/auth/get-session", credential.token, null)))
        val user = session.optJSONObject("user")?.optString("id").orEmpty()
        if (user.isEmpty()) throw ProjectAddFailure("unauthorized")
        val organization = runCatching {
            JSONObject(expect(http.request("GET",
                "${app.lody.android.BackendEnvironment.site}/api/auth/organization/get-full-organization?organizationId=" + URLEncoder.encode(workspace, "UTF-8"),
                credential.token, null)))
        }.getOrNull() ?: return false
        if (organization.optString("id") != workspace) return false
        val members = organization.optJSONArray("members") ?: return false
        val role = (0 until members.length()).map { members.getJSONObject(it) }.firstOrNull { it.optString("userId") == user }?.optString("role").orEmpty()
        return role.split(",").map { it.trim() }.any { it == "admin" || it == "owner" }
    }

    private suspend fun convex(credential: Credential, kind: String, path: String, args: JSONObject): Any? {
        val auth = JSONObject(expect(http.request("GET", "${app.lody.android.BackendEnvironment.site}/api/auth/convex/token", credential.token, null)))
        val jwt = auth.optString("token").ifEmpty { throw ProjectAddFailure("unauthorized") }
        val response = JSONObject(expect(http.request("POST", "${app.lody.android.BackendEnvironment.convex}/api/$kind", jwt,
            JSONObject().put("path", path).put("format", "convex_encoded_json").put("args", JSONArray().put(args)))))
        if (response.optString("status") != "success") throw ProjectAddFailure("request_failed")
        return response.opt("value")
    }

    private fun expect(response: Pair<Int, String>): String {
        val (status, body) = response
        if (status in 200..299) return body
        throw ProjectAddFailure(if (status == 401) "unauthorized" else if (status == 403) "forbidden" else "request_failed")
    }

    private fun validRepository(repo: String) =
        repo.matches(Regex("[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}")) && repo.substringAfter('/') !in listOf(".", "..")
}
