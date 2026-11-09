package app.lody.android.catalog

import app.lody.android.create.CreationOptionsStore
import app.lody.android.create.BranchCache
import app.lody.android.create.BranchPage
import android.content.Context
import android.util.AtomicFile
import app.lody.android.auth.*
import app.lody.android.runtime.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest

/** Whole display snapshots, serialized on IO. No tokens, CRDT replicas or cursors. */
internal class AtomicCatalogStore(context: Context, name: String = "catalog") : CatalogStore, CreationOptionsStore, WorkspaceMemberStore, app.lody.android.schedules.ScheduleStore {
    init { require(name.matches(Regex("[a-zA-Z0-9_-]+"))) }
    private val directory = File(context.noBackupFilesDir, name + app.lody.android.BackendEnvironment.storageSuffix)
    private val mutex = Mutex()
    private suspend fun <T> io(block: () -> T): T = mutex.withLock { withContext(Dispatchers.IO) { block() } }
    private val accountFile get() = File(directory, "account.json")
    private fun catalogFile(scope: RuntimeScope): File {
        val digest = MessageDigest.getInstance("SHA-256").digest((scope.accountId + "\u0000" + scope.workspaceId).toByteArray())
        return File(directory, digest.joinToString("") { "%02x".format(it) } + ".json")
    }
    private fun load(file: File, maximum: Long = 8L * 1024 * 1024): JSONObject? {
        val atomic = AtomicFile(file)
        if (!file.exists() && !File(file.path + ".bak").exists()) return null
        return try {
            atomic.openRead().use {
                require(it.channel.size() in 1..maximum)
                JSONObject(it.readBytes().toString(Charsets.UTF_8)).also { json -> require(json.getInt("version") == 1) }
            }
        } catch (_: Exception) { atomic.delete(); null }
    }
    private fun save(file: File, json: JSONObject, maximum: Int = 8 * 1024 * 1024) {
        val bytes = json.put("version", 1).toString().toByteArray()
        require(bytes.size <= maximum) { "cache_limit" }
        check(directory.isDirectory || directory.mkdirs())
        val atomic = AtomicFile(file)
        val output = atomic.startWrite()
        try { output.write(bytes); atomic.finishWrite(output) }
        catch (error: Exception) { atomic.failWrite(output); throw error }
    }
    private fun context(): AccountContext? {
        val json = load(accountFile, 1024 * 1024) ?: return null
        return try {
            val workspaces = json.getJSONArray("workspaces").objects().map { Workspace(it.getString("id"), it.getString("name"), httpsImage(it.optString("image")), it.optString("slug").takeIf { slug -> slug.isNotBlank() && slug != "null" }) }
            val account = Account(json.getString("id"), json.getString("name"), workspaces, httpsImage(json.optString("image")))
            AccountContext(account, json.optString("selected").takeIf { id -> workspaces.any { it.id == id } })
        } catch (_: Exception) { AtomicFile(accountFile).delete(); null }
    }
    private fun saveContext(context: AccountContext) {
        save(accountFile, JSONObject().put("id", context.account.id).put("name", context.account.name).put("image", context.account.image)
            .put("workspaces", JSONArray(context.account.workspaces.map { JSONObject().put("id", it.id).put("name", it.name).put("image", it.image).put("slug", it.slug) }))
            .put("selected", context.workspaceId), 1024 * 1024)
    }
    private fun owns(scope: RuntimeScope): Boolean = context()?.account?.let { it.id == scope.accountId && it.workspaces.any { w -> w.id == scope.workspaceId } } == true
    private fun optionsFile(scope: RuntimeScope, projectId: String?): File {
        val key = JSONArray(listOf(scope.accountId, scope.workspaceId, projectId ?: "")).toString()
        val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray())
        return File(directory, "options-" + digest.joinToString("") { "%02x".format(it) } + ".json")
    }
    override suspend fun readOptions(scope: RuntimeScope, projectId: String?): CreationOptions? = io {
        if (!owns(scope)) return@io null
        val data = load(optionsFile(scope, projectId)) ?: return@io null
        try {
            require(data.getString("account") == scope.accountId && data.getString("workspace") == scope.workspaceId && data.getString("project") == (projectId ?: ""))
            CreationJson.options(data.getJSONObject("options"))
        } catch (_: Exception) { null }
    }
    override suspend fun writeOptions(scope: RuntimeScope, projectId: String?, options: CreationOptions) = io {
        require(owns(scope)) { "cache_scope_changed" }
        save(optionsFile(scope, projectId), JSONObject().put("account", scope.accountId).put("workspace", scope.workspaceId).put("project", projectId ?: "").put("options", CreationJson.encodeOptions(options)))
        directory.listFiles()?.filter { it.name.startsWith("options-") && it.name.endsWith(".json") }
            ?.sortedByDescending { it.lastModified() }?.drop(16)?.forEach { AtomicFile(it).delete() }
        Unit
    }
    private fun branchFile(scope: RuntimeScope, repo: String): File {
        val key = JSONArray(listOf(scope.accountId, scope.workspaceId, repo)).toString()
        val digest = MessageDigest.getInstance("SHA-256").digest(key.toByteArray())
        return File(directory, "branches-" + digest.joinToString("") { "%02x".format(it) } + ".json")
    }
    override suspend fun readBranches(scope: RuntimeScope, repo: String): BranchCache? = io {
        if (!owns(scope)) return@io null
        val data = load(branchFile(scope, repo), 1024 * 1024) ?: return@io null
        try {
            require(data.getString("account") == scope.accountId && data.getString("workspace") == scope.workspaceId && data.getString("repo") == repo)
            val names = data.getJSONArray("names").let { a -> (0 until a.length()).map { a.getString(it) } }
            BranchCache(BranchPage(names, data.optString("default").takeIf { it.isNotEmpty() }, data.optInt("next").takeIf { it > 0 }), data.optString("selected"))
        } catch (_: Exception) { null }
    }
    override suspend fun writeBranches(scope: RuntimeScope, repo: String, page: BranchPage) = io {
        require(owns(scope)) { "cache_scope_changed" }
        val file = branchFile(scope, repo)
        val selected = load(file, 1024 * 1024)?.optString("selected").orEmpty()
        save(file, JSONObject().put("account", scope.accountId).put("workspace", scope.workspaceId).put("repo", repo)
            .put("names", JSONArray(page.names)).put("default", page.defaultBranch).put("next", page.nextPage).put("selected", selected), 1024 * 1024)
        directory.listFiles()?.filter { it.name.startsWith("branches-") }?.sortedByDescending { it.lastModified() }?.drop(16)?.forEach { AtomicFile(it).delete() }
        Unit
    }
    override suspend fun selectBranch(scope: RuntimeScope, repo: String, name: String) = io {
        require(owns(scope)) { "cache_scope_changed" }
        val file = branchFile(scope, repo)
        val data = load(file, 1024 * 1024) ?: JSONObject().put("account", scope.accountId).put("workspace", scope.workspaceId)
            .put("repo", repo).put("names", JSONArray())
        save(file, data.put("selected", name), 1024 * 1024)
    }
    private fun schedulesFile(scope: RuntimeScope) = File(directory, "schedules-" + catalogFile(scope).name)
    override suspend fun readSchedules(scope: RuntimeScope): ScheduleList? = io {
        if (!owns(scope)) return@io null
        val data = load(schedulesFile(scope)) ?: return@io null
        try {
            require(data.getString("account") == scope.accountId && data.getString("workspace") == scope.workspaceId)
            ScheduleJson.list(data.getJSONObject("schedules"))
        } catch (_: Exception) { AtomicFile(schedulesFile(scope)).delete(); null }
    }
    override suspend fun writeSchedules(scope: RuntimeScope, value: ScheduleList) = io {
        require(owns(scope)) { "cache_scope_changed" }
        save(schedulesFile(scope), JSONObject().put("account", scope.accountId).put("workspace", scope.workspaceId)
            .put("schedules", ScheduleJson.encodeList(value)))
        directory.listFiles()?.filter { it.name.startsWith("schedules-") && it.name.endsWith(".json") }
            ?.sortedByDescending { it.lastModified() }?.drop(8)?.forEach { AtomicFile(it).delete() }
        Unit
    }
    override suspend fun readContext(): AccountContext? = io { context() }
    private fun membersFile(scope: RuntimeScope) = File(directory, "members-" + catalogFile(scope).name)
    override suspend fun readMembers(scope: RuntimeScope): List<WorkspaceMember>? = io {
        if (!owns(scope)) return@io null
        val data = load(membersFile(scope), 1024 * 1024) ?: return@io null
        if (data.optString("account") != scope.accountId || data.optString("workspace") != scope.workspaceId) return@io null
        data.getJSONArray("members").objects().map { WorkspaceMember(it.getString("id"), it.getString("name"), httpsImage(it.optString("image"))) }
    }
    override suspend fun writeMembers(scope: RuntimeScope, members: List<WorkspaceMember>) = io {
        require(owns(scope)) { "cache_scope_changed" }
        save(membersFile(scope), JSONObject().put("account", scope.accountId).put("workspace", scope.workspaceId)
            .put("members", JSONArray(members.map { JSONObject().put("id", it.id).put("name", it.name).put("image", it.image) })), 1024 * 1024)
        directory.listFiles()?.filter { it.name.startsWith("members-") && it.name.endsWith(".json") }
            ?.sortedByDescending { it.lastModified() }?.drop(16)?.forEach { AtomicFile(it).delete() }
        Unit
    }
    override suspend fun saveAccount(account: Account) = io {
        val previous = context()
        if (previous != null && previous.account.id != account.id) directory.deleteRecursively()
        previous?.account?.workspaces?.filter { old -> account.id != previous.account.id || account.workspaces.none { it.id == old.id } }?.forEach {
            AtomicFile(catalogFile(RuntimeScope(previous.account.id, it.id))).delete()
        }
        directory.listFiles()?.filter { (it.name.startsWith("options-") || it.name.startsWith("branches-") || it.name.startsWith("members-") || it.name.startsWith("schedules-")) && it.name.endsWith(".json") }?.forEach { file ->
            val cached = load(file)
            if (cached == null || cached.optString("account") != account.id || account.workspaces.none { it.id == cached.optString("workspace") }) AtomicFile(file).delete()
        }
        saveContext(AccountContext(account, previous?.workspaceId?.takeIf { previous.account.id == account.id && account.workspaces.any { w -> w.id == it } }))
    }
    override suspend fun select(scope: RuntimeScope) = io {
        require(owns(scope)) { "cache_scope_changed" }
        saveContext(context()!!.copy(workspaceId = scope.workspaceId))
    }
    override suspend fun read(scope: RuntimeScope): SavedCatalog? = io {
        if (!owns(scope)) return@io null
        val file = catalogFile(scope)
        val data = load(file) ?: return@io null
        try {
            require(data.getString("account") == scope.accountId && data.getString("workspace") == scope.workspaceId)
            SavedCatalog(CatalogSnapshot(data.getLong("revision"),
                data.getJSONArray("projects").objects().map { CatalogJson.project(CatalogProject(it.getString("id"), it.getString("machineId"), it.getString("name"), it.getString("rootPath")), it) },
                data.getJSONArray("sessions").objects().map { CatalogJson.session(CatalogSession(it.getString("id"), it.getString("machineId"), it.getString("projectId"), it.getString("title"), it.getString("status"), it.getBoolean("archived"), it.getBoolean("pinned"), it.getString("createdAt")), it) },
                data.getJSONArray("machines").let { array -> (0 until array.length()).map { array.getString(it) } },
                CatalogJson.machineNames(data), CatalogJson.machineOs(data)), data.getLong("syncedAt"))
        } catch (_: Exception) { AtomicFile(file).delete(); null }
    }
    override suspend fun write(scope: RuntimeScope, catalog: SavedCatalog) = io {
        require(owns(scope)) { "cache_scope_changed" }
        val snapshot = catalog.snapshot
        val data = JSONObject().put("account", scope.accountId).put("workspace", scope.workspaceId)
            .put("revision", snapshot.revision).put("syncedAt", catalog.syncedAt).put("machines", JSONArray(snapshot.machineIds))
            .put("machineNames", JSONObject(snapshot.machineNames))
            .put("machineOs", JSONObject(snapshot.machineOs))
            .put("projects", JSONArray(snapshot.projects.map { CatalogJson.putProject(JSONObject().put("id", it.id).put("machineId", it.machineId).put("name", it.name).put("rootPath", it.rootPath), it) }))
            .put("sessions", JSONArray(snapshot.sessions.map { CatalogJson.putSession(JSONObject().put("id", it.id).put("machineId", it.machineId).put("projectId", it.projectId).put("title", it.title).put("status", it.status).put("archived", it.archived).put("pinned", it.pinned).put("createdAt", it.createdAt), it) }))
        val target = catalogFile(scope)
        save(target, data)
        // Bound disk use to eight recently updated workspace projections (<=64 MiB).
        directory.listFiles()?.filter { it.name.endsWith(".json") && !it.name.startsWith("options-") && !it.name.startsWith("branches-") && !it.name.startsWith("members-") && !it.name.startsWith("schedules-") && it != accountFile && it != target }
            ?.sortedByDescending { it.lastModified() }?.drop(7)?.forEach { AtomicFile(it).delete() }
        Unit
    }
    override suspend fun clear() = io { check(!directory.exists() || directory.deleteRecursively()); Unit }
    private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
}
