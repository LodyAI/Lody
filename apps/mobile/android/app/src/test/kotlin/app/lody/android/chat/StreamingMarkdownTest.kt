package app.lody.android.chat

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class StreamingMarkdownTest {
    private val reply = """
        |## Title
        |
        |Some **bold** text.
        |
        |```kotlin
        |val a = 1
        |
        |val b = 2
        |```
        |
        || a | b |
        || - | - |
        || 1 | 2 |
        |
        |- one
        |- two
        |""".trimMargin()

    @Test
    fun splitsTopLevelBlocksAndKeepsFencesWhole() {
        val blocks = MarkdownBlockSplitter.split(reply)
        assertEquals(5, blocks.size)
        assertEquals("## Title", blocks[0])
        assertTrue(blocks[2].startsWith("```kotlin") && blocks[2].contains("val b = 2"))
        assertTrue(blocks[3].startsWith("| a | b |"))
        assertEquals("- one\n- two", blocks[4])
    }

    @Test
    fun earlierBlocksStayStableWhileTheTailGrows() {
        val full = MarkdownBlockSplitter.split(reply)
        val partial = MarkdownBlockSplitter.split(reply.substring(0, reply.indexOf("- two")))
        assertEquals(full.take(4), partial.take(4))
    }

    @Test
    fun repairsOnlyWhileStreamingAndAlwaysRendersTheFinalText() = runTest {
        val repaired = mutableListOf<String>()
        val repair = MarkdownRepair { text -> repaired += text; "$text**" }
        val dispatcher = StandardTestDispatcher(testScheduler)
        val chunks = listOf("**a", "**ab", "**abc")
        val results = flow {
            chunks.forEach { emit(MessageText(it, streaming = true)) }
            emit(MessageText("**abc**", streaming = false))
        }.renderMarkdown(repair, dispatcher = dispatcher).toList()

        val last = results.last()
        assertFalse(last.streaming)
        assertEquals(listOf("**abc**"), last.blocks)
        // Final, complete text is never repaired; streaming text is.
        assertTrue(repaired.isNotEmpty() && repaired.none { it == "**abc**" })
        assertTrue(results.dropLast(1).all { it.streaming })
    }

    @Test
    fun coalescesBurstsToFewerRenders() = runTest {
        val dispatcher = StandardTestDispatcher(testScheduler)
        val source = flow {
            repeat(100) { i -> emit(MessageText("x".repeat(i + 1), streaming = true)) }
            emit(MessageText("x".repeat(100), streaming = false))
        }
        val results = source.renderMarkdown(MarkdownRepair.None, dispatcher = dispatcher).toList()
        assertTrue("expected coalescing, got ${results.size} renders", results.size < 10)
        assertEquals("x".repeat(100), results.last().blocks.single())
    }
}
