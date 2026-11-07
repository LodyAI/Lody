package app.lody.android.auth

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Fixed official origin, no redirects, cookies, logging or response caching. */
internal class OkHttpAuthTransport : AuthTransport {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(20, TimeUnit.SECONDS).callTimeout(25, TimeUnit.SECONDS).build()
    override suspend fun request(path: String, credential: Credential?, body: String?): HttpReply = suspendCancellableCoroutine { continuation ->
        require(path.matches(Regex("/api/auth/organization/list-members\\?organizationId=[A-Za-z0-9_-]{1,200}&limit=100&offset=[0-9]{1,4}")) || path in setOf("/api/auth/mobile/exchange", "/api/auth/sign-in/email", "/api/auth/sign-up/email", "/api/auth/sign-in/social", "/api/auth/send-verification-email", "/api/auth/request-password-reset", "/api/auth/get-session", "/api/auth/organization/list", "/api/auth/sign-out", "/api/loro-streams/token"))
        val request = Request.Builder().url("${app.lody.android.BackendEnvironment.site}$path").apply {
            credential?.let { header("Authorization", "Bearer ${it.token}") }
            if (body != null) post(body.toRequestBody("application/json".toMediaType()))
        }.build()
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) { continuation.resumeWithException(AuthFailure("network_unavailable")) }
            override fun onResponse(call: Call, response: Response) {
                response.use {
                    try {
                        val source = it.body.source()
                        source.request(1024 * 1024 + 1L)
                        if (source.buffer.size > 1024 * 1024) throw AuthFailure("response_too_large")
                        continuation.resume(HttpReply(it.code, source.buffer.readUtf8()))
                    } catch (_: IOException) { continuation.resumeWithException(AuthFailure("network_unavailable")) }
                    catch (failure: AuthFailure) { continuation.resumeWithException(failure) }
                }
            }
        })
    }
}
