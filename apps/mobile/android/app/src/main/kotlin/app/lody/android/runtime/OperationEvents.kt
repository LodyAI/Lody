package app.lody.android.runtime

import org.json.JSONArray
import org.json.JSONObject

/** Display projection of durable operation receipts; never used to drive execution. */
data class OperationEvent(
    val id: String,
    val creates: Boolean,
    val cards: List<OperationCard> = emptyList(),
    val outcome: String? = null,
    val error: String? = null,
    val memberCount: Int? = null,
    val deliveryUnknown: Boolean = false,
)
data class OperationCard(val sessionId: String?, val label: String?, val status: String, val detail: String?, val reply: String? = null, val replyTruncated: Boolean = false)

/** Decodes the shared runtime's OperationPresentation, which owns receipt visibility. */
internal object OperationEvents {
    fun parse(item: JSONObject): List<OperationEvent> {
        if (item.optString("type") !in setOf("operation_progress", "operation_completion", "operation_completion_batch")) return emptyList()
        val presentation = item.optJSONObject("operation") ?: return emptyList()
        val id = item.optString("itemId")
        val notices = presentation.optJSONArray("notices").objects().mapIndexedNotNull { index, notice ->
            val kind = notice.optString("kind")
            when (kind) {
                "batch", "batchUnknown" -> OperationEvent("$id:notice:$index", false,
                    memberCount = notice.optInt("count"), deliveryUnknown = kind == "batchUnknown")
                "failed", "cancelled", "partial" -> OperationEvent("$id:notice:$index", false,
                    outcome = kind, error = notice.text("detail"))
                else -> null
            }
        }
        val cards = presentation.optJSONArray("cards").objects()
            .filter { it.optString("kind") in setOf("created", "reply") }
            .groupBy { it.optString("kind") }
            .mapNotNull { (kind, values) ->
                val decoded = values.mapNotNull { value ->
                    val target = value.text("sessionId") ?: return@mapNotNull null
                    val status = value.optString("status")
                    if (status !in setOf("created", "running", "succeeded", "failed", "cancelled")) return@mapNotNull null
                    OperationCard(target, value.text("label"), status, value.text("detail"), value.text("reply"), value.optBoolean("replyTruncated", false))
                }
                if (decoded.isEmpty()) null else OperationEvent("$id:$kind", kind == "created", decoded)
            }
        return notices + cards
    }
    private fun JSONObject.text(key: String) = (opt(key) as? String)?.takeIf { it.isNotBlank() }
    private fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
}
