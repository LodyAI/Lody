package app.lody.android.runtime

import org.json.JSONArray
import org.json.JSONObject

/**
 * Optional catalog display fields, shared by the runtime bridge (`RuntimeProtocol`) and the disk
 * cache (`AtomicCatalogStore`). Required fields stay strictly parsed by those callers; these are
 * lenient so a missing, null or malformed extra never rejects a catalog or an older cache file.
 */
object CatalogJson {
    fun project(base: CatalogProject, json: JSONObject) = base.copy(
        repoFullName = json.optText("repoFullName"),
        repositories = json.optJSONArray("repositories")?.let { array ->
            (0 until array.length()).mapNotNull { (array.opt(it) as? String)?.takeIf(String::isNotBlank) }.distinct()
        }.orEmpty(),
    )

    fun session(base: CatalogSession, json: JSONObject) = base.copy(
        isTabClosed = json.opt("isTabClosed") == true,
        branchName = json.optText("branchName"),
        userId = json.optText("userId"),
        openedBySessionId = json.optText("openedBySessionId"),
        openedByRootSessionId = json.optText("openedByRootSessionId"),
        parentSessionId = json.optText("parentSessionId"),
        childSessionPlacement = json.optText("childSessionPlacement"),
        cliType = json.optText("cliType"),
        agentType = json.optText("agentType"),
        resume = json.optText("resume"),
        agentConfigId = json.optText("agentConfigId"),
        modelName = json.optJSONObject("lastModel")?.let { it.optText("name") ?: it.optText("modelId") },
        lastMessageAt = json.optMillis("lastMessageAt"),
        lastReadAt = json.optMillis("lastReadAt"),
        awaitingUserSince = json.optMillis("awaitingUserSince"),
        pullRequests = json.optJSONArray("pullRequests")?.let { array ->
            (0 until array.length()).mapNotNull { index -> array.optJSONObject(index)?.let(::pullRequest) }
        }.orEmpty(),
        diffAdded = json.optJSONObject("diff")?.optCount("add") ?: 0,
        diffRemoved = json.optJSONObject("diff")?.optCount("del") ?: 0,
        workspaceDirty = json.opt("workspaceDirty") == true,
        workspaceUnpushed = json.opt("workspaceUnpushed") == true,
        projectRun = json.optJSONObject("projectRun")?.let(::projectRun),
    )

    /** A Project group snapshot; a member without an id or path is skipped, never the session. */
    private fun projectRun(json: JSONObject): CatalogProjectRun? {
        val id = json.optText("id") ?: return null
        val members = json.optJSONArray("members") ?: JSONArray()
        return CatalogProjectRun(id, json.optText("name").orEmpty(), (0 until members.length()).mapNotNull { index ->
            val member = members.optJSONObject(index) ?: return@mapNotNull null
            val memberId = member.optText("id") ?: return@mapNotNull null
            val path = member.optText("path") ?: return@mapNotNull null
            val diff = member.optJSONObject("diff")
            CatalogProjectMember(
                memberId, path, member.optText("kind") ?: "github", member.optCount("depth") ?: 0, member.opt("submodule") == true,
                member.optText("access"), member.optText("repoFullName"), member.optText("branch"),
                diff?.optCount("add"), diff?.optCount("del"),
                member.opt("dirty") == true, member.opt("unpushed") == true,
                member.optJSONObject("pullRequest")?.let(::pullRequest),
            )
        })
    }

    private fun putProjectRun(run: CatalogProjectRun): JSONObject = JSONObject().put("id", run.id).put("name", run.name)
        .put("members", JSONArray(run.members.map { member ->
            JSONObject().put("id", member.id).put("path", member.path).put("kind", member.kind)
                .put("depth", member.depth).put("submodule", member.submodule).apply {
                    member.access?.let { put("access", it) }
                    member.repoFullName?.let { put("repoFullName", it) }
                    member.branch?.let { put("branch", it) }
                    if (member.diffAdded != null && member.diffRemoved != null) {
                        put("diff", JSONObject().put("add", member.diffAdded).put("del", member.diffRemoved))
                    }
                    if (member.dirty) put("dirty", true)
                    if (member.unpushed) put("unpushed", true)
                    member.pullRequest?.let { put("pullRequest", putPullRequest(it)) }
                }
        }))

