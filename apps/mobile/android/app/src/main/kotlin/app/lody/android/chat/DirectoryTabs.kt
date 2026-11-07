package app.lody.android.chat

import app.lody.android.runtime.CatalogSession
import app.lody.android.home.ChatAttention
import app.lody.android.home.ChatListModel

object DirectoryTabs {
    fun sessions(current: CatalogSession, all: List<CatalogSession>) = family(current, all).filter { !it.isTabClosed }
    fun closed(current: CatalogSession, all: List<CatalogSession>) = family(current, all).filter { it.isTabClosed }
    fun root(current: CatalogSession, all: List<CatalogSession>): String = root(current, all.associateBy { it.id })
    private fun root(current: CatalogSession, byId: Map<String, CatalogSession>): String {
        var node = current
        val seen = mutableSetOf<String>()
        while (seen.add(node.id)) {
            val parent = node.parentSessionId ?: return node.id
            node = byId[parent] ?: return parent
        }
        return current.id
    }
    private fun family(current: CatalogSession, all: List<CatalogSession>): List<CatalogSession> {
        val byId = all.associateBy { it.id }
        val owner = root(current, byId)
        return all.filter { !it.archived && it.childSessionPlacement != "side-panel" && it.machineId == current.machineId && root(it, byId) == owner }
            .sortedWith(compareBy<CatalogSession> { if (it.id == owner) 0 else 1 }.thenBy { it.createdAt }.thenBy { it.id })
    }
    fun attention(sessions: List<CatalogSession>): ChatAttention? = listOf(ChatAttention.Waiting, ChatAttention.Failed, ChatAttention.Running, ChatAttention.Unread)
        .firstOrNull { state -> sessions.any { session ->
            val status = ChatListModel.attention(session.status)
            val attention = if (session.awaitingUserSince != null && status != ChatAttention.Running) ChatAttention.Waiting else ChatListModel.attention(session)
            attention == state
        } }
}
