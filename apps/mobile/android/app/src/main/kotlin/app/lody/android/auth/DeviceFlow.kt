package app.lody.android.auth
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive

internal class DeviceFlow(private val api: CloudAuthApi, private val now: () -> Long = { System.nanoTime()/1_000_000 }) {
    suspend fun await(code: DeviceAuthorization): Credential {
        require(code.expiresIn in 1..3600 && code.interval in 1..60)
        val deadline = now() + code.expiresIn * 1000L
        var interval = code.interval * 1000L
        while (now() < deadline) {
            delay(minOf(interval, deadline - now()))
            currentCoroutineContext().ensureActive()
            if (now() >= deadline) break
            when (val result = api.poll(code)) {
                is TokenPoll.Authorized -> return result.credential
                TokenPoll.Pending -> Unit
                TokenPoll.SlowDown -> interval += 5000
                TokenPoll.Denied -> throw AuthFailure("access_denied")
                TokenPoll.Expired -> break
            }
        }
        throw AuthFailure("code_expired")
    }
}
