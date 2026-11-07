package app.lody.android.chat

import android.content.ContentResolver
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.URLEncoder
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import kotlin.coroutines.coroutineContext
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A picked attachment waiting in the composer; [image] ones go through the image endpoint. */
data class PendingAttachment(val id: String, val uri: Uri, val name: String, val mime: String, val size: Long, val image: Boolean)

/** An attachment that could not be prepared or uploaded; [code] maps to copy (`limit`, `too_large`, …). */
class AttachmentFailure(val code: String) : Exception(code)

/** Uploads a turn's attachments with the account's verified credential; null where uploads are unavailable. */
fun interface AttachmentUploader {
    suspend fun upload(scope: app.lody.android.runtime.RuntimeScope, sessionId: String, items: List<PendingAttachment>): List<JSONObject>
}

/**
 * iOS `SessionAttachments.upload`, natively: bytes go straight to the fixed official API with the
 * account bearer; only the server's attachment blocks (`imageId` / `fileId` references) reach the
 * runtime and Streams. Images over 5 MiB or in other formats are re-encoded as JPEG (longest side
 * 2048); files up to 100 MiB upload whole, or in 16 MiB parts above that (aborted on failure).
 * Nothing is retried: a failed upload fails the send before any turn is written.
 */
internal class SessionAttachmentUploads(private val resolver: ContentResolver) {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS).writeTimeout(120, TimeUnit.SECONDS).build()

    suspend fun upload(token: String, workspace: String, session: String, items: List<PendingAttachment>): List<JSONObject> = withContext(Dispatchers.IO) {
        if (items.size > 16 || items.count { it.image } > 8 || items.count { !it.image } > 8) throw AttachmentFailure("limit")
        items.map { item ->
            coroutineContext.ensureActive()
            val kind = if (item.image) "image" else "file"
            val base = "https://api.lody.ai/api/workspaces/${segment(workspace)}/session-${if (item.image) "images" else "files"}"
            val result = if (item.image) uploadImage(token, base, session, item) else uploadFile(token, base, session, item)
            val block = result.optJSONObject(kind)
            val id = block?.optString(if (item.image) "imageId" else "fileId").orEmpty()
            if (block == null || block.optString("type") != kind || id.isEmpty() || block.opt("mimeType") !is String || block.optLong("sizeBytes") <= 0) {
                throw AttachmentFailure("invalid_response")
            }
            block
        }
    }

    private suspend fun uploadImage(token: String, base: String, session: String, item: PendingAttachment): JSONObject {
        var bytes: ByteArray
        var name = item.name
        var type = item.mime
        if (item.mime in setOf("image/png", "image/jpeg", "image/webp", "image/gif") && item.size in 1..IMAGE_LIMIT) {
            bytes = read(item.uri, IMAGE_LIMIT)
        } else {
            // Decode at most ~2048 px on the longest side, then JPEG 85 (iOS thumbnail path).
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            open(item.uri).use { BitmapFactory.decodeStream(it, null, bounds) }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw AttachmentFailure("image_read")
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / (sample * 2) >= 2048) sample *= 2
            val decoded = open(item.uri).use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
                ?: throw AttachmentFailure("image_read")
            val scale = minOf(1f, 2048f / maxOf(decoded.width, decoded.height))
            val bitmap = if (scale < 1f) Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt().coerceAtLeast(1), (decoded.height * scale).toInt().coerceAtLeast(1), true) else decoded
            bytes = ByteArrayOutputStream().use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out); out.toByteArray() }
            type = "image/jpeg"
            name = name.substringBeforeLast('.', name) + ".jpg"
        }
        if (bytes.isEmpty()) throw AttachmentFailure("empty")
        if (bytes.size > IMAGE_LIMIT) throw AttachmentFailure("image_too_large")
        val body = MultipartBody.Builder().setType(MultipartBody.FORM)
            .addFormDataPart("sessionId", session)
            .addFormDataPart("file", name.replace(Regex("[\"\r\n]"), "_"), bytes.toRequestBody(type.toMediaType()))
            .build()
        return request(token, "POST", "$base/upload", body)
    }

    private suspend fun uploadFile(token: String, base: String, session: String, item: PendingAttachment): JSONObject {
        if (item.size <= 0) throw AttachmentFailure("empty")
        if (item.size > FILE_LIMIT) throw AttachmentFailure("too_large")
        // One pass for the hash and the text-preview probe (the first 8 KiB decode as UTF-8, no NUL).
        val digest = MessageDigest.getInstance("SHA-256")
        var prefix = ByteArray(0)
        var total = 0L
        open(item.uri).use { input ->
            val buffer = ByteArray(1 shl 20)
            while (true) {
                coroutineContext.ensureActive()
                val count = input.read(buffer)
                if (count < 0) break
                if (prefix.size < 8192) prefix += buffer.copyOf(minOf(count, 8192 - prefix.size))
                digest.update(buffer, 0, count)
                total += count
                if (total > FILE_LIMIT) throw AttachmentFailure("too_large")
            }
        }
        if (total <= 0) throw AttachmentFailure("empty")
        val headers = Headers.Builder()
            .add("x-session-id", session)
            .add("x-file-name", segment(item.name))
            .add("x-file-mime-type", item.mime.ifBlank { "application/octet-stream" })
            .add("x-file-sha256", digest.digest().joinToString("") { "%02x".format(it) })
            .add("x-file-size-bytes", total.toString())
            .add("x-file-text-preview", textPreview(prefix).toString())
            .build()
        if (total <= PART_SIZE) {
            return request(token, "POST", "$base/upload", read(item.uri, PART_SIZE.toLong()).toRequestBody(), headers)
        }
        val created = request(token, "POST", "$base/multipart/create", ByteArray(0).toRequestBody(), headers)
        val uploadId = created.optString("uploadId")
        val fileId = created.optString("fileId")
        if (uploadId.isEmpty() || fileId.isEmpty()) throw AttachmentFailure("invalid_response")
        val path = "$base/multipart/${segment(uploadId)}"
        val identity = Headers.Builder().add("x-session-id", session).add("x-file-id", fileId).build()
        try {
            val parts = JSONArray()
            open(item.uri).use { input ->
                while (true) {
                    coroutineContext.ensureActive()
                    val data = readUpTo(input, PART_SIZE)
                    if (data.isEmpty()) break
                    val number = parts.length() + 1
                    val part = request(token, "PUT", "$path/part/$number", data.toRequestBody(),
                        identity.newBuilder().add("x-file-part-size-bytes", data.size.toString()).build())
                    val etag = part.optString("etag").ifEmpty { throw AttachmentFailure("invalid_response") }
                    parts.put(JSONObject().put("partNumber", number).put("etag", etag))
                }
            }
            return request(token, "POST", "$path/complete",
                JSONObject().put("parts", parts).toString().toRequestBody("application/json".toMediaType()), identity)
        } catch (error: Throwable) {
            // Cleanup also runs after cancellation; the send itself is never retried.
            withContext(kotlinx.coroutines.NonCancellable) {
                try { request(token, "DELETE", "$path/abort", null, identity) } catch (_: Exception) { }
            }
            throw error
        }
    }

    private suspend fun request(token: String, verb: String, url: String, body: RequestBody?, headers: Headers? = null): JSONObject = suspendCancellableCoroutine { continuation ->
        val builder = Request.Builder().url(url)
        if (headers != null) builder.headers(headers)
        val request = builder.header("Authorization", "Bearer $token").method(verb, body).build()
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { continuation.resumeWithException(AttachmentFailure("network")) }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        // Never surface response text: only the status decides the copy.
                        if (it.code !in 200..299) throw AttachmentFailure(if (it.code == 401 || it.code == 403) "sign_in" else "upload")
                        val source = it.body.source()
                        source.request(256 * 1024 + 1L)
                        if (source.buffer.size > 256 * 1024) throw AttachmentFailure("invalid_response")
                        val text = source.buffer.readUtf8()
                        continuation.resume(if (text.isBlank()) JSONObject() else JSONObject(text))
                    } catch (failure: AttachmentFailure) { continuation.resumeWithException(failure) }
                    catch (_: Exception) { continuation.resumeWithException(AttachmentFailure("invalid_response")) }
                }
            }
        })
    }

    private fun open(uri: Uri): InputStream = resolver.openInputStream(uri) ?: throw AttachmentFailure("invalid")

    private fun read(uri: Uri, limit: Long): ByteArray = open(uri).use { input ->
        val bytes = readUpTo(input, (limit + 1).toInt())
        if (bytes.size > limit) throw AttachmentFailure("too_large")
        bytes
    }

    /** Up to [limit] bytes (fewer only at the end of the stream); `readNBytes` needs API 33. */
    private fun readUpTo(input: InputStream, limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(1 shl 16)
        while (out.size() < limit) {
            val count = input.read(buffer, 0, minOf(buffer.size, limit - out.size()))
            if (count < 0) break
            out.write(buffer, 0, count)
        }
        return out.toByteArray()
    }

    companion object {
        const val IMAGE_LIMIT = 5L * 1024 * 1024
        const val FILE_LIMIT = 100L * 1024 * 1024
        const val PART_SIZE = 16 * 1024 * 1024

        fun segment(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

        /** iOS: the prefix has no NUL and decodes as UTF-8 (a cut multi-byte tail still counts). */
        fun textPreview(prefix: ByteArray): Boolean {
            if (prefix.any { it == 0.toByte() }) return false
            val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
            for (trim in 0..3) {
                if (trim > prefix.size) break
                try { decoder.reset().decode(ByteBuffer.wrap(prefix, 0, prefix.size - trim)); return true } catch (_: Exception) { }
            }
            return false
        }

        /** A picked document's display name, size and type, or null when it cannot be read. */
        fun describe(resolver: ContentResolver, uri: Uri, image: Boolean): PendingAttachment? {
            var name = ""
            var size = -1L
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) {
                    name = cursor.getString(0).orEmpty()
                    if (!cursor.isNull(1)) size = cursor.getLong(1)
                }
            }
            val mime = resolver.getType(uri).orEmpty()
            if (name.isBlank()) name = uri.lastPathSegment?.substringAfterLast('/').orEmpty().ifBlank { if (image) "image" else "file" }
            // A picked video uploads as a file, as on iOS.
            val asImage = image && mime.startsWith("image/")
            return PendingAttachment(java.util.UUID.randomUUID().toString(), uri, name, mime, size, asImage)
        }
    }
}
