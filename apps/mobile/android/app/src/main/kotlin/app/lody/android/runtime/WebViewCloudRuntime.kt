package app.lody.android.runtime

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.*
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** Owns an offscreen WebView; screens never own it or receive its reference. */
class WebViewCloudRuntime internal constructor(
    context: Context,
    private val document: String,
    private val access: app.lody.android.cloud.StreamAccess? = null,
) : RuntimeBackend {
    constructor(context: Context) : this(context, "DataRuntime.html")
    private val context = context.applicationContext
    internal val preferRoost: Boolean get() = RoostPreferences.enabled(context)
    private val handler = Handler(Looper.getMainLooper())
    private val health = RuntimeHealth()
    private var view: WebView? = null
    private var active = true
    private var started = false
    private var ready = false
    private var pingPending = false
    private var requestId = 0L
    private val listeners = linkedSetOf<(RuntimeStatus) -> Unit>()
    private data class Pending(val deadline: Long, val control: Boolean, val complete: (Result<Any?>) -> Unit)
    private val chunks = ChunkAssembler()
    private val eventListeners = linkedSetOf<(RuntimeEmission) -> Unit>()
    private val pending = linkedMapOf<String, Pending>()
    override var status = RuntimeStatus()
        private set
    private val origin = "https://lody.ai"
    private val url = "$origin/android-runtime/$document"
    private val loader = WebViewAssetLoader.Builder().setDomain("lody.ai")
        .addPathHandler("/android-runtime/", WebViewAssetLoader.PathHandler { path ->
            if (path != document) denied()
            else try {
                val html = this.context.assets.open("runtime/$document").bufferedReader().use { it.readText() }
                    .replace("__LODY_STREAM_ORIGIN__", access?.origin ?: "'none'")
                WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(html.toByteArray()))
            }
            catch (_: java.io.IOException) { denied() }
        }).build()
    private val tick = object : Runnable {
        override fun run() {
            if (!started || !active) return
            val tickGeneration = status.generation
            val now = SystemClock.elapsedRealtime()
            val expired = pending.filterValues { it.deadline <= now }.keys.toList()
            expired.forEach { id ->
                val call = pending.remove(id)
                cancelJavascript(id)
                call?.complete?.invoke(Result.failure(RuntimeFailure("command_timeout")))
            }
            if (chunks.expire(now)) { recover("bridge_chunk_timeout"); return }
            if (!started || !active || tickGeneration != status.generation) return
            if (health.timedOut(now)) {
                recover("watchdog_timeout")
                return
            }
            if (ready && !pingPending) {
                pingPending = true
                val generation = status.generation
                ping { result ->
                    if (generation != status.generation) return@ping
                    pingPending = false
                    if (result.getOrNull() == true) {
                        health.acknowledged(SystemClock.elapsedRealtime())
                        publish(status.copy(acknowledgements = status.acknowledgements + 1))
                    }
                }
            }
            handler.postDelayed(this, 1000)
        }
    }
    private fun assertOwner() = check(Looper.myLooper() == Looper.getMainLooper()) { "Runtime requires its UI executor" }
    override fun observe(listener: (RuntimeStatus) -> Unit): AutoCloseable {
        assertOwner(); listeners.add(listener); listener(status)
        return AutoCloseable { assertOwner(); listeners.remove(listener) }
    }
    private fun publish(next: RuntimeStatus) {
        status = next
        listeners.toList().forEach { it(next) }
    }
    override fun start() {
        assertOwner()
        if (started) return
        started = true
        if (active) create() else publish(status.copy(phase = RuntimePhase.SUSPENDED))
    }
    // The feature guard below fails closed before creating/injecting the bridge.
    // Lint does not follow the early return through this try/catch.
    @SuppressLint("SetJavaScriptEnabled", "RequiresFeature")
    private fun create() {
        dispose("runtime_replaced")
        val generation = status.generation
        health.started(SystemClock.elapsedRealtime())
        publish(status.copy(phase = RuntimePhase.STARTING, failure = null, fault = null, capabilities = emptySet()))
        try {
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
                fail("web_message_listener_unavailable"); return
            }
            val owned = WebView(context)
            view = owned
            owned.settings.apply {
                javaScriptEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                domStorageEnabled = true
                cacheMode = WebSettings.LOAD_NO_CACHE
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                javaScriptCanOpenWindowsAutomatically = false
                setSupportMultipleWindows(false)
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(owned, false)
            owned.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(webView: WebView, request: WebResourceRequest): WebResourceResponse? {
                    // No fallback to network, including subresources, redirects and missing assets.
                    if (request.url.toString() == url && request.method == "GET") {
                        return loader.shouldInterceptRequest(request.url) ?: denied()
                    }
                    if (!request.isForMainFrame && access?.allows(request.url.toString(), request.method) == true) return null
                    return denied()
                }
                override fun shouldOverrideUrlLoading(webView: WebView, request: WebResourceRequest): Boolean {
                    if (view === owned && status.generation == generation) {
                        publish(status.copy(blockedNavigations = status.blockedNavigations + 1))
                    }
                    return true
                }
                override fun onReceivedError(webView: WebView, request: WebResourceRequest, error: WebResourceError) {
                    if (request.isForMainFrame && view === owned && status.generation == generation) recover("document_load_failed")
                }
                override fun onReceivedHttpError(webView: WebView, request: WebResourceRequest, response: WebResourceResponse) {
                    if (request.isForMainFrame && view === owned && status.generation == generation) recover("document_http_error")
                }
                override fun onRenderProcessGone(webView: WebView, detail: RenderProcessGoneDetail): Boolean {
                    if (view === owned && status.generation == generation) recover("renderer_gone")
                    return true
                }
            }
            WebViewCompat.addWebMessageListener(owned, "LodyHost", setOf(origin)) { sender, message, sourceOrigin, isMainFrame, _ ->
                if (sender !== view || generation != status.generation || !isMainFrame || sourceOrigin.toString().trimEnd('/') != origin) return@addWebMessageListener
                val data = message.data ?: return@addWebMessageListener
                if (data.length > 192 * 1024) { recover("bridge_message_too_large"); return@addWebMessageListener }
                try {
                    val frame = JSONObject(data)
                    if (frame.optString("type") == "bridgeChunk") {
                        val text = chunks.add(frame.getString("id"), frame.getInt("index"), frame.getInt("total"), frame.getString("data"), SystemClock.elapsedRealtime())
                        if (text != null) receive(JSONObject(text))
                    } else receive(frame)
                } catch (_: Exception) { recover("invalid_bridge_message") }
            }
            owned.loadUrl(url)
            handler.removeCallbacks(tick)
            handler.post(tick)
        } catch (_: Exception) { fail("webview_unavailable") }
    }
    private fun denied() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(byteArrayOf()))
    private fun receive(message: JSONObject) {
        if (message.optString("type") == "diagnostic") ConnectionTrace.mark(message.optString("stage"))
        if (message.optString("type") == "synced") ConnectionTrace.mark("synced")
        when (message.optString("type")) {
            "hostReady" -> {
                val capabilities = try { RuntimeProtocol.capabilities(message) }
                catch (_: Exception) { fail("capability_protocol_mismatch"); return }
                if (ready) { fail("duplicate_host_ready"); return }
                ready = true
                health.acknowledged(SystemClock.elapsedRealtime())
                val phase = if (active) RuntimePhase.READY else RuntimePhase.SUSPENDED
                publish(status.copy(phase = phase, capabilities = capabilities))
            }
            "reply" -> {
                val callback = pending.remove(message.optString("id"))?.complete ?: return
                if (message.has("error")) callback(Result.failure(RuntimeFailure(message.getString("error"))))
                else callback(Result.success(message.opt("value")))
            }
            "bridgeError" -> recover("bridge_transport_error")
            "ready" -> Unit
            else -> {
                val event = RuntimeProtocol.event(message) ?: return
                if (!ready || !active) return
                eventListeners.toList().forEach { it(RuntimeEmission(status.generation, event)) }
            }
        }
    }
    internal fun observeEvents(listener: (RuntimeEmission) -> Unit): AutoCloseable {
        assertOwner(); eventListeners.add(listener)
        return AutoCloseable { assertOwner(); eventListeners.remove(listener) }
    }
    internal fun request(method: String, args: JSONArray = JSONArray(), deadline: CommandDeadline = CommandDeadline.CONTROL, completion: (Result<Any?>) -> Unit): AutoCloseable {
        assertOwner()
        val empty = AutoCloseable { }
        if (!ready || !active || !started) { completion(Result.failure(RuntimeFailure("runtime_not_ready"))); return empty }
        if (method !in status.capabilities) { completion(Result.failure(RuntimeFailure("unsupported_command"))); return empty }
        val owned = view ?: run { completion(Result.failure(RuntimeFailure("runtime_unavailable"))); return empty }
        val control = method == "ping" || method == "setActive"
        if (pending.size >= 32 || (!control && pending.values.count { !it.control } >= 30)) { completion(Result.failure(RuntimeFailure("too_many_commands"))); return empty }
        val id = "${status.generation}:${++requestId}"
        val request = JSONObject().put("id", id).put("method", method).put("args", args)
        val json = request.toString()
        if (json.length > 192 * 1024) { completion(Result.failure(RuntimeFailure("command_too_large"))); return empty }
        pending[id] = Pending(SystemClock.elapsedRealtime() + deadline.milliseconds, control, completion)
        owned.evaluateJavascript("globalThis.androidDispatch(JSON.parse(${JSONObject.quote(json)}))", null)
        return AutoCloseable {
            assertOwner()
            if (pending.remove(id) != null && view === owned) cancelJavascript(id)
        }
    }
    private fun cancelJavascript(id: String) {
        val command = JSONObject().put("id", id).put("method", "\$cancel").put("args", JSONArray().put(id))
        view?.evaluateJavascript("globalThis.androidDispatch(JSON.parse(${JSONObject.quote(command.toString())}))", null)
    }
    override fun ping(completion: (Result<Boolean>) -> Unit) {
        request("ping") { result -> completion(result.mapCatching { it as? Boolean ?: throw RuntimeFailure("invalid_ping_reply") }) }
    }
    override fun setActive(active: Boolean) {
        assertOwner()
        if (this.active == active) return
        if (!active) {
            if (ready) request("setActive", JSONArray().put(false)) {}
            this.active = false
            health.suspend()
            chunks.suspend(SystemClock.elapsedRealtime())
            handler.removeCallbacks(tick)
            cancelPending("runtime_suspended")
            view?.onPause()
            if (started) publish(status.copy(phase = RuntimePhase.SUSPENDED))
        } else {
            this.active = true
            health.resume(SystemClock.elapsedRealtime())
            chunks.resume(SystemClock.elapsedRealtime())
            if (!started) return
            if (view == null) { create(); return }
            view?.onResume()
            val phase = if (ready) RuntimePhase.READY else RuntimePhase.STARTING
            publish(status.copy(phase = phase))
            if (ready) request("setActive", JSONArray().put(true)) {}
            handler.post(tick)
        }
    }
    private fun recover(reason: String) {
        if (!started) return
        if (!active) { dispose("runtime_replaced"); return }
        if (!health.allowRestart(SystemClock.elapsedRealtime())) { fail("restart_limit_$reason"); return }
        publish(status.copy(automaticRestarts = status.automaticRestarts + 1))
        create()
    }
    private fun fail(reason: String) {
        dispose("runtime_failed")
        started = false
        publish(status.copy(phase = RuntimePhase.FAILED, failure = reason, fault = runtimeFault(reason)))
    }
    private fun cancelPending(reason: String) {
        pending.keys.toList().forEach(::cancelJavascript)
        val calls = pending.values.toList()
        pending.clear()
        pingPending = false
        calls.forEach { it.complete(Result.failure(RuntimeFailure(reason))) }
    }
    private fun dispose(reason: String) {
        handler.removeCallbacks(tick)
        ready = false
        chunks.clear()
        status = status.copy(generation = status.generation + 1, capabilities = emptySet())
        val old = view
        view = null
        cancelPending(reason)
        old?.stopLoading()
        old?.destroy()
    }
    override fun stop() {
        assertOwner(); started = false
        dispose("runtime_stopped")
        publish(status.copy(phase = RuntimePhase.STOPPED))
    }
}
