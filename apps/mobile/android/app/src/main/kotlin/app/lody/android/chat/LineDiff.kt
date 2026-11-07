package app.lody.android.chat

/**
 * A line diff for the diff page, pure. Common leading and trailing lines are trimmed, the middle
 * gets a longest-common-subsequence diff, and unchanged runs collapse to [context] lines around
 * each change, so a page shows hunks rather than the whole file. A middle larger than [limit] cells
 * reports [Result.tooLarge] instead of spending the phone's memory.
 */
object LineDiff {
    enum class Kind { Context, Added, Removed }

    /** One shown line; numbers are 1-based in the old / new file (null on the side it is absent from). */
    data class Line(val kind: Kind, val text: String, val oldNumber: Int?, val newNumber: Int?)

    /** A run of shown lines; [skippedBefore] unchanged lines were folded away above it. */
    data class Hunk(val lines: List<Line>, val skippedBefore: Int)

    data class Result(val hunks: List<Hunk>, val skippedAfter: Int, val tooLarge: Boolean = false)

    fun compute(old: String, new: String, context: Int = 3, limit: Long = 4_000_000): Result {
        val a = lines(old)
        val b = lines(new)
        var prefix = 0
        while (prefix < a.size && prefix < b.size && a[prefix] == b[prefix]) prefix++
        var suffix = 0
        while (suffix < a.size - prefix && suffix < b.size - prefix && a[a.size - 1 - suffix] == b[b.size - 1 - suffix]) suffix++
        val midA = a.subList(prefix, a.size - suffix)
        val midB = b.subList(prefix, b.size - suffix)
        if (midA.size.toLong() * midB.size > limit) return Result(emptyList(), 0, tooLarge = true)

        val all = ArrayList<Line>(a.size + b.size)
        for (i in 0 until prefix) all += Line(Kind.Context, a[i], i + 1, i + 1)
        all += middle(midA, midB, prefix)
        for (k in 0 until suffix) {
            val i = a.size - suffix + k
            val j = b.size - suffix + k
            all += Line(Kind.Context, a[i], i + 1, j + 1)
        }
        return hunks(all, context)
    }

    private fun lines(text: String): List<String> = if (text.isEmpty()) emptyList() else text.removeSuffix("\n").split("\n")

    /** LCS over the trimmed middle; removals before additions where both change. */
    private fun middle(a: List<String>, b: List<String>, offset: Int): List<Line> {
        val n = a.size
        val m = b.size
        val table = Array(n + 1) { IntArray(m + 1) }
        for (i in n - 1 downTo 0) for (j in m - 1 downTo 0) {
            table[i][j] = if (a[i] == b[j]) table[i + 1][j + 1] + 1 else maxOf(table[i + 1][j], table[i][j + 1])
        }
        val out = ArrayList<Line>(n + m)
        var i = 0
        var j = 0
        while (i < n || j < m) {
            when {
                i < n && j < m && a[i] == b[j] -> { out += Line(Kind.Context, a[i], offset + i + 1, offset + j + 1); i++; j++ }
                j >= m || (i < n && table[i + 1][j] >= table[i][j + 1]) -> { out += Line(Kind.Removed, a[i], offset + i + 1, null); i++ }
                else -> { out += Line(Kind.Added, b[j], null, offset + j + 1); j++ }
            }
        }
        return out
    }

    private fun hunks(all: List<Line>, context: Int): Result {
        val changed = all.indices.filter { all[it].kind != Kind.Context }
        if (changed.isEmpty()) return Result(emptyList(), all.size)
        val keep = BooleanArray(all.size)
        for (index in changed) for (k in maxOf(0, index - context)..minOf(all.lastIndex, index + context)) keep[k] = true
        val hunks = ArrayList<Hunk>()
        var skipped = 0
        var current = ArrayList<Line>()
        for (index in all.indices) {
            if (keep[index]) {
                current += all[index]
            } else {
                if (current.isNotEmpty()) { hunks += Hunk(current, skipped); current = ArrayList(); skipped = 0 }
                skipped++
            }
        }
        if (current.isNotEmpty()) { hunks += Hunk(current, skipped); skipped = 0 }
        return Result(hunks, skipped)
    }
}
