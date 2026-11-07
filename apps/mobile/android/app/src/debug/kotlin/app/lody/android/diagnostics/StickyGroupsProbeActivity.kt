package app.lody.android.diagnostics

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import app.lody.android.chat.ChatHeader
import androidx.compose.material3.Surface
import app.lody.android.designsystem.LodySize
import app.lody.android.designsystem.LodyTheme
import app.lody.android.home.ChatAttention
import app.lody.android.home.ChatRowDetail
import app.lody.android.home.ChatItem
import app.lody.android.home.HomeList
import app.lody.android.home.HomeSection

/** Offline production-list fixture; does not touch login, workspace, or preferences. */
class StickyGroupsProbeActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val listReview = intent.getBooleanExtra("list-review", false)
        val sections = if (intent.getBooleanExtra("pins-review", false)) {
            app.lody.android.home.ChatListModel.home(app.lody.android.runtime.CatalogSnapshot(
                revision = 1, projects = emptyList(), machineIds = emptyList(), sessions = listOf(
                    app.lody.android.runtime.CatalogSession("pinned", "m", "p", "Pinned conversation", "running", false, true, "2026-11-07T00:00:00Z"),
                    app.lody.android.runtime.CatalogSession("regular", "m", "p", "Other conversation", "idle", false, false, "2026-11-07T00:00:00Z"),
                ),
            ), app.lody.android.home.HomeGrouping.Status)
        } else if (listReview) listOf(HomeSection("list-review", HomeSection.Header.Bucket(app.lody.android.home.TimeBucket.Today), listOf(
            ChatItem("list-review-unread", "Lody E2E improvements", ChatAttention.Unread, place = "Lody", prStatus = "merged", activityAt = System.currentTimeMillis() - 3_600_000),
            ChatItem("list-review-parent", "Local-first attachments", ChatAttention.Running, place = "Lody", prStatus = "open", prCi = "s", activityAt = System.currentTimeMillis() - 3_600_000, treeParent = true, childCount = 3, childAttention = ChatAttention.Waiting),
            ChatItem("list-review-child-idle", "Review attachments PR", null, prStatus = "merged", activityAt = System.currentTimeMillis() - 3_600_000, nestedUnder = "list-review-parent"),
            ChatItem("list-review-child-waiting", "Confirm storage changes", ChatAttention.Waiting, place = "Loro", prStatus = "open", prCi = "s", activityAt = System.currentTimeMillis() - 3_600_000, nestedUnder = "list-review-parent"),
            ChatItem("list-review-child-failed", "Retry integration tests", ChatAttention.Failed, activityAt = System.currentTimeMillis() - 3_600_000, nestedUnder = "list-review-parent", lastChild = true),
            ChatItem("list-review-idle", "Native session synchronization", null, place = "Lody", prStatus = "open", prCi = "s", activityAt = System.currentTimeMillis() - 3_600_000),
            ChatItem("list-review-plain", "A conversation without extra details", null, activityAt = System.currentTimeMillis() - 3_600_000),
        ))) else listOf("Alpha project", "Beta project", "Gamma project").mapIndexed { group, name ->
            HomeSection("group-$group", HomeSection.Header.Project(name), (1..18).map { row ->
                ChatItem("$group-$row", "Conversation ${group + 1}.$row", null)
            })
        }
        setContent {
            LodyTheme {
                Surface(color = LodyTheme.colors.bgBase) {
                    if (intent.getBooleanExtra("pr-review", false)) {
                        Column(Modifier.fillMaxSize().padding(24.dp), verticalArrangement = Arrangement.spacedBy(28.dp)) {
                            Text("PR / CI · Web parity")
                            Text("None · Pass · Fail · Running · Expected")
                            listOf("open", "draft", "merged", "closed").forEach { status ->
                                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                    Text(status)
                                    Row(horizontalArrangement = Arrangement.spacedBy(36.dp)) {
                                        listOf("", "s", "f", "p", "x").forEach { ci ->
                                            app.lody.android.designsystem.LodyPullRequestIcon(status, ci, size = 24.dp)
                                        }
                                    }
                                }
                            }
                        }
                    } else if (intent.getBooleanExtra("context-review", false)) {
                        Box(Modifier.fillMaxSize().padding(16.dp)) {
                            Box(Modifier.align(Alignment.BottomCenter).padding(bottom = 48.dp)) {
                                app.lody.android.chat.ChatActionBar(
                                    app.lody.android.chat.SessionInfoBar("loro-dev/lody", "investigate-billing-cycle",
                                        app.lody.android.runtime.CatalogPullRequest("loro-dev/lody", 4223, "open"), 3338, 249,
                                        listOf(app.lody.android.chat.SessionInfoBar.Action.CommitAndPush)),
                                    "Mac", app.lody.android.create.CreateSessionModel.MachineKind.Desktop, {}, {},
                                )
                            }
                        }
                    } else if (intent.getBooleanExtra("tabs-review", false)) {
                        val tabs = listOf(
                            app.lody.android.runtime.CatalogSession("current", "machine", "project", "当前工作目录对话", "idle", false, false, "2026-11-06"),
                            app.lody.android.runtime.CatalogSession("other", "machine", "project", "检查附件上传", "running", false, false, "2026-11-06"),
                        )
                        Box(Modifier.fillMaxSize()) { ChatHeader(tabs[0].title, tabs, emptyList(), "current", false, null, {}, {}, {}, { _, _ -> }) }
                    } else HomeList(sections.map { it.copy(chats = it.chats.map { chat -> chat.copy(ownerId = "") }) }, if (listReview) setOf(ChatRowDetail.Project, ChatRowDetail.PullRequest) else emptySet(), PaddingValues(top = LodySize.controlLg), empty = null,
                        owners = if (intent.getBooleanExtra("owners", false)) mapOf("" to app.lody.android.auth.WorkspaceMember("", "Leon")) else null,
                        pinsLabels = !intent.getBooleanExtra("search", false), onOpenChat = {})
                }
            }
        }
    }
}
