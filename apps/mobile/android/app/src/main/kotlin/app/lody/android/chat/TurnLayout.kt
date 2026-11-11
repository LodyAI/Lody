package app.lody.android.chat

import app.lody.android.runtime.TurnItem

/**
 * Web's assistant turn layout (`assistant-turn-render-blocks.ts`, `message-copy.ts`), pure:
 *
 * - Consecutive thought / tool steps form one activity group; its header summarizes it ("Ran 3
 *   commands · Read 2 files"). Only builtin DSH shows thoughts ([showThoughts]); then thought runs
 *   and tool runs are separate groups, both closed by default. Other providers
 *   hide thoughts, and `think` tool steps are never shown.
 * - A streaming turn stays expanded. A finished turn keeps its answer — the final contiguous text
 *   run before the never-folded tail (plans, checklists, notices) — and folds the earlier work
 *   under one "Worked for …" row, but only when such an answer exists: a cancelled or tool-only
 *   turn stays expanded.
 */
object TurnLayout {
    sealed interface Block { val key: String }

    data class Content(override val key: String, val item: TurnItem) : Block

    data class Activity(override val key: String, val items: List<TurnItem>, val summary: Summary) : Block

    data class Summary(
        val thought: Boolean = false,
        val commands: Int = 0,
        val reads: Int = 0,
        val edits: Int = 0,
        val searches: Int = 0,
        val fetches: Int = 0,
        val others: Int = 0,
    )

    /**
     * [folded]: the turn shows a "Worked for …" row; [work] holds the block keys it folds, in
     * order, and every other block stays visible below it.
     */
    data class Layout(
        val blocks: List<Block>,
        val work: Set<String>,
        val folded: Boolean,
        /** Background tasks and sub-agents: one panel after the turn, outside its blocks (web). */
        val tasks: List<TurnItem.Task> = emptyList(),
    ) {
        /** Only a final visible activity is live; tasks/footer bookkeeping is outside these blocks. */
        fun activeActivityKey(working: Boolean): String? =
            if (working) (visible.lastOrNull() as? Activity)?.key else null

        val visible: List<Block> get() = if (folded) blocks.filter { it.key !in work } else blocks
        val folding: List<Block> get() = if (folded) blocks.filter { it.key in work } else emptyList()
    }

    fun build(turnId: String, items: List<TurnItem>, finished: Boolean, showThoughts: Boolean): Layout {
        val tasks = items.filterIsInstance<TurnItem.Task>()
        val shown = items.filter { item ->
            when (item) {
                is TurnItem.Thought -> showThoughts
                is TurnItem.Tool -> item.kind != "think"
                is TurnItem.Task -> false
                else -> true
            }
        }
        val blocks = mutableListOf<Block>()
        var pending = mutableListOf<TurnItem>()
        // The image stack later images may still join: only activity blocks may follow it.
        var stack: Int? = null
        fun flush() {
            val first = pending.firstOrNull() ?: return
            blocks += Activity("$turnId:activity:${first.id}", pending, summarize(pending))
            pending = mutableListOf()
        }
        for (item in shown) {
            if (isActivity(item)) {
                val previous = pending.firstOrNull()
                if (showThoughts && previous != null && (previous is TurnItem.Thought) != (item is TurnItem.Thought)) flush()
                pending += item
            } else if (item is TurnItem.Images) {
                // Images that only tool work separates (repeated upload calls) fan into the first
                // one's stack; the work between them follows the stack.
                flush()
                val at = stack
                val joined = at?.let { blocks[it] as Content }
                if (at != null && joined != null) {
                    val previous = joined.item as TurnItem.Images
                    blocks[at] = joined.copy(item = previous.copy(images = previous.images + item.images))
                } else {
                    stack = blocks.size
                    blocks += Content("$turnId:content:${item.id}", item)
                }
            } else {
                flush()
                stack = null
                blocks += Content("$turnId:content:${item.id}", item)
            }
        }
        flush()
        if (!finished) return Layout(blocks, emptySet(), folded = false, tasks)

        val answerStart = finalTextRunStart(shown)
        val collapsible = shown.withIndex().filter { (index, item) ->
            shown.size > 1 && index < shown.size - 1 && !(item is TurnItem.Text && index >= answerStart) && !neverFolded(item)
        }.map { it.value.id }.toSet()
        val work = blocks.filter { block ->
            block is Activity || (block is Content && block.item.id in collapsible)
        }.map { it.key }.toSet()
        // Fold only when something stays visible below: otherwise nothing would answer the turn.
        val folded = work.isNotEmpty() && blocks.any { it.key !in work }
        return Layout(blocks, if (folded) work else emptySet(), folded, tasks)
    }

    /** Thought and tool steps fold into groups; a plan-approval (`switch_mode`) step stays content. */
    private fun isActivity(item: TurnItem): Boolean =
        item is TurnItem.Thought || (item is TurnItem.Tool && item.kind != "switch_mode")

    private fun neverFolded(item: TurnItem): Boolean =
        item is TurnItem.ProposedPlan || item is TurnItem.Checklist || item is TurnItem.Notice || item is TurnItem.Images ||
            (item is TurnItem.Tool && item.kind == "switch_mode")

    /** Web `getFinalTextRunStart`: skip the never-folded tail, then walk back over adjacent text. */
    internal fun finalTextRunStart(items: List<TurnItem>): Int {
        var index = items.size - 1
        while (index >= 0 && neverFolded(items[index])) index -= 1
        if (items.getOrNull(index) !is TurnItem.Text) return items.size
        while (index > 0 && items[index - 1] is TurnItem.Text) index -= 1
        return index
    }

    /** Web `summarizeAssistantActivity`: files count once per path. */
    internal fun summarize(items: List<TurnItem>): Summary {
        val read = mutableSetOf<String>()
        val edited = mutableSetOf<String>()
        var reads = 0
        var edits = 0
        var summary = Summary()
        for (item in items) {
            when (item) {
                is TurnItem.Thought -> summary = summary.copy(thought = true)
                is TurnItem.Tool -> when (item.kind) {
                    "execute", "bash" -> summary = summary.copy(commands = summary.commands + 1)
                    "read" -> if (item.path == null) reads += 1 else read += item.path
                    "edit", "write", "delete", "move" -> if (item.path == null) edits += 1 else edited += item.path
                    "search" -> summary = summary.copy(searches = summary.searches + 1)
                    "fetch" -> summary = summary.copy(fetches = summary.fetches + 1)
                    else -> summary = summary.copy(others = summary.others + 1)
                }
                else -> Unit
            }
        }
        return summary.copy(reads = read.size + reads, edits = edited.size + edits)
    }
}
