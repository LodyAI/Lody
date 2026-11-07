import Foundation
import LodyCore

func entry(
  _ id: String, visibility: RuntimeContract.PromptShortcutIndexEntryVisibility = .private, owner: String = "me",
  scope: RuntimeContract.PromptShortcutScope = .init()
) -> PromptShortcutEntry {
  PromptShortcutEntry(
    v: 1, id: id, workspaceId: "w", ownerUserId: owner, visibility: visibility, name: id.uppercased(), slug: id,
    scope: scope, revision: "r1", createdAt: 1, updatedAt: 1, bodyDocId: "body-\(id)", dependencySummary: []
  )
}

let single = PromptShortcutSections.make([entry("review-pr")], userId: "me")
let row = single[0].rows[0]
precondition(row.subtitle == "/review-pr" && row.subtitleMono, "Rows show only the command")
precondition(row.trailingSymbol.isEmpty, "An owned plain shortcut is editable")

let marked = PromptShortcutSections.make(
  [entry("mine"), entry("theirs", visibility: .workspace, owner: "other"), entry("context", scope: .init(machineId: "m"))],
  userId: "me"
).flatMap(\.rows).filter { $0.trailingSymbol == "eye" }
precondition(marked.map(\.id) == ["context", "theirs"], "Templates another member owns or that need context are view only")
precondition(marked.allSatisfy { $0.trailingSymbolLabel == "settings.shortcuts.viewOnly" })

let sections = PromptShortcutSections.make([entry("a", visibility: .workspace), entry("b")], userId: "me")
precondition(sections.map(\.id) == ["private", "workspace"], "Private and shared sections keep their order")
precondition(sections[0].footer.isEmpty && sections[1].footer == "settings.shortcuts.hintShort")
precondition(PromptShortcutSections.make([], userId: "me").isEmpty)

precondition(PromptShortcutSections.validSlug("review-pr") && PromptShortcutSections.validSlug("a"))
for slug in ["", "-review", "Review", "review pr", "review\n", String(repeating: "a", count: 41)] {
  precondition(!PromptShortcutSections.validSlug(slug), "Invalid slug accepted: \(slug)")
}

let value = PromptShortcutValue(
  v: 1, id: "review", workspaceId: "w", ownerUserId: "me", visibility: .private, name: "Review", slug: "review",
  scope: .init(), revision: "r1", createdAt: 1, updatedAt: 1, prompt: "Review", mentions: []
)
precondition(!PromptShortcutSections.readOnly(value, userId: "me"))
precondition(PromptShortcutSections.readOnly(value, userId: "other"), "Only the owner edits")
var long = value
long.prompt = String(repeating: "a", count: 16001)
precondition(PromptShortcutSections.readOnly(long, userId: "me"), "Prompts beyond the mobile limit are view only")

let target = RuntimeContract.AgentRoleItemTargetsItem(
  machineId: "m1", agentConfigId: "a1", machineName: "Studio", agentName: "Coder", state: .configured
)
func role(_ id: String, owner: String = "me", name: String = "Reviewer", targets: [RuntimeContract.AgentRoleItemTargetsItem] = [target]) -> AgentRole {
  AgentRole(
    id: id, ownerUserId: owner, visibility: owner == "me" ? .private : .workspace, name: name,
    description: "Review changes", promptPrefix: "Keep changes focused.", revision: 1, updatedAt: 1, targets: targets
  )
}
var missing = target
missing.state = .agentUnavailable
let roles = AgentRoleSections.make([role("review"), role("search", owner: "other"), role("missing", targets: [missing])], userId: "me")
let roleRows = roles[0].rows
precondition(roleRows.map(\.id) == ["role:review", "role:search", "role:missing"])
precondition(roleRows[0].subtitle == "Review changes\nStudio · Coder" && roleRows[0].value == "settings.roles.private")
precondition(roleRows[1].subtitle.hasSuffix("\nsettings.roles.ownerOnly") && roleRows[1].value == "settings.roles.sharedValue")
precondition(roleRows[2].subtitle.hasSuffix("Studio · Coder · settings.roles.agentUnavailable"))
precondition(roles[0].footer == "settings.roles.hint")

precondition(AgentRoleSections.editable(role("r"), userId: "me"))
precondition(!AgentRoleSections.editable(role("r", owner: "other"), userId: "me"))
precondition(AgentRoleSections.editable(role("r", name: String(repeating: "😀", count: 60)), userId: "me"), "Names count code points")
precondition(!AgentRoleSections.editable(role("r", name: String(repeating: "a", count: 61)), userId: "me"))
precondition(AgentRoleSections.readOnlyHint(role("r", owner: "other"), userId: "me") == "settings.roles.readOnly")
precondition(AgentRoleSections.readOnlyHint(role("r", name: String(repeating: "a", count: 61)), userId: "me") == "settings.roles.longReadOnly")
precondition(AgentRoleSections.readOnlyHint(role("r"), userId: "me") == nil)

func error(_ text: String) -> NSError { NSError(domain: "t", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
let duplicate = AgentRoleSections.failure(error("command_failed: role_duplicate"))
precondition(duplicate.message == "settings.roles.duplicate" && !duplicate.uncertain)
precondition(AgentRoleSections.failure(error("role_conflict")).message == "settings.remote.conflict")
let unknown = AgentRoleSections.failure(error("send_timeout: timed out"))
precondition(unknown.message == "settings.roles.unknown" && unknown.uncertain, "Unrecognised failures need a fresh read")

print("PASS: shortcut rows, view-only marks, slug and owner rules; role rows, ownership limits and failure mapping")
