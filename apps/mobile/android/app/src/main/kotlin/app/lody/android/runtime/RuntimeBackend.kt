package app.lody.android.runtime

/** Host lifecycle contract. No Android, WebView or JSON types cross this boundary.
 * Commands retain the shared runtime's names/semantics. Cloud authentication and
 * workspace commands are intentionally not exposed by this offline integration.
 * Calls/listeners are serialized on the owning platform UI executor.
 */
interface RuntimeBackend {
    val status: RuntimeStatus
    fun observe(listener: (RuntimeStatus) -> Unit): AutoCloseable
    fun start()
    fun setActive(active: Boolean)
    fun ping(completion: (Result<Boolean>) -> Unit)
    fun stop()
}

enum class RuntimePhase { STOPPED, STARTING, READY, SUSPENDED, FAILED }
data class RuntimeStatus(
    val phase: RuntimePhase = RuntimePhase.STOPPED,
    val generation: Long = 0,
    val acknowledgements: Int = 0,
    val automaticRestarts: Int = 0,
    val blockedNavigations: Int = 0,
    val failure: String? = null,
    val capabilities: Set<String> = emptySet(),
    val fault: RuntimeFault? = failure?.let(::runtimeFault),
)
class RuntimeFailure(val code: String) : Exception(code)

internal fun runtimeFault(code: String): RuntimeFault {
    val category = when {
        code in setOf("unsupported_command", "web_message_listener_unavailable") -> RuntimeErrorCategory.UNSUPPORTED
        code in setOf("runtime_stopped", "runtime_suspended", "runtime_replaced", "scope_changed") -> RuntimeErrorCategory.CANCELLED
        code.contains("protocol") || code.contains("bridge") || code.contains("capability") || code.startsWith("invalid_") -> RuntimeErrorCategory.PROTOCOL
        else -> RuntimeErrorCategory.RUNTIME
    }
    return RuntimeFault(code, category)
}
internal enum class CommandDeadline(val milliseconds: Long) { WRITE(120_000), CONTROL(5_000), QUERY(30_000), DIAGNOSTIC(15_000) }
