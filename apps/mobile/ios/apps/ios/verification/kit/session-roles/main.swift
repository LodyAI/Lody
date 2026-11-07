import LodyCore
import Foundation

// Web's session composer Roles (`selectSessionAgentRoles`, `use-session-agent-role.ts`) on the
// production Swift logic: only Roles bound to the conversation's own computer and Agent Config,
// pins applied without changing the agent, and the Role sent only while it is what will run.
func check(_ condition: Bool, _ message: String) {
  if !condition { fatalError(message) }
}

typealias Role = RuntimeContract.AgentRoleItem
typealias Target = RuntimeContract.AgentRoleItemTargetsItem

func role(
  _ id: String, _ name: String, machine: String = "m1", config: String = "a1",
  state: RuntimeContract.AgentRoleItemTargetsItemState = .configured,
  pins: RuntimeContract.AgentRoleItemTargetsItemRunConfig? = nil
) -> Role {
  Role(
    id: id, ownerUserId: "u1", visibility: .private, name: name, description: "", promptPrefix: "Do it.",
    emoji: nil, revision: 2, updatedAt: 1,
    targets: [Target(machineId: machine, agentConfigId: config, runConfig: pins, machineName: "Mac", agentName: "Codex", state: state)])
}

let reviewer = role("r", "Reviewer", pins: .init(modelId: "gpt", configOptionValues: ["reasoning_effort": .string("high"), "fast": .bool(true)]))
let writer = role("w", "Writer")
let otherAgent = role("x", "Other agent", config: "a2")
let otherMachine = role("y", "Other machine", machine: "m2")
let broken = role("b", "Broken", state: .agentUnavailable)
let roles = [writer, otherAgent, reviewer, otherMachine, broken]
let capability = Capability(
  machineId: "m1", agentConfigId: "a1", cliType: "builtin", agentType: "codex",
  models: [CapabilityChoice(id: "gpt", name: "GPT"), CapabilityChoice(id: "mini", name: "Mini")],
  modes: [CapabilityChoice(id: "default", name: "Default")],
  reasoningEfforts: ["gpt": ["low", "high"]], reasoningEffortConfigId: "reasoning_effort")

// Only the conversation's own computer and Agent Config, sorted by name; unavailable stay listed.
do {
  let items = SessionRoles.items(roles: roles, machineId: "m1", agentConfigId: "a1", online: ["a1"])
  check(items.map(\.role.id) == ["b", "r", "w"], "bound Roles only, by name: \(items.map(\.role.id))")
  check(items.first?.unavailable == "create.role.unavailable.agent", "an unavailable Role keeps its reason")
  check(items[1].unavailable == nil, "an online Role is available")
  let offline = SessionRoles.items(roles: roles, machineId: "m1", agentConfigId: "a1", online: [])
  check(offline.allSatisfy { $0.unavailable != nil }, "an offline agent disables its Roles")
  check(SessionRoles.items(roles: roles, machineId: "m1", agentConfigId: nil, online: ["a1"]).isEmpty, "no config, no Roles")
}

// Picking a Role applies only what it pins, keeping the rest of the conversation's choice.
do {
  let items = SessionRoles.items(roles: roles, machineId: "m1", agentConfigId: "a1", online: ["a1"])
  let item = items.first { $0.role.id == "r" }!
  let current = ModelChoice(modelId: "mini", effort: "low", modeId: "default", configOptionValues: ["sandbox": .string("on")])
  let picked = SessionRoles.choice(applying: item, to: current, capability: capability)
  check(picked.modelId == "gpt" && picked.effort == "high", "pinned model and effort")
  check(picked.modeId == "default", "an unpinned mode stays")
  check(picked.configOptionValues == ["sandbox": .string("on"), "fast": .bool(true)], "pinned options merge into the choice")
  let unsupported = SessionRoles.choice(
    applying: SessionRoles.items(roles: [role("u", "U", pins: .init(modelId: "gone", modeId: "nope"))], machineId: "m1", agentConfigId: "a1", online: ["a1"])[0],
    to: current, capability: capability)
  check(unsupported.modelId == "mini" && unsupported.modeId == "default", "values the agent does not offer are skipped")
}

