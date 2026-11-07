package app.lody.android.chat

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import app.lody.android.runtime.MentionCandidate
import org.junit.Assert.*
import org.junit.Test

class MentionPresentationTest {
    @Test fun labelsHideIDsAndMappingStaysInBounds() {
        val input = "🙂 @session:one @role:two end"
        val presentation = MentionPresentation(listOf(
            MentionCandidate("one", "修复登录", "session", insertText = "@session:one"),
            MentionCandidate("two", "Reviewer", "role", insertText = "@role:two", emoji = "🧪"),
        ), Color.Blue).filter(AnnotatedString(input))
        assertEquals("🙂 @修复登录 🧪 Reviewer end", presentation.text.text)
        val forward = (0..input.length).map(presentation.offsetMapping::originalToTransformed)
        val reverse = (0..presentation.text.length).map(presentation.offsetMapping::transformedToOriginal)
        assertEquals(forward.sorted(), forward)
        assertEquals(reverse.sorted(), reverse)
        assertTrue(forward.all { it in 0..presentation.text.length })
        assertTrue(reverse.all { it in 0..input.length })
        assertEquals(input.length, reverse.last())
    }
    @Test fun backspaceRemovesEntireReferenceAndPreservesSurroundingText() {
        val old = androidx.compose.ui.text.input.TextFieldValue("See @session:one now")
        val next = MentionPresentation.edit(old, androidx.compose.ui.text.input.TextFieldValue("See @session:on now"))
        assertEquals("See  now", next.text)
        assertEquals(4, next.selection.start)
    }
    @Test fun codeSamplesRemainLiteral() {
        val text = "```\n@session:example\n```"
        assertEquals(text, MentionPresentation(emptyList(), Color.Blue).filter(AnnotatedString(text)).text.text)
    }
    @Test fun draftWithoutCatalogDoesNotLeakIDs() {
        val result = MentionPresentation(emptyList(), Color.Blue).filter(AnnotatedString("@session:private-id @role:private-role"))
        assertEquals("@Session 🪼 Role", result.text.text)
    }
    @Test fun insertionKeepsDistinctTokensForDuplicateNames() {
        val a = MentionCandidate("one", "Same", "session", insertText = "@session:one")
        val b = a.copy(path = "two", insertText = "@session:two")
        assertEquals(Mentions.shown(a), Mentions.shown(b))
        assertNotEquals(Mentions.token(a), Mentions.token(b))
    }
}
