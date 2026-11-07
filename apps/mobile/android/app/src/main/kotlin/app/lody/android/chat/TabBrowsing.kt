package app.lody.android.chat

import app.lody.android.runtime.CatalogSession
import app.lody.android.runtime.RuntimeScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Device-local selection and viewed-output watermarks; never overwrite server read receipts. */
class TabBrowsing(private val read: (String) -> String?, private val write: (String, String) -> Unit) {
    private val changes = MutableStateFlow(0L)
    val revision = changes.asStateFlow()
    private fun key(kind: String, scope: RuntimeScope, id: String) =
        "$kind:" + listOf(scope.accountId, scope.workspaceId, id).joinToString("") { "${it.length}:$it" }
    private fun save(key: String, value: String) {
        if (read(key) == value) return
        write(key, value)
        changes.value++
    }
    fun visit(scope: RuntimeScope, session: CatalogSession, all: List<CatalogSession>) {
        if (DirectoryTabs.sessions(session, all).none { it.id == session.id }) return
        save(key("tab-v1", scope, DirectoryTabs.root(session, all)), session.id)
        val message = session.lastMessageAt ?: return
        val key = key("view-v1", scope, session.id)
        if (message > (read(key)?.toLongOrNull() ?: Long.MIN_VALUE)) save(key, message.toString())
    }
    fun resolve(scope: RuntimeScope, session: CatalogSession, all: List<CatalogSession>): String {
        if (session.parentSessionId != null) return session.id
        val open = DirectoryTabs.sessions(session, all)
        val saved = read(key("tab-v1", scope, DirectoryTabs.root(session, all)))
        return open.firstOrNull { it.id == saved }?.id ?: open.firstOrNull()?.id ?: session.id
    }
    fun viewed(scope: RuntimeScope, session: CatalogSession): CatalogSession {
        val viewed = read(key("view-v1", scope, session.id))?.toLongOrNull() ?: return session
        return session.copy(lastReadAt = maxOf(session.lastReadAt ?: Long.MIN_VALUE, viewed))
    }
}
