package app.lody.android.chat

import app.lody.android.runtime.CatalogSession

/** Opened-by edges connect conversations; parentSessionId only groups contained Tabs. */
object SessionRelations {
    data class Row(val session: CatalogSession, val depth: Int, val tabs: List<CatalogSession>)

    fun target(id: String?, sessions: List<CatalogSession>): CatalogSession? {
        val byId = sessions.associateBy { it.id }
        val target = byId[id] ?: return null
        var node = target
        val seen = mutableSetOf<String>()
        while (seen.add(node.id)) {
            if (node.archived || node.childSessionPlacement == "side-panel") return null
            val parent = node.parentSessionId ?: return target
            node = byId[parent] ?: return null
        }
        return null
    }

    fun rows(current: String, sessions: List<CatalogSession>): List<Row> {
        val live = sessions.filter { !it.archived && it.childSessionPlacement != "side-panel" }
        val byId = live.associateBy { it.id }
        fun root(id: String?): CatalogSession? {
            var node = target(id, live) ?: return null
            while (node.parentSessionId != null) node = byId[node.parentSessionId] ?: return null
            return node
        }
        var top = root(current) ?: return emptyList()
        val walked = mutableSetOf(top.id)
        while (true) {
            val parent = root(top.openedBySessionId) ?: break
            if (!walked.add(parent.id)) break
            top = parent
        }
        val ordered = live.sortedWith(compareBy<CatalogSession> { it.createdAt }.thenBy { it.id })
        val tabs = ordered.filter { it.parentSessionId != null && (!it.isTabClosed || it.id == current) }.groupBy { it.parentSessionId }
        val children = ordered.filter { it.parentSessionId == null }.groupBy { root(it.openedBySessionId)?.id }
        val result = mutableListOf<Row>()
        val visited = mutableSetOf<String>()
        val pending = ArrayDeque<Pair<CatalogSession, Int>>()
        pending.add(top to 0)
        while (pending.isNotEmpty()) {
            val (node, depth) = pending.removeLast()
            if (!visited.add(node.id)) continue
            result += Row(node, depth, tabs[node.id].orEmpty())
            children[node.id].orEmpty().asReversed().forEach { pending.add(it to depth + 1) }
        }
        return result.takeIf { rows -> rows.any { it.depth > 0 || it.tabs.any { tab -> tab.openedBySessionId != null } } }.orEmpty()
    }
}
