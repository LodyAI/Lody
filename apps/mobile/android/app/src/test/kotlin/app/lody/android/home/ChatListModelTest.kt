package app.lody.android.home

import app.lody.android.runtime.CatalogProject
import app.lody.android.runtime.CatalogPullRequest
import app.lody.android.runtime.CatalogSession
import app.lody.android.runtime.CatalogSnapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset

class ChatListModelTest {
    private fun session(id: String, project: String, status: String = "idle", archived: Boolean = false, pinned: Boolean = false, at: String) =
        CatalogSession(id, "m", project, "Chat $id", status, archived, pinned, at)

    @Test fun pinnedGroupLeadsEveryViewWithoutDuplicates() {
        for (grouping in HomeGrouping.entries) {
            val sections = ChatListModel.home(snapshot, grouping)
            assertEquals("pinned", sections.first().id)
            assertEquals(listOf("5"), sections.first().chats.map { it.id })
            assertEquals(1, sections.flatMap { it.chats }.count { it.id == "5" })
        }
        val mine = snapshot.copy(sessions = snapshot.sessions.map { it.copy(userId = if (it.pinned) "other" else "me") })
        assertFalse(ChatListModel.home(mine, HomeGrouping.Time, "me").any { it.id == "pinned" })
        val family = snapshot.copy(sessions = listOf(
            session("parent", "p-zed", pinned = true, at = "2026-10-01T00:00:00Z"),
            session("child", "p-alpha", at = "2026-10-06T00:00:00Z").copy(openedBySessionId = "parent"),
        ))
        assertEquals(listOf("parent", "child"), ChatListModel.home(family, HomeGrouping.Status).single().chats.map { it.id })
    }

    @Test fun childrenAlwaysFollowParentBucketAcrossProjectsDatesAndStatuses() {
        val parent = session("parent", "p-zed", at = "2026-10-01T00:00:00Z")
        val child = session("child", "p-alpha", status = "running", at = "2026-10-06T00:00:00Z").copy(openedBySessionId = "parent")
        val tab = session("tab", "p-alpha", status = "waiting", at = "2026-10-06T00:00:00Z").copy(parentSessionId = "parent")
        val data = snapshot.copy(sessions = listOf(child, tab, parent))
        // Tabs belong to their conversation and never list (web `sessionListAtom`).
        val expected = listOf("parent", "child")
        val time = ChatListModel.timeline(data, LocalDate.parse("2026-10-06"), ZoneOffset.UTC)
        assertEquals(1, time.size)
        assertEquals(TimeBucket.Week, time.single().bucket)
        assertEquals(expected, time.single().chats.map { it.id })
        val status = ChatListModel.byStatus(data)
        assertEquals(1, status.size)
        assertEquals(HomeSection.Header.Status(StatusGroup.Idle), status.single().header)
        assertEquals(expected, status.single().chats.map { it.id })
        val projects = ChatListModel.byProject(data)
        assertEquals(1, projects.size)
        assertEquals(expected, projects.single().chats.map { it.id })
        assertEquals(listOf(null, "parent"), projects.single().chats.map { it.nestedUnder })
    }

    @Test fun idleLimitNeverCutsThroughFamily() {
        val chats = (1..21).flatMap { index -> listOf(ChatItem("p$index", "Parent", null), ChatItem("c$index", "Child", null, nestedUnder = "p$index")) }
        val section = HomeSection("idle", HomeSection.Header.Status(StatusGroup.Idle), chats)
        assertEquals(21, section.rootCount)
        assertEquals(40, section.visibleChats(false).size)
        assertEquals("c20", section.visibleChats(false).last().id)
    }

    private val snapshot = CatalogSnapshot(
        revision = 1,
        projects = listOf(
            CatalogProject("p-zed", "m", "zed", "/z"),
            CatalogProject("p-alpha", "m", "Alpha", "/a"),
            CatalogProject("p-empty", "m", "empty", "/e"),
            CatalogProject("m:unassigned", "m", "", ""),
        ),
        sessions = listOf(
            session("1", "p-zed", at = "2026-10-01T00:00:00Z"),
            session("2", "p-zed", status = "running", at = "2026-10-03T00:00:00Z"),
            session("3", "p-alpha", status = "waiting", at = "2026-10-02T00:00:00Z"),
            session("4", "p-alpha", archived = true, at = "2026-10-04T00:00:00Z"),
            session("5", "p-zed", pinned = true, at = "2026-10-05T00:00:00Z"),
            session("6", "m:unassigned", status = "error", at = "2026-10-06T00:00:00Z"),
        ),
        machineIds = listOf("m"),
    )

