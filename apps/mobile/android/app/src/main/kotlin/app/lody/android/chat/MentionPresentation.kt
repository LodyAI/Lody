package app.lody.android.chat

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.input.OffsetMapping
import androidx.compose.ui.text.input.TransformedText
import androidx.compose.ui.text.input.VisualTransformation
import app.lody.android.runtime.MentionCandidate

/** Keep wire tokens in drafts; only their visual representation changes. */
internal class MentionPresentation(items: List<MentionCandidate>, private val color: Color) : VisualTransformation {
    private val labels = items.associate { Mentions.token(it) to Mentions.shown(it) }
    override fun filter(text: AnnotatedString): TransformedText {
        val code = Regex("```[\\s\\S]*?(?:```|$)|`+[^`\\n]*`+").findAll(text.text).map { it.range }.toList()
        val replacements = referenceTokens.findAll(text.text).filter { match -> code.none { match.range.first <= it.last && match.range.last >= it.first } }.map { match ->
            val token = match.value
            Triple(match.range.first, match.range.last + 1, labels[token] ?: when {
                token.startsWith("@session:") -> "@Session"
                token.startsWith("@role:") -> "🪼 Role"
                else -> token
            })
        }.toList()
        val output = AnnotatedString.Builder()
        val ranges = mutableListOf<IntArray>()
        var cursor = 0
        replacements.forEach { (start, end, label) ->
            output.append(text.subSequence(cursor, start))
            val shownStart = output.length
            output.pushStyle(SpanStyle(color = color)); output.append(label); output.pop()
            ranges += intArrayOf(start, end, shownStart, output.length)
            cursor = end
        }
        output.append(text.subSequence(cursor, text.length))
        fun map(offset: Int, reverse: Boolean): Int {
            var delta = 0
            for (range in ranges) {
                val a = range[if (reverse) 2 else 0]; val b = range[if (reverse) 3 else 1]
                val c = range[if (reverse) 0 else 2]; val d = range[if (reverse) 1 else 3]
                if (offset < a) break
                if (offset <= b) return if (offset == a) c else if (offset == b) d else c + ((offset - a).toLong() * (d - c) / (b - a)).toInt()
                delta = d - b
            }
            return offset + delta
        }
        return TransformedText(output.toAnnotatedString(), object : OffsetMapping {
            override fun originalToTransformed(offset: Int) = map(offset, false)
            override fun transformedToOriginal(offset: Int) = map(offset, true)
        })
    }
    companion object {
        /** A deletion through a displayed label removes its entire underlying reference. */
        fun edit(previous: androidx.compose.ui.text.input.TextFieldValue, next: androidx.compose.ui.text.input.TextFieldValue): androidx.compose.ui.text.input.TextFieldValue {
            if (next.text.length >= previous.text.length) return next
            val prefix = previous.text.commonPrefixWith(next.text).length
            val suffix = previous.text.drop(prefix).commonSuffixWith(next.text.drop(prefix)).length
            val removedEnd = previous.text.length - suffix
            val touched = referenceTokens.findAll(previous.text).filter { it.value.startsWith("@session:") || it.value.startsWith("@role:") }
                .filter { it.range.first < removedEnd && it.range.last + 1 > prefix }.toList()
            if (touched.isEmpty()) return next
            val start = minOf(prefix, touched.first().range.first)
            val end = maxOf(removedEnd, touched.last().range.last + 1)
            val inserted = next.text.substring(prefix, next.text.length - suffix)
            return androidx.compose.ui.text.input.TextFieldValue(previous.text.replaceRange(start, end, inserted), androidx.compose.ui.text.TextRange(start + inserted.length))
        }

        private val referenceTokens = Regex("(?<!\\S)(?:@session:[^\\s@]+|@role:[^\\s@]+(?:@[^\\s@]+)?|@\"(?:\\\\.|[^\"\\\\])*\"|@[^\\s]+|\\$[^\\s]+|#[0-9]+)")
    }
}
