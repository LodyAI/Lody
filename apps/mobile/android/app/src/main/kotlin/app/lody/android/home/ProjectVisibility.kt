package app.lody.android.home

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.lody.android.BackendEnvironment
import app.lody.android.auth.AccountController
import app.lody.android.chat.GitHubHttp
import app.lody.android.chat.GitHubHttpClient
import app.lody.android.runtime.CatalogProject
import app.lody.android.runtime.CatalogSnapshot
import app.lody.android.runtime.RuntimeScope
import kotlinx.coroutines.CancellationException
import org.json.JSONArray
import org.json.JSONObject

/** One cloud registration of a local project (`localProjects:listVisibleLocalProjects`). */
data class VisibilityRow(
    val machineId: String,
    val localProjectId: String,
    val ownerUserId: String,
    val sharedWithTeam: Boolean,
    val updatedAt: Double,
) {
    val key: String get() = "$machineId\u0000$localProjectId"
}

/**
 * iOS `VisibilitySnapshot`: the registrations, the signed-in user, and the user's own computers
 * (null when the machine read failed).
 */
data class VisibilitySnapshot(val userId: String, val rows: List<VisibilityRow>, val ownedMachineIds: Set<String>? = null) {
    /**
     * Registrations plus, as desktop does, a private row for each catalog project on the user's own
     * computer that has no registration yet.
     */
    fun effectiveRows(projects: List<CatalogProject>): List<VisibilityRow> {
        val owned = ownedMachineIds?.takeIf { it.isNotEmpty() } ?: return rows
        val keys = rows.mapTo(mutableSetOf()) { it.key }
        val added = projects.filter { it.machineId in owned }.mapNotNull { project ->
            val local = ProjectVisibilityModel.localId(project) ?: return@mapNotNull null
            VisibilityRow(project.machineId, local, userId, sharedWithTeam = false, updatedAt = 0.0).takeIf { keys.add(it.key) }
        }
        return rows + added
    }
}

class ProjectVisibilityFailure(code: String) : Exception(code)

interface ProjectVisibilityService {
    suspend fun list(scope: RuntimeScope): VisibilitySnapshot
    /** Writes, then returns a fresh read that already shows the write. Never retried. */
    suspend fun set(scope: RuntimeScope, row: VisibilityRow, shared: Boolean): VisibilitySnapshot
}

/** Pure projection of Settings › Projects' local project visibility (iOS `ProjectVisibilitySections`). */
internal object ProjectVisibilityModel {
    enum class State { Shared, Private, Unknown }

    data class Item(
        val id: String,
        val title: String,
        /** The root path for the owner's projects; null for another member's project. */
        val path: String?,
        val state: State,
        /** Set for the owner's registered (or owned, unregistered) projects: the row it changes. */
        val editable: VisibilityRow?,
    )

    data class Machine(val machineId: String, val items: List<Item>)

    /** The local project id of a catalog `<machine>:local:<id>` project. */
    fun localId(project: CatalogProject): String? =
        "${project.machineId}:local:".let { prefix -> project.id.takeIf { it.startsWith(prefix) }?.removePrefix(prefix)?.ifEmpty { null } }

    /**
     * The local catalog is the source: registrations (cached, then live) only add each project's
     * sharing state, so a slow, failed or empty read never blanks the page. Before the first read,
     * or when the machine read failed, a project without a registration is Unknown and read only.
     * Once the user's computers are known, unregistered projects on others' computers stay hidden.
     */
    fun machines(snapshot: VisibilitySnapshot?, catalog: CatalogSnapshot?): List<Machine> {
        val projects = catalog?.projects.orEmpty()
        val byId = projects.associateBy { it.id }
        val order = mutableListOf<String>()
        val groups = mutableMapOf<String, MutableList<Item>>()
        fun add(machine: String, item: Item) {
            groups.getOrPut(machine) { order += machine; mutableListOf() } += item
        }
        val effective = snapshot?.effectiveRows(projects).orEmpty()
        for (row in effective) {
            val project = byId["${row.machineId}:local:${row.localProjectId}"]
            val owned = row.ownerUserId == snapshot?.userId
            add(row.machineId, Item(
                "visibility:${row.key}",
                project?.name?.ifEmpty { null } ?: row.localProjectId,
                if (owned) project?.rootPath.orEmpty() else null,
                if (row.sharedWithTeam) State.Shared else State.Private,
                row.takeIf { owned },
            ))
        }
        val known = effective.mapTo(mutableSetOf()) { it.key }
        if (snapshot?.ownedMachineIds == null) {
            for (project in projects) {
                val local = localId(project) ?: continue
                if ("${project.machineId}\u0000$local" in known) continue
                add(project.machineId, Item("unknown:${project.id}", project.name.ifEmpty { local }, project.rootPath, State.Unknown, null))
            }
        }
        return order.map { Machine(it, groups.getValue(it)) }
    }
}

