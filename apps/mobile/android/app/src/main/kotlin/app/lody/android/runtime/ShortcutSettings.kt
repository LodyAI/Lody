package app.lody.android.runtime

import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** One readable prompt shortcut from the runtime `promptShortcuts` index (iOS `PromptShortcutEntry`). */
data class ShortcutEntry(
    val id: String, val ownerUserId: String, val shared: Boolean, val name: String, val emoji: String?, val slug: String,
    /** No project / computer / provider scope and no structured references: mobile can edit it. */
    val simple: Boolean,
    internal val raw: String = "",
)
/** A shortcut's body as read fresh before editing. */
data class ShortcutBody(val prompt: String, val simple: Boolean, internal val raw: String)
data class ShortcutFields(val name: String, val slug: String, val prompt: String, val shared: Boolean)

sealed interface ShortcutSettingsAction {
    data object List : ShortcutSettingsAction
    data class Read(val entry: ShortcutEntry) : ShortcutSettingsAction
    /** Built once ([ShortcutSettingsJson.save]); retrying an unknown outcome sends this same payload. */
    data class Save(val id: String, internal val payload: String) : ShortcutSettingsAction
}
sealed interface ShortcutSettingsResult {
    data class Listed(val entries: kotlin.collections.List<ShortcutEntry>) : ShortcutSettingsResult
    data class Read(val body: ShortcutBody) : ShortcutSettingsResult
    data class Saved(val entry: ShortcutEntry) : ShortcutSettingsResult
}

internal object ShortcutSettingsJson {
    const val PROMPT_LIMIT = 16_000
    private val slug = Regex("[a-z0-9][a-z0-9-]{0,39}")
    fun validSlug(value: String) = slug.matches(value)

    private fun scopeSimple(scope: JSONObject?) = scope == null || listOf("project", "machineId", "providerKey").none { scope.has(it) && !scope.isNull(it) }

    private fun entry(value: JSONObject) = ShortcutEntry(
        value.getString("id"), value.getString("ownerUserId"), value.optString("visibility") == "workspace",
        value.optString("name"), (value.opt("emoji") as? String)?.takeIf { it.isNotBlank() }, value.optString("slug"),
        scopeSimple(value.optJSONObject("scope")) && (value.optJSONArray("dependencySummary")?.length() ?: 0) == 0,
        value.toString(),
    )

    /** An entry or body back from the settings cache (their `raw` JSON), parsed as the live read is. */
    fun cachedEntry(raw: String): ShortcutEntry = entry(JSONObject(raw))
    fun cachedBody(raw: String): ShortcutBody = body(JSONObject(raw))

    private fun body(value: JSONObject) = ShortcutBody(value.optString("prompt"),
        scopeSimple(value.optJSONObject("scope")) && (value.optJSONArray("mentions")?.length() ?: 0) == 0, value.toString())

    fun result(value: JSONObject): ShortcutSettingsResult {
        if (value.has("error")) throw RuntimeException(RuntimeFault(value.getString("error"), RuntimeErrorCategory.BUSINESS))
        return when (value.optString("action")) {
            "list" -> ShortcutSettingsResult.Listed(value.getJSONArray("entries").let { rows -> (0 until rows.length()).map { entry(rows.getJSONObject(it)) } })
            "read" -> ShortcutSettingsResult.Read(body(value.getJSONObject("shortcut")))
            "save" -> ShortcutSettingsResult.Saved(entry(value.getJSONObject("entry")))
            else -> throw RuntimeException(RuntimeFault("invalid_shortcut", RuntimeErrorCategory.BUSINESS))
        }
    }

    fun request(action: ShortcutSettingsAction): JSONObject = when (action) {
        // Settings re-reads the access directory, as iOS; the composer may use the runtime's recent copy.
        ShortcutSettingsAction.List -> JSONObject().put("action", "list").put("fresh", true)
        is ShortcutSettingsAction.Read -> JSONObject().put("action", "read").put("entry", JSONObject(action.entry.raw))
        is ShortcutSettingsAction.Save -> JSONObject(action.payload)
    }

    /**
     * iOS `PromptShortcutEditorController.makeRequest`: a fresh revision and body document; an
     * edit keeps the stored id, visibility, emoji, description, scope and creation time.
     */
    fun save(scope: RuntimeScope, base: ShortcutEntry?, body: ShortcutBody?, fields: ShortcutFields, now: Long = System.currentTimeMillis()): ShortcutSettingsAction.Save {
        val previous = body?.raw?.let(::JSONObject)
        val id = previous?.optString("id")?.takeIf { it.isNotBlank() } ?: UUID.randomUUID().toString().lowercase()
        val value = JSONObject().put("v", 1).put("id", id).put("workspaceId", scope.workspaceId).put("ownerUserId", scope.accountId)
            .put("visibility", previous?.optString("visibility")?.takeIf { it == "workspace" || it == "private" } ?: if (fields.shared) "workspace" else "private")
            .put("name", fields.name.trim()).put("slug", fields.slug)
            .put("scope", previous?.optJSONObject("scope") ?: JSONObject())
            .put("revision", UUID.randomUUID().toString().lowercase())
            .put("createdAt", previous?.optLong("createdAt")?.takeIf { it > 0 } ?: now).put("updatedAt", now)
            .put("prompt", fields.prompt).put("mentions", JSONArray())
        previous?.opt("emoji")?.takeIf { it is String }?.let { value.put("emoji", it) }
        previous?.opt("description")?.takeIf { it is String }?.let { value.put("description", it) }
        val payload = JSONObject().put("action", "save").put("entry", base?.raw?.let(::JSONObject) ?: JSONObject.NULL)
            .put("value", value).put("bodyDocId", UUID.randomUUID().toString().lowercase())
        return ShortcutSettingsAction.Save(id, payload.toString())
    }
}
