import Foundation
import UIKit

func agent(_ id: String, machine: String? = "m1", name: String? = "Studio", detail: String = "codex", readOnly: Bool? = nil) -> RemoteSetting {
  RemoteSetting(kind: "agent", id: id, name: id.capitalized, machineId: machine, machineName: name, readOnly: readOnly, detail: detail)
}
let live = SettingsMachinePresence(state: "live", onlineMachineIds: ["m1", "m2", "owner-mac"])

let grouped = RemoteSettingsSections.make(
  kind: "agent", items: [agent("grok", detail: "grok"), agent("grok", machine: "m2", readOnly: true), agent("claude", detail: "claude"),
                         agent("grok", machine: nil, name: nil)],
  failed: false, connected: true
)
precondition(grouped.map { $0.rows.map(\.id) } == [
  ["setting:agent:m1:grok", "setting:agent:m1:claude"], ["setting:agent:m2:grok"], ["setting:agent::grok"],
], "\(grouped.map { $0.rows.map(\.id) })")
precondition(grouped[0].header == "Studio" && grouped[1].id == "machine:m2" && !grouped[1].rows[0].action)
precondition(grouped[1].rows[0].trailingSymbol == "lock" && grouped[2].header == "settings.remote.machine")
precondition(grouped[0].rows[1].imageAsset == "lody-agent-claude" && grouped[0].rows[1].subtitle.isEmpty)
precondition(RemoteSettingsSections.make(kind: "agent", items: [], failed: false, connected: true).isEmpty)

let machines = [
  RemoteSetting(kind: "machine", id: "owner-mac", name: "Studio Mac", detail: "macOS"),
  RemoteSetting(kind: "machine", id: "team-mac", name: "Studio Mac", readOnly: true),
  RemoteSetting(kind: "machine", id: "build", name: "Builder", detail: "Linux"),
]
let machineRows = RemoteSettingsSections.make(kind: "machine", items: machines, failed: false, connected: true,
                                              presence: SettingsMachinePresence(state: "live", onlineMachineIds: ["owner-mac"]))[0]
precondition(machineRows.rows.map(\.status) == ["online", "offline", "offline"])
precondition(machineRows.rows[0].subtitle == "devices.online · macOS · owner-mac", machineRows.rows[0].subtitle)
precondition(machineRows.rows[2].subtitle == "devices.offline · Linux", "Unique names hide the raw id")
precondition(!machineRows.rows[1].action && !machineRows.rows[1].disclosure && machineRows.rows[1].trailingSymbol == "lock")
precondition(machineRows.footer == "settings.remote.machineFooter")
for (failed, connected) in [(true, true), (false, false)] {
  let rows = RemoteSettingsSections.make(kind: "machine", items: machines, failed: failed, connected: connected, presence: live)[0].rows
  precondition(rows.allSatisfy { $0.status == "unknown" && $0.subtitle.hasPrefix("devices.unknown") }, "Stale presence is never live")
}

let subscription = AgentUsage(
  configs: [AgentUsageConfig(id: "codex-one", name: "", provider: "codex", eligible: true),
            AgentUsageConfig(id: "codex-two", name: "", provider: "codex", eligible: true),
            AgentUsageConfig(id: "custom-api", name: "", provider: "codex", eligible: false)],
  quotas: [AgentQuota(id: "codex", provider: "codex", windows: [UsageWindow(usedPercent: 0, duration: 18000, resetsAt: nil)])]
)
let usage = ["m1": subscription, "m2": subscription]
let rings = RemoteSettingsSections.make(
  kind: "agent", items: [agent("codex-one"), agent("codex-one", machine: "m2", readOnly: true), agent("codex-two"), agent("custom-api")],
  failed: false, connected: true, agentUsage: usage, presence: live
)
precondition(rings.count == 2 && rings[0].rows.count == 3 && rings[0].headerStatus == "online")
precondition(rings[0].header == "Studio · devices.online")
precondition(rings[0].visual?.type == "quotas" && rings[0].visual?.items.count == 1 && rings[0].visual?.dimmed == false,
             "One ring per provider per machine")