internal typealias ProjectVisibilityCall = suspend (kind: String, path: String, args: JSONObject) -> Any?

/**
 * iOS `WorkspaceSettingsCloud` `projects` page, natively: the `localProjects:*` and
 * `machines:listVisibleMachines` Convex functions, the workspace always from the native scope.
 * A write is allowed only for the user's own registration, or an unregistered project on the
 * user's own computer, and counts only once a fresh read shows it.
 */
internal object ProjectVisibilityCloud {
    suspend fun list(workspace: String, user: String, call: ProjectVisibilityCall): VisibilitySnapshot {
        val rows = rows(call("query", "localProjects:listVisibleLocalProjects", scope(workspace)))
        return VisibilitySnapshot(user, rows, owned(workspace, user, call))
    }

    suspend fun set(workspace: String, user: String, row: VisibilityRow, shared: Boolean, call: ProjectVisibilityCall): VisibilitySnapshot {
        val rows = rows(call("query", "localProjects:listVisibleLocalProjects", scope(workspace)))
        val owned = owned(workspace, user, call)
        val existing = rows.firstOrNull { it.key == row.key }
        if (existing != null) { if (existing.ownerUserId != user) throw ProjectVisibilityFailure("forbidden") }
        else if (owned?.contains(row.machineId) != true) throw ProjectVisibilityFailure("forbidden")
        val result = call("mutation", "localProjects:setLocalProjectSharedWithTeam", scope(workspace)
            .put("machineId", row.machineId).put("localProjectId", row.localProjectId).put("sharedWithTeam", shared)) as? JSONObject
        if (result?.opt("success") != true || result?.opt("sharedWithTeam") != shared) throw ProjectVisibilityFailure("write_unknown")
        val fresh = rows(call("query", "localProjects:listVisibleLocalProjects", scope(workspace)))
        if (fresh.none { it.key == row.key && it.sharedWithTeam == shared }) throw ProjectVisibilityFailure("write_unknown")
        return VisibilitySnapshot(user, fresh, owned)
    }

    private fun scope(workspace: String) = JSONObject().put("workspaceId", workspace)

