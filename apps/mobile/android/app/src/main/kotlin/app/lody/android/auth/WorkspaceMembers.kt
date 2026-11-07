package app.lody.android.auth

import app.lody.android.runtime.RuntimeScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.flow

interface WorkspaceMemberStore {
    suspend fun readMembers(scope: RuntimeScope): List<WorkspaceMember>?
    suspend fun writeMembers(scope: RuntimeScope, members: List<WorkspaceMember>)
}

/** Cache first; failures leave the last display snapshot intact. No credentials are cached. */
class WorkspaceMembers(private val store: WorkspaceMemberStore, private val load: suspend (RuntimeScope) -> List<WorkspaceMember>) {
    fun observe(scope: RuntimeScope) = flow {
        val cached = try { store.readMembers(scope) } catch (error: CancellationException) { throw error } catch (_: Exception) { null }
        cached?.let { emit(it.associateBy(WorkspaceMember::id)) }
        val fresh = try { load(scope) } catch (error: CancellationException) { throw error } catch (_: Exception) { return@flow }
        emit(fresh.associateBy(WorkspaceMember::id))
        try { store.writeMembers(scope, fresh) } catch (error: CancellationException) { throw error } catch (_: Exception) { }
    }
}
