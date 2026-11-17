package app.lody.android.runtime

import org.json.JSONObject

/**
 * Remote previews of a conversation, after the shared runtime's `sessionPreview`,
 * `iosSimulatorControl` and `androidEmulatorControl` (contract `preview.ts`). Failures arrive in
 * band as [BrowserPreviewReply.error] / [DeviceControlReply.error]; a thrown command failure means
 * the runtime could not run it at all.
 */

/** A session's managed web preview candidate (runtime session `preview`): `host:port`, and whether a link is open. */
data class BrowserPreview(val label: String, val active: Boolean)

/** `sessionPreview` result: the viewer link, or an error code with the computer's message. */
data class BrowserPreviewReply(val url: String? = null, val error: String? = null, val message: String? = null, val status: Int? = null)

/** The device preview families; each has its own runtime command and device id field. */
enum class DevicePlatform(val method: String, val idField: String) {
    IOS("iosSimulatorControl", "udid"),
    ANDROID("androidEmulatorControl", "id"),
}

/** One device lifecycle command. [Start.quality] (`saver` / `balanced` / `clear`) applies to Android only. */
sealed interface DeviceCommand {
    data object Devices : DeviceCommand
    data class Start(val deviceId: String, val quality: String? = null) : DeviceCommand
    data class Status(val operationId: String? = null) : DeviceCommand
    data class Stop(val operationId: String) : DeviceCommand
}

/** [occupancy]: `available`, `this-session` or `other-session`. */
data class PreviewDevice(
    val id: String, val name: String, val runtime: String, val deviceType: String, val state: String,
    val available: Boolean, val unavailableReason: String? = null, val occupancy: String = "available",
)

/** [phase]: `preparing` / `booting` / `connecting` / `ready` / `closed` / `failed`. */
data class DevicePreviewState(
    val operationId: String, val deviceId: String, val phase: String, val transport: String,
    val viewerUrl: String? = null, val message: String? = null,
)

data class DeviceControlReply(
    val success: Boolean,
    val devices: List<PreviewDevice>? = null,
    val preview: DevicePreviewState? = null,
    val error: String? = null,
    val message: String? = null,
)

object PreviewJson {
    private val qualities = setOf("saver", "balanced", "clear")
    private val phases = setOf("preparing", "booting", "connecting", "ready", "closed", "failed")

    fun command(platform: DevicePlatform, command: DeviceCommand): JSONObject = when (command) {
        DeviceCommand.Devices -> JSONObject().put("action", "list")
        is DeviceCommand.Start -> JSONObject().put("action", "start").put(platform.idField, command.deviceId).apply {
            if (platform == DevicePlatform.ANDROID && command.quality in qualities) put("quality", command.quality)
        }
        is DeviceCommand.Status -> JSONObject().put("action", "status").apply { command.operationId?.let { put("operationId", it) } }
        is DeviceCommand.Stop -> JSONObject().put("action", "stop").put("operationId", command.operationId)
    }

    fun browser(json: JSONObject) = BrowserPreviewReply(
        json.text("url"), json.text("error"), json.text("message"), (json.opt("status") as? Number)?.toInt(),
    )

    /** Leniently: a malformed device is dropped; a preview without its ids is no preview. */
    fun reply(platform: DevicePlatform, json: JSONObject): DeviceControlReply {
        val devices = json.optJSONArray("devices")?.let { array ->
            (0 until array.length()).mapNotNull { index ->
                val item = array.optJSONObject(index) ?: return@mapNotNull null
                val id = item.text(platform.idField) ?: return@mapNotNull null
                PreviewDevice(
                    id, item.text("name") ?: id, item.optString("runtime"), item.optString("deviceType"), item.optString("state"),
                    item.optBoolean("available"), item.text("unavailableReason"), item.text("occupancy") ?: "available",
                )
            }
        }
        val preview = json.optJSONObject("preview")?.let { item ->
            val operationId = item.text("operationId") ?: return@let null
            val deviceId = item.text(platform.idField) ?: return@let null
            val phase = item.text("phase")?.takeIf { it in phases } ?: return@let null
            DevicePreviewState(operationId, deviceId, phase, item.optString("transport"), item.text("viewerUrl"), item.text("message"))
        }
        return DeviceControlReply(json.optBoolean("success"), devices, preview, json.text("error"), json.text("message"))
    }

    /** Runtime session `preview` ({label, active}); absent without a loopback candidate. */
    fun summary(json: JSONObject?): BrowserPreview? {
        val label = json?.text("label") ?: return null
        return BrowserPreview(label, json.optBoolean("active"))
    }

    private fun JSONObject.text(key: String): String? = (opt(key) as? String)?.takeIf { it.isNotEmpty() }
}
