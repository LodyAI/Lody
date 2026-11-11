package app.lody.android.chat

import android.annotation.SuppressLint
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.util.UUID

/** Preview links the runtime returns: HTTPS on a `*.trycloudflare.com` quick tunnel, no credentials or port. */
object PreviewUrls {
    private val tunnelHost = Regex("^[a-z0-9]+(?:-[a-z0-9]+)*\\.trycloudflare\\.com$")

    /** The link's exact origin (`https://host`), or null when it is not a preview tunnel link. */
    fun origin(url: String?): String? {
        val uri = try { Uri.parse(url ?: return null) } catch (_: Exception) { return null }
        val host = uri.host ?: return null
        if (uri.scheme != "https" || uri.userInfo != null || uri.port != -1 || !tunnelHost.matches(host)) return null
        return "https://$host"
    }
}

private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(byteArrayOf()))

@SuppressLint("SetJavaScriptEnabled")
private fun WebView.previewSettings(storage: Boolean) {
    settings.apply {
        javaScriptEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        domStorageEnabled = storage
        mediaPlaybackRequiresUserGesture = false
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        javaScriptCanOpenWindowsAutomatically = false
        setSupportMultipleWindows(false)
    }
    CookieManager.getInstance().setAcceptThirdPartyCookies(this, false)
}

/**
 * The managed web preview, full screen (iOS opens it in Safari). Only the tunnel's own origin
 * loads here; a link elsewhere that the reader taps opens in the browser, and anything else is
 * blocked. No native bridge is exposed to the page.
 */
@Composable
fun BrowserPreviewWebView(url: String, modifier: Modifier = Modifier, onTitle: (String) -> Unit = {}) {
    val origin = remember(url) { PreviewUrls.origin(url) } ?: return
    AndroidView(
        modifier = modifier,
        factory = { context ->
            WebView(context).apply {
                previewSettings(storage = true)
                webViewClient = object : WebViewClient() {
                    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                        val target = request.url.toString()
                        if (PreviewUrls.origin(target) == origin) return false
                        if (request.isForMainFrame && request.hasGesture() && request.url.scheme in setOf("http", "https")) openExternal(context, target)
                        return true
                    }
                    override fun onPageFinished(view: WebView, address: String?) { view.title?.takeIf { it.isNotBlank() }?.let(onTitle) }
                    override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true
                }
                loadUrl(url)
            }
        },
        onRelease = { it.stopLoading(); it.destroy() },
    )
}

internal fun openExternal(context: Context, url: String) {
    runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
}

/** What the device viewer reports (web `lody:ios-simulator:state`): `connecting` / `ready` / `disconnected` / `error`. */
data class ViewerState(val state: String, val width: Int = 0, val height: Int = 0)

/**
 * The native side of one viewer host page: device controls go to the viewer and their replies come
 * back by request id. One control at a time, bounded at 15 s like web; a busy or unloaded viewer
 * answers at once.
 */
class DeviceViewerBridge {
    internal var proxy: JavaScriptReplyProxy? = null
    internal var loaded = false
    private val pending = mutableMapOf<String, CompletableDeferred<String?>>()

    /** Null on success, else `busy` / `unavailable` / `unsupported` / `failed` / `timeout`. */
    suspend fun control(control: JSONObject): String? {
        val target = proxy ?: return "unavailable"
        if (!loaded) return "unavailable"
        if (pending.isNotEmpty()) return "busy"
        val requestId = UUID.randomUUID().toString()
        val reply = CompletableDeferred<String?>()
        pending[requestId] = reply
        return try {
            target.postMessage(JSONObject().put("type", "control").put("requestId", requestId).put("control", control).toString())
            withTimeoutOrNull(15_000) { reply.await() } ?: if (reply.isCompleted) null else "timeout"
        } finally { pending.remove(requestId) }
    }

    internal fun visibility(visible: Boolean) {
        proxy?.postMessage(JSONObject().put("type", "visibility").put("visible", visible).toString())
    }

    internal fun answered(requestId: String, error: String?) { pending[requestId]?.complete(error) }

    internal fun reset() {
        proxy = null; loaded = false
        pending.values.forEach { it.complete("unavailable") }
        pending.clear()
    }
}

private const val HostDomain = "appassets.androidplatform.net"
private const val HostOrigin = "https://$HostDomain"
private const val HostUrl = "$HostOrigin/lody-preview/host.html"

/**
 * The parent page the device viewer requires (web `IosSimulatorViewer`): it frames the viewer
 * (`sandbox="allow-scripts allow-same-origin"`), sends `init` to the viewer's exact origin after
 * each load, and accepts state and control replies only from that frame, that origin and that
 * operation. It talks to native only through the `LodyPreview` web message listener, which exists
 * in this host origin alone.
 */
