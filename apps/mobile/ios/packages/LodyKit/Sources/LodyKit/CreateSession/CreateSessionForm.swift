import LodyCore
import Foundation

struct CreateSessionSelection: Equatable {
  var chat: Bool { projectId.isEmpty }
  var projectId = ""
  var options: CreationOptions?
  var machineId = ""
  var agentKey = ""
  var choice = ModelChoice()
  /// The Agent Role last picked; it names the composer only while still applied (`activeRole`).
  var roleId = ""
  var branch = ""
  var branches: CreateBranches?
  var branchesStale = false
  var branchesLoading = false
  var branchesFailed = false
  /// Local projects only: start the session in a new git worktree (web's workdir mode). GitHub
  /// sessions always run in a worktree.
  var worktree = false
  var loading = true
  var failed = false

  var target: String { chat ? CreateLogic.chatTarget : projectId }
  var github: Bool { !chat && projectId.hasPrefix("github:") }
  /// A multi-repository project (web Project group): every member, worktrees on its computer.
  var group: Bool { !chat && projectId.hasPrefix(Self.groupPrefix) }
  var local: Bool { !chat && !projectId.isEmpty && !github && !group }
  static let groupPrefix = "group:"

  // The workspace snapshot covers every machine; the selected project determines the target.
  var machines: [(id: String, name: String)] {
    var seen = Set<String>()
    return (options?.agents ?? []).compactMap { agent in
      seen.insert(agent.machineId).inserted ? (agent.machineId, agent.machineName) : nil
    }
  }
  var machine: (id: String, name: String)? {
    if machineId.isEmpty { return machines.first }
    return machines.first { $0.id == machineId }
  }
  var unavailableMessage: String? {
    unavailableKey.map { String(localized: String.LocalizationValue($0), bundle: .lody) }
  }
  /// The read failed, or listed no assistant: the page note ("Tap to retry") reads the options again.
  var retriesOptions: Bool { unavailableKey == "create.devices.failed" || unavailableKey == "create.devices.noAgents" }
  private var unavailableKey: String? {
    if failed { return "create.devices.failed" }
    if options?.availability == "unknown" { return "devices.unknown" }
    if !machineId.isEmpty && machine == nil {
      return !chat && !github ? "create.devices.projectOffline" : "create.devices.selectedOffline"
    }
    if options?.availability == "offline" {
      return !chat && !github ? "create.devices.projectOffline" : "create.devices.offline"
    }
    if !agents.isEmpty && agent == nil { return "create.devices.chooseAgent" }
    if options != nil && agent == nil { return "create.devices.noAgents" }
    return nil
  }
  var agents: [CreationAgent] { (options?.agents ?? []).filter { $0.machineId == machine?.id } }
  var agent: CreationAgent? { agents.first { $0.key == agentKey } }
  var capability: Capability? { CreateLogic.capabilityFor(options, agent) }
}

struct CreateSessionDraft: Codable, Equatable {
  var sessionId: String
  var userId: String
  var workspaceId: String
  var projectId: String?
  var projectName: String
  var branch: String?
  var agent: CreationAgent
  var choice: ModelChoice
  var reasoningEffortConfigId: String?
  /// The Role the first turn runs as; the runtime re-reads its row (web: provenance at its revision).
  var agentRoleId: String?
  var agentRoleRevision: Int?
  /// Local project in a new git worktree; nil keeps drafts saved before the field decodable.
  var useWorktree: Bool?
}

struct CreateSessionForm {
  var userId = ""
  var workspaceId = ""
  var projects: [CreateProject] = []
  var machineNames: [String: String] = [:]
  /// Computer id to OS, for the computer's icon.
  var machineOs: [String: String] = [:]
  var prefs: CreatePrefs?
  /// The workspace's Agent Roles readable by this user; nil until listed (no Role row then).
  var roles: [RuntimeContract.AgentRoleItem]?
  /// Members per multi-repository project, by project id (`group:<uuid>`), for the picker.
  var groupMembers: [String: Int] = [:]
  var locked = false
  // Share Extension: a selection without cached options is sent and finished in the app.
  var deferUnresolved = false
  var signedOut = false
  var current = CreateSessionSelection()

  var prefsTarget: String { current.target }

  /// Shared by recent, search and the full picker. Unbound groups and GitHub repositories
  /// can run on any computer; local projects and bound groups stay on their own computer.
  var availableProjects: [CreateProject] {
    let machine = current.machine?.id ?? current.machineId
    return projects.filter {
      $0.id.hasPrefix("github:") || machine.isEmpty || $0.machineId == machine
        || ($0.id.hasPrefix(CreateSessionSelection.groupPrefix) && $0.machineId.isEmpty)
    }
  }

