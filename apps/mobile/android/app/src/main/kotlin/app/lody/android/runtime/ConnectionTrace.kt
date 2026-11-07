package app.lody.android.runtime

import android.os.SystemClock
import android.util.Log
import app.lody.android.BuildConfig

/** Debug-only timings; fixed stage labels, no URLs, tokens, account IDs or payloads. */
internal object ConnectionTrace {
    fun mark(stage: String, milliseconds: Long = 0) {
        if (BuildConfig.DEBUG && stage in setOf("capability_config_missing", "capability_auth_required", "capability_binary_missing", "capability_timeout", "capability_denied", "capability_unsupported", "capability_provider_failed", "capability_refresh_failed", "capability_refresh_replied", "grant_ok", "grant_failed", "bootstrap", "bootstrap_ok", "network_error", "timeout", "unauthorized", "forbidden", "network_validated", "synced")) {
            Log.d("LodyConnection", "${SystemClock.elapsedRealtime()} $stage ${milliseconds.coerceIn(0, 3_600_000)}ms")
        }
    }
}
