package app.lody.android.chat

import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.withLink
import androidx.compose.ui.unit.em
import app.lody.android.designsystem.LodyIcons
import app.lody.android.designsystem.LodyTheme
import com.mikepenz.markdown.model.MarkdownAnnotator
import com.mikepenz.markdown.model.MarkdownInlineContent
import com.mikepenz.markdown.model.markdownAnnotator
import com.mikepenz.markdown.model.markdownInlineContent
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.ast.findChildOfType
import org.intellij.markdown.ast.getTextInNode

/**
 * A Markdown link that names a file on the session's computer (iOS `ChatFileLink`, web
 * `parseMarkdownAgentFileHref`): a relative or absolute path, optionally with a line anchor
 * (`#L12`, `#L12-L20`, `:L12`, `:12`, `:12:3`). Web links, other schemes, protocol-relative
 * links, fragments and queries are not file links.
 */
internal data class ChatFileLink(val path: String, val line: Int?) {
    val isMarkdown: Boolean get() = ProjectFiles.isMarkdown(path)
    val name: String get() = path.trimEnd('/').substringAfterLast('/')

    companion object {
        private val lineSuffix =
            Regex("""(?:#L([1-9][0-9]*)(?:C[0-9]+)?(?:-L?[0-9]+(?:C[0-9]+)?)?|:L([1-9][0-9]*)(?:C[0-9]+)?|:([1-9][0-9]*)(?::[0-9]+)?)$""")
        private val windowsDrive = Regex("^[A-Za-z]:/")
        private val scheme = Regex("^[A-Za-z][A-Za-z0-9+.-]*:")

        private val bareDomainTlds = setOf("com", "org", "net", "io", "dev", "app", "co", "ai", "gov", "edu", "info")

        /**
         * Web `matchWholeFilePath` for inline code, narrowed to Markdown, the only type the native
         * preview opens: the whole span must be one file path. Native clients have no session file
         * index to confirm relative paths, so a missing file shows the preview's not-found state.
         */
        fun markdownCode(code: String): String? {
            val value = code.trim()
            if (value.isEmpty() || value.any { it.isWhitespace() }) return null
            val link = parse(value)?.takeIf { it.isMarkdown } ?: return null
            // `example.com/readme.md` is an unschemed URL, not a file.
            val first = link.path.substringBefore('/')
            if ('/' in link.path && '.' in first && first.substringAfterLast('.').lowercase() in bareDomainTlds) return null
            return value
        }

        fun parse(href: String): ChatFileLink? {
            var value = href.trim().replace('\\', '/')
            var line: Int? = null
            lineSuffix.find(value)?.let { match ->
                line = match.groupValues.drop(1).firstOrNull { it.isNotEmpty() }?.toIntOrNull()
                value = value.substring(0, match.range.first)
            }
            val windows = windowsDrive.containsMatchIn(value)
            if (value.isEmpty() || value.startsWith("#") || value.startsWith("//")) return null
            if (!windows && scheme.containsMatchIn(value)) return null
            if ('?' in value || '#' in value) return null
            val name = value.substringAfterLast('/')
            val hasExtension = name.lastIndexOf('.') > 0 && !name.endsWith('.')
            if ('/' !in value && !hasExtension) return null
            value = try { java.net.URLDecoder.decode(value.replace("+", "%2B"), "UTF-8") } catch (_: IllegalArgumentException) { value }
            if ('\u0000' in value || value.toByteArray(Charsets.UTF_8).size > 32_768) return null
            return ChatFileLink(value, line)
        }
    }
}

private const val FILE_ICON = "lody-file-link-icon"

private fun ASTNode.insideLink(): Boolean = generateSequence(parent) { it.parent }.any {
    it.type == MarkdownElementTypes.INLINE_LINK || it.type == MarkdownElementTypes.FULL_REFERENCE_LINK || it.type == MarkdownElementTypes.SHORT_REFERENCE_LINK
}

/**
 * Transcript Markdown draws a file link like web `AgentFileLink`: a file glyph and the link
 * text as plain link-coloured prose (an inline-code label loses its code chrome), both inside
 * one link whose URL is the authored destination, so the surrounding `UriHandler` opens it.
 */
@Composable
internal fun rememberFileLinkMarkdown(): Pair<MarkdownAnnotator, MarkdownInlineContent> {
    val colors = LodyTheme.colors
    return remember(colors.textLink) {
        val style = TextLinkStyles(style = SpanStyle(color = colors.textLink))
        val annotator = markdownAnnotator { content, child ->
            // Inline code that is exactly one Markdown file path reads as a file link, as on Web;
            // inside an authored link it stays that link's label.
            if (child.type == MarkdownElementTypes.CODE_SPAN && !child.insideLink()) {
                val code = child.getTextInNode(content).toString().trim('`')
                val path = ChatFileLink.markdownCode(code) ?: return@markdownAnnotator false
                withLink(LinkAnnotation.Url(path, style)) {
                    appendInlineContent(FILE_ICON, "\uD83D\uDCC4")
                    append(" ")
                    append(code.trim())
                }
                return@markdownAnnotator true
            }
            if (child.type != MarkdownElementTypes.INLINE_LINK) return@markdownAnnotator false
            val destination = child.findChildOfType(MarkdownElementTypes.LINK_DESTINATION)?.getTextInNode(content)?.toString()
                ?.removePrefix("<")?.removeSuffix(">") ?: return@markdownAnnotator false
            val target = ChatFileLink.parse(destination) ?: return@markdownAnnotator false
            val label = child.findChildOfType(MarkdownElementTypes.LINK_TEXT)?.getTextInNode(content)?.toString()
                ?.removePrefix("[")?.removeSuffix("]")?.replace("`", "")?.trim()
                .orEmpty().ifEmpty { target.name }
            withLink(LinkAnnotation.Url(destination, style)) {
                appendInlineContent(FILE_ICON, "\uD83D\uDCC4")
                append(" ")
                append(label)
            }
            true
        }
        val icon = InlineTextContent(Placeholder(1.1.em, 1.em, PlaceholderVerticalAlign.TextCenter)) {
            Icon(LodyIcons.File, contentDescription = null, tint = colors.textLink, modifier = Modifier.fillMaxSize())
        }
        annotator to markdownInlineContent(mapOf(FILE_ICON to icon))
    }
}