    @Test
    fun groupsPinnedFirstProjectsByNameChatsLastAndHidesArchivedAndEmpty() {
        val groups = ChatListModel.groups(snapshot)
        assertEquals(listOf("pinned", "p-alpha", "p-zed", "chats"), groups.map { it.id })
        assertEquals(listOf("5"), groups[0].chats.map { it.id })
        assertEquals(listOf("3"), groups[1].chats.map { it.id })
        // Newest first within a group.
        assertEquals(listOf("2", "1"), groups[2].chats.map { it.id })
    }

    @Test
    fun mapsStatusesToAttentionAndRanksWaitingAboveRunning() {
        val groups = ChatListModel.groups(snapshot).associateBy { it.id }
        assertEquals(ChatAttention.Running, groups.getValue("p-zed").chats.first().attention)
        assertNull(groups.getValue("p-zed").chats.last().attention)
        assertEquals(ChatAttention.Failed, groups.getValue("chats").chats.single().attention)
        val mixed = ChatGroup("x", "x", ChatGroup.Kind.Project, listOf(ChatItem("u", "u", ChatAttention.Unread), ChatItem("a", "a", ChatAttention.Running), ChatItem("b", "b", ChatAttention.Waiting)))
        assertEquals(ChatAttention.Waiting, mixed.mostUrgent)
        val failed = mixed.copy(chats = mixed.chats + ChatItem("c", "c", ChatAttention.Failed))
        assertEquals(ChatAttention.Failed, failed.mostUrgent)
    }

    @Test
    fun searchKeepsOnlyMatchingChatsAndDropsEmptyGroups() {
        val groups = ChatListModel.groups(snapshot)
        val result = ChatListModel.search(groups, " chat 3 ")
        assertEquals(listOf("p-alpha"), result.map { it.id })
        assertEquals(groups, ChatListModel.search(groups, "  "))
    }

    @Test
    fun timelineBucketsByDayNewestFirstWithProjectNames() {
        val today = LocalDate.parse("2026-10-06")
        val sections = ChatListModel.timeline(snapshot, today, ZoneOffset.UTC)
        assertEquals(listOf(TimeBucket.Today, TimeBucket.Yesterday, TimeBucket.Week), sections.map { it.bucket })
        assertEquals(listOf("6"), sections[0].chats.map { it.id })
        assertEquals("", sections[0].chats.single().place)
        assertEquals(listOf("5"), sections[1].chats.map { it.id })
        // Archived #4 is hidden; the rest are newest first and carry their project.
        assertEquals(listOf("2", "3", "1"), sections[2].chats.map { it.id })
        assertEquals(listOf("zed", "Alpha", "zed"), sections[2].chats.map { it.place })
    }

    @Test
    fun bucketBoundariesAndUnparseableDates() {
        val today = LocalDate.parse("2026-10-31")
        fun bucket(at: String) = ChatListModel.bucket(at, today, ZoneOffset.UTC)
        assertEquals(TimeBucket.Today, bucket("2026-10-31T23:59:00Z"))
        assertEquals(TimeBucket.Yesterday, bucket("2026-10-30T00:00:00Z"))
        assertEquals(TimeBucket.Week, bucket("2026-10-24T12:00:00Z"))
        assertEquals(TimeBucket.Month, bucket("2026-10-01T12:00:00Z"))
        assertEquals(TimeBucket.Older, bucket("2026-09-01T12:00:00Z"))
        assertEquals(TimeBucket.Older, bucket("not a date"))
    }

    @Test
    fun timelineSearchMatchesTitleOrProject() {
        val sections = ChatListModel.timeline(snapshot, LocalDate.parse("2026-10-06"), ZoneOffset.UTC)
        assertEquals(listOf("3"), ChatListModel.searchTimeline(sections, "alpha").flatMap { section -> section.chats.map { it.id } })
        assertEquals(listOf("6"), ChatListModel.searchTimeline(sections, "chat 6").flatMap { section -> section.chats.map { it.id } })
    }

