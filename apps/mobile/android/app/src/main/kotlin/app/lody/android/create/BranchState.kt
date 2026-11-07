package app.lody.android.create

data class BranchPage(val names: List<String>, val defaultBranch: String? = null, val nextPage: Int? = null)
data class BranchCache(val page: BranchPage, val selected: String = "")
data class BranchState(val page: BranchPage? = null, val selected: String = "") {
    fun restore(cache: BranchCache?): BranchState {
        if (cache == null || page != null) return this
        return accept(cache.page, 1).let { restored ->
            if (selected.isEmpty() && cache.selected in cache.page.names) restored.copy(selected = cache.selected) else restored
        }
    }
    fun select(name: String) = if (name in page?.names.orEmpty()) copy(selected = name) else this
    fun accept(value: BranchPage, number: Int): BranchState {
        val merged = if (number == 1 || page == null) value else value.copy(
            names = (page.names + value.names).distinct(), defaultBranch = value.defaultBranch ?: page.defaultBranch)
        return copy(page = merged, selected = selected.ifEmpty { merged.defaultBranch?.takeIf { it in merged.names } ?: "" })
    }
}
