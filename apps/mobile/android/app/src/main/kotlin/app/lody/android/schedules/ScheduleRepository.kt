package app.lody.android.schedules

import app.lody.android.runtime.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.withLock

/** A failed schedule read or write; [code] is the runtime's (`schedule_not_owner`, …) or a local one. */
class ScheduleFailure(val code: String) : Exception(code)

/** Schedules through the shared runtime (iOS / web: owner-only writes on the machine's registry). */
interface ScheduleService {
    val displayCache: ScheduleDisplayCache? get() = null
    suspend fun list(scope: RuntimeScope): ScheduleList
    suspend fun detail(scope: RuntimeScope, scheduleId: String): ScheduleDetail
    /** One write; never retried. Returns the schedule id it wrote. */
    suspend fun command(scope: RuntimeScope, request: ScheduleCommandRequest): String
}

/** Uses the existing account/workspace lease, like creation. */
class RuntimeScheduleService(private val owner: RuntimeOwner, override val displayCache: ScheduleDisplayCache? = null) : ScheduleService {
    override suspend fun list(scope: RuntimeScope): ScheduleList = read {
        owner.use(scope) { (it.execute(RuntimeCommand.ListSchedules) as RuntimeResult.Schedules).value }
    }

    override suspend fun detail(scope: RuntimeScope, scheduleId: String): ScheduleDetail = read {
        owner.use(scope) { (it.execute(RuntimeCommand.ScheduleDetail(scheduleId)) as RuntimeResult.Schedule).value }
    }

    override suspend fun command(scope: RuntimeScope, request: ScheduleCommandRequest): String = try {
        owner.use(scope) { (it.execute(RuntimeCommand.ScheduleCommand(request)) as RuntimeResult.ScheduleWritten).scheduleId }
    } catch (cancelled: CancellationException) { throw cancelled }
    catch (error: app.lody.android.runtime.RuntimeException) {
        // A business code is the runtime's answer and a missing command never ran; any other
        // failure (deadline, runtime restart, a lease lost mid-call) may have written.
        throw ScheduleFailure(
            when {
                error.fault.category == RuntimeErrorCategory.BUSINESS -> error.fault.code
                error.fault.code == "unsupported_command" -> error.fault.code
                else -> ScheduleCodes.WRITE_UNKNOWN
            },
        )
    }

    private suspend fun <T> read(block: suspend () -> T): T = try { block() }
    catch (cancelled: CancellationException) { throw cancelled }
    catch (error: app.lody.android.runtime.RuntimeException) { throw ScheduleFailure(error.fault.code) }
}

object ScheduleCodes {
    const val WRITE_UNKNOWN = "schedule_write_unknown"
}

/** Display data only, sharing the account store's pruning and logout lifecycle. */
interface ScheduleStore {
    suspend fun readSchedules(scope: RuntimeScope): ScheduleList?
    suspend fun writeSchedules(scope: RuntimeScope, value: ScheduleList)
}

class ScheduleDisplayCache(private val store: ScheduleStore) {
    private val mutex = kotlinx.coroutines.sync.Mutex()
    var generation: Long = 0
        private set
    suspend fun invalidate() = mutex.withLock { generation++ }
    suspend fun read(scope: RuntimeScope, expected: Long): ScheduleList? = mutex.withLock {
        if (expected != generation) null else store.readSchedules(scope)
    }
    suspend fun write(scope: RuntimeScope, expected: Long, value: ScheduleList, accept: () -> Boolean = { true }) = mutex.withLock {
        if (expected == generation && accept()) store.writeSchedules(scope, value)
    }
}
