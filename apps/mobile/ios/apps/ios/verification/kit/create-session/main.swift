import LodyCore
import Foundation

// Ports tests/sessions/create-prefs.test.mjs onto the production Swift form.
func check(_ condition: Bool, _ message: String) {
  if !condition { fatalError(message) }
}

func roundTrip(_ prefs: CreatePrefs?) -> CreatePrefs? {
  CreateJSON.decode(CreatePrefs.self, CreateJSON.encode(prefs))
}

let codex = CreationAgent(id: "c1", name: "A", machineId: "m1", machineName: "Mac", cliType: "builtin", agentType: "codex")
let claude = CreationAgent(id: "c2", name: "B", machineId: "m2", machineName: "PC", cliType: "builtin", agentType: "claude")
let claudeCapability = Capability(
  machineId: "m2", cliType: "builtin", agentType: "claude",
  models: [CapabilityChoice(id: "opus", name: "Opus")], modes: [CapabilityChoice(id: "plan", name: "Plan")],
  reasoningEfforts: ["opus": ["low", "high"]])
let options = CreationOptions(sessionId: "s", project: CreateProject(id: "p1", machineId: "m1", name: "P"), agents: [codex, claude], capabilities: [claudeCapability])

// Every project picker scopes local projects and groups to the selected computer.
do {
  var form = CreateSessionForm(projects: [
    CreateProject(id: "m1:local:a", machineId: "m1", name: "A"),
    CreateProject(id: "m2:local:b", machineId: "m2", name: "B"),
    CreateProject(id: "github:owner/repo", machineId: "", name: "Repo"),
    CreateProject(id: "group:bound", machineId: "m1", name: "Bound"),
    CreateProject(id: "group:any", machineId: "", name: "Anywhere"),
  ])
  form.current.machineId = "m2"
  form.current.projectId = "m1:local:a"
  check(form.availableProjects.map(\.id) == ["m2:local:b", "github:owner/repo", "group:any"],
    "other computers' projects stay out even when selected")
  form.current.machineId = "m1"
  check(form.availableProjects.map(\.id) == ["m1:local:a", "github:owner/repo", "group:bound", "group:any"],
    "switching computers changes the complete picker scope")
}

// Chat context is remembered without overwriting the last project.
do {
  let project = CreateLogic.withSelection(nil, target: "p1", selection: ProjectPrefs(machineId: "m1", agentKey: "m1:c1"), chat: false)
  let chat = CreateLogic.withSelection(project, target: "chat", selection: ProjectPrefs(machineId: "m2", agentKey: "m2:c2"), chat: true)
  check(chat.context == "chat", "chat context")
  check(chat.projectId == "p1", "chat keeps project")
  check(CreateLogic.restoreSelection(chat, target: "chat", options: options).agentKey == "m2:c2", "chat agent restored")
}

// The sheet opens on the project page unless chat is requested.
do {
  var form = CreateSessionForm(projects: [CreateProject(id: "p1", machineId: "m1", name: "P")], prefs: CreatePrefs(context: "chat"))
  form.open(projectId: nil, context: nil)
  check(!form.current.chat && !form.locked, "project page opens by default")
  form.open(projectId: "p1", context: nil)
  check(form.locked, "an explicit project locks the sheet")
  form.open(projectId: nil, context: "chat")
  check(form.current.chat && !form.locked, "chat context")
}