precondition(rings[0].visual?.items[0].id == "usage:m1:codex:shared:codex:0" && rings[1].visual?.items[0].id == "usage:m2:codex:shared:codex:0")
precondition(rings[0].footer == "settings.usage.paceFooter\nsettings.usage.sharedShort")
let offlinePresence = SettingsMachinePresence(state: "live", onlineMachineIds: [])
for (failed, connected, presence, footer) in [
  (false, true, offlinePresence, "settings.usage.lastOffline"), (false, true, SettingsMachinePresence.unknown, "settings.usage.lastUnknown"),
  (true, true, live, "settings.usage.lastUnknown"), (false, false, live, "settings.usage.lastUnknown"),
] {
  let section = RemoteSettingsSections.make(kind: "agent", items: [agent("codex-one")], failed: failed, connected: connected,
                                            agentUsage: usage, presence: presence)[0]
  precondition(section.visual?.dimmed == true && section.footer == footer && section.headerStatus != "online")
  precondition(section.visual?.items[0].pace == nil && section.visual?.items[0].detail == "" && section.visual?.items[0].tone == "")
}
for item in [agent("custom-api"), agent("codex-one", detail: "claude")] {
  precondition(RemoteSettingsSections.make(kind: "agent", items: [item], failed: false, connected: true, agentUsage: usage,
                                           presence: live)[0].visual == nil, "Ineligible or mismatched configs never become zero usage")
}
precondition(RemoteSettingsSections.make(kind: "agent", items: [agent("codex-one")], failed: false, connected: true,
                                         presence: offlinePresence)[0].footer == "settings.usage.noneOffline")

let hour = 3600.0
let now = 1_792_152_000_000.0
func ring(_ window: UsageWindow) -> LodyListVisualItem {
  let usage = AgentUsage(configs: [AgentUsageConfig(id: "a", name: "", provider: "codex", eligible: true)],
                         quotas: [AgentQuota(id: "codex", provider: "codex", windows: [window])])
  return RemoteSettingsSections.rings(RemoteSetting(kind: "agent", id: "a", name: "", machineId: "m", detail: "codex"), usage, now: now)[0]
}
let pace = ring(UsageWindow(usedPercent: 42, duration: 5 * hour, resetsAt: now / 1000 + 2 * hour + 14 * 60))
precondition(pace.fraction == 0.42 && pace.detail == "settings.usage.onPace" && pace.tone.isEmpty)
precondition(abs(pace.pace! - (1 - (2 * 3600 + 14 * 60) / (5 * 3600))) < 1e-9)
precondition(pace.label == "Codex · settings.usage.hours", pace.label)
precondition(RemoteSettingsSections.usageSpan((2 * hour + 14 * 60) * 1000) == "settings.usage.spanHours")
let ahead = ring(UsageWindow(usedPercent: 17, duration: 7 * 24 * hour, resetsAt: now / 1000 + 6 * 24 * hour + 6 * hour))
precondition(ahead.tone == "warning" && ahead.detail == "settings.usage.ahead")
precondition(ring(UsageWindow(usedPercent: 51, duration: 10 * hour, resetsAt: now / 1000 + 5 * hour)).detail == "settings.usage.onPace",
             "Within two points of the marker is on pace")
let exhausted = ring(UsageWindow(usedPercent: 100, duration: 5 * hour, resetsAt: now / 1000 + 65 * 60))
precondition(exhausted.detail == "settings.usage.exhausted" && exhausted.tone == "warning" && exhausted.fraction == 1)
let unknown = ring(UsageWindow(usedPercent: 8, duration: 7 * 24 * hour, resetsAt: nil))
precondition(unknown.pace == nil && unknown.detail.isEmpty && unknown.caption == "settings.usage.resetsUnknown")
precondition(ring(UsageWindow(usedPercent: 30, duration: 5 * hour, resetsAt: now / 1000 - 60)).pace == nil, "A past reset never forecasts")
let named = AgentUsage(configs: [AgentUsageConfig(id: "a", name: "", provider: "codex", eligible: true)],
                       quotas: [AgentQuota(id: "codex_bengalfox", provider: "codex", name: "Codex Spark",
                                           windows: [UsageWindow(label: "Weekly", usedPercent: 8, duration: nil, resetsAt: nil)])])
let spark = RemoteSettingsSections.rings(RemoteSetting(kind: "agent", id: "a", name: "", machineId: "m"), named, now: now)[0]
precondition(spark.label == "Codex Spark · settings.usage.window · Weekly", spark.label)

