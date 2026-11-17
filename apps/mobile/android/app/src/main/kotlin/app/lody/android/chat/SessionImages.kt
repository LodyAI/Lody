package app.lody.android.chat

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import app.lody.android.runtime.RuntimeScope
import app.lody.android.runtime.TurnImage
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Reads one session image's bytes with the verified account; [width] asks for a thumbnail. */
fun interface SessionImageReader {
    suspend fun read(scope: RuntimeScope, sessionId: String, image: TurnImage, width: Int?): ByteArray
}

/** An image that could not be read; the card shows its failure state and can retry. */
class SessionImageFailure(code: String) : Exception(code)

/**
 * iOS `ChatImageCell` / `ChatImagePreviewPage` reads, natively: a GET to the fixed Worker
 * session-images endpoint with the account bearer, no redirects or cookies, bounded body.
 * Thumbnails use the same `width` / `scale-down` / `quality` query as iOS.
 */
internal class SessionImageHttp {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).build()

    suspend fun read(token: String, workspace: String, session: String, imageId: String, width: Int?): ByteArray {
        fun segment(value: String) = SessionAttachmentUploads.segment(value)
        val base = "${app.lody.android.BackendEnvironment.worker}/api/workspaces/${segment(workspace)}/session-images/${segment(session)}/${segment(imageId)}"
        val url = if (width == null) base else "$base/thumbnail?width=$width&fit=scale-down&quality=85"
        val request = Request.Builder().url(url).get()
            .header("Authorization", "Bearer $token")
            .header("Accept", "image/*,*/*")
            .build()
        val call = client.newCall(request)
        val response = suspendCancellableCoroutine { continuation ->
            continuation.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) = continuation.resumeWithException(SessionImageFailure("network"))
                override fun onResponse(call: Call, response: Response) = continuation.resume(response)
            })
        }
        return withContext(Dispatchers.IO) {
            response.use {
                if (!it.isSuccessful) throw SessionImageFailure("http_${it.code}")
                val body = it.body
                if (body.contentLength() > LIMIT) throw SessionImageFailure("too_large")
                val bytes = body.byteStream().use { input -> input.readNBytesCompat(LIMIT + 1) }
                if (bytes.size > LIMIT) throw SessionImageFailure("too_large")
                bytes
            }
        }
    }

    private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(64 * 1024)
        while (out.size() < limit) {
            val count = read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (count < 0) break
            out.write(buffer, 0, count)
        }
        return out.toByteArray()
    }

    private companion object {
        /** Session images are uploaded at most 5 MiB (re-encoded above); leave room for originals. */
        const val LIMIT = 32 * 1024 * 1024
    }
}

/**
 * One conversation's images: thumbnails decode once into a process-wide memory cache shared by
 * the stack and the viewer, so swiping cards and opening the viewer never reload them.
 */
class SessionImageSource(private val reader: SessionImageReader, private val scope: RuntimeScope, private val sessionId: String) {
    private fun key(image: TurnImage, width: Int?) =
        "${scope.accountId}/${scope.workspaceId}/${image.storageSessionId ?: sessionId}/${image.id}@${width ?: "full"}"

    /** The cached bitmap, if this size was already decoded (first frame without a spinner). */
    fun cached(image: TurnImage, full: Boolean): ImageBitmap? =
        cache.get(key(image, if (full) null else THUMBNAIL_WIDTH))

    /** A ~768 px thumbnail for cards, or the original for the viewer, downsampled to [maxSide]. */
    suspend fun bitmap(image: TurnImage, full: Boolean, maxSide: Int = if (full) 4096 else 1536): ImageBitmap {
        val width = if (full) null else THUMBNAIL_WIDTH
        val key = key(image, width)
        cache.get(key)?.let { return it }
        val bytes = if (full) original(image) else reader.read(scope, sessionId, image, width)
        val bitmap = withContext(Dispatchers.Default) { decode(bytes, maxSide) } ?: throw SessionImageFailure("decode")
        cache.put(key, bitmap)
        return bitmap
    }

    /** The original bytes for copy / save / share (the thumbnail is never shared). */
    suspend fun original(image: TurnImage): ByteArray = reader.read(scope, sessionId, image, null)

    private fun decode(bytes: ByteArray, maxSide: Int): ImageBitmap? {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
        var sample = 1
        while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= maxSide) sample *= 2
        val options = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.asImageBitmap()
    }

    private companion object {
        const val THUMBNAIL_WIDTH = 768
        /** About 48 MiB of decoded bitmaps across conversations. */
        private val cache = object : LruCache<String, ImageBitmap>(48 * 1024 * 1024) {
            override fun sizeOf(key: String, value: ImageBitmap) = value.width * value.height * 4
        }
    }
}

/** The conversation's image source; null outside a conversation (previews, probes). */
val LocalSessionImages = staticCompositionLocalOf<SessionImageSource?> { null }