private val HostPage = """<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src https://*.trycloudflare.com; base-uri 'none'; form-action 'none'">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}iframe{display:block;border:0;width:100%;height:100%}</style>
<iframe id="f" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" allow="autoplay"></iframe>
<script>
const host=globalThis.LodyPreview,frame=document.getElementById('f');let config=null,loaded=false;
const send=m=>host.postMessage(JSON.stringify(m));
const toViewer=m=>frame.contentWindow&&frame.contentWindow.postMessage({...m,operationId:config.operationId},config.origin);
frame.addEventListener('load',()=>{if(!config)return;loaded=true;toViewer({type:'lody:ios-simulator:init',visible:config.visible,rotateWithDevice:true});send({type:'loaded'})});
host.onmessage=e=>{let d;try{d=JSON.parse(e.data)}catch{return}
 if(d.type==='open'){if(config||typeof d.url!=='string'||typeof d.origin!=='string'||typeof d.operationId!=='string')return;config={url:d.url,origin:d.origin,operationId:d.operationId,visible:d.visible===true};frame.src=d.url;return}
 if(!config)return;
 if(d.type==='visibility'&&typeof d.visible==='boolean'){config.visible=d.visible;if(loaded)toViewer({type:'lody:ios-simulator:visibility',visible:d.visible})}
 else if(d.type==='control'&&typeof d.requestId==='string'){if(!loaded)send({type:'control-result',requestId:d.requestId,error:'unavailable'});else toViewer({type:'lody:ios-simulator:control',requestId:d.requestId,control:d.control})}
};
addEventListener('message',e=>{if(!config||e.source!==frame.contentWindow||e.origin!==config.origin)return;const d=e.data;if(!d||typeof d!=='object'||d.operationId!==config.operationId)return;
 if(d.type==='lody:ios-simulator:state'&&['connecting','ready','disconnected','error'].includes(d.state))send({type:'state',state:d.state,width:Number.isInteger(d.width)?d.width:0,height:Number.isInteger(d.height)?d.height:0});
 else if(d.type==='lody:ios-simulator:control-result'&&typeof d.requestId==='string')send({type:'control-result',requestId:d.requestId,error:d.success===true?null:(typeof d.error==='string'?d.error:'failed')});
});
send({type:'hello'});
</script>"""

/**
 * The device viewer in a native-owned WebView. Returns without drawing when the link is not a
 * preview tunnel link or the WebView lacks web message listeners.
 */
@SuppressLint("RequiresFeature")
@Composable
fun DeviceViewerWebView(
    viewerUrl: String,
    operationId: String,
    visible: Boolean,
    bridge: DeviceViewerBridge,
    modifier: Modifier = Modifier,
    onState: (ViewerState) -> Unit,
) {
    val origin = remember(viewerUrl) { PreviewUrls.origin(viewerUrl) }
    if (origin == null || !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
        LaunchedEffect(viewerUrl) { onState(ViewerState("error")) }
        return
    }
    val latestState by rememberUpdatedState(onState)
    val latestVisible by rememberUpdatedState(visible)
    LaunchedEffect(visible) { if (bridge.loaded) bridge.visibility(visible) }
    key(viewerUrl, operationId) {
        AndroidView(
            modifier = modifier,
            factory = { context ->
                bridge.reset()
                val loader = WebViewAssetLoader.Builder().setDomain(HostDomain)
                    .addPathHandler("/lody-preview/", WebViewAssetLoader.PathHandler { path ->
                        if (path == "host.html") WebResourceResponse("text/html", "UTF-8", ByteArrayInputStream(HostPage.toByteArray())) else blocked()
                    }).build()
                WebView(context).apply {
                    previewSettings(storage = false)
                    setBackgroundColor(android.graphics.Color.TRANSPARENT)
                    webViewClient = object : WebViewClient() {
                        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                            val url = request.url.toString()
                            if (request.url.host == HostDomain) return if (url == HostUrl && request.method == "GET") loader.shouldInterceptRequest(request.url) ?: blocked() else blocked()
                            // The viewer frame and its own requests stay on the viewer's origin.
                            return if (!request.isForMainFrame && PreviewUrls.origin(url) == origin) null else blocked()
                        }
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                            if (request.isForMainFrame) request.url.toString() != HostUrl else PreviewUrls.origin(request.url.toString()) != origin
                        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                            bridge.reset(); latestState(ViewerState("error")); return true
                        }
                    }
                    WebViewCompat.addWebMessageListener(this, "LodyPreview", setOf(HostOrigin)) { _, message, sourceOrigin, isMainFrame, replyProxy ->
                        if (!isMainFrame || sourceOrigin.toString().trimEnd('/') != HostOrigin) return@addWebMessageListener
                        val data = message.data?.takeIf { it.length <= 16 * 1024 } ?: return@addWebMessageListener
                        val frame = try { JSONObject(data) } catch (_: Exception) { return@addWebMessageListener }
                        when (frame.optString("type")) {
                            "hello" -> {
                                bridge.proxy = replyProxy
                                replyProxy.postMessage(JSONObject().put("type", "open").put("url", viewerUrl).put("origin", origin)
                                    .put("operationId", operationId).put("visible", latestVisible).toString())
                            }
                            "loaded" -> bridge.loaded = true
                            "state" -> latestState(ViewerState(frame.optString("state"), frame.optInt("width"), frame.optInt("height")))
                            "control-result" -> bridge.answered(frame.optString("requestId"), if (frame.isNull("error")) null else frame.optString("error"))
                        }
                    }
                    loadUrl(HostUrl)
                }
            },
            onRelease = { bridge.reset(); it.stopLoading(); it.destroy() },
        )
    }
}
