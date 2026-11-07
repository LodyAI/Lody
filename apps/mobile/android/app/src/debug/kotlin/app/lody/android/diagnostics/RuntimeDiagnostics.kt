package app.lody.android.diagnostics

import android.content.Context
import app.lody.android.runtime.WebViewCloudRuntime
import org.json.JSONArray

data class CapabilityCheck(val name: String, val passed: Boolean)

/** Debug-only adapter. Production exposes neither a diagnostic document nor fault injection. */
class RuntimeDiagnostics(context: Context) {
    val runtime = WebViewCloudRuntime(context, "DebugRuntime.html")
    fun check(completion: (Result<List<CapabilityCheck>>) -> Unit) {
        runtime.request("compatibility") { result ->
            completion(result.mapCatching { value ->
                val rows = value as JSONArray
                (0 until rows.length()).map { i ->
                    val row = rows.getJSONObject(i)
                    CapabilityCheck(row.getString("name"), row.getBoolean("passed"))
                }
            })
        }
    }
    fun stall(completion: (Result<Any?>) -> Unit) = runtime.request("stall", completion = completion)
}

/** The screen only sees this typed debug port, never WebView or bridge JSON. */
interface DiagnosticCommands {
    suspend fun checks(): List<CapabilityCheck>
    suspend fun stall()
}
class DiagnosticRuntime(context: Context, scope: app.lody.android.runtime.RuntimeScope) :
    app.lody.android.runtime.WebViewRuntime(scope, WebViewCloudRuntime(context, "DebugRuntime.html")), DiagnosticCommands {
    override suspend fun checks(): List<CapabilityCheck> {
        val rows = call("compatibility", deadline = app.lody.android.runtime.CommandDeadline.DIAGNOSTIC) as JSONArray
        return (0 until rows.length()).map { i -> rows.getJSONObject(i).let { CapabilityCheck(it.getString("name"), it.getBoolean("passed")) } }
    }
    override suspend fun stall() { call("stall", deadline = app.lody.android.runtime.CommandDeadline.DIAGNOSTIC) }
}
