package app.lody.android.chat

import app.lody.android.runtime.CatalogPullRequest
import java.net.URI

/**
 * A GitHub pull request URL in a message (`https://github.com/<owner>/<repo>/pull/<number>`,
 * optionally followed by a tab such as `/files`, a query or a fragment). iOS `ChatPullRequestLink`.
 */
data class PullRequestLink(val repository: String, val number: Int) {
    val url: String get() = "https://github.com/$repository/pull/$number"

    /** The PR as the panel opens it: the session's own catalog entry when it has one. */
    fun reference(known: List<CatalogPullRequest>): CatalogPullRequest =
        known.lastOrNull { it.number == number && it.repository.equals(repository, ignoreCase = true) }
            ?: CatalogPullRequest(repository, number, status = "", url = url)

    companion object {
        fun parse(href: String): PullRequestLink? {
            val uri = try { URI(href.trim()) } catch (_: Exception) { return null }
            if (uri.scheme?.lowercase() !in setOf("http", "https")) return null
            if (uri.host?.lowercase() !in setOf("github.com", "www.github.com")) return null
            val parts = uri.path.orEmpty().split('/').filter { it.isNotEmpty() }
            if (parts.size < 4 || parts[2] != "pull") return null
            val digits = parts[3]
            if (digits.isEmpty() || digits.length > 9 || !digits.all { it in '0'..'9' }) return null
            val number = digits.toInt().takeIf { it > 0 } ?: return null
            return PullRequestLink("${parts[0]}/${parts[1]}", number)
        }

        /**
         * The link when it belongs to one of [repositories] (case-insensitive), named with the
         * project's spelling; null leaves it to the browser.
         */
        fun inProject(href: String, repositories: List<String>): PullRequestLink? {
            val link = parse(href) ?: return null
            val repository = repositories.firstOrNull { it.equals(link.repository, ignoreCase = true) } ?: return null
            return link.copy(repository = repository)
        }
    }
}
