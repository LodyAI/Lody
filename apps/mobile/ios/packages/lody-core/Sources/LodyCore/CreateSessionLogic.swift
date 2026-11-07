import Foundation

public enum CreateLogic {
  public static let chatTarget = "chat"
  public static let fullAccessModes = ["agent-full-access", "danger-full-access", "bypassPermissions", "yolo", "always-approve"]

  public static func isThoughtLevel(_ option: ConfigOption) -> Bool {
    option.type == "select" && (option.category == "thought_level" || option.id == "reasoning_effort")
  }

  public static func extraConfigOptions(_ capability: Capability?) -> [ConfigOption] {
    (capability?.configOptions ?? []).filter { option in
      !(option.type == "select" && ["model", "mode"].contains(option.category ?? "")) && !isThoughtLevel(option)
    }
  }

  public static func validConfigValue(_ option: ConfigOption, _ value: ConfigValue?) -> Bool {
    switch value {
    case .bool: option.type == "boolean"
    case .string(let id): option.type != "boolean" && option.options.contains { $0.id == id }
    case nil: false
    }
  }

  public static func effortsFor(_ capability: Capability?, modelId: String? = nil) -> [String] {
    var model = modelId
    if model == nil, case .string(let current)? = capability?.configOptions?.first(where: { $0.category == "model" })?.currentValue {
      model = current
    }
    if let model, let efforts = capability?.reasoningEfforts[model] { return efforts }
    return capability?.configOptions?.first(where: isThoughtLevel)?.options.map(\.id) ?? []
  }

  public static func capabilityFor(_ options: CreationOptions?, _ agent: CreationAgent?) -> Capability? {
    guard let options, let agent else { return nil }
    return capability(in: options.capabilities, machineId: agent.machineId, configId: agent.id, cliType: agent.cliType, agentType: agent.agentType)
  }

  /// The capability probed for this agent config (ACP provider); runtimes that predate per-config
  /// capabilities only key them by agent type, so fall back to that.
  public static func capability(
    in capabilities: [Capability], machineId: String, configId: String?, cliType: String, agentType: String
  ) -> Capability? {
    if let configId, !configId.isEmpty,
      let exact = capabilities.first(where: { $0.machineId == machineId && $0.agentConfigId == configId }) {
      return exact
    }
    return capabilities.first {
      $0.machineId == machineId && $0.agentConfigId == nil && $0.cliType == cliType && $0.agentType == agentType
    }
  }

  public static func fastMode(_ capability: Capability?, _ choice: ModelChoice) -> (id: String, enabled: Bool)? {
    var model = choice.modelId
    if model == nil, case .string(let current)? = capability?.configOptions?.first(where: { $0.category == "model" })?.currentValue { model = current }
    if let model, capability?.fastModes?[model] == false { return nil }
    guard let option = capability?.configOptions?.first(where: { ["fast-mode", "fast"].contains($0.id) && $0.type == "boolean" })
    else { return nil }
    let value = choice.configOptionValues?[option.id] ?? option.currentValue
    return (option.id, value == .bool(true))
  }

  public static func withFastMode(_ capability: Capability?, _ choice: ModelChoice, enabled: Bool) -> ModelChoice {
    guard let mode = fastMode(capability, choice) else { return choice }
    var next = choice
    next.configOptionValues = (choice.configOptionValues ?? [:]).merging([mode.id: .bool(enabled)]) { $1 }
    return next
  }