  mutating func open(projectId: String?, context: String?) {
    let selected = context == "chat" ? nil : (projectId
      ?? CreateLogic.rememberedProject(prefs, projects)
      ?? projects.first?.id)
    locked = projectId != nil && context != "chat"
    current = CreateSessionSelection(projectId: selected ?? "")
    if current.local { current.machineId = projects.first { $0.id == selected }?.machineId ?? "" }
  }

  mutating func applyCachedOptions(_ options: CreationOptions) {
    applyOptions(options)
    // Cache is for display only; live validation still controls Send.
    current.loading = true
  }

  mutating func applyOptions(_ options: CreationOptions) {
    let previous = current
    current.options = options
    current.loading = false
    current.failed = false
    let restored = CreateLogic.restoreSelection(prefs, target: current.target, options: options)
    current.machineId = restored.machineId
    current.agentKey = restored.agentKey
    current.choice = restored.choice
    // Preserve a computer picked while loading, including before the cache arrives.
    if !previous.machineId.isEmpty {
      current.machineId = previous.machineId
      current.agentKey = previous.agentKey
      if previous.agentKey.isEmpty {
        if current.agents.contains(where: { $0.key == restored.agentKey }) {
          current.agentKey = restored.agentKey
          current.choice = restored.choice
          return
        }
        // The computer's own last agent and choice, as when it is picked.
        let machine = CreateLogic.restoreMachine(prefs, machineId: current.machine?.id ?? previous.machineId, options: options)
        current.agentKey = machine.agentKey
        current.choice = machine.choice
        return
      }
      current.choice = previous.choice
      if let agent = current.agent {
        current.choice = CreateLogic.rememberedModelChoice(
          prefs, agentKey: agent.key, capability: current.capability, modelId: previous.choice.modelId)
      }
    }
  }

  mutating func failOptions() {
    current.loading = false
    current.failed = true
  }

  /// One form and one workspace-wide options snapshot; changing project only changes selection.
  /// Lists the workspace's multi-repository projects (one that cannot run — local members on
  /// two computers — is left out), as projects pinned to their computer or to none.
  mutating func applyGroups(_ groups: [RuntimeContract.ProjectGroupItem]) {
    let runnable = groups.filter { !$0.conflict && $0.members.count > 1 }
    projects.removeAll { $0.id.hasPrefix(CreateSessionSelection.groupPrefix) }
    projects += runnable.map { CreateProject(id: CreateSessionSelection.groupPrefix + $0.id, machineId: $0.machineId ?? "", name: $0.name) }
    groupMembers = Dictionary(runnable.map { (CreateSessionSelection.groupPrefix + $0.id, $0.members.count) }, uniquingKeysWith: { first, _ in first })
  }

  mutating func selectProject(_ picked: CreateProject?) {
    if let picked, !projects.contains(where: { $0.id == picked.id }) { projects.append(picked) }
    let id = picked?.id ?? ""
    guard id != current.projectId else { return }
    current.projectId = id
    current.branch = ""
    current.branches = nil
    current.branchesStale = false
    current.branchesLoading = false
    current.branchesFailed = false
    current.worktree = false
    if current.local, let picked, picked.machineId != current.machineId { selectMachine(picked.machineId) }
    // A group with local members runs on their computer.
    if current.group, let picked, !picked.machineId.isEmpty, picked.machineId != current.machine?.id { selectMachine(picked.machineId) }
    var value = prefs ?? CreatePrefs()
    value.context = current.chat ? "chat" : "project"
    if let picked { value.projectId = picked.id }
    prefs = value
    updateChoice(current.choice)
  }

  mutating func applyCachedBranches(_ value: CreateBranches) {
    applyBranches(value)
    current.branchesStale = true
  }

  mutating func selectBranch(_ name: String) {
    guard current.branches?.names.contains(name) == true else { return }
    current.branch = name
    if prefs == nil { prefs = CreatePrefs() }
    if prefs?.branches == nil { prefs?.branches = [:] }
    prefs?.branches?[current.projectId] = name
  }

  mutating func applyBranches(_ value: CreateBranches, replacing: Bool = false) {
    if current.branches == nil || replacing { current.branches = value }
    else { current.branches?.append(value) }
    current.branchesStale = false
    current.branchesLoading = false
    current.branchesFailed = false
    if current.branch.isEmpty, let remembered = prefs?.branches?[current.projectId],
      current.branches?.names.contains(remembered) == true { current.branch = remembered }
    if current.branch.isEmpty, let name = current.branches?.defaultBranch,
      current.branches?.names.contains(name) == true { current.branch = name }
  }

  mutating func selectMachine(_ id: String) {
    // A Role binds one machine's agent exactly, so another computer clears it (web).
    current.roleId = ""
    // A group pinned to another computer cannot run here.
    if current.group, let pinned = projects.first(where: { $0.id == current.projectId })?.machineId, !pinned.isEmpty, pinned != id {
      current.projectId = ""
    }
    current.machineId = id
    // The last agent and choice used on this computer, else its first agent.
    let restored = CreateLogic.restoreMachine(prefs, machineId: id, options: current.options)
    current.agentKey = restored.agentKey
    updateChoice(restored.choice)
  }

