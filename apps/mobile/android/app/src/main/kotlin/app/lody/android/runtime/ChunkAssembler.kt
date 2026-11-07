package app.lody.android.runtime

/** Bounded, ordered assemblies. The owner clears them whenever its generation changes. */
internal class ChunkAssembler {
    private data class Assembly(val total: Int, var deadline: Long, var next: Int = 0, val text: StringBuilder = StringBuilder())
    private var suspendedAt: Long? = null
    private val assemblies = mutableMapOf<String, Assembly>()
    fun add(id: String, index: Int, total: Int, data: String, now: Long): String? {
        require(id.isNotEmpty() && id.length <= 80 && total in 1..512 && index in 0 until total && data.length <= 16384)
        require(!expire(now))
        val assembly = assemblies[id] ?: run {
            require(index == 0 && assemblies.size < 2)
            Assembly(total, (suspendedAt ?: now) + 5000).also { assemblies[id] = it }
        }
        require(assembly.total == total && assembly.next == index)
        require(assemblies.values.sumOf { it.text.length } + data.length <= 8 * 1024 * 1024)
        assembly.text.append(data); assembly.next++
        if (assembly.next != total) return null
        assemblies.remove(id)
        val text = assembly.text.toString()
        require(text.toByteArray(Charsets.UTF_8).size <= 8 * 1024 * 1024)
        return text
    }
    fun expire(now: Long): Boolean {
        if (suspendedAt != null) return false
        val expired = assemblies.filterValues { it.deadline <= now }.keys
        expired.forEach(assemblies::remove)
        return expired.isNotEmpty()
    }
    fun suspend(now: Long) { if (suspendedAt == null) suspendedAt = now }
    fun resume(now: Long) {
        val start = suspendedAt ?: return
        val elapsed = (now - start).coerceAtLeast(0)
        assemblies.values.forEach { it.deadline += elapsed }
        suspendedAt = null
    }
    fun clear() { assemblies.clear(); suspendedAt = null }
}
