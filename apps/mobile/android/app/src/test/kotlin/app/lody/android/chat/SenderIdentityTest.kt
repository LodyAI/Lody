package app.lody.android.chat

import app.lody.android.auth.Account
import app.lody.android.auth.WorkspaceMember
import org.junit.Assert.assertEquals
import org.junit.Test

class SenderIdentityTest {
    @Test fun resolvedMemberReplacesFallbackWithoutChangingTimestamp() {
        assertEquals(TurnIdentity("Member", time = "18:36"), senderIdentity("other", null, null, "Member", "18:36"))
        val member = WorkspaceMember("other", "Alice", "https://example.com/avatar.png")
        assertEquals(TurnIdentity("Alice", member.image, "18:36"), senderIdentity("other", null, member, "Member", "18:36"))
    }
    @Test fun workspaceMemberRefreshReplacesLoginSnapshot() {
        val me = Account("me", "Current", emptyList(), "https://example.com/current.png")
        val fresh = WorkspaceMember("me", "Updated", "https://example.com/updated.png")
        assertEquals(TurnIdentity(fresh.name, fresh.image, "now"), senderIdentity("me", me, fresh, "Member", "now"))
        assertEquals(TurnIdentity(fresh.name, fresh.image, "now"), senderIdentity(null, me, fresh, "Member", "now"))
        assertEquals(TurnIdentity("Member", time = "now"), senderIdentity("different", me, fresh, "Member", "now"))
    }
}
