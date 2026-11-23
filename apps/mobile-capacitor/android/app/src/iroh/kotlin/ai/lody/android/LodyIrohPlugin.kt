package ai.lody.android

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import uniffi.lody_iroh_uniffi.IrohException
import uniffi.lody_iroh_uniffi.MobileIrohCall
import uniffi.lody_iroh_uniffi.MobileIrohEndpoint
import uniffi.lody_iroh_uniffi.openMobileEndpoint

/**
 * Native iroh transport for the WebView portable host: open, connection status,
 * send and receive only. It never returns the seed and frames stay opaque. Bridge
 * logging is off (`loggingBehavior: none`); rejections carry fixed codes only.
 */
@CapacitorPlugin(name = "LodyIroh")
class LodyIrohPlugin : Plugin() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val registry = IrohRegistry()

    private class Invalid : Exception()

    private fun run(call: PluginCall, body: suspend () -> JSObject) {
        scope.launch {
            try {
                call.resolve(body())
            } catch (error: Throwable) {
                val code = (error as? IrohException.Failed)?.code
                    ?.takeIf { Regex("^[a-z_]{1,64}$").matches(it) }
                    ?: if (error is Invalid) "iroh_invalid_request" else "iroh_unavailable"
                call.reject(code, code)
            }
        }
    }
    private fun decode(call: PluginCall, name: String, limit: Int): ByteArray {
        val text = call.getString(name) ?: throw Invalid()
        if (text.length > (limit + 2) / 3 * 4) throw Invalid()
        val bytes = try { Base64.decode(text, Base64.NO_WRAP) } catch (_: IllegalArgumentException) { throw Invalid() }
        if (bytes.size > limit) throw Invalid()
        return bytes
    }
    private fun string(call: PluginCall, name: String): String =
        call.getString(name)?.takeIf { it.isNotEmpty() && it.length <= 128 } ?: throw Invalid()
    private fun millis(call: PluginCall, name: String): UInt =
        call.getInt(name)?.takeIf { it in 1..120_000 }?.toUInt() ?: throw Invalid()
    private fun endpoint(call: PluginCall) = registry.endpoint(string(call, "handle"))
    private fun result(vararg pairs: Pair<String, Any?>) = JSObject().apply { pairs.forEach { (k, v) -> put(k, v) } }

    @PluginMethod
    fun open(call: PluginCall) = run(call) {
        val seed = decode(call, "seed", 32)
        try {
            if (seed.size != 32) throw Invalid()
            val relays = call.getArray("relays")?.toList<String>() ?: throw Invalid()
            if (relays.isEmpty() || relays.size > 16) throw Invalid()
            // Mobile is dial-only with port mapping off. A proxy comes only from a
            // test build's VITE_IROH_PROXY_URL; release builds never set it.
            val opened = openMobileEndpoint(seed, relays, call.getString("relayToken"), call.getString("proxyUrl"))
            result("handle" to registry.addEndpoint(opened))
        } finally {
            seed.fill(0)
        }
    }

    @PluginMethod
    fun connectionPath(call: PluginCall) = run(call) {
        result("value" to endpoint(call).connectionPath(string(call, "endpointId")))
    }

    @PluginMethod
    fun hasConnection(call: PluginCall) = run(call) {
        result("value" to endpoint(call).hasConnection(string(call, "endpointId")))
    }

    @PluginMethod
    fun warm(call: PluginCall) = run(call) {
        endpoint(call).warm(string(call, "endpointId"), millis(call, "timeoutMs"))
        JSObject()
    }

    @PluginMethod
    fun call(call: PluginCall) = run(call) {
        val started = endpoint(call).call(
            string(call, "endpointId"),
            decode(call, "request", MAX_FRAME),
            millis(call, "connectTimeoutMs"),
        )
        result("call" to registry.addCall(started))
    }

    @PluginMethod
    fun nextReply(call: PluginCall) = run(call) {
        val id = string(call, "call")
        val active = registry.call(id)
        val reply = active.nextReply()
        if (reply == null) {
            registry.removeCall(id)
            result("reply" to JSONObject.NULL)
        } else result("reply" to Base64.encodeToString(reply, Base64.NO_WRAP))
    }

    @PluginMethod
    fun cancel(call: PluginCall) = run(call) {
        // Lock-free in Rust: a pending nextReply returns null promptly.
        registry.removeCall(string(call, "call"))?.cancel()
        JSObject()
    }

    @PluginMethod
    fun close(call: PluginCall) = run(call) {
        withContext(NonCancellable) { registry.removeEndpoint(string(call, "handle"))?.shutdown() }
        JSObject()
    }

    override fun handleOnDestroy() {
        val closing = registry.destroy()
        scope.cancel()
        val cleanup = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        closing.forEach { endpoint ->
            cleanup.launch {
                runCatching { endpoint.shutdown() }
            }
        }
        super.handleOnDestroy()
    }

    private companion object {
        const val MAX_FRAME = 2 * 1024 * 1024 + 4096
    }
}

private class IrohRegistry {
    private val lock = Any()
    private var destroyed = false
    private val endpoints = mutableMapOf<String, MobileIrohEndpoint>()
    private val calls = mutableMapOf<String, MobileIrohCall>()

    suspend fun addEndpoint(endpoint: MobileIrohEndpoint): String {
        val id = UUID.randomUUID().toString()
        val retained = synchronized(lock) {
            if (destroyed) false else { endpoints[id] = endpoint; true }
        }
        if (!retained) {
            withContext(NonCancellable) { endpoint.shutdown() }
            throw IrohException.Failed("iroh_closed")
        }
        return id
    }

    fun addCall(call: MobileIrohCall): String {
        val id = UUID.randomUUID().toString()
        val retained = synchronized(lock) {
            if (destroyed) false else { calls[id] = call; true }
        }
        if (!retained) {
            call.cancel()
            throw IrohException.Failed("iroh_closed")
        }
        return id
    }

    fun endpoint(id: String): MobileIrohEndpoint = synchronized(lock) {
        endpoints[id] ?: throw IrohException.Failed("iroh_closed")
    }
    fun call(id: String): MobileIrohCall = synchronized(lock) {
        calls[id] ?: throw IrohException.Failed("iroh_closed")
    }
    fun removeCall(id: String): MobileIrohCall? = synchronized(lock) { calls.remove(id) }
    fun removeEndpoint(id: String): MobileIrohEndpoint? = synchronized(lock) { endpoints.remove(id) }

    fun destroy(): List<MobileIrohEndpoint> {
        val (closingEndpoints, closingCalls) = synchronized(lock) {
            destroyed = true
            Pair(endpoints.values.toList(), calls.values.toList()).also {
                endpoints.clear()
                calls.clear()
            }
        }
        closingCalls.forEach { it.cancel() }
        return closingEndpoints
    }
}
