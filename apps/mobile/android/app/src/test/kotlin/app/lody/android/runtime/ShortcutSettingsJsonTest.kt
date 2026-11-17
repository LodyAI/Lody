package app.lody.android.runtime

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class ShortcutSettingsJsonTest {
    private val scope = RuntimeScope("user", "workspace")
    private val stored = JSONObject().put("v", 1).put("id", "s1").put("workspaceId", "workspace").put("ownerUserId", "user")
        .put("visibility", "workspace").put("name", "Review").put("emoji", "🧪").put("slug", "review")
        .put("scope", JSONObject()).put("revision", "r1").put("createdAt", 5).put("updatedAt", 5).put("bodyDocId", "b1")
        .put("dependencySummary", org.json.JSONArray())

    @Test fun editKeepsIdentityVisibilityAndCreationButPublishesAFreshRevision() {
        val entry = (ShortcutSettingsJson.result(JSONObject().put("action", "list").put("entries", org.json.JSONArray().put(stored))) as ShortcutSettingsResult.Listed).entries.single()
        assertTrue(entry.simple)
        val body = (ShortcutSettingsJson.result(JSONObject().put("action", "read").put("shortcut", JSONObject(stored.toString()).put("prompt", "old").put("mentions", org.json.JSONArray()))) as ShortcutSettingsResult.Read).body
        // A private toggle cannot change an existing shortcut's visibility.
        val save = ShortcutSettingsJson.save(scope, entry, body, ShortcutFields(" Review 2 ", "review-2", "new prompt", shared = false), now = 9)
        val payload = ShortcutSettingsJson.request(save)
        val value = payload.getJSONObject("value")
        assertEquals("s1", save.id)
        assertEquals("workspace", value.getString("visibility"))
        assertEquals(5L, value.getLong("createdAt")); assertEquals(9L, value.getLong("updatedAt"))
        assertNotEquals("r1", value.getString("revision"))
        assertEquals("Review 2", value.getString("name")); assertEquals("🧪", value.getString("emoji"))
        assertEquals("user", value.getString("ownerUserId")); assertEquals("workspace", value.getString("workspaceId"))
        assertEquals("b1", payload.getJSONObject("entry").getString("bodyDocId"))
        assertNotEquals("b1", payload.getString("bodyDocId"))
        // Retrying an unknown outcome resends the identical payload.
        assertEquals(payload.toString(), ShortcutSettingsJson.request(save).toString())
    }

    @Test fun scopedOrReferencingShortcutsAreViewOnlyAndErrorsSurfaceTheirCode() {
        val scoped = JSONObject(stored.toString()).put("scope", JSONObject().put("machineId", "m1"))
        val entry = (ShortcutSettingsJson.result(JSONObject().put("action", "list").put("entries", org.json.JSONArray().put(scoped))) as ShortcutSettingsResult.Listed).entries.single()
        assertFalse(entry.simple)
        val failure = runCatching { ShortcutSettingsJson.result(JSONObject().put("error", "shortcut_write_unknown")) }.exceptionOrNull()
        assertEquals("shortcut_write_unknown", (failure as RuntimeException).fault.code)
    }
}
