package app.lody.android.runtime

import org.json.JSONObject

/**
 * An Agent's proposal carried by a `system_notice` (web `AgentRoleProposalNotice` /
 * `ScheduleProposalNotice`), as the shared runtime presents it (`protocol/proposals.ts`).
 * [kind] is `agent_role` or `schedule`; [outcome] `saved` / `created` / `dismissed` once decided.
 */
data class ProposalCard(
    /** The history entry and item the decision is recorded on. */
    val entryId: String,
    val itemId: String,
    val kind: String,
    val outcome: String? = null,
    // Agent Role
    val action: String? = null,
    val requesterUserId: String? = null,
    val fields: RoleProposalFields = RoleProposalFields(),
    val before: RoleProposalFields? = null,
    // Schedule
    val title: String? = null,
    val prompt: String? = null,
    val rule: ScheduleRule? = null,
    val destination: String? = null,
    val scheduleId: String? = null,
) {
    val isRole: Boolean get() = kind == "agent_role"
    val decided: Boolean get() = outcome != null
}

data class RoleProposalFields(val name: String? = null, val description: String? = null, val promptPrefix: String? = null)

object ProposalEvents {
    /** The proposal a `system_notice` item carries, or null for any other item. */
    fun parse(entryId: String, item: JSONObject): ProposalCard? {
        if (item.optString("type") != "system_notice") return null
        val itemId = item.optString("itemId").ifEmpty { return null }
        val value = item.optJSONObject("proposal") ?: return null
        val kind = value.optString("kind").takeIf { it == "agent_role" || it == "schedule" } ?: return null
        val outcome = value.text("outcome")?.takeIf { it in setOf("saved", "created", "dismissed") }
        return if (kind == "agent_role") ProposalCard(
            entryId, itemId, kind, outcome,
            action = value.text("action")?.takeIf { it == "create" || it == "update" } ?: return null,
            requesterUserId = value.text("requesterUserId") ?: return null,
            fields = fields(value.optJSONObject("fields")) ?: return null,
            before = fields(value.optJSONObject("before")),
        ) else ProposalCard(
            entryId, itemId, kind, outcome,
            title = value.text("title") ?: return null,
            prompt = value.text("prompt"),
            rule = value.optJSONObject("rule")?.let { rule -> runCatching { ScheduleJson.rule(rule) }.getOrNull() },
            destination = value.text("destination"),
            scheduleId = value.text("scheduleId"),
        )
    }

    private fun fields(json: JSONObject?): RoleProposalFields? = json?.let {
        RoleProposalFields(it.text("name"), it.text("description"), it.text("promptPrefix"))
    }

    private fun JSONObject.text(key: String): String? = (opt(key) as? String)
}
