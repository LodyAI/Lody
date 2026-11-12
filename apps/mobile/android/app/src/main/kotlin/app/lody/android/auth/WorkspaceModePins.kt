package app.lody.android.auth

import java.io.File
import java.io.FileOutputStream
import org.json.JSONObject

enum class WorkspaceContentMode { UNKNOWN, PLAINTEXT, E2EE }

/** Encrypted pins survive logout. Plaintext cache failures cannot revoke online admission. */
internal class WorkspaceModePins(private val file: File? = null, private val write: (File, String) -> Unit = ::atomicWrite) {
    private val encrypted = mutableSetOf<String>()
    private val verifiedPlaintext = mutableSetOf<String>()
    private val unconfirmed = mutableSetOf<String>()
    private fun read(source: File?): MutableMap<String, String> {
        val data = if (source?.exists() == true) JSONObject(source.readText()) else JSONObject()
        return data.keys().asSequence().associateWith { data.getString(it) }.toMutableMap()
    }
    private fun retained(): MutableMap<String, String> = read(file).apply {
        // Old interrupted mixed-cache writes may contain positive encrypted evidence.
        // A partial plaintext cache is optional and never stops login.
        val pending = file?.let { File(it.path + ".pending") }
        val recovered = try { read(pending) } catch (_: Exception) { emptyMap() }
        recovered.filterValues { it != "plaintext" }.forEach { (id, value) -> put(id, value) }
    }
    private val plaintextFile get() = file?.let { File(it.path + ".plaintext") }
    private fun current(id: String, values: Map<String, String>): WorkspaceContentMode = when {
        id in encrypted || (values[id] != null && values[id] != "plaintext") -> WorkspaceContentMode.E2EE
        id in unconfirmed -> WorkspaceContentMode.UNKNOWN
        id in verifiedPlaintext || values[id] == "plaintext" || try { read(plaintextFile)[id] == "plaintext" } catch (_: Exception) { false } -> WorkspaceContentMode.PLAINTEXT
        else -> WorkspaceContentMode.UNKNOWN
    }
    fun rejectPlaintext(id: String) { synchronized(lock) { unconfirmed.add(id) } }
    fun mode(id: String): WorkspaceContentMode = synchronized(lock) {
        if (id in encrypted) return@synchronized WorkspaceContentMode.E2EE
        try { current(id, retained()) } catch (_: Exception) { WorkspaceContentMode.UNKNOWN }
    }
    fun observe(id: String, mode: WorkspaceContentMode, genesis: String? = null): WorkspaceContentMode = synchronized(lock) {
        if (mode == WorkspaceContentMode.E2EE) { encrypted.add(id); verifiedPlaintext.remove(id) }
        val values = retained()
        if (mode == WorkspaceContentMode.E2EE) {
            val pins = values.filterValues { it != "plaintext" }.toMutableMap()
            pins.putIfAbsent(id, "e2ee:" + (genesis ?: ""))
            if (file != null) write(file, JSONObject(pins as Map<*, *>).toString())
            return@synchronized WorkspaceContentMode.E2EE
        }
        if (current(id, values) == WorkspaceContentMode.E2EE) return@synchronized WorkspaceContentMode.E2EE
        if (mode != WorkspaceContentMode.PLAINTEXT) return@synchronized current(id, values)
        unconfirmed.remove(id)
        verifiedPlaintext.add(id)
        try {
            val cache = read(plaintextFile).apply { put(id, "plaintext") }
            plaintextFile?.let { write(it, JSONObject(cache as Map<*, *>).toString()) }
        } catch (_: Exception) { /* Online admission remains usable; cold-start cache is optional. */ }
        WorkspaceContentMode.PLAINTEXT
    }
    companion object {
        private val lock = Any()
        private fun atomicWrite(file: File, text: String) {
            check(file.parentFile!!.isDirectory || file.parentFile!!.mkdirs())
            val pending = File(file.path + ".pending")
            FileOutputStream(pending).use { it.write(text.toByteArray()); it.fd.sync() }
            check(pending.renameTo(file)) { "mode_persistence_failed" }
        }
    }
}