  mutating func selectAgent(_ key: String) {
    current.agentKey = key
    let selected = current.options?.agents.first { $0.key == key }
    updateChoice(CreateLogic.rememberedModelChoice(
      prefs, agentKey: key, capability: CreateLogic.capabilityFor(current.options, selected)))
  }

  mutating func selectModel(_ modelId: String?) {
    updateChoice(CreateLogic.rememberedModelChoice(
      prefs, agentKey: current.agentKey, capability: current.capability, modelId: modelId))
  }

  mutating func updateChoice(_ next: ModelChoice) {
    current.choice = next
    guard let agent = current.agent else { return }
    prefs = CreateLogic.withSelection(prefs, target: prefsTarget, selection: ProjectPrefs(
      modelId: next.modelId, effort: next.effort, modeId: next.modeId, configOptionValues: next.configOptionValues,
      machineId: agent.machineId, agentKey: agent.key), chat: current.chat)
  }

  /// Records the configuration a chat is started with (web: on start, never on a knob change).
  mutating func recordRecent(at usedAt: Date = Date()) {
    guard let agent = current.agent else { return }
    prefs = CreateLogic.withRecent(prefs, RecentRunConfig(
      machineId: agent.machineId, agentKey: agent.key, choice: current.choice,
      agentRoleId: activeRole?.role.id, usedAt: usedAt.timeIntervalSince1970 * 1000))
  }

  /// Recent configurations offered now (web `buildRecentRunConfigItems`): on the selected
  /// computer, with the agent still offered and a recorded Role still runnable, excluding
  /// the current one.
  var recentRunConfigs: [(key: String, record: RecentRunConfig)] {
    guard let machine = current.machine else { return [] }
    let currentKey = current.agent.map {
      CreateLogic.recentKey(agentKey: $0.key, choice: current.choice, agentRoleId: activeRole?.role.id)
    }
    let runnableRoles = Set(roleItems.filter { $0.unavailable == nil }.map(\.role.id))
    var seen = Set<String>()
    var items: [(key: String, record: RecentRunConfig)] = []
    for record in prefs?.recents ?? [] where items.count < CreateLogic.maxVisibleRecents {
      let key = CreateLogic.recentKey(record)
      guard record.machineId == machine.id, key != currentKey, !seen.contains(key),
            current.agents.contains(where: { $0.key == record.agentKey }) else { continue }
      if let role = record.agentRoleId, !runnableRoles.contains(role) { continue }
      seen.insert(key)
      items.append((key, record))
    }
    return items
  }

  /// Applies one recent configuration whole. One recorded as a Role re-applies the Role,
  /// whose instruction and provenance ride with it, not just the values it set.
  mutating func selectRecent(_ key: String) {
    guard let record = recentRunConfigs.first(where: { $0.key == key })?.record else { return }
    if let role = record.agentRoleId { return selectRole(role) }
    guard let agent = current.agents.first(where: { $0.key == record.agentKey }) else { return }
    current.roleId = ""
    current.agentKey = agent.key
    updateChoice(CreateLogic.applicableChoice(record.choice, capability: CreateLogic.capabilityFor(current.options, agent)))
  }

  var canSend: Bool {
    !userId.isEmpty && !current.loading &&
      (deferUnresolved || (!current.failed && current.agent != nil && (!current.github || !current.branch.isEmpty)))
  }

  var notice: String {
    if signedOut { return "" }
    if !deferUnresolved, current.unavailableMessage != nil { return "" }
    if current.loading { return String(localized: "create.composer.loading", bundle: .lody) }
    if current.agent == nil {
      return String(localized: String.LocalizationValue(deferUnresolved ? "native.share.deferred" : "create.composer.needAgent"), bundle: .lody)
    }
    return ""
  }

  func draft(sessionId: String) -> CreateSessionDraft? {
    let page = current
    guard let agent = page.agent, !userId.isEmpty, !page.github || !page.branch.isEmpty else { return nil }
    let project = projects.first { $0.id == page.projectId }
    return CreateSessionDraft(
      sessionId: sessionId,
      userId: userId,
      workspaceId: workspaceId,
      projectId: page.chat ? nil : page.projectId,
      projectName: page.chat ? "" : (project?.name ?? page.options?.project?.name ?? ""),
      branch: page.github ? page.branch.trimmingCharacters(in: .whitespaces) : nil,
      agent: agent,
      choice: page.choice,
      reasoningEffortConfigId: page.capability?.reasoningEffortConfigId,
      agentRoleId: activeRole?.role.id,
      agentRoleRevision: activeRole?.role.revision,
      useWorktree: page.local && page.worktree ? true : nil
    )
  }
}

