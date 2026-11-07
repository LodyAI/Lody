import Foundation
import LodyCore

@MainActor
struct SessionComposerService {
  /// A nil project reads the workspace-wide options (plain chats have no catalog project).
  var options: @MainActor (_ workspaceId: String, _ projectId: String?) async throws -> CreationOptions
  var tier: @MainActor (_ workspaceId: String, _ userId: String) async -> String?
  /// Agent Roles readable by this user (runtime `agentRoles` list).
  var roles: @MainActor (_ workspaceId: String) async throws -> [RuntimeContract.AgentRoleItem] = { _ in [] }

  static let live = SessionComposerService(
    options: { workspaceId, projectId in
      guard let runtime = DataRuntime.current else { throw OutboxError.scopeExpired }
      var body: [String: Any] = ["workspaceId": workspaceId]
      if let projectId { body["projectId"] = projectId }
      let payload = SessionController.json(body)
      let json: String = try await withCheckedThrowingContinuation { runtime.creationOptions(payload, sink: .continuation($0)) }
      guard let options = CreateJSON.decode(CreationOptions.self, json) else { throw OutboxError.invalidRecord }
      return options
    },
    tier: { workspaceId, userId in
      guard let runtime = DataRuntime.current, runtime.workspace == workspaceId, runtime.userId == userId else { return nil }
      return await runtime.billing.entitlement(workspace: workspaceId, user: userId)?["effectivePlanTier"] as? String
    },
    roles: { workspaceId in
      guard !LodyUIVerify.enabled, let runtime = DataRuntime.current, runtime.workspace == workspaceId else { return [] }
      return try await runtime.workspaceCall(RuntimeContract.Calls.AgentRoles.self) { workspace, userId in
        .list(.init(workspaceId: workspace, userId: userId))
      }.roles
    }
  )
}

@MainActor
final class SessionComposerModel {
  var changed: (() -> Void)?
  private(set) var capability: Capability?
  private(set) var tier: String?
  /// The session's provider mark; the composer's model chip leads with it (web's run-config chip).
  private(set) var agentAsset: String?
  private let service: SessionComposerService
  private var choice: ModelChoice
  private var hydrated: Bool
  private var restored = ""
  private var snapshotChoice: ModelChoice?
  private var capabilityKey: String?
  private var capabilityTask: Task<Void, Never>?
  private var tierKey = ""
  private var tierTimer: Timer?
  /// The conversation's agent: it never changes here (web locks the Agent row once a chat has history).
  private(set) var agentName: String?
  private var agentKind: (cliType: String, agentType: String) = ("", "")
  private var machineId = ""
  private var agentConfigId: String?
  /// Agent configs online on the conversation's computer, from the creation options.
  private var online: Set<String> = []
  /// Readable Roles; nil until listed, and then no Role is claimed either way.
  private var roles: [RuntimeContract.AgentRoleItem]?
  private var rolesKey = ""
  private var rolesTask: Task<Void, Never>?
  /// The Role picked in this composer; `.some(nil)` is an explicit None. Dropped once a newer
  /// turn lands (web fences its selection override by turn keys).
  private var pickedRole: String??
  /// The Role the latest turn ran as (runtime composer projection); `.some(nil)` after a None.
  private var durableRole: String??

  init(choice: ModelChoice?, service: SessionComposerService = .live) {
    self.choice = choice ?? ModelChoice()
    hydrated = choice != nil
    self.service = service
  }

  isolated deinit {
    capabilityTask?.cancel()
    rolesTask?.cancel()
    tierTimer?.invalidate()
  }

  var active: ModelChoice { hydrated ? choice : snapshotChoice ?? choice }
  var steerable: Bool { capability?.steer == true }

  func hydrate(pending: OutboxRecord?, ready: Bool, snapshot: ModelChoice?, role: String??) {
    snapshotChoice = snapshot
    if role != durableRole {
      durableRole = role
      pickedRole = nil
    }
    guard ready else { return }
    if let pending {
      guard restored != pending.sendId else { return }
      restored = pending.sendId
      hydrated = true
      choice = pending.send["choice"].flatMap(Self.choice) ?? ModelChoice()
      switch pending.send["agentRoleId"] {
      case .string(let id)?: pickedRole = .some(id)
      case .null?: pickedRole = .some(nil)
      default: break
      }
    } else if !hydrated, let snapshot {
      hydrated = true
      choice = snapshot
    }
  }