    @Test
    fun attentionFollowsWebPriority() {
        val base = session("a", "p-zed", at = "2026-10-01T00:00:00Z")
        assertNull(ChatListModel.attention(base))
        // A reply the user has not read yet; no read mark at all counts as unread.
        assertEquals(ChatAttention.Unread, ChatListModel.attention(base.copy(lastMessageAt = 20, lastReadAt = 10)))
        assertEquals(ChatAttention.Unread, ChatListModel.attention(base.copy(lastMessageAt = 20)))
        assertNull(ChatListModel.attention(base.copy(lastMessageAt = 20, lastReadAt = 20)))
        // An open question outranks unread, but a running turn still shows as working.
        assertEquals(ChatAttention.Waiting, ChatListModel.attention(base.copy(lastMessageAt = 20, awaitingUserSince = 15)))
        assertEquals(ChatAttention.Running, ChatListModel.attention(base.copy(status = "running", awaitingUserSince = 15)))
        assertEquals(ChatAttention.Failed, ChatListModel.attention(base.copy(status = "error", awaitingUserSince = 15)))
    }

    @Test
    fun rowsCarryActivityBranchLatestPrAndRepoPlace() {
        val activity = Instant.parse("2026-10-06T08:00:00Z").toEpochMilli()
        val withRepo = snapshot.copy(
            projects = snapshot.projects.map { if (it.id == "p-alpha") it.copy(repoFullName = "lody/alpha") else it },
            sessions = snapshot.sessions.map {
                if (it.id != "3") it else it.copy(
                    lastMessageAt = activity,
                    lastReadAt = activity,
                    branchName = "feat/rows",
                    pullRequests = listOf(CatalogPullRequest("lody/alpha", 1, "closed"), CatalogPullRequest("lody/alpha", 2, "merged")),
                )
            },
        )
        val sections = ChatListModel.timeline(withRepo, LocalDate.parse("2026-10-06"), ZoneOffset.UTC)
        // The last message moves #3 into today, ahead of #6 (created at midnight).
        assertEquals(listOf("3", "6"), sections[0].chats.map { it.id })
        val row = sections[0].chats[0]
        assertEquals(activity, row.activityAt)
        assertEquals("Alpha", row.place)
        assertEquals("lody/alpha", row.repository)
        assertTrue(row.placeIsRepo)
        assertEquals("feat/rows", row.branch)
        assertEquals("merged", row.prStatus)
        assertFalse(sections[2].chats.first { it.id == "2" }.placeIsRepo)
    }

    @Test
    fun compactAgeUnits() {
        val now = Instant.parse("2026-10-31T12:00:00Z").toEpochMilli()
        fun age(seconds: Long) = ChatListModel.age(now - seconds * 1000, now, ZoneOffset.UTC)
        assertEquals(ChatListModel.Age.Now, age(59))
        assertEquals(ChatListModel.Age.Minutes(5), age(5 * 60))
        assertEquals(ChatListModel.Age.Hours(23), age(23 * 3600 + 59 * 60))
        assertEquals(ChatListModel.Age.Days(6), age(6 * 86400))
        assertEquals(ChatListModel.Age.Date(LocalDate.parse("2026-10-24")), age(7 * 86400))
    }

    @Test
    fun statusGroupsFollowWebHomeNowOrder() {
        val base = session("a", "p-zed", at = "2026-10-01T00:00:00Z")
        fun pr(status: String, ci: String? = null) = listOf(CatalogPullRequest("lody/zed", 1, status, ci))
        fun group(session: CatalogSession) = ChatListModel.statusGroup(session)
        assertEquals(StatusGroup.Idle, group(base))
        assertEquals(StatusGroup.Attention, group(base.copy(status = "error")))
        assertEquals(StatusGroup.Attention, group(base.copy(awaitingUserSince = 1)))
        // Running wins over unread and over red CI: it may be fixing exactly that.
        assertEquals(StatusGroup.Running, group(base.copy(status = "running", lastMessageAt = 5, pullRequests = pr("open", "f"))))
        // Red CI outranks unread; a draft only after unread.
        assertEquals(StatusGroup.Attention, group(base.copy(lastMessageAt = 5, pullRequests = pr("open", "e"))))
        assertEquals(StatusGroup.Finished, group(base.copy(lastMessageAt = 5, pullRequests = pr("draft"))))
        assertEquals(StatusGroup.Attention, group(base.copy(pullRequests = pr("draft"))))
        assertEquals(StatusGroup.PullRequest, group(base.copy(pullRequests = pr("open", "p"))))
        // A merged or closed PR is done, so the chat is idle.
        assertEquals(StatusGroup.Idle, group(base.copy(pullRequests = pr("merged", "f"))))
    }

    @Test
    fun byStatusOrdersGroupsByUrgency() {
        val sections = ChatListModel.byStatus(snapshot)
        assertEquals(
            listOf(HomeSection.Header.Status(StatusGroup.Attention), HomeSection.Header.Status(StatusGroup.Running), HomeSection.Header.Status(StatusGroup.Idle)),
            sections.map { it.header },
        )
        assertEquals(listOf("6", "3"), sections[0].chats.map { it.id })
        assertEquals(listOf("5", "1"), sections[2].chats.map { it.id })
    }