    /** Optional `machineNames` object; non-string or empty names are skipped. */
    fun machineNames(json: JSONObject): Map<String, String> = stringMap(json, "machineNames")

    /** Optional `machineOs` object (computer id to OS). */
    fun machineOs(json: JSONObject): Map<String, String> = stringMap(json, "machineOs")

    private fun stringMap(json: JSONObject, key: String): Map<String, String> {
        val names = json.optJSONObject(key) ?: return emptyMap()
        return names.keys().asSequence().mapNotNull { id -> names.optText(id)?.let { id to it } }.toMap()
    }

    fun putProject(json: JSONObject, project: CatalogProject): JSONObject = json.apply {
        project.repoFullName?.let { put("repoFullName", it) }
        if (project.repositories.isNotEmpty()) put("repositories", JSONArray(project.repositories))
    }

    fun putSession(json: JSONObject, session: CatalogSession): JSONObject = json.apply {
        put("isTabClosed", session.isTabClosed)
        session.branchName?.let { put("branchName", it) }
        session.userId?.let { put("userId", it) }
        session.openedBySessionId?.let { put("openedBySessionId", it) }
        session.openedByRootSessionId?.let { put("openedByRootSessionId", it) }
        session.parentSessionId?.let { put("parentSessionId", it) }
        session.childSessionPlacement?.let { put("childSessionPlacement", it) }
        session.cliType?.let { put("cliType", it) }
        session.agentType?.let { put("agentType", it) }
        session.resume?.let { put("resume", it) }
        session.agentConfigId?.let { put("agentConfigId", it) }
        session.modelName?.let { put("lastModel", JSONObject().put("name", it)) }
        session.lastMessageAt?.let { put("lastMessageAt", it) }
        session.lastReadAt?.let { put("lastReadAt", it) }
        session.awaitingUserSince?.let { put("awaitingUserSince", it) }
        if (session.pullRequests.isNotEmpty()) {
            put("pullRequests", JSONArray(session.pullRequests.map(::putPullRequest)))
        }
        session.projectRun?.let { put("projectRun", putProjectRun(it)) }
        if (session.diffAdded > 0 || session.diffRemoved > 0) put("diff", JSONObject().put("add", session.diffAdded).put("del", session.diffRemoved))
        if (session.workspaceDirty) put("workspaceDirty", true)
        if (session.workspaceUnpushed) put("workspaceUnpushed", true)
    }

    private fun putPullRequest(pr: CatalogPullRequest): JSONObject =
        JSONObject().put("repository", pr.repository).put("number", pr.number).put("status", pr.status).apply {
            pr.ci?.let { put("ci", it) }
            pr.url?.let { put("url", it) }
            pr.merge?.let { put("merge", it) }
        }

    private fun pullRequest(json: JSONObject): CatalogPullRequest? {
        val repository = json.optText("repository") ?: return null
        val status = json.optText("status") ?: return null
        val number = (json.opt("number") as? Number)?.toInt() ?: return null
        val url = json.optText("url")?.takeIf { it.startsWith("https://github.com/") }
        return CatalogPullRequest(repository, number, status, json.optText("ci"), url, json.optText("merge"))
    }

    private fun JSONObject.optText(key: String): String? = (opt(key) as? String)?.takeIf { it.isNotEmpty() }

    private fun JSONObject.optCount(key: String): Int? =
        (opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 && it <= Int.MAX_VALUE }?.toInt()

    private fun JSONObject.optMillis(key: String): Long? =
        (opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() && it >= 0 }?.toLong()
}