  func load(workspaceId: String, projectId: String?, session: SessionItem) {
    let key = [workspaceId, projectId ?? "", session.machineId, session.agentConfigId ?? "", session.cliType, session.agentType].joined(separator: "\n")
    guard key != capabilityKey else { return }
    agentAsset = LodyAgentIcon.asset(cliType: session.cliType, agentType: session.agentType)
    agentKind = (session.cliType, session.agentType)
    machineId = session.machineId
    agentConfigId = session.agentConfigId
    capabilityKey = key
    capabilityTask?.cancel()
    loadRoles(workspaceId)
    // A plain chat's `<machine>:unassigned` project is not in the catalog: still load the
    // workspace's options, or the composer loses its model, reasoning and permission controls.
    guard !workspaceId.isEmpty, !session.cliType.isEmpty, !session.agentType.isEmpty else {
      capability = nil
      return
    }
    let service = service
    capabilityTask = Task { [weak self] in
      let options = try? await service.options(workspaceId, projectId)
      guard let self, !Task.isCancelled, self.capabilityKey == key else { return }
      self.capability = options.flatMap {
        CreateLogic.capability(
          in: $0.capabilities, machineId: session.machineId, configId: session.agentConfigId,
          cliType: session.cliType, agentType: session.agentType)
      }
      let agents = (options?.agents ?? []).filter { $0.machineId == session.machineId }
      self.online = Set(agents.map(\.id))
      self.agentName = agents.first { $0.id == session.agentConfigId }?.name
        ?? agents.first { session.agentConfigId == nil && $0.cliType == session.cliType && $0.agentType == session.agentType }?.name
      self.changed?()
    }
  }

  private func loadRoles(_ workspaceId: String) {
    guard workspaceId != rolesKey else { return }
    rolesKey = workspaceId
    roles = nil
    rolesTask?.cancel()
    guard !workspaceId.isEmpty else { return }
    let service = service
    rolesTask = Task { [weak self] in
      guard let roles = try? await service.roles(workspaceId), let self, !Task.isCancelled, self.rolesKey == workspaceId else { return }
      self.roles = roles
      self.changed?()
    }
  }

  // MARK: Roles (web session composer)

  var roleItems: [CreateRoleItem] {
    SessionRoles.items(roles: roles ?? [], machineId: machineId, agentConfigId: agentConfigId, online: online)
  }

  var activeRole: CreateRoleItem? {
    SessionRoles.active(roleItems, picked: pickedRole, durable: durableRole, choice: active,
                        effortId: capability?.reasoningEffortConfigId)
  }

  /// Picking a Role applies the values it pins; None clears only its name (web).
  func selectRole(_ id: String?) {
    guard let id else {
      pickedRole = .some(nil)
      changed?()
      return
    }
    guard let item = roleItems.first(where: { $0.role.id == id }), item.unavailable == nil else { return }
    choice = SessionRoles.choice(applying: item, to: active, capability: capability)
    hydrated = true
    pickedRole = .some(id)
    changed?()
  }

  /// The next turn's Role (`agentRoleId`): the Role, an explicit None, or nothing to inherit.
  var sendRole: OutboxValue? {
    switch SessionRoles.send(loaded: roles != nil, active: activeRole, picked: pickedRole, durable: durableRole) {
    case .inherit: nil
    case .none: .null
    case .role(let id): .string(id)
    }
  }

  /// Web's mobile run-config sheet in a conversation: Role, the locked Agent, Model, Reasoning,
  /// Mode, then the Plan and Fast switches when the agent offers them.
  var runConfig: [CreatePicker] {
    let value = active
    var rows: [CreatePicker] = []
    let text = { (key: String) in String(localized: String.LocalizationValue(key), bundle: .lody) }
    if roles != nil {
      let current = activeRole
      let none = CreateOption(id: CreateSessionContext.roleNoneOption, title: text("create.role.none"), glyph: .emoji(""), selected: current == nil)
      rows.append(CreatePicker(
        id: "role", glyph: current.map { CreateGlyph.emoji($0.glyph) } ?? .lody(.user), title: current?.role.name ?? text("create.role.none"),
        placeholder: current == nil,
        options: [none] + roleItems.map { item in
          CreateOption(
            id: item.role.id, title: item.role.name, subtitle: item.unavailable.map(text) ?? "",
            glyph: .emoji(item.glyph), selected: item.role.id == current?.role.id, disabled: item.unavailable != nil)
        }))
    }
    // No options: the row shows the conversation's agent and cannot be opened.
    rows.append(CreatePicker(
      id: "agent", glyph: Self.agentGlyph(agentKind.cliType, agentKind.agentType),
      title: agentName ?? text("create.row.selectAgent"), placeholder: agentName == nil))
    guard let capability else { return rows }
    if !capability.models.isEmpty {
      let current = capability.models.first { $0.id == value.modelId }
      rows.append(CreatePicker(
        id: "model", glyph: .symbol("cpu"), title: current?.name ?? text("model.default"), placeholder: current == nil,
        options: capability.models.map { CreateOption(id: $0.id, title: $0.name, selected: $0.id == value.modelId) },
        searchPlaceholder: text("create.context.searchModels")))
    }
    let efforts = CreateLogic.effortsFor(capability, modelId: value.modelId)
    if !efforts.isEmpty {
      rows.append(CreatePicker(
        id: "effort", glyph: .symbol("brain"), title: value.effort ?? text("model.default"), placeholder: value.effort == nil,
        options: efforts.map { CreateOption(id: $0, title: $0, selected: $0 == value.effort) }))
    }
    if let permission = CreateLogic.permissionMode(capability, value), !permission.options.isEmpty {
      let current = permission.options.first { $0.id == permission.value }
      rows.append(CreatePicker(
        id: "permission", glyph: .symbol("checkmark.shield"), title: current?.name ?? text("model.default"), placeholder: current == nil,
        options: permission.options.map { CreateOption(id: $0.id, title: $0.name, subtitle: $0.description ?? "", selected: $0.id == permission.value) }))
    }
    if let plan = CreateLogic.planMode(capability, value) {
      rows.append(CreatePicker(id: "plan", glyph: .symbol("checklist"), title: "", toggle: plan.enabled))
    }
    if let fast = CreateLogic.fastMode(capability, value) {
      rows.append(CreatePicker(id: "fast", glyph: .symbol("bolt"), title: "", toggle: fast.enabled))
    }
    return rows
  }