    @Test
    fun byProjectOrdersByLatestActivityWithChatsAsAGroup() {
        val sections = ChatListModel.byProject(snapshot)
        assertEquals(listOf(HomeSection.Header.Chats, HomeSection.Header.Project("zed"), HomeSection.Header.Project("Alpha")), sections.map { it.header })
        assertEquals(listOf("5", "2", "1"), sections[1].chats.map { it.id })
    }

    @Test
    fun ciLettersMatchWeb() {
        assertEquals(listOf("pass", "fail", "fail", "pending", "expected", ""), listOf("s", "f", "e", "p", "x", null).map(ChatListModel::ci))
    }

    @Test
    fun myTasksKeepOnlyTheOwnersChats() {
        val owned = snapshot.copy(sessions = snapshot.sessions.map { if (it.id in setOf("2", "6")) it.copy(userId = "me") else it.copy(userId = "teammate") })
        fun ids(owner: String?) = ChatListModel.home(owned, HomeGrouping.Time, owner, LocalDate.parse("2026-10-06"), ZoneOffset.UTC).flatMap { section -> section.chats.map { it.id } }
        assertEquals(listOf("6", "2"), ids("me"))
        assertEquals(listOf("5", "6", "2", "3", "1"), ids(null))
        val team = ChatListModel.home(owned, HomeGrouping.Time).flatMap { it.chats }
        team.forEach { chat -> assertEquals(owned.sessions.first { it.id == chat.id }.userId, chat.ownerId) }
        // Chats without an owner (older caches) are not anyone's.
        assertEquals(emptyList<String>(), ids("nobody"))
    }

    @Test
    fun nestsOpenedChatsUnderTheirRootOpenerInTheSameGroup() {
        val opened = snapshot.copy(
            sessions = snapshot.sessions.map {
                when (it.id) {
                    // #2 opened #1 and #5; #5's opener is a Tab of #2, which resolves to #2.
                    "1" -> it.copy(openedBySessionId = "2")
                    "5" -> it.copy(openedBySessionId = "t", openedByRootSessionId = "t")
                    else -> it
                }
            } + CatalogSession("t", "m", "p-zed", "Tab", "idle", false, false, "2026-09-01T00:00:00Z", parentSessionId = "2"),
        )
        val zed = ChatListModel.byProject(opened).first { it.header == HomeSection.Header.Project("zed") }.chats
        // The family takes its freshest member's (#5) place; the Tab itself never lists.
        assertEquals(listOf("2", "5", "1"), zed.map { it.id })
        assertEquals(listOf(null, "2", "2"), zed.map { it.nestedUnder })
        assertEquals(listOf(false, false, true), zed.map { it.lastChild })
        // Children drop a project that repeats their opener's.
        assertEquals(listOf("zed", "", ""), zed.map { it.place })
        assertTrue(zed[0].treeParent)
        assertEquals(listOf(2, 0, 0), zed.map { it.childCount })
        // A child from a different project follows its parent and retains its project label.
        val other = opened.copy(sessions = opened.sessions.map { if (it.id == "3") it.copy(openedBySessionId = "2") else it })
        val crossProject = ChatListModel.byProject(other).first { it.header == HomeSection.Header.Project("zed") }.chats.first { it.id == "3" }
        assertEquals("2", crossProject.nestedUnder)
        assertEquals("Alpha", crossProject.place)
    }

    @Test
    fun foldingKeepsParentStatusSeparateFromChildStatus() {
        val chats = listOf(
            ChatItem("p", "p", null, treeParent = true),
            ChatItem("a", "a", ChatAttention.Running, nestedUnder = "p"),
            ChatItem("b", "b", ChatAttention.Waiting, nestedUnder = "p", lastChild = true),
            ChatItem("q", "q", null),
        )
        assertEquals(chats, ChatListModel.fold(chats, emptySet()))
        val folded = ChatListModel.fold(chats, setOf("p"))
        assertEquals(listOf("p", "q"), folded.map { it.id })
        assertEquals(null, folded[0].attention)
        assertEquals(ChatAttention.Waiting, folded[0].childAttention)
        val runningParent = chats.map { if (it.id == "p") it.copy(attention = ChatAttention.Failed) else it }
        val separate = ChatListModel.fold(runningParent, setOf("p"))[0]
        assertEquals(ChatAttention.Failed, separate.attention)
        assertEquals(ChatAttention.Waiting, separate.childAttention)
    }
}
