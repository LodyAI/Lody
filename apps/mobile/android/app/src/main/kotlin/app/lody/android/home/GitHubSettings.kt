package app.lody.android.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.lody.android.BackendEnvironment
import app.lody.android.auth.AccountController
import app.lody.android.auth.Credential
import app.lody.android.chat.GitHubHttp
import app.lody.android.chat.GitHubHttpClient
import app.lody.android.runtime.RuntimeScope
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject
import java.net.URLEncoder

data class GitHubSettingsRepo(val fullName: String, val name: String, val private: Boolean, val enabled: Boolean) {
    val owner: String get() = fullName.substringBefore('/')
}

/** `state` is missing / expired / authorized; only display fields leave the adapter. */
data class GitHubIdentity(val state: String, val login: String?)

data class GitHubPersonalSettings(val enabled: Boolean, val identity: GitHubIdentity)

/**
 * iOS `GitHubSettings`: [repositories] is null when the workspace has no GitHub App installation;
 * [errors] names the sources ("repositories", "personal") that could not be read.
 */
data class GitHubSettingsData(
    val canManage: Boolean,
    val roleKnown: Boolean,
    val repositories: List<GitHubSettingsRepo>?,
    val personal: GitHubPersonalSettings?,
    val errors: Set<String> = emptySet(),
)

class GitHubSettingsFailure(val code: String) : Exception(code)

sealed interface GitHubSettingsAction {
    data object List : GitHubSettingsAction
    data class Repository(val fullName: String, val enabled: Boolean) : GitHubSettingsAction
    data class Personal(val enabled: Boolean) : GitHubSettingsAction
    data object Install : GitHubSettingsAction
}

interface GitHubSettingsService {
    /** Reads, or writes and reads back; [GitHubSettingsAction.Install] is answered by [installUrl]. */
    suspend fun perform(scope: RuntimeScope, action: GitHubSettingsAction): GitHubSettingsData
    suspend fun installUrl(scope: RuntimeScope): String
}

/**
 * iOS `WorkspaceSettingsCloud.github`, natively: the `github:*` Convex functions with the verified
 * account's session-bound token, the workspace always from the native scope. Writes check the
 * row exists first, are never retried, and count only once a fresh read shows them.
 */
internal typealias GitHubSettingsCall = suspend (kind: String, path: String, args: JSONObject) -> Any?

internal object GitHubSettingsCloud {

    private fun canManage(role: String?) = role.orEmpty().split(",").map { it.trim() }.any { it == "admin" || it == "owner" }

