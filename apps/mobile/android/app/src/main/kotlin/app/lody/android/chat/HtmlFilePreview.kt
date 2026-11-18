package app.lody.android.chat

import android.net.Uri
import android.util.Base64
import android.webkit.MimeTypeMap
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import app.lody.android.runtime.FileContent
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayInputStream
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * Paths and policy for previewing an HTML file from the session's computer, matching iOS
 * `HTMLPreviewResource` and `HTMLPreviewDocumentPolicy`. The document is served from a private
 * origin; its relative resources, website-root paths of a document opened by absolute path, and
 * authored `file://` URLs are all read through the session's `readFile`, so the computer's
 * file-preview policy decides what is readable.
 */
internal object HtmlPreviewPaths {
    const val FILES = "/__lody_files/"
    /** Absolute computer paths, from rewritten `file://` URLs. */
    const val ABSOLUTE = "/__lody_fs/"

    /** Always prepended before authored markup; an authored policy can only tighten it. */
    const val CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self' https: 'unsafe-inline' 'unsafe-eval'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:; media-src 'self' https: data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; worker-src 'none'"

    private val drive = Regex("^[A-Za-z]:/")
    private val fileUrl = Regex("file://(?:localhost)?/", RegexOption.IGNORE_CASE)
    private val loopback = Regex("^(localhost|.*\\.localhost|127\\..*|\\[?::1]?)$", RegexOption.IGNORE_CASE)

    fun documentUrl(origin: String, path: String): String =
        Uri.parse(origin).buildUpon().path(FILES + path.trimStart('/')).build().toString()

    /**
     * The computer path a preview URL path names. A website-root path resolves like a browser
     * opening the document from disk, so only a document opened by absolute path resolves it.
     */
    fun path(urlPath: String, documentPath: String): String? {
        if (urlPath.startsWith(ABSOLUTE)) {
            val rest = urlPath.removePrefix(ABSOLUTE)
            return if (drive.containsMatchIn(rest)) rest else "/$rest"
        }
        if (urlPath.startsWith(FILES)) {
            val rest = urlPath.removePrefix(FILES)
            return if (documentPath.startsWith('/')) "/$rest" else rest
        }
        if (documentPath.startsWith('/')) return urlPath
        if (drive.containsMatchIn(documentPath)) return documentPath.take(2) + urlPath
        return null
    }

    fun rewriteFileUrls(text: String, origin: String): String =
        if (!text.contains("file:", ignoreCase = true)) text
        else fileUrl.replace(text, Regex.escapeReplacement(origin + ABSOLUTE))

    fun protect(html: String, origin: String): String =
        "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"$CONTENT_SECURITY_POLICY\">" +
            "<meta name=\"referrer\" content=\"no-referrer\">" + rewriteFileUrls(html, origin)

    fun isLoopback(host: String?): Boolean = host != null && loopback.matches(host)
}

private const val MAX_RESOURCES = 128
private const val MAX_RESOURCE_BYTES = 16L * 1024 * 1024
private const val RESOURCE_TIMEOUT_MS = 45_000L

private fun response(mime: String, data: ByteArray, status: Int = 200) = WebResourceResponse(
    mime, if (mime.startsWith("text/") || "javascript" in mime) "UTF-8" else null, status,
    if (status == 200) "OK" else "Not Found", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(data),
)

private fun mimeType(path: String): String {
    val extension = path.substringAfterLast('/').substringAfterLast('.', "").lowercase()
    return when (extension) {
        "js", "mjs", "cjs" -> "text/javascript"
        "css" -> "text/css"
        "svg" -> "image/svg+xml"
        "html", "htm" -> "text/html"
        "json" -> "application/json"
        else -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "application/octet-stream"
    }
}

/** Serves one preview's document and resources; [intercept] runs on WebView's network thread. */
private class HtmlPreviewServer(
    private val documentPath: String,
    private val html: String,
    private val readFile: suspend (String) -> FileContent,
) {
    private val host = "${UUID.randomUUID()}.lody-preview.invalid"
    val origin = "https://$host"
    val documentUrl = HtmlPreviewPaths.documentUrl(origin, documentPath)
    private val documentUri: Uri = Uri.parse(documentUrl)
    private val resources = AtomicInteger()
    private val bytes = AtomicLong()

    fun isDocument(uri: Uri): Boolean = uri.host == host && uri.path == documentUri.path

    fun intercept(request: WebResourceRequest): WebResourceResponse? {
        val uri = request.url
        if (uri.host != host) {
            // Remote HTTPS resources (CDNs) load normally; plain HTTP and the phone's own loopback never do.
            return if (uri.scheme == "http" || HtmlPreviewPaths.isLoopback(uri.host)) blocked() else null
        }
        if (request.method != "GET") return blocked()
        if (isDocument(uri)) return response("text/html", HtmlPreviewPaths.protect(html, origin).toByteArray(Charsets.UTF_8))
        val path = HtmlPreviewPaths.path(uri.path ?: return blocked(), documentPath) ?: return notFound()
        if (resources.incrementAndGet() > MAX_RESOURCES) return blocked()
        // WebView's network thread waits for the read; a failure is a missing resource, never a crash.
        val file = try {
            runBlocking { withTimeoutOrNull(RESOURCE_TIMEOUT_MS) { readFile(path) } }
        } catch (_: Exception) {
            null
        } ?: return notFound()
        val (mime, data) = when (file) {
            is FileContent.Text -> mimeType(path).let { mime ->
                // Stylesheets name images and fonts by `file://` URL as often as documents do.
                val text = if (mime == "text/css") HtmlPreviewPaths.rewriteFileUrls(file.text, origin) else file.text
                mime to text.toByteArray(Charsets.UTF_8)
            }
            is FileContent.Binary -> {
                val data = try { Base64.decode(file.base64, Base64.DEFAULT) } catch (_: IllegalArgumentException) { return notFound() }
                (file.mimeType ?: mimeType(path)) to data
            }
            is FileContent.Failed -> return notFound()
        }
        if (bytes.addAndGet(data.size.toLong()) > MAX_RESOURCE_BYTES) return blocked()
        return response(mime, data)
    }

    private fun notFound() = response("text/plain", byteArrayOf(), 404)
}

/**
 * A sandboxed preview of an HTML file on the session's computer (iOS `LodyHTMLPreviewView`):
 * JavaScript runs, no native bridge is exposed, no storage persists, and only the initial
 * document and its own anchors navigate; links and popups never leave the preview.
 */
@Composable
internal fun HtmlFilePreview(path: String, html: String, readFile: suspend (String) -> FileContent, modifier: Modifier = Modifier) {
    key(path, html) {
        AndroidView(
            modifier = modifier,
            factory = { context ->
                val server = HtmlPreviewServer(path, html, readFile)
                WebView(context).apply {
                    previewSettings(storage = false)
                    webViewClient = object : WebViewClient() {
                        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                            val url = request.url
                            val sameDocument = url.fragment != null && server.isDocument(url) && request.method == "GET"
                            return !(request.isForMainFrame && sameDocument)
                        }
                        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                            server.intercept(request)
                        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean = true
                    }
                    loadUrl(server.documentUrl)
                }
            },
            onRelease = { it.stopLoading(); it.destroy() },
        )
    }
}
