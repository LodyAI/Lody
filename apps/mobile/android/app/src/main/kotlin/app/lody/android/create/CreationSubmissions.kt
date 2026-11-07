package app.lody.android.create

import app.lody.android.runtime.*
import java.time.Instant
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow

/** A creation write belongs to the application, not the form that submits it. Never replay it. */
class CreationSubmissions(
    private val tasks: CoroutineScope,
    private val create: suspend (RuntimeScope, CreateRequest) -> CreationReceipt,
) {
    data class Submission(val scope: RuntimeScope, val request: CreateRequest, val at: String, val state: String = "sending") {
        val session get() = CatalogSession(
            request.sessionId, request.machineId, request.projectId ?: "${request.machineId}:unassigned",
            request.text.take(200), "idle", false, false, at,
        )
    }
    private val mutable = MutableStateFlow<Map<String, Submission>>(emptyMap())
    val state = mutable.asStateFlow()
    private val jobs = mutableMapOf<String, Job>()

    fun activate(scope: RuntimeScope?) {
        mutable.value.values.filter { it.scope != scope }.forEach {
            jobs.remove(it.request.sessionId)?.cancel()
        }
        mutable.value = mutable.value.filterValues { it.scope == scope }
    }

    fun submit(scope: RuntimeScope, request: CreateRequest) {
        if (request.sessionId in mutable.value) return
        val entry = Submission(scope, request, Instant.now().toString())
        mutable.value = mutable.value + (request.sessionId to entry)
        jobs[request.sessionId] = tasks.launch {
            // Publish and navigate before starting any transport work, even on Main.immediate.
            yield()
            val result = try { create(scope, request).state }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (_: Exception) { "unknown" }
            if (mutable.value[request.sessionId] === entry) {
                mutable.value = mutable.value + (request.sessionId to entry.copy(state = result))
            }
            jobs.remove(request.sessionId)
        }
    }
}