// The Role shown is the one picked here, else the one the latest turn ran as, while it still applies.
do {
  let items = SessionRoles.items(roles: roles, machineId: "m1", agentConfigId: "a1", online: ["a1"])
  let applied = ModelChoice(modelId: "gpt", effort: "high", configOptionValues: ["fast": .bool(true)])
  check(SessionRoles.active(items, picked: nil, durable: "r", choice: applied, effortId: "reasoning_effort")?.role.id == "r", "durable Role")
  check(SessionRoles.active(items, picked: .some(nil), durable: "r", choice: applied, effortId: "reasoning_effort") == nil, "explicit None wins")
  check(SessionRoles.active(items, picked: "w", durable: "r", choice: applied, effortId: "reasoning_effort")?.role.id == "w", "a pick wins")
  let drifted = ModelChoice(modelId: "mini", effort: "high", configOptionValues: ["fast": .bool(true)])
  check(SessionRoles.active(items, picked: nil, durable: "r", choice: drifted, effortId: "reasoning_effort") == nil, "a moved pin detaches")
  check(SessionRoles.active(items, picked: "b", durable: nil, choice: ModelChoice(), effortId: nil) == nil, "an unavailable Role never runs")
}

// What a turn carries: the Role while it applies, an explicit None once it no longer does, and
// nothing (inherit) while the Role list is still loading or there was never a Role.
do {
  let items = SessionRoles.items(roles: roles, machineId: "m1", agentConfigId: "a1", online: ["a1"])
  let applied = ModelChoice(modelId: "gpt", effort: "high", configOptionValues: ["fast": .bool(true)])
  let active = SessionRoles.active(items, picked: nil, durable: "r", choice: applied, effortId: "reasoning_effort")
  check(SessionRoles.send(loaded: true, active: active, picked: nil, durable: "r") == .role("r"), "runs as the Role")
  check(SessionRoles.send(loaded: true, active: nil, picked: nil, durable: "r") == .none, "a detached Role ends")
  check(SessionRoles.send(loaded: true, active: nil, picked: .some(nil), durable: nil) == .none, "explicit None")
  check(SessionRoles.send(loaded: false, active: nil, picked: nil, durable: "r") == .inherit, "pending list inherits")
  check(SessionRoles.send(loaded: true, active: nil, picked: nil, durable: nil) == .inherit, "never a Role")
}

// Web's Plan switch: Lody's boolean `plan_mode`, or a collaboration mode with plan/default.
do {
  let boolean = Capability(
    machineId: "m1", cliType: "builtin", agentType: "codex",
    configOptions: [ConfigOption(id: "plan_mode", name: "Plan", type: "boolean", currentValue: .bool(false), options: [])])
  check(CreateLogic.planMode(boolean, ModelChoice())?.enabled == false, "boolean plan off by default")
  let on = CreateLogic.withPlanMode(boolean, ModelChoice(), enabled: true)
  check(on.configOptionValues == ["plan_mode": .bool(true)], "boolean plan on")
  check(CreateLogic.planMode(boolean, on)?.enabled == true, "boolean plan reads back")
  let collaboration = Capability(
    machineId: "m1", cliType: "builtin", agentType: "codex",
    configOptions: [ConfigOption(id: "collaboration_mode", name: "Mode", type: "select", currentValue: .string("default"),
      options: [CapabilityChoice(id: "default", name: "Default"), CapabilityChoice(id: "plan", name: "Plan")])])
  let planned = CreateLogic.withPlanMode(collaboration, ModelChoice(), enabled: true)
  check(planned.configOptionValues == ["collaboration_mode": .string("plan")], "collaboration plan")
  check(CreateLogic.withPlanMode(collaboration, planned, enabled: false).configOptionValues == ["collaboration_mode": .string("default")], "collaboration default")
  check(CreateLogic.planMode(capability, ModelChoice()) == nil, "no plan selector, no switch")
}

print("session-roles ok")