precondition(SavedRemoteSettings.key(userId: "u1", workspaceId: "w1", kind: "agent") == "remote-settings:u1:w1:agent")
let saved = SavedRemoteSettings(items: [agent("grok")], syncedAt: 1)
precondition(SavedRemoteSettings.parse(saved.json, kind: "agent") == saved)
precondition(SavedRemoteSettings.parse(saved.json, kind: "machine") == nil, "Cross-kind snapshots are rejected")
precondition(SavedRemoteSettings.parse(#"{"configs":[]}"#, kind: "agent") == nil)
precondition(SavedRemoteSettings.parse(nil, kind: "agent") == nil)

struct Failure: Error, CustomStringConvertible { let description: String }
let list = RemoteSettingsRequest(workspaceId: "w", kind: "agent")
var edit = list
edit.edit = RemoteSettingEdit(item: saved.items[0], name: "x")
precondition(RemoteSettingsFailure.message(Failure(description: "setting_read_only"), request: list) == "settings.remote.readOnly")
precondition(RemoteSettingsFailure.message(Failure(description: "setting_conflict"), request: edit) == "settings.remote.conflict")
precondition(RemoteSettingsFailure.message(Failure(description: "offline"), request: list) == "settings.remote.loadFailed")
precondition(RemoteSettingsFailure.message(Failure(description: "offline"), request: edit) == "settings.remote.saveFailed")
let body = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(RemoteSettingsRequest(
  workspaceId: "w", kind: "agent", edit: RemoteSettingEdit(item: agent("a1"), name: "N", prompt: "P")
))) as! [String: Any]
precondition((body["edit"] as! [String: Any])["enabledByDefault"] == nil && body["remove"] == nil, "Only the kind's fields are sent")

print("PASS: remote settings sections, agent usage rings and pace, saved snapshots, failure mapping")

let scopedQuotas = AgentUsage(configs: [AgentUsageConfig(id: "a", name: "Codex", provider: "codex", eligible: true, rateLimitsAvailable: true)], quotas: [
  AgentQuota(id: "codex", provider: "codex", agentConfigId: "b", windows: []),
  AgentQuota(id: "codex", provider: "codex", windows: []),
  AgentQuota(id: "codex_bengalfox", provider: "codex", agentConfigId: "a", name: "Codex Spark", windows: []),
])
precondition(SessionUsageSelection.quota(scopedQuotas, configId: "a", provider: "codex", model: "gpt-5.3-codex") == nil)
precondition(SessionUsageSelection.quota(scopedQuotas, configId: "a", provider: "codex", model: "gpt-5.3-codex-spark")?.id == "codex_bengalfox")
precondition(SessionUsageSelection.quota(scopedQuotas, configId: "b", provider: "codex", model: nil) == nil)
var unsupportedQuotas = scopedQuotas
unsupportedQuotas.configs[0].rateLimitsAvailable = false
precondition(SessionUsageSelection.quota(unsupportedQuotas, configId: "a", provider: "codex", model: nil) == nil)
print("PASS: session quota exact account, model-specific Spark selection and capability gating")

let providerSnapshot = AgentProviderSnapshot(
  machines: [AgentProviderMachine(id: "m1", name: "Studio", online: true, readOnly: false, supportsSetup: true),
             AgentProviderMachine(id: "empty", name: "Empty", online: false, readOnly: true)],
  providers: [AgentProviderItem(id: "codex-one", machineId: "m1", name: "Codex", cliType: "builtin", agentType: "codex")],
  setups: [], catalog: [])
let providerSections = AgentProviderSections.make(providerSnapshot, selectedID: "m1", busy: false, usage: ["m1": subscription])
precondition(providerSections[0].rows[0].id == "provider-machine-picker")
precondition(providerSections[1].rows[0].menuActions.map(\.id) == ["edit", "refresh", "delete"])
precondition(providerSections.first { $0.id == "provider-usage" }?.rows.isEmpty == false, "Provider page preserves subscription quota display")
let emptyProviderSections = AgentProviderSections.make(providerSnapshot, selectedID: "empty", busy: false)
precondition(emptyProviderSections[1].rows.map(\.id) == ["providers-empty"], "Read-only empty machines remain selectable without create")
precondition(AgentProviderSections.picker(providerSnapshot.machines, selectedID: "empty")[0].rows.count == 2)
let staleProviders = AgentProviderSections.make(providerSnapshot, selectedID: "m1", busy: true)
precondition(staleProviders[1].rows.allSatisfy { $0.menuActions.isEmpty }, "Cached providers cannot authorize mutation actions")
var mixedSnapshot = providerSnapshot
mixedSnapshot.providers.append(AgentProviderItem(id: "codex-two", machineId: "m1", name: "Second", cliType: "builtin", agentType: "codex"))
var mixedUsage = AgentUsage(configs: [
  AgentUsageConfig(id: "codex-one", name: "First", provider: "codex", eligible: true),
  AgentUsageConfig(id: "codex-two", name: "Second", provider: "codex", eligible: true),
], quotas: [
  AgentQuota(id: "codex", provider: "codex", windows: [UsageWindow(usedPercent: 10)]),
  AgentQuota(id: "codex", provider: "codex", agentConfigId: "codex-one", windows: [UsageWindow(usedPercent: 40)]),
  AgentQuota(id: "codex", provider: "codex", agentConfigId: "codex-two", windows: [UsageWindow(usedPercent: 70)]),
])
@MainActor func verifyMixedUsage() {
  let sections = AgentProviderSections.make(mixedSnapshot, selectedID: "m1", busy: true, usage: ["m1": mixedUsage])
  let rows = sections.first { $0.id == "provider-usage" }!.rows
  precondition(rows.count == 2 && Set(rows.map(\.id)).count == 2)
  precondition(Set(rows.compactMap(\.progress)) == Set([0.6, 1 - 0.7]), "Each configured account keeps its own quota")
  var snapshot = NSDiffableDataSourceSnapshot<String, String>()
  for section in sections {
    snapshot.appendSections([section.id])
    snapshot.appendItems(section.rows.map(\.id), toSection: section.id)
  }
  precondition(snapshot.numberOfItems == sections.reduce(0) { $0 + $1.rows.count })
}
verifyMixedUsage()
mixedUsage.quotas.reverse()
verifyMixedUsage()
mixedUsage.quotas.removeAll { $0.agentConfigId == "codex-two" }
let sharedFallback = RemoteSettingsSections.rings(agent("codex-two"), mixedUsage, now: now)
precondition(sharedFallback.count == 1 && sharedFallback[0].fraction == 0.1, "Legacy shared quota is used only without an exact account quota")
mixedUsage.quotas.removeAll { $0.agentConfigId == nil }
precondition(RemoteSettingsSections.rings(agent("codex-two"), mixedUsage, now: now).isEmpty, "Never substitute another account's quota")
print("PASS: provider machine selection, management gating and mixed shared/configured subscription quotas")

var multiMachineProviders = providerSnapshot
multiMachineProviders.providers.append(AgentProviderItem(id: "other", machineId: "empty", name: "Other", cliType: "builtin", agentType: "claude"))
multiMachineProviders.setups = [AgentProviderSetup(id: "other-setup", machineId: "empty", name: "Other setup", agentType: "codex", status: "queued", attempt: 1)]
var mutation = providerSnapshot
mutation.providers[0].name = "Renamed"
let mergedProviders = AgentProviderSections.merging(mutation, into: multiMachineProviders, machineID: "m1")
precondition(mergedProviders.providers.first { $0.id == "codex-one" }?.name == "Renamed")
precondition(AgentProviderSections.make(mergedProviders, selectedID: "empty", busy: false)[1].rows.contains { $0.id == "provider:other" }, "Switching machine after mutation retains its provider")
precondition(mergedProviders.setups.map(\.id) == ["other-setup"], "Mutation retains other-machine setup")
mutation.providers = []
let deletedProviders = AgentProviderSections.merging(mutation, into: mergedProviders, machineID: "m1")
precondition(deletedProviders.providers.map(\.id) == ["other"], "Empty target projection removes the deleted provider")
mutation.machines.removeAll { $0.id == "empty" }
let removedMachine = AgentProviderSections.merging(mutation, into: mergedProviders, machineID: "m1")
precondition(removedMachine.providers.isEmpty && removedMachine.setups.isEmpty, "Removed machines cannot retain cached providers or setups")
print("PASS: target-machine mutation merge preserves other machines and removes deleted targets")
