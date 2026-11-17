package app.lody.android.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import app.lody.android.runtime.*
import kotlinx.coroutines.*

/** A device lifecycle call the computer refused; [code] is its error code, [detail] its message. */
class DevicePreviewFailure(val code: String, val detail: String? = null) : Exception(code)

/**
 * One conversation's iOS Simulator or Android Emulator preview (iOS `SessionSimulator`). Each
 * platform has its own instance per conversation page; it runs on the page's coroutine scope, so
 * leaving the page stops polling but never the device, and the next visit resumes it through
 * `status`. Every call goes through the app's existing runtime lease ([call]); nothing here creates
 * a runtime. Start / stop are never retried; a newer action fences an older one's late reply.
 */
class DevicePreviewSession(
    val platform: DevicePlatform,
    private val call: suspend (DeviceCommand) -> DeviceControlReply,
    private val tasks: CoroutineScope,
    private val pollDelayMillis: Long = 1_000,
) {
    /** `closed` / `preparing` / `booting` / `connecting` / `ready` / `failed`. */
    var phase by mutableStateOf("closed"); private set
    var preview by mutableStateOf<DevicePreviewState?>(null); private set
    var name by mutableStateOf(""); private set
    var failure by mutableStateOf<DevicePreviewFailure?>(null); private set
    var devices by mutableStateOf<List<PreviewDevice>?>(null); private set
    /** The first `status` read (resume) or a device list read is in flight. */
    var loading by mutableStateOf(false); private set
    /** Android quality preset; remote previews default to Balanced, as web. */
    var quality by mutableStateOf("balanced"); private set
    private var version = 0
    private var job: Job? = null

    val running: Boolean get() = phase !in setOf("closed", "failed")
    val connecting: Boolean get() = phase in setOf("preparing", "booting", "connecting")
    val viewerUrl: String? get() = preview?.takeIf { phase == "ready" }?.viewerUrl

    /** Resume a running preview through `status`, else list devices for the picker. */
    fun open() {
        if (running || loading) return
        val token = ++version
        job?.cancel()
        loading = true; failure = null
        job = tasks.launch {
            try {
                val reply = request(DeviceCommand.Status())
                if (token != version) return@launch
                val current = reply.preview?.takeIf { it.phase != "failed" && it.phase != "closed" }
                val list = request(DeviceCommand.Devices).devices.orEmpty()
                if (token != version) return@launch
                devices = list
                if (current != null) {
                    name = list.firstOrNull { it.id == current.deviceId }?.name ?: current.deviceId
                    apply(reply)
                    loading = false
                    polling(token)
                } else { preview = null; phase = "closed" }
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (token == version) fail(error) }
            finally { if (token == version) loading = false }
        }
    }

    /** The page went away: stop polling; the device keeps running and the next visit resumes it. */
    fun close() { version++; job?.cancel(); job = null; loading = false }

    /** Re-read the device list (after a failure or stop). */
    fun refreshDevices() {
        if (running) return
        phase = "closed"; preview = null
        open()
    }

    fun start(device: PreviewDevice) = start(device.id, device.name)

    /** Android only: restart the running device with another preset (web switches the same way). */
    fun changeQuality(next: String) {
        if (platform != DevicePlatform.ANDROID || next == quality) return
        quality = next
        val current = preview ?: return
        start(current.deviceId, name)
    }

    private fun start(deviceId: String, deviceName: String) {
        val token = ++version
        job?.cancel()
        name = deviceName; preview = null; phase = "preparing"; failure = null; loading = false
        job = tasks.launch {
            try {
                val command = DeviceCommand.Start(deviceId, quality.takeIf { platform == DevicePlatform.ANDROID })
                val reply = request(command)
                if (token != version) return@launch
                apply(reply)
                polling(token)
            } catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { if (token == version) fail(error) }
        }
    }

    /**
     * Stops the device preview, then lists devices again for the picker (unless another action
     * came first). Never retried; a failure is reported through [onFailure].
     */
    fun stop(onFailure: (DevicePreviewFailure) -> Unit = {}) {
        val token = ++version
        job?.cancel(); job = null
        val operationId = preview?.operationId
        preview = null; phase = "closed"; failure = null; loading = operationId != null
        if (operationId == null) { open(); return }
        tasks.launch {
            try { request(DeviceCommand.Stop(operationId)) }
            catch (cancelled: CancellationException) { throw cancelled }
            catch (error: Exception) { onFailure(error as? DevicePreviewFailure ?: DevicePreviewFailure("failed")) }
            if (token == version) { loading = false; open() }
        }
    }

    private suspend fun request(command: DeviceCommand): DeviceControlReply {
        val reply = call(command)
        if (!reply.success) throw DevicePreviewFailure(reply.error ?: "failed", reply.message)
        return reply
    }

    private fun apply(reply: DeviceControlReply) {
        preview = reply.preview
        phase = reply.preview?.phase ?: "closed"
        if (phase == "failed") failure = DevicePreviewFailure("failed", reply.preview?.message)
    }

    private fun fail(error: Exception) {
        phase = "failed"
        failure = error as? DevicePreviewFailure ?: DevicePreviewFailure((error as? app.lody.android.runtime.RuntimeException)?.fault?.code ?: "failed")
    }

    /** Poll `status` each second while the device prepares, at most 180 times (iOS). */
    private suspend fun polling(token: Int) {
        repeat(180) {
            val operationId = preview?.operationId
            if (token != version || !connecting || operationId == null) return
            delay(pollDelayMillis)
            val reply = request(DeviceCommand.Status(operationId))
            if (token != version) return
            apply(reply)
        }
        if (token == version && connecting) throw DevicePreviewFailure("timeout")
    }
}