// Remembered agent and model per project, dropping choices the machine no longer offers.
do {
  let prefs = CreateLogic.withSelection(CreatePrefs(projectId: "old"), target: "p1", selection: ProjectPrefs(
    modelId: "opus", effort: "high", modeId: "plan", machineId: "m2", agentKey: "m2:c2"), chat: false)
  check(prefs.projectId == "p1", "project remembered")
  check(CreateLogic.rememberedProject(prefs, [CreateProject(id: "p1", machineId: "m1", name: "P")]) == "p1", "project found")
  check(CreateLogic.rememberedProject(prefs, [CreateProject(id: "p9", machineId: "m1", name: "Gone")]) == nil, "missing project")
  let restored = CreateLogic.restoreSelection(prefs, target: "p1", options: options)
  check(restored.machineId == "m2" && restored.agentKey == "m2:c2", "agent restored")
  check(restored.choice == ModelChoice(modelId: "opus", effort: "high", modeId: "plan"), "choice restored")
  let stale = CreateLogic.withSelection(prefs, target: "p1", selection: ProjectPrefs(
    modelId: "gone", effort: "high", modeId: "plan", machineId: "m2", agentKey: "m2:removed"), chat: false)
  let fallback = CreateLogic.restoreSelection(stale, target: "p1", options: options)
  check(fallback.agentKey == "m2:c2" && fallback.choice == ModelChoice(), "stale choices dropped")
  let empty = CreateLogic.restoreSelection(nil, target: "p1", options: options)
  check(empty.agentKey == "m1:c1" && empty.choice == ModelChoice(), "first agent by default")
  check(CreateLogic.restoreSelection(prefs, target: "other", options: options).agentKey == "m1:c1", "per project")
}

// Each model is remembered across projects and serialization, without leaking agent choices.
do {
  var capability = claudeCapability
  capability.models = [CapabilityChoice(id: "opus", name: ""), CapabilityChoice(id: "sonnet", name: "")]
  capability.modes = [CapabilityChoice(id: "plan", name: ""), CapabilityChoice(id: "bypassPermissions", name: "")]
  capability.reasoningEfforts = ["opus": ["low", "high"], "sonnet": ["low", "high"]]
  var prefs = CreateLogic.withSelection(nil, target: "p1", selection: ProjectPrefs(modelId: "opus", effort: "high", modeId: "plan", agentKey: "m2:c2"), chat: false)
  check(CreateLogic.rememberedModelChoice(prefs, agentKey: "m2:c2", capability: capability, modelId: "sonnet")
    == ModelChoice(modelId: "sonnet", modeId: "bypassPermissions"), "new model defaults to full access")
  prefs = roundTrip(CreateLogic.withSelection(prefs, target: "p2", selection: ProjectPrefs(modelId: "sonnet", effort: "low", modeId: "bypassPermissions", agentKey: "m2:c2"), chat: false))!
  check(CreateLogic.rememberedModelChoice(prefs, agentKey: "m2:c2", capability: capability, modelId: "opus")
    == ModelChoice(modelId: "opus", effort: "high", modeId: "plan"), "model memory survives JSON")
  let other = CreateLogic.rememberedModelChoice(prefs, agentKey: "another-agent", capability: capability, modelId: "opus")
  check(other.modeId == "bypassPermissions" && other.effort == nil, "no leak across agents")
  var removed = capability
  removed.reasoningEfforts = [:]
  removed.modes = [CapabilityChoice(id: "bypassPermissions", name: "")]
  check(CreateLogic.rememberedModelChoice(prefs, agentKey: "m2:c2", capability: removed, modelId: "opus")
    == ModelChoice(modelId: "opus", modeId: "bypassPermissions"), "removed effort and mode dropped")
  prefs = CreateLogic.withSelection(prefs, target: "p1", selection: ProjectPrefs(modelId: "opus", agentKey: "m2:c2"), chat: false)
  check(CreateLogic.rememberedModelChoice(roundTrip(prefs), agentKey: "m2:c2", capability: capability, modelId: "opus").modeId == nil,
    "explicit assistant default is remembered")
}

