package app.lody.android.notifications

import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal interface PushSession {
    suspend fun selfHosted(): Boolean
    suspend fun register(token: String)
    suspend fun unregister()
}
internal interface PushDevice {
    fun oneSignal(userId: String?)
    suspend fun token(): String
}

/** Only a verified native session may bind this installation. No workspace dependency. */
internal class PushBinding(private val device: PushDevice) {
    var direct = false
        private set
    private var session: PushSession? = null
    suspend fun refresh(userId: String, next: PushSession) {
        session = next // Retain cleanup even if a registration response is lost.
        val selfHosted = next.selfHosted()
        currentCoroutineContext().ensureActive()
        direct = selfHosted
        if (selfHosted) {
            device.oneSignal(null)
            val token = device.token()
            currentCoroutineContext().ensureActive()
            next.register(token)
        } else {
            // Cleanup is best effort; the server's provider gate prevents dual sends.
            // A transient cleanup failure must not disable the selected OneSignal path.
            try { next.unregister() }
            catch (_: kotlinx.coroutines.TimeoutCancellationException) { currentCoroutineContext().ensureActive() }
            catch (cancelled: kotlinx.coroutines.CancellationException) { throw cancelled }
            catch (_: Exception) { }
            currentCoroutineContext().ensureActive()
            device.oneSignal(userId)
        }
    }
    fun detach() { direct = false; device.oneSignal(null) }
    suspend fun clear() {
        detach()
        val old = session
        session = null
        old?.unregister()
    }
}
