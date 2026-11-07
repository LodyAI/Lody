package app.lody.android.home

import android.content.Context
import app.lody.android.runtime.CatalogProject
import app.lody.android.runtime.CatalogSnapshot

/** Which projects the Projects tab lists (its view menu). */
enum class ProjectSource(val key: String) { All("all"), GitHub("github"), Local("local") }

/**
 * One Projects card (iOS `ProjectCard`): the project, where it runs, when it last moved, and its
 * open (non-archived) chats counted by Home's status groups.
 */
data class ProjectCard(
    val id: String,
    val title: String,
    val github: Boolean,
    /** GitHub: the repository owner's avatar. */
    val avatar: String?,
    /** Local: the computer it lives on. */
    val machine: String?,
    val machineId: String?,
    /** Latest activity of its open chats (epoch ms); null when it has none. */
    val updatedAt: Long?,
    val open: Int,
    val attention: Int,
    val running: Int,
    val finished: Int,
    val pullRequests: Int,
) {
    /** The one line the card leads with, most pressing first. */
    enum class Summary { Attention, Running, Finished, PullRequests, Open, Empty }

    val summary: Pair<Summary, Int>
        get() = when {
            attention > 0 -> Summary.Attention to attention
            running > 0 -> Summary.Running to running
            finished > 0 -> Summary.Finished to finished
            pullRequests > 0 -> Summary.PullRequests to pullRequests
            open > 0 -> Summary.Open to open
            else -> Summary.Empty to 0
        }
}

object ProjectCards {
    fun isGithub(project: CatalogProject) = project.id.startsWith("github:")

    fun ownerAvatar(repo: String): String? =
        repo.substringBefore('/', "").takeIf { it.isNotEmpty() }?.let { "https://avatars.githubusercontent.com/${java.net.URLEncoder.encode(it, "UTF-8")}?size=96" }

    /**
     * Every project (plain chats excluded), newest activity first; projects without open chats
     * follow by name. [owner] ("My tasks") counts only that user's chats; [query] matches the
     * name, repository, path and computer.
     */
    fun build(
        snapshot: CatalogSnapshot, owner: String?, source: ProjectSource, hideEmpty: Boolean, query: String = "",
    ): List<ProjectCard> {
        // Tabs belong to their parent conversation, so they never count on their own.
        val live = snapshot.sessions.filter { !it.archived && !ChatListModel.isTab(it) && (owner == null || it.userId == owner) }
        val byProject = live.groupBy { it.projectId }
        val term = query.trim()
        return snapshot.projects.asSequence()
            .filterNot { ChatListModel.isChat(it.id) }
            .filter { project ->
                when (source) {
                    ProjectSource.All -> true
                    ProjectSource.GitHub -> isGithub(project)
                    ProjectSource.Local -> !isGithub(project)
                }
            }
            .map { project ->
                val sessions = byProject[project.id].orEmpty()
                val groups = sessions.groupingBy { ChatListModel.statusGroup(it) }.eachCount()
                val github = isGithub(project)
                val repo = project.repoFullName?.takeIf { it.isNotBlank() }
                ProjectCard(
                    id = project.id,
                    title = if (github) repo ?: project.name else project.name.ifBlank { project.rootPath.substringAfterLast('/') },
                    github = github,
                    avatar = if (github) repo?.let(::ownerAvatar) else null,
                    machine = if (github) null else snapshot.machineNames[project.machineId] ?: project.machineId.takeIf { it.isNotBlank() },
                    machineId = project.machineId.takeIf { !github && it.isNotBlank() },
                    updatedAt = sessions.mapNotNull { ChatListModel.activityAt(it) }.maxOrNull(),
                    open = sessions.size,
                    attention = groups[StatusGroup.Attention] ?: 0,
                    running = groups[StatusGroup.Running] ?: 0,
                    finished = groups[StatusGroup.Finished] ?: 0,
                    pullRequests = groups[StatusGroup.PullRequest] ?: 0,
                ) to project
            }
            .filter { (card, _) -> !hideEmpty || card.open > 0 }
            .filter { (card, project) ->
                term.isEmpty() || listOfNotNull(card.title, project.name, project.repoFullName, project.rootPath, card.machine)
                    .any { it.contains(term, ignoreCase = true) }
            }
            .map { it.first }
            .sortedWith(compareByDescending<ProjectCard> { it.updatedAt ?: Long.MIN_VALUE }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.title })
            .toList()
    }
}

/** The Projects view menu's choices, kept with Home's other view preferences. */
object ProjectViewPrefs {
    private const val FILE = "home"
    private const val SOURCE = "projectSource"
    private const val HIDE_EMPTY = "projectHideEmpty"

    fun source(context: Context): ProjectSource {
        val stored = context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getString(SOURCE, null)
        return ProjectSource.entries.firstOrNull { it.key == stored } ?: ProjectSource.All
    }

    fun saveSource(context: Context, source: ProjectSource) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putString(SOURCE, source.key).apply()
    }

    fun hideEmpty(context: Context): Boolean =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).getBoolean(HIDE_EMPTY, false)

    fun saveHideEmpty(context: Context, hide: Boolean) {
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE).edit().putBoolean(HIDE_EMPTY, hide).apply()
    }
}