    /** Like desktop; a failed machine read only leaves unregistered projects unknown. */
    private suspend fun owned(workspace: String, user: String, call: ProjectVisibilityCall): Set<String>? = try {
        val rows = call("query", "machines:listVisibleMachines", scope(workspace)) as? JSONArray ?: throw ProjectVisibilityFailure("invalid")
        if (rows.length() > 10000) throw ProjectVisibilityFailure("invalid")
        (0 until rows.length()).mapNotNull { rows.optJSONObject(it) }
            .filter { it.optString("ownerUserId") == user }
            .mapNotNullTo(mutableSetOf()) { it.optString("machineId").ifEmpty { null } }
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (_: Exception) { null }

    fun rows(value: Any?): List<VisibilityRow> {
        val array = value as? JSONArray ?: throw ProjectVisibilityFailure("invalid")
        if (array.length() > 10000) throw ProjectVisibilityFailure("invalid")
        val keys = mutableSetOf<String>()
        return (0 until array.length()).map { index ->
            val row = array.optJSONObject(index) ?: throw ProjectVisibilityFailure("invalid")
            val updated = (row.opt("updatedAt") as? Number)?.toDouble()
            val shared = row.opt("sharedWithTeam") as? Boolean
            val parsed = VisibilityRow(row.optString("machineId"), row.optString("localProjectId"), row.optString("ownerUserId"), shared ?: false, updated ?: -1.0)
            if (parsed.machineId.isEmpty() || parsed.localProjectId.isEmpty() || parsed.ownerUserId.isEmpty() || shared == null ||
                updated == null || !updated.isFinite() || updated < 0 || !keys.add(parsed.key)) throw ProjectVisibilityFailure("invalid")
            parsed
        }
    }
}

internal class LiveProjectVisibilityService(
    private val account: AccountController,
    private val reads: GitHubHttp = GitHubHttpClient(),
    private val writes: GitHubHttp = GitHubHttpClient(retryOnConnectionFailure = false),
) : ProjectVisibilityService {
    override suspend fun list(scope: RuntimeScope): VisibilitySnapshot =
        execute(scope) { call -> ProjectVisibilityCloud.list(scope.workspaceId, scope.accountId, call) }

    override suspend fun set(scope: RuntimeScope, row: VisibilityRow, shared: Boolean): VisibilitySnapshot =
        execute(scope) { call -> ProjectVisibilityCloud.set(scope.workspaceId, scope.accountId, row, shared, call) }

    private suspend fun execute(scope: RuntimeScope, body: suspend (ProjectVisibilityCall) -> VisibilitySnapshot): VisibilitySnapshot =
        account.withVerifiedAccount(scope) { credential ->
            val jwt = JSONObject(expect(reads.request("GET", "${BackendEnvironment.site}/api/auth/convex/token", credential.token, null)))
                .optString("token").ifEmpty { throw ProjectVisibilityFailure("unauthorized") }
            body { kind, path, args ->
                val http = if (kind == "query") reads else writes
                val response = JSONObject(expect(http.request("POST", "${BackendEnvironment.convex}/api/$kind", jwt,
                    JSONObject().put("path", path).put("format", "convex_encoded_json").put("args", JSONArray().put(args)))))
                if (response.optString("status") != "success") throw ProjectVisibilityFailure("request_failed")
                response.opt("value")
            }
        }

    private fun expect(response: Pair<Int, String>): String {
        val (status, body) = response
        if (status in 200..299) return body
        throw ProjectVisibilityFailure(if (status == 401) "unauthorized" else "request_failed")
    }
}

/**
 * iOS `ProjectVisibilityController`: the last accepted read for this scope shows at once (process
 * memory), the live read replaces it, and only a live read enables changes. A failed or unknown
 * write leaves the page locked until a fresh read; it is never replayed.
 */
internal class ProjectVisibilityState(private val service: ProjectVisibilityService, val scope: RuntimeScope) {
    var snapshot by mutableStateOf(remembered?.takeIf { it.first == scope }?.second); private set
    var live by mutableStateOf(false); private set
    var loading by mutableStateOf(false); private set
    var failed by mutableStateOf(false); private set
    var unconfirmed by mutableStateOf(false); private set
    var writing by mutableStateOf(false); private set
    private var version = 0

    val editable: Boolean get() = live && !loading && !writing && !failed && !unconfirmed

    suspend fun refresh() {
        if (writing) return
        val id = ++version
        loading = true
        failed = false
        try {
            val next = service.list(scope)
            if (id == version) { accept(next); unconfirmed = false }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { if (id == version) failed = true }
        finally { if (id == version) loading = false }
    }

    suspend fun set(row: VisibilityRow, shared: Boolean) {
        if (!editable || row.sharedWithTeam == shared) return
        val id = ++version
        writing = true
        loading = false
        try {
            val next = service.set(scope, row, shared)
            if (id == version) { accept(next); failed = false }
        } catch (cancelled: CancellationException) { throw cancelled }
        catch (_: Exception) { if (id == version) unconfirmed = true }
        finally { writing = false }
    }

    private fun accept(next: VisibilitySnapshot) {
        snapshot = next
        live = true
        remembered = scope to next
    }

    companion object {
        /** Process memory only (one scope). */
        @Volatile private var remembered: Pair<RuntimeScope, VisibilitySnapshot>? = null
    }
}