/// A Role offered on the selected computer (web `buildComposerAgentRoleItems`): bound to that
/// machine's target, listed even when it cannot run, with the reason.
struct CreateRoleItem: Equatable {
  let role: RuntimeContract.AgentRoleItem
  let target: RuntimeContract.AgentRoleItemTargetsItem
  /// Localization key of why it cannot run here; nil when it can.
  let unavailable: String?
  var glyph: String { role.emoji.flatMap { $0.isEmpty ? nil : $0 } ?? "🪼" }
}

extension CreateSessionForm {
  var roleItems: [CreateRoleItem] {
    guard let roles, let machine = current.machine else { return [] }
    return roles.compactMap { role -> CreateRoleItem? in
      guard let target = role.targets.first(where: { $0.machineId == machine.id }) else { return nil }
      var reason: String?
      switch target.state {
      case .machineUnavailable: reason = "create.role.unavailable.machine"
      case .agentUnavailable: reason = "create.role.unavailable.agent"
      default:
        let online = current.agents.contains { $0.id == target.agentConfigId }
        if !online { reason = "create.role.unavailable.offline" }
      }
      return CreateRoleItem(role: role, target: target, unavailable: reason)
    }
    .sorted { lhs, rhs in
      let order = lhs.role.name.localizedCompare(rhs.role.name)
      return order == .orderedSame ? lhs.role.id < rhs.role.id : order == .orderedAscending
    }
  }

  /// The Role the composer IS, not merely the last picked (web `isComposerAgentRoleApplied`):
  /// its agent and every value it pins are still what will run.
  var activeRole: CreateRoleItem? {
    guard !current.roleId.isEmpty, let item = roleItems.first(where: { $0.role.id == current.roleId }),
          item.unavailable == nil, let agent = current.agent,
          agent.id == item.target.agentConfigId, agent.machineId == item.target.machineId else { return nil }
    return Self.applied(item.target.runConfig, to: current.choice, effortId: current.capability?.reasoningEffortConfigId) ? item : nil
  }

  /// Picking a Role sets exactly what it says: its agent, then the values it pins. None clears
  /// only the name; the values it seeded stay the user's own (web).
  mutating func selectRole(_ id: String?) {
    guard let id else { current.roleId = ""; return }
    guard let item = roleItems.first(where: { $0.role.id == id }), item.unavailable == nil,
          let agent = current.agents.first(where: { $0.id == item.target.agentConfigId }) else { return }
    current.agentKey = agent.key
    let capability = CreateLogic.capabilityFor(current.options, agent)
    updateChoice(Self.choice(item.target.runConfig, effortId: capability?.reasoningEffortConfigId))
    current.roleId = id
  }

  /// A target's pins as the composer's choice; the reasoning option becomes `effort`.
  static func choice(_ pinned: RuntimeContract.AgentRoleItemTargetsItemRunConfig?, effortId: String?) -> ModelChoice {
    let effortKey = effortId ?? "reasoning_effort"
    var effort: String?
    var options: [String: ConfigValue] = [:]
    for (key, value) in pinned?.configOptionValues ?? [:] {
      switch value {
      case .string(let text) where key == effortKey: effort = text
      case .string(let text): options[key] = .string(text)
      case .bool(let flag): options[key] = .bool(flag)
      default: continue
      }
    }
    return ModelChoice(modelId: pinned?.modelId, effort: effort, modeId: pinned?.modeId, configOptionValues: options.isEmpty ? nil : options)
  }

  /// Runtime `roleRunConfigApplied` on the composer's choice: unpinned values are the agent's
  /// own, and independent Plan toggles keep the Role.
  static func applied(_ pinned: RuntimeContract.AgentRoleItemTargetsItemRunConfig?, to choice: ModelChoice, effortId: String?) -> Bool {
    guard let pinned else { return true }
    if let mode = pinned.modeId, choice.modeId != mode { return false }
    if let model = pinned.modelId, choice.modelId != model { return false }
    let effortKey = effortId ?? "reasoning_effort"
    for (key, value) in pinned.configOptionValues ?? [:] {
      let selected: RuntimeContract.JSONValue?
      if key == effortKey {
        selected = choice.effort.map { .string($0) }
      } else {
        switch choice.configOptionValues?[key] {
        case .string(let text): selected = .string(text)
        case .bool(let flag): selected = .bool(flag)
        case nil: selected = nil
        }
      }
      if key == "plan_mode", case .bool(_) = value, case .bool(_)? = selected { continue }
      let plan: (RuntimeContract.JSONValue?) -> Bool = { $0 == .string("plan") || $0 == .string("default") }
      if key == "collaboration_mode", plan(value), plan(selected) { continue }
      if selected != value { return false }
    }
    return true
  }
}