// Full access defaults only use modes the assistant offers; legacy project prefs still restore.
do {
  for id in CreateLogic.fullAccessModes {
    var capability = claudeCapability
    capability.modes = [CapabilityChoice(id: "plan", name: ""), CapabilityChoice(id: id, name: "")]
    check(CreateLogic.rememberedModelChoice(nil, agentKey: "agent", capability: capability).modeId == id, "full access \(id)")
  }
  check(CreateLogic.rememberedModelChoice(nil, agentKey: "agent", capability: claudeCapability).modeId == nil, "no full access mode")
  let legacy = CreatePrefs(projects: ["p1": ProjectPrefs(modelId: "opus", effort: "high", modeId: "plan", agentKey: "m2:c2")])
  check(CreateLogic.restoreSelection(legacy, target: "p1", options: options).choice.modeId == "plan", "legacy prefs")
}

// Permission, boolean and custom choices survive serialization, scoped to agent and model.
do {
  func select(_ id: String, _ values: [String], _ category: String? = nil) -> ConfigOption {
    ConfigOption(id: id, name: id, category: category ?? id, type: "select", options: values.map { CapabilityChoice(id: $0, name: $0) })
  }
  var capability = claudeCapability
  capability.reasoningEfforts = [:]
  capability.configOptions = [
    select("permission_mode", ["ask", "always-approve"], "_permission"),
    ConfigOption(id: "fast", name: "fast", type: "boolean"),
    select("agent_preset", ["standard", "coder"]),
    select("effort", ["low", "high"], "thought_level"),
  ]
  let values: [String: ConfigValue] = ["permission_mode": .string("always-approve"), "fast": .bool(false), "agent_preset": .string("coder")]
  var prefs = CreateLogic.withSelection(nil, target: "p1", selection: ProjectPrefs(modelId: "a", effort: "high", configOptionValues: values, agentKey: "grok"), chat: false)
  prefs = roundTrip(CreateLogic.withSelection(prefs, target: "p2", selection: ProjectPrefs(modelId: "b", configOptionValues: ["permission_mode": .string("ask")], agentKey: "grok"), chat: false))!
  let restored = CreateLogic.rememberedModelChoice(prefs, agentKey: "grok", capability: capability, modelId: "a")
  check(restored.configOptionValues == values, "config values survive JSON")
  check(restored.effort == "high", "config-only effort")
  check(CreateLogic.effortsFor(capability, modelId: "a") == ["low", "high"], "thought level efforts")
  check(CreateLogic.rememberedModelChoice(prefs, agentKey: "other-agent", capability: capability, modelId: "a").configOptionValues == nil, "scoped to agent")
  check(CreateLogic.rememberedModelChoice(prefs, agentKey: "grok", capability: capability, modelId: "c").configOptionValues == nil, "scoped to model")
  var changed = capability
  changed.configOptions = [select("permission_mode", ["ask"]), select("fast", ["on", "off"])]
  check(CreateLogic.rememberedModelChoice(prefs, agentKey: "grok", capability: changed, modelId: "a").configOptionValues == nil,
    "removed values and changed option types are discarded")
  prefs = CreateLogic.withSelection(prefs, target: "p1", selection: ProjectPrefs(modelId: "a", configOptionValues: [:], agentKey: "grok"), chat: false)
  check(CreateLogic.rememberedModelChoice(roundTrip(prefs), agentKey: "grok", capability: capability, modelId: "a").configOptionValues == nil,
    "Use default clears the remembered override")
}

