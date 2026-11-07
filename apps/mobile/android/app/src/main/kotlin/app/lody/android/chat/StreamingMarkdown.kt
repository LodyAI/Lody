package app.lody.android.chat

import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.transform
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.flavours.gfm.GFMFlavourDescriptor
import org.intellij.markdown.parser.MarkdownParser

/** One message's text as it arrives; `streaming` is false once the reply completes. */
data class MessageText(val text: String, val streaming: Boolean)

/**
 * A message split into top-level Markdown blocks. Blocks are rendered as separate list
 * items, so while a reply streams only the growing tail block re-renders (iOS
 * `ChatMarkdownStore` reuses unchanged blocks the same way).
 */
data class MarkdownBlocks(
    val blocks: List<String>,
    val streaming: Boolean,
    val repairMicros: Long = 0,
    val splitMicros: Long = 0,
)

object MarkdownBlockSplitter {
    private val flavour = GFMFlavourDescriptor()
    private val separators = setOf(MarkdownTokenTypes.EOL, MarkdownTokenTypes.WHITE_SPACE)

    /**
     * Top-level blocks in source order. Link reference definitions stay their own block,
     * so references across blocks do not resolve; agent replies rarely use them.
     */
    fun split(text: String): List<String> {
        if (text.isBlank()) return emptyList()
        val tree = MarkdownParser(flavour).buildMarkdownTreeFromString(text)
        return tree.children
            .filter { it.type !in separators }
            .map { text.substring(it.startOffset, it.endOffset) }
            .filter { it.isNotBlank() }
    }
}

/**
 * The streaming pipeline: coalesce chunks to at most one render per [frame] (the latest
 * text always renders, including the final one), repair only while streaming, then split
 * into blocks off the main thread.
 */
fun Flow<MessageText>.renderMarkdown(
    repair: MarkdownRepair,
    frame: Duration = 33.milliseconds,
    dispatcher: CoroutineDispatcher = Dispatchers.Default,
): Flow<MarkdownBlocks> = conflate()
    .transform { value ->
        emit(value)
        if (value.streaming) delay(frame)
    }
    .map { message ->
        val repairStart = System.nanoTime()
        val source = if (message.streaming) repair.repair(message.text) else message.text
        val splitStart = System.nanoTime()
        val blocks = MarkdownBlockSplitter.split(source)
        val end = System.nanoTime()
        MarkdownBlocks(
            blocks = blocks,
            streaming = message.streaming,
            repairMicros = (splitStart - repairStart) / 1_000,
            splitMicros = (end - splitStart) / 1_000,
        )
    }
    .flowOn(dispatcher)
