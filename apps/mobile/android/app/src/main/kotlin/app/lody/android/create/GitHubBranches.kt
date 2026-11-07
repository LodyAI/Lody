package app.lody.android.create

import app.lody.android.auth.Credential
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.*
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** Credentials stay native and are sent only to their fixed issuer/audience. */
internal fun interface BranchHttp {
    suspend fun request(url: String, token: String, body: JSONObject?): String
}

internal class GitHubBranches(private val transport: BranchHttp = BranchHttpClient()) {
    private suspend fun request(url: String, token: String, body: JSONObject? = null) = transport.request(url, token, body)

    suspend fun load(credential: Credential, workspace: String, repo: String, page: Int): BranchPage {
        require(repo.matches(Regex("[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}")) && repo.substringAfter('/') !in listOf(".", "..") && page in 1..1000)
        val auth = JSONObject(request("https://backend.lody.ai/api/auth/convex/token", credential.token))
        val broker = JSONObject(request("https://convex.lody.ai/api/action", auth.getString("token"),
            JSONObject().put("path", "github:getAccessTokenByRepoNameForClient").put("format", "convex_encoded_json")
                .put("args", JSONArray().put(JSONObject().put("workspaceId", workspace).put("repoFullName", repo)))))
        check(broker.optString("status") == "success")
        val value = broker.getJSONObject("value")
        check(value.optBoolean("success"))
        val token = value.getString("token")
        val base = "https://api.github.com/repos/$repo"
        val default = if (page == 1) JSONObject(request(base, token)).getString("default_branch") else null
        val rows = JSONArray(request("$base/branches?per_page=100&page=$page", token))
        require(rows.length() <= 100)
        val names = (0 until rows.length()).map { rows.getJSONObject(it).getString("name") }.toMutableList()
        if (names.isNotEmpty() && default != null) names.add(default)
        require(names.all { it.isNotBlank() && it.toByteArray().size <= 255 })
        return BranchPage(names.distinct(), default.takeUnless { names.isEmpty() }, if (rows.length() == 100) page + 1 else null)
    }

}

private class BranchHttpClient : BranchHttp {
    private val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).callTimeout(25, TimeUnit.SECONDS).build()
    override suspend fun request(url: String, token: String, body: JSONObject?): String = suspendCancellableCoroutine { continuation ->
        val request = Request.Builder().url(url).header("Authorization", "Bearer $token").header("Accept", "application/json").apply {
            if (body != null) post(body.toString().toRequestBody("application/json".toMediaType()))
        }.build()
        val call = client.newCall(request)
        continuation.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: java.io.IOException) { continuation.resumeWithException(e) }
            override fun onResponse(call: Call, response: Response) {
                try {
                    val result = response.use {
                        check(it.isSuccessful) { "branches_unavailable" }
                        val source = it.body.source()
                        source.request(1024 * 1024 + 1L)
                        check(source.buffer.size <= 1024 * 1024) { "branches_too_large" }
                        source.buffer.readUtf8()
                    }
                    continuation.resume(result)
                } catch (error: Exception) { continuation.resumeWithException(error) }
            }
        })
    }
}