    suspend fun run(action: GitHubSettingsAction, workspace: String, role: String?, call: GitHubSettingsCall): Any {
        val scope = { JSONObject().put("workspaceId", workspace) }
        val manage = canManage(role)
        when (action) {
            GitHubSettingsAction.Install -> {
                if (!manage) throw GitHubSettingsFailure("forbidden")
                val result = call("action", "github:createGitHubInstallState", scope().put("returnTarget", "web")) as? JSONObject
                val state = result?.optString("state").orEmpty()
                if (state.isEmpty() || state.length > 4096) throw GitHubSettingsFailure("install_failed")
                return "https://github.com/apps/lodyai/installations/new?state=" + URLEncoder.encode(state, "UTF-8")
            }
            is GitHubSettingsAction.Repository -> {
                if (!manage || !validRepository(action.fullName)) throw GitHubSettingsFailure("forbidden")
                val current = call("query", "github:listWorkspaceReposWithStatus", scope()) as? JSONArray
                if (current == null || rows(current).none { it.optString("repoFullName") == action.fullName }) throw GitHubSettingsFailure("not_found")
                val result = call("mutation", "github:setRepoEnabled", scope().put("repoFullName", action.fullName).put("enabled", action.enabled)) as? JSONObject
                if (result?.opt("updated") !is Boolean) throw GitHubSettingsFailure("write_unknown")
                val readback = call("query", "github:listWorkspaceReposWithStatus", scope()) as? JSONArray
                if (readback == null || rows(readback).none { it.optString("repoFullName") == action.fullName && it.optBoolean("enabled") == action.enabled }) {
                    throw GitHubSettingsFailure("write_unknown")
                }
            }
            is GitHubSettingsAction.Personal -> {
                val current = call("query", "github:getPersonalOperationSettings", scope()) as? JSONObject
                if (action.enabled && current?.optJSONObject("authorization")?.optString("state") != "authorized") throw GitHubSettingsFailure("unauthorized")
                call("mutation", "github:setPersonalOperationPreference", scope().put("enabled", action.enabled))
                val fresh = call("query", "github:getPersonalOperationSettings", scope()) as? JSONObject
                if (fresh?.opt("enabled") != action.enabled) throw GitHubSettingsFailure("write_unknown")
            }
            GitHubSettingsAction.List -> Unit
        }
        val errors = mutableSetOf<String>()
        val repositories = try {
            when (val raw = call("query", "github:listWorkspaceReposWithStatus", scope())) {
                null, JSONObject.NULL -> null
                is JSONArray -> {
                    if (raw.length() > 10000) throw GitHubSettingsFailure("invalid")
                    rows(raw).map { row ->
                        val name = row.optString("repoFullName")
                        if (!validRepository(name) || row.opt("private") !is Boolean || row.opt("enabled") !is Boolean) throw GitHubSettingsFailure("invalid")
                        GitHubSettingsRepo(name, row.optString("name").ifEmpty { name.substringAfter('/') }, row.getBoolean("private"), row.getBoolean("enabled"))
                    }
                }
                else -> throw GitHubSettingsFailure("invalid")
            }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { errors += "repositories"; null }
        val personal = try {
            val raw = call("query", "github:getPersonalOperationSettings", scope()) as? JSONObject ?: throw GitHubSettingsFailure("invalid")
            val auth = raw.optJSONObject("authorization") ?: throw GitHubSettingsFailure("invalid")
            val state = auth.optString("state")
            if (raw.opt("enabled") !is Boolean || state !in setOf("missing", "authorized", "expired")) throw GitHubSettingsFailure("invalid")
            if (state == "authorized" && auth.optString("githubAccountId").isEmpty()) throw GitHubSettingsFailure("invalid")
            GitHubPersonalSettings(raw.getBoolean("enabled"), GitHubIdentity(state, auth.optJSONObject("profile")?.optString("login")?.ifEmpty { null }))
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { errors += "personal"; null }
        return GitHubSettingsData(manage, role != null, repositories, personal, errors)
    }

    private fun rows(array: JSONArray) = (0 until array.length()).mapNotNull { array.optJSONObject(it) }

    fun validRepository(repo: String) =
        repo.matches(Regex("[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}")) && repo.substringAfter('/') !in listOf(".", "..")
}

internal class LiveGitHubSettingsService(
    private val account: AccountController,
    private val reads: GitHubHttp = GitHubHttpClient(),
    private val writes: GitHubHttp = GitHubHttpClient(retryOnConnectionFailure = false),
) : GitHubSettingsService {
    override suspend fun perform(scope: RuntimeScope, action: GitHubSettingsAction): GitHubSettingsData =
        execute(scope, action) as? GitHubSettingsData ?: throw GitHubSettingsFailure("invalid")

    override suspend fun installUrl(scope: RuntimeScope): String =
        execute(scope, GitHubSettingsAction.Install) as? String ?: throw GitHubSettingsFailure("install_failed")

    private suspend fun execute(scope: RuntimeScope, action: GitHubSettingsAction): Any = account.withVerifiedAccount(scope) { credential ->
        val role = role(credential, scope)
        val jwt = JSONObject(expect(reads.request("GET", "${BackendEnvironment.site}/api/auth/convex/token", credential.token, null)))
            .optString("token").ifEmpty { throw GitHubSettingsFailure("unauthorized") }
        GitHubSettingsCloud.run(action, scope.workspaceId, role) { kind, path, args ->
            val http = if (kind == "query") reads else writes
            val response = JSONObject(expect(http.request("POST", "${BackendEnvironment.convex}/api/$kind", jwt,
                JSONObject().put("path", path).put("format", "convex_encoded_json").put("args", JSONArray().put(args)))))
            if (response.optString("status") != "success") throw GitHubSettingsFailure("request_failed")
            response.opt("value")
        }
    }

    /** The account's workspace role; null when it cannot be read, which keeps writes off. */
    private suspend fun role(credential: Credential, scope: RuntimeScope): String? = try {
        val organization = JSONObject(expect(reads.request("GET",
            "${BackendEnvironment.site}/api/auth/organization/get-full-organization?organizationId=" + URLEncoder.encode(scope.workspaceId, "UTF-8"),
            credential.token, null)))
        if (organization.optString("id") != scope.workspaceId) null
        else organization.optJSONArray("members")?.let { members ->
            (0 until members.length()).mapNotNull { members.optJSONObject(it) }.firstOrNull { it.optString("userId") == scope.accountId }?.optString("role")
        }
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { null }

    private fun expect(response: Pair<Int, String>): String {
        val (status, body) = response
        if (status in 200..299) return body
        throw GitHubSettingsFailure(if (status == 401) "unauthorized" else "request_failed")
    }
}

/** Pure presentation rules shared by the screen and its tests. */
internal object GitHubSettingsModel {
    fun repositories(data: GitHubSettingsData?, query: String): List<GitHubSettingsRepo> {
        val needle = query.trim()
        return data?.repositories.orEmpty()
            .filter { needle.isEmpty() || it.fullName.contains(needle, ignoreCase = true) }
            .sortedWith(compareBy(String.CASE_INSENSITIVE_ORDER) { it.fullName })
    }

    /** Turning the personal identity on needs a live authorization; turning it off never does. */
    fun personalEditable(personal: GitHubPersonalSettings?): Boolean =
        personal != null && (personal.enabled || personal.identity.state == "authorized")

    fun avatarUrl(login: String?): String? =
        login?.takeIf { it.isNotEmpty() && it.all { c -> c.isLetterOrDigit() && c.code < 128 || c == '-' } }
            ?.let { "https://avatars.githubusercontent.com/$it?size=96" }
}

/**
 * iOS `GitHubSettingsController`: a flipped switch shows its new position until the write reads
 * back; a failed or unknown write returns it to the last read value and locks the page until a
 * fresh read, since the outcome is unknown and is never replayed.
 */
internal class GitHubSettingsState(private val service: GitHubSettingsService, val scope: RuntimeScope) {
    var data by mutableStateOf<GitHubSettingsData?>(null); private set
    var loading by mutableStateOf(false); private set
    var failed by mutableStateOf(false); private set
    var unconfirmed by mutableStateOf(false); private set
    var writing by mutableStateOf(false); private set
    /** The in-flight switch: "personal" or "repo:<fullName>" to its requested value. */
    var pending by mutableStateOf<Pair<String, Boolean>?>(null); private set
    private var version = 0

    val blocked: Boolean get() = failed || unconfirmed || data?.errors?.isNotEmpty() == true
    val editable: Boolean get() = !loading && !writing && !blocked

    /** The last read value with the in-flight switch applied. */
    val shown: GitHubSettingsData? get() {
        val base = data ?: return null
        val (id, value) = pending ?: return base
        return if (id == PERSONAL) base.copy(personal = base.personal?.copy(enabled = value))
        else base.copy(repositories = base.repositories?.map { if ("repo:${it.fullName}" == id) it.copy(enabled = value) else it })
    }

    suspend fun refresh() {
        if (writing) return
        val id = ++version
        loading = true
        failed = false
        try {
            val next = service.perform(scope, GitHubSettingsAction.List)
            if (id == version) { data = next; unconfirmed = false }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { if (id == version) failed = true }
        finally { if (id == version) loading = false }
    }

    suspend fun installUrl(): String = service.installUrl(scope)

    suspend fun setRepository(fullName: String, enabled: Boolean) {
        val current = data ?: return
        if (!current.canManage || current.repositories?.any { it.fullName == fullName && it.enabled != enabled } != true) return
        write("repo:$fullName" to enabled, GitHubSettingsAction.Repository(fullName, enabled))
    }

    suspend fun setPersonal(enabled: Boolean) {
        val personal = data?.personal ?: return
        if (personal.enabled == enabled || (enabled && personal.identity.state != "authorized")) return
        write(PERSONAL to enabled, GitHubSettingsAction.Personal(enabled))
    }

    private suspend fun write(shown: Pair<String, Boolean>, action: GitHubSettingsAction) {
        if (!editable) return
        val id = ++version
        writing = true
        pending = shown
        try {
            val next = service.perform(scope, action)
            if (id == version) data = next
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { if (id == version) unconfirmed = true }
        finally { writing = false; pending = null }
    }

    companion object { const val PERSONAL = "personal" }
}