// Legacy JSON preferences decode and restore unchanged.
do {
  let written = #"{"projectId":"p1","context":"project","modelChoices":{"[\"m2:c2\",\"opus\"]":{"modelId":"opus","effort":"high","modeId":"plan","configOptionValues":{"fast":true}}},"projects":{"p1":{"machineId":"m2","agentKey":"m2:c2","modelId":"opus","effort":"high","modeId":"plan"}}}"#
  let prefs = CreateJSON.decode(CreatePrefs.self, written)
  check(prefs?.projects?["p1"]?.agentKey == "m2:c2", "Legacy preferences decode")
  check(prefs?.modelChoices?[CreateLogic.modelKey("m2:c2", "opus")]?.configOptionValues?["fast"] == .bool(true), "model key matches JSON.stringify")
  check(CreateLogic.modelKey("m2:c2", nil) == #"["m2:c2",null]"#, "null model key")
  check(CreateLogic.modelKey("a/b", "x") == #"["a/b","x"]"#, "slashes are not escaped")
}

// The form builds a draft only for a ready agent, with branch and chat project rules.
do {
  let github = CreateProject(id: "github:Owner/Repo", machineId: "", name: "Owner/Repo")
  var form = CreateSessionForm(userId: "u", workspaceId: "w", projects: [github])
  form.open(projectId: nil, context: nil)
  check(form.draft(sessionId: "s1") == nil, "no draft before options")
  form.applyOptions(options)
  form.current.branch = " main "
  let draft = form.draft(sessionId: "s1")
  check(draft?.projectId == github.id && draft?.branch == "main" && draft?.agent == codex, "github draft")
  form.selectProject(nil)
  form.applyOptions(options)
  let chat = form.draft(sessionId: "s2")
  check(chat?.projectId == nil && chat?.branch == nil && chat?.projectName == "", "chat draft")
  check(form.prefs?.context == "chat", "page switch remembered")
}
// A failed/empty configuration can recover in the same form without retargeting a draft.
do {
  var form = CreateSessionForm(userId: "u", workspaceId: "w")
  form.open(projectId: nil, context: "chat")
  form.failOptions()
  check(!form.canSend && form.current.failed, "failed options disable sending")
  var empty = options
  empty.agents = []
  empty.availability = "offline"
  form.applyOptions(empty)
  check(!form.canSend && form.current.agent == nil, "empty successful response disables sending")
  form.applyOptions(options)
  check(form.canSend, "device return restores sending without reopening")
  let selected = form.current.agent!
  let choice = form.current.choice
  var different = options
  different.agents = options.agents.filter { $0.machineId != selected.machineId }
  form.applyOptions(different)
  check(!form.canSend && form.current.machineId == selected.machineId, "never move a draft to another device automatically")
  form.applyOptions(options)
  check(form.canSend && form.current.agent == selected && form.current.choice == choice, "selected device and configuration return")
  form.failOptions()
  check(!form.canSend, "a failed refresh must not enable sending with stale options")
  form.deferUnresolved = true
  check(form.canSend, "Share Extension can still defer unresolved selection to the app")
}
print("PASS: create-session form logic")

// Permission changes survive form preferences and preserve independent settings.
do {
  let permissions = [CapabilityChoice(id: "ask", name: "Ask"), CapabilityChoice(id: "auto", name: "Auto")]
  let selector = ConfigOption(id: "permission_mode", name: "Permission", category: "_permission", type: "select", currentValue: .string("ask"), options: permissions)
  var capability = Capability(machineId: "m1", cliType: "builtin", agentType: "codex", models: [CapabilityChoice(id: "a", name: "A")], modes: [CapabilityChoice(id: "plan", name: "Plan")], reasoningEfforts: ["a": ["high"]], configOptions: [selector])
  let choice = ModelChoice(modelId: "a", effort: "high", modeId: "plan", configOptionValues: ["fast": .bool(true)])
  let next = CreateLogic.withPermissionMode(capability, choice, value: "auto")
  check(next.modelId == "a" && next.effort == "high" && next.modeId == "plan", "permission preserves model, effort and interaction mode")
  check(next.configOptionValues?["fast"] == .bool(true), "permission preserves unrelated options")
  check(CreateLogic.permissionMode(capability, next)?.value == "auto", "permission displays chosen option")
  check(CreateLogic.withPermissionMode(capability, next, value: "removed") == next, "unsupported permission is ignored")
  var form = CreateSessionForm(userId: "u", workspaceId: "w")
  form.open(projectId: nil, context: "chat")
  form.applyOptions(CreationOptions(sessionId: "s", agents: [codex], capabilities: [capability]))
  form.updateChoice(next)
  check(form.draft(sessionId: "s")?.choice.configOptionValues?["permission_mode"] == .string("auto"), "permission enters first-turn draft")
  check(CreateLogic.rememberedModelChoice(roundTrip(form.prefs), agentKey: codex.key, capability: capability, modelId: "a").configOptionValues?["permission_mode"] == .string("auto"), "permission restores from persisted prefs")
  capability.configOptions = []
  capability.modes = permissions
  check(CreateLogic.withPermissionMode(capability, choice, value: "auto").modeId == "auto", "legacy permission uses modeId")
  capability.modes = permissions // Picker compatibility projection is not legacy ACP modes.
  capability.legacyModes = []
  capability.configOptions = [ConfigOption(id: "interaction_mode", name: "Interaction", category: "mode", type: "select", options: permissions)]
  check(CreateLogic.permissionMode(capability, choice) == nil, "interaction mode alone is not permission")
  capability.configOptions?.append(ConfigOption(id: "approval", name: "Approval", category: "mode", type: "select", options: permissions))
  let generic = CreateLogic.withPermissionMode(capability, choice, value: "auto")
  check(generic.configOptionValues?["approval"] == .string("auto"), "generic mode fallback uses config value")
}

do {
  var form = CreateSessionForm(userId: "u", workspaceId: "w")
  form.selectProject(CreateProject(id: "github:Owner/Repo", machineId: "", name: "Repo"))
  form.applyOptions(options)
  check(!form.canSend && form.draft(sessionId: "s") == nil, "GitHub must have an existing base branch before sending")
  form.applyBranches(CreateBranches(names: ["trunk", "develop"], defaultBranch: "trunk", nextPage: 2))
  check(form.canSend && form.current.branch == "trunk", "repository default is selected without typing")
  form.current.branch = "develop"
  form.applyBranches(CreateBranches(names: ["feature/Search", "develop"]))
  check(form.current.branch == "develop", "pagination never replaces an explicit choice")
  check(form.current.branches?.matching(" SEARCH ") == ["feature/Search"], "search matches later pages case-insensitively")
  check(form.current.branches?.matching("").first == "trunk", "default sorts first")
  check(form.current.branches?.names.count == 3 && form.current.branches?.nextPage == nil, "pages deduplicate and terminate")
  form.selectMachine("m2")
  check(form.current.branch == "develop" && form.draft(sessionId: "s")?.branch == "develop", "changing machines keeps selected GitHub branch in the draft")
  form.selectProject(CreateProject(id: "github:Owner/Empty", machineId: "", name: "Empty"))
  form.applyOptions(options)
  form.applyBranches(CreateBranches(names: []))
  check(form.current.branch.isEmpty && !form.canSend, "new empty repository cannot reuse previous branch")
  form.deferUnresolved = true
  check(form.canSend && form.draft(sessionId: "s") == nil, "offline share defers unresolved branch to the app")
}

// A computer picked before the one-shot response must survive cache and live hydration.
do {
  var form = CreateSessionForm(userId: "u", workspaceId: "w")
  form.open(projectId: nil, context: "chat")
  form.selectMachine("m2")
  form.applyCachedOptions(options)
  check(form.current.machineId == "m2" && form.current.agent == claude, "cache must not replace the explicitly picked computer")
  form.selectModel("opus")
  form.applyOptions(options)
  check(form.current.machineId == "m2" && form.current.choice.modelId == "opus", "live options preserve choices made while loading")
}

// Cached choices are displayable while live availability is still unverified.
do {
  var form = CreateSessionForm(userId: "u", workspaceId: "w", projects: [])
  form.open(projectId: nil, context: "chat")
  form.applyCachedOptions(options)
  check(form.current.options == options, "complete cached options restored")
  check(CreateJSON.decode(CreationOptions.self, CreateJSON.encode(options)) == options, "providers and complete capability lists survive persistence")
  check(!form.canSend, "cached options cannot authorize sending")
  form.failOptions()
  check(form.current.options == options && !form.canSend, "failed refresh retains cached choices")
  form.applyOptions(options)
  check(form.canSend, "live options unlock sending")
}


do {
  var form = CreateSessionForm(userId: "u", workspaceId: "w")
  let repo = CreateProject(id: "github:Owner/Repo", machineId: "", name: "Repo")
  form.selectProject(repo)
  form.applyBranches(CreateBranches(names: ["main", "feature"], defaultBranch: "main"))
  form.selectBranch("feature")
  let saved = roundTrip(form.prefs)
  var reopened = CreateSessionForm(userId: "u", workspaceId: "w", prefs: saved)
  reopened.selectProject(repo)
  reopened.applyCachedBranches(CreateBranches(names: ["main", "feature"], defaultBranch: "main"))
  check(reopened.current.branchesStale, "cached complete lists still need a first-page refresh")
  check(reopened.current.branch == "feature", "cached branch list restores last choice")
  reopened.selectBranch("main")
  reopened.applyBranches(CreateBranches(names: ["main", "new"], defaultBranch: "new", nextPage: 2), replacing: true)
  check(!reopened.current.branchesStale, "successful refresh clears stale state")
  check(reopened.current.branch == "main", "background refresh preserves user's new choice")
  check(reopened.current.branches?.names == ["main", "new"], "refresh replaces stale first page instead of retaining deleted branches")
  reopened.applyBranches(CreateBranches(names: ["later"]))
  check(reopened.current.branches?.names.contains("later") == true, "fresh pagination still appends")
  reopened.selectProject(CreateProject(id: "github:Other/Repo", machineId: "", name: "Other"))
  reopened.applyBranches(CreateBranches(names: ["trunk"], defaultBranch: "trunk"))
  check(reopened.current.branch == "trunk", "branch preferences are scoped by repository")
}

// An empty cache must not prevent the one live response from selecting an available agent.
do {
  var form = CreateSessionForm(userId: "u", workspaceId: "w")
  form.open(projectId: nil, context: "chat")
  form.selectMachine("m2")
  form.applyCachedOptions(CreationOptions(sessionId: "cached", agents: [], capabilities: []))
  form.applyOptions(options)
  check(form.current.agent == claude && form.canSend, "the one live response fills an agent missing from cache")
}

// Selecting a project or No project reuses one complete workspace snapshot.
do {
  let local = CreateProject(id: "m2:local:repo", machineId: "m2", name: "Repo", rootPath: "/repo")
  let github = CreateProject(id: "github:Owner/Repo", machineId: "", name: "Owner/Repo")
  var form = CreateSessionForm(userId: "u", workspaceId: "w", projects: [local, github])
  form.open(projectId: nil, context: "chat")
  form.applyOptions(options)
  form.selectProject(local)
  check(form.current.options == options && !form.current.loading, "project selection reuses the full snapshot")
  check(form.current.machineId == "m2" && form.current.agent == claude, "local project selects its owning computer")
  form.selectModel("opus")
  form.selectProject(github)
  form.applyBranches(CreateBranches(names: ["main"], defaultBranch: "main"))
  form.selectProject(nil)
  check(form.current.chat && form.current.options == options, "No project is the same form and snapshot")
  check(form.current.branch.isEmpty && form.current.branches == nil, "No project drops repository-only state")
  check(form.current.choice.modelId == "opus" && form.current.agent == claude, "project changes preserve the active run configuration")
  check(form.draft(sessionId: "one")?.projectId == nil && form.canSend, "No project creates a chat without another options request")
}

// Agent Roles (web chat landing): offered per computer, picking one sets its agent and pins,
// it names the composer only while still applied, and another computer clears it.
do {
  func target(_ machine: String, _ config: String, _ state: RuntimeContract.AgentRoleItemTargetsItemState = .configured) -> RuntimeContract.AgentRoleItemTargetsItem {
    .init(machineId: machine, agentConfigId: config,
          runConfig: .init(modelId: "opus", modeId: "plan", configOptionValues: ["reasoning_effort": .string("high"), "plan_mode": .bool(true)]),
          machineName: machine, agentName: config, state: state)
  }
  func role(_ id: String, _ name: String, _ targets: [RuntimeContract.AgentRoleItemTargetsItem], emoji: String? = nil) -> RuntimeContract.AgentRoleItem {
    .init(id: id, ownerUserId: "u", visibility: .workspace, name: name, description: "", promptPrefix: "Review.", emoji: emoji, revision: 4, updatedAt: 1, targets: targets)
  }
  var form = CreateSessionForm(userId: "u", workspaceId: "w")
  form.open(projectId: nil, context: "chat")
  form.applyOptions(options)
  form.selectMachine("m2")
  form.roles = [
    role("reviewer", "Reviewer", [target("m2", "c2")], emoji: "🧪"),
    role("gone", "Gone", [target("m2", "missing", .agentUnavailable)]),
    role("elsewhere", "Elsewhere", [target("m9", "c9")]),
  ]
  check(form.roleItems.map(\.role.id) == ["gone", "reviewer"], "only Roles bound to this computer, sorted by name")
  check(form.roleItems.first?.unavailable != nil, "an unavailable Role stays listed with its reason")
  form.selectRole("gone")
  check(form.current.roleId.isEmpty && form.activeRole == nil, "an unavailable Role is never picked")

  form.selectRole("reviewer")
  check(form.current.agent == claude, "picking a Role selects its agent")
  check(form.current.choice.modelId == "opus" && form.current.choice.modeId == "plan" && form.current.choice.effort == "high",
        "picking a Role seeds what it pins (the reasoning option as effort)")
  check(form.activeRole?.role.id == "reviewer" && form.roleItems.last?.glyph == "🧪", "the composer is the Role")
  var draft = form.draft(sessionId: "s1")
  check(draft?.agentRoleId == "reviewer" && draft?.agentRoleRevision == 4, "the draft carries the Role and its revision")

  form.current.choice.configOptionValues?["plan_mode"] = .bool(false)
  check(form.activeRole != nil, "an independent Plan toggle keeps the Role")
  form.current.choice.modelId = "other"
  check(form.activeRole == nil && form.draft(sessionId: "s2")?.agentRoleId == nil, "moving a pinned value ends the Role")

  form.selectRole("reviewer")
  form.selectRole(nil)
  check(form.activeRole == nil && form.current.choice.modelId == "opus", "None clears the name, not the values")
  form.selectRole("reviewer")
  form.selectMachine("m1")
  draft = form.draft(sessionId: "s3")
  check(form.current.roleId.isEmpty && draft?.agentRoleId == nil, "another computer clears the Role")
}

// Upstream combined reset regression: Fast must not swallow model/effort clears.
do {
  let capability = Capability(machineId: "m", cliType: "builtin", agentType: "codex", configOptions: [
    ConfigOption(id: "fast", name: "Fast", type: "boolean", currentValue: .bool(false)),
  ])
  let choice = ModelChoice(modelId: "a", effort: "high", modeId: "ask", configOptionValues: ["fast": .bool(true), "verbosity": .string("detailed")])
  let toggled = CreateLogic.applyingComposerChange(capability, choice, body: ["fast": false])
  check(toggled.modelId == "a" && toggled.effort == "high", "Fast-only toggles preserve model and effort")
  let reset = CreateLogic.applyingComposerChange(capability, choice, body: ["modelId": "", "effort": "", "fast": false])
  check(reset.modelId == nil && reset.effort == nil, "Combined reset clears both overrides")
  check(reset.configOptionValues?["fast"] == .bool(false), "Combined reset also resets Fast")
  check(reset.modeId == "ask" && reset.configOptionValues?["verbosity"] == .string("detailed"), "Unrelated options survive a reset")
}
