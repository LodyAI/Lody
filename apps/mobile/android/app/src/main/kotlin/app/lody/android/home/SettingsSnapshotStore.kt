package app.lody.android.home

import app.lody.android.runtime.RuntimeScope
import org.json.JSONObject

/**
 * iOS `SettingsSnapshotStore`: the last accepted read of a settings page, per account/workspace
 * and [kind] (`[a-z0-9-]+`). Display only: a cached snapshot never authorizes a write. Cleared on
 * logout with the rest of the catalog cache; never holds tokens.
 */
interface SettingsSnapshotStore {
    suspend fun readSettings(scope: RuntimeScope, kind: String): JSONObject?
    suspend fun writeSettings(scope: RuntimeScope, kind: String, value: JSONObject)
}
