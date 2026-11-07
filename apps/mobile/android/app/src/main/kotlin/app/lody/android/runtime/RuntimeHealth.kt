package app.lody.android.runtime

/** Monotonic-clock watchdog, matching the Swift RuntimeHealth timing contract. */
internal class RuntimeHealth {
    private var lastAck = 0L
    private var ready = false
    private var suspended = false
    private val restarts = ArrayDeque<Long>()
    fun started(now: Long) { lastAck = now; ready = false }
    fun acknowledged(now: Long) { lastAck = now; ready = true }
    fun suspend() { suspended = true }
    fun resume(now: Long) { suspended = false; lastAck = now }
    fun timedOut(now: Long): Boolean {
        val deadline = if (ready) 8000 else 20000
        return !suspended && now - lastAck >= deadline
    }
    fun allowRestart(now: Long): Boolean {
        while (restarts.isNotEmpty() && now - restarts.first() >= 60000) restarts.removeFirst()
        if (restarts.size >= 3) return false
        restarts.addLast(now)
        return true
    }
}