  /// A row picked in the run-config sheet.
  func pick(_ row: String, _ option: String) {
    switch row {
    case "role": selectRole(option == CreateSessionContext.roleNoneOption ? nil : option)
    case "model": change(["modelId": option, "effort": ""])
    case "effort": change(["modelId": active.modelId ?? "", "effort": option])
    case "permission": change(["permissionId": option])
    case "fast": change(["fast": option == CreateSessionContext.toggleOn])
    case "plan":
      hydrated = true
      choice = CreateLogic.withPlanMode(capability, active, enabled: option == CreateSessionContext.toggleOn)
      changed?()
    default: break
    }
  }

  private static func agentGlyph(_ cliType: String, _ agentType: String) -> CreateGlyph {
    switch LodyAgentIcon.mark(cliType: cliType, agentType: agentType) {
    case .asset(let name): .asset(name)
    case .terminal: .lody(.terminal)
    case .generic: .lody(.agent)
    }
  }

  func watchTier(workspaceId: String, userId: String, watch: Bool) {
    let key = watch && !workspaceId.isEmpty && !userId.isEmpty ? "\(userId):\(workspaceId)" : ""
    guard key != tierKey else { return }
    tierKey = key
    tier = nil
    tierTimer?.invalidate()
    tierTimer = nil
    guard !key.isEmpty else { return }
    refreshTier(workspaceId, userId, key)
    tierTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.refreshTier(workspaceId, userId, key) }
    }
  }

  private func refreshTier(_ workspaceId: String, _ userId: String, _ key: String) {
    let service = service
    Task { [weak self] in
      let tier = await service.tier(workspaceId, userId)
      guard let self, self.tierKey == key else { return }
      self.tier = ["free", "plus", "enterprise"].contains(tier ?? "") ? tier : nil
      self.changed?()
    }
  }

  var optionsJSON: String {
    let value = active
    let permission = CreateLogic.permissionMode(capability, value)
    var options: [String: Any] = [
      "permissionId": permission?.value ?? "",
      "permissions": (permission?.options ?? []).map { ["id": $0.id, "title": $0.name, "description": $0.description ?? ""] },
      "modelId": value.modelId ?? "",
      "effort": value.effort ?? "",
      "models": (capability?.models ?? []).map { ["id": $0.id, "title": $0.name] },
      "efforts": CreateLogic.effortsFor(capability, modelId: value.modelId).map { ["id": $0, "title": $0] },
    ]
    options["fast"] = CreateLogic.fastMode(capability, value)?.enabled
    options["agentAsset"] = agentAsset
    options["agentName"] = agentName
    if let role = activeRole {
      options["roleEmoji"] = role.glyph
      options["roleName"] = role.role.name
    }
    return SessionController.json(options)
  }

  func change(_ body: [String: Any]) {
    hydrated = true
    choice = CreateLogic.applyingComposerChange(capability, active, body: body)
    changed?()
  }

  var sendChoice: [String: OutboxValue] {
    let value = active
    var result: [String: OutboxValue] = [:]
    let explicit = capability != nil
    for (key, field) in [("modelId", value.modelId), ("effort", value.effort)] {
      if let field { result[key] = .string(field) } else if explicit { result[key] = .null }
    }
    if let mode = value.modeId { result["modeId"] = .string(mode) }
    if let values = value.configOptionValues {
      result["configOptionValues"] = .object(values.mapValues { config in
        switch config {
        case .string(let text): .string(text)
        case .bool(let flag): .bool(flag)
        }
      })
    }
    if let config = capability?.reasoningEffortConfigId { result["reasoningEffortConfigId"] = .string(config) }
    return result
  }

  static func choice(_ value: OutboxValue) -> ModelChoice? {
    guard let data = try? JSONEncoder().encode(value) else { return nil }
    return try? JSONDecoder().decode(ModelChoice.self, from: data)
  }
}
