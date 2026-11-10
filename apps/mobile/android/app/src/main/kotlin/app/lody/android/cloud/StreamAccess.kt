package app.lody.android.cloud

import java.net.URI
import java.net.URLDecoder

/** Only a successful official grant response may construct this permission. */
internal class StreamAccess(val workspaceId: String, gateway: String) {
    val origin: String
    init {
        require(workspaceId.matches(Regex("[a-zA-Z0-9_-]{1,128}")))
        val uri = URI(gateway)
        require(uri.scheme == "https" && uri.userInfo == null && uri.port == -1 && uri.query == null && uri.fragment == null && uri.path in setOf("", "/"))
        val host = uri.host ?: throw IllegalArgumentException()
        require(host.matches(Regex("[a-zA-Z0-9][a-zA-Z0-9.-]*\\.[a-zA-Z]{2,}")) && !host.endsWith(".local") && !host.endsWith(".internal"))
        origin = "https://${host.lowercase()}"
    }
    fun allows(url: String, method: String): Boolean = try {
        val uri = URI(url)
        val parts = uri.rawPath.split('/')
        val stream = if (parts.size >= 4) URLDecoder.decode(parts[3], "UTF-8") else ""
        val read = method in setOf("GET", "HEAD", "OPTIONS")
        val id = "[a-zA-Z0-9_-]{1,128}"
        val workspace = Regex.escape(workspaceId)
        val permitted = when {
            stream == "$workspaceId:meta" -> read || method == "POST"
            stream.matches(Regex("$workspace:mf:$id")) -> read || method == "POST"
            // Agent Roles: the workspace Flock is read, created when missing and appended by Role edits.
            stream == "$workspaceId:wf:workspace" -> read || method in setOf("PUT", "POST")
            // Prompt shortcuts: this workspace's index Flocks and body docs, under stream-specific tokens.
            stream.matches(Regex("shortcut-index:$workspace:[^:/]{1,600}:(private|workspace)")) -> read || method in setOf("PUT", "POST")
            stream.matches(Regex("shortcut-body:[^:/]{1,600}")) -> read || method in setOf("PUT", "POST")
            // Schedules: the Flock registry and one schedule's Loro doc are each created, read and appended.
            stream == "$workspaceId:sr" -> read || method in setOf("PUT", "POST")
            stream.matches(Regex("$workspace:schedule:$id")) -> read || method in setOf("PUT", "POST")
            stream.matches(Regex("$workspace:s:$id")) -> read || method in setOf("PUT", "POST")
            stream.matches(Regex("$workspace:rpc:req:$id")) -> method in setOf("POST", "OPTIONS")
            stream.matches(Regex("$workspace:rpc:res:$id:$id")) -> read || method == "PUT"
            else -> false
        }
        permitted && uri.scheme == "https" && "https://${uri.host}" == origin && uri.port == -1 && uri.userInfo == null && uri.fragment == null &&
            parts.size in 4..5 && parts[1] == "ds" && parts[2] == "lody" && (parts.size == 4 || (parts[4] == "bootstrap" && read))

    } catch (_: Exception) { false }
}