  /// A combined reset is one change; a Fast-only toggle preserves model and effort.
  public static func applyingComposerChange(_ capability: Capability?, _ choice: ModelChoice, body: [String: Any]) -> ModelChoice {
    if let permission = body["permissionId"] as? String {
      return withPermissionMode(capability, choice, value: permission)
    }
    var next = choice
    let fast = body["fast"] as? Bool
    if let fast { next = withFastMode(capability, next, enabled: fast) }
    if fast == nil || body["modelId"] != nil || body["effort"] != nil {
      next.modelId = (body["modelId"] as? String).flatMap { $0.isEmpty ? nil : $0 }
      next.effort = (body["effort"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    }
    return next
  }

  /// Web's Plan switch (`isAcpPlanModeConfigOption`): Lody's boolean `plan_mode`, or a
  /// collaboration mode whose `plan` value turns it on and `default` off.
  public static func planMode(_ capability: Capability?, _ choice: ModelChoice) -> (id: String, enabled: Bool)? {
    guard let option = capability?.configOptions?.first(where: { option in
      (option.id == "plan_mode" && option.type == "boolean")
        || ((option.id == "collaboration_mode" || option.category == "collaboration_mode") && option.type == "select"
          && option.options.contains { $0.id == "plan" })
    }) else { return nil }
    let value = choice.configOptionValues?[option.id] ?? option.currentValue
    return (option.id, value == .bool(true) || value == .string("plan"))
  }

  public static func withPlanMode(_ capability: Capability?, _ choice: ModelChoice, enabled: Bool) -> ModelChoice {
    guard let mode = planMode(capability, choice),
          let option = capability?.configOptions?.first(where: { $0.id == mode.id }) else { return choice }
    let value: ConfigValue = option.type == "boolean" ? .bool(enabled) : .string(enabled ? "plan" : "default")
    var next = choice
    next.configOptionValues = (choice.configOptionValues ?? [:]).merging([mode.id: value]) { $1 }
    return next
  }

  // Same precedence as OSS resolvePermissionModeFace and the chat projection.
  public static func permissionMode(_ capability: Capability?, _ choice: ModelChoice)
    -> (options: [CapabilityChoice], value: String?, configId: String?)?
  {
    let selectors = (capability?.configOptions ?? []).filter { $0.type == "select" }
    var option = selectors.first { $0.id == "permission_mode" || $0.category == "_permission" }
    if option == nil, let modes = capability?.legacyModes ?? capability?.modes, !modes.isEmpty {
      return (modes, choice.modeId, nil)
    }
    if option == nil {
      option = selectors.first { $0.category == "mode" && $0.id != "interaction_mode" && !isThoughtLevel($0) }
    }
    guard let option, !option.options.isEmpty else { return nil }
    let selected = choice.configOptionValues?[option.id]
    let current = validConfigValue(option, selected) ? selected : option.currentValue
    var value: String?
    if case .string(let id) = current { value = id }
    return (option.options, value, option.id)
  }

  public static func withPermissionMode(_ capability: Capability?, _ choice: ModelChoice, value: String) -> ModelChoice {
    guard let permission = permissionMode(capability, choice), permission.options.contains(where: { $0.id == value }) else { return choice }
    var next = choice
    if let id = permission.configId {
      next.configOptionValues = (choice.configOptionValues ?? [:]).merging([id: .string(value)]) { $1 }
    } else {
      next.modeId = value
    }
    return next
  }

  public static func rememberedProject(_ prefs: CreatePrefs?, _ projects: [CreateProject]) -> String? {
    projects.first { $0.id == prefs?.projectId }?.id
  }

  public static func modelKey(_ agentKey: String, _ modelId: String?) -> String {
    CreateJSON.encode([agentKey, modelId].map { $0.map(JSONScalar.string) ?? .null })
  }

  public static func restoreSelection(_ prefs: CreatePrefs?, target: String, options: CreationOptions)
    -> (machineId: String, agentKey: String, choice: ModelChoice)
  {
    let saved = prefs?.projects?[target] ?? ProjectPrefs()
    let agent = options.agents.first { $0.key == saved.agentKey }
      ?? options.agents.first { $0.machineId == saved.machineId }
      ?? options.agents.first
    let capability = capabilityFor(options, agent)
    let modelId = capability?.models.contains { $0.id == saved.modelId } == true ? saved.modelId : nil
    return (
      agent?.machineId ?? "",
      agent?.key ?? "",
      rememberedModelChoice(prefs, agentKey: agent?.key ?? "", capability: capability, modelId: modelId, legacy: saved)
    )
  }

  public static func rememberedModelChoice(
    _ prefs: CreatePrefs?, agentKey: String, capability: Capability?, modelId: String? = nil, legacy: ProjectPrefs? = nil
  ) -> ModelChoice {
    let remembered = prefs?.modelChoices?[modelKey(agentKey, modelId)]
    let saved = remembered ?? (legacy?.agentKey == agentKey && legacy?.modelId == modelId ? legacy?.choice : nil)
    let effort = saved?.effort.flatMap { effortsFor(capability, modelId: modelId).contains($0) ? $0 : nil }
    var modeId = saved?.modeId
    if (remembered == nil && modeId == nil) || (modeId != nil && capability?.modes.contains { $0.id == modeId } != true) {
      modeId = capability?.modes.first { fullAccessModes.contains($0.id) }?.id
    }
    var values: [String: ConfigValue] = [:]
    // Mode config values selected by the composer must survive reopening too.
    for option in capability?.configOptions ?? [] where option.category != "model" && !isThoughtLevel(option) {
      let value = saved?.configOptionValues?[option.id]
      if validConfigValue(option, value) { values[option.id] = value }
    }
    return ModelChoice(modelId: modelId, effort: effort, modeId: modeId, configOptionValues: values.isEmpty ? nil : values)
  }

  public static func withSelection(_ prefs: CreatePrefs?, target: String, selection: ProjectPrefs, chat: Bool) -> CreatePrefs {
    var next = prefs ?? CreatePrefs()
    next.context = chat ? "chat" : "project"
    if !chat { next.projectId = target }
    var models = next.modelChoices ?? [:]
    models[modelKey(selection.agentKey ?? "", selection.modelId)] = selection.choice
    next.modelChoices = models
    var projects = next.projects ?? [:]
    projects[target] = selection
    next.projects = projects
    return next
  }
}

enum JSONScalar: Encodable {
  case string(String)
  case null

  func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .null: try container.encodeNil()
    }
  }
}
