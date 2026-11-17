import Foundation

// JSON shapes shared with src/models/send.ts and the LocalStore `create:` preferences.

public struct CreateProject: Codable, Equatable, Sendable {
  public var id: String
  public var machineId: String
  public var name: String
  public var rootPath = ""

  public init(id: String, machineId: String, name: String, rootPath: String = "") {
    self.id = id
    self.machineId = machineId
    self.name = name
    self.rootPath = rootPath
  }

  public init(from decoder: Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    machineId = try values.decodeIfPresent(String.self, forKey: .machineId) ?? ""
    name = try values.decodeIfPresent(String.self, forKey: .name) ?? id
    rootPath = try values.decodeIfPresent(String.self, forKey: .rootPath) ?? ""
  }
}

public struct CreationAgent: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var machineId: String
  public var machineName: String
  public var cliType: String
  public var agentType: String
  public var key: String { "\(machineId):\(id)" }

  public init(id: String, name: String, machineId: String, machineName: String, cliType: String, agentType: String) {
    self.id = id
    self.name = name
    self.machineId = machineId
    self.machineName = machineName
    self.cliType = cliType
    self.agentType = agentType
  }
}

public enum ConfigValue: Codable, Equatable, Sendable {
  case string(String)
  case bool(Bool)

  public init(from decoder: Decoder) throws {
    let container = try decoder.singleValueContainer()
    if let flag = try? container.decode(Bool.self) { self = .bool(flag) }
    else { self = .string(try container.decode(String.self)) }
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    switch self {
    case .string(let value): try container.encode(value)
    case .bool(let value): try container.encode(value)
    }
  }
}

public struct CapabilityChoice: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var description: String?

  public init(id: String, name: String, description: String? = nil) {
    self.id = id
    self.name = name
    self.description = description
  }
}

public struct ConfigOption: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var description: String?
  public var category: String?
  public var type: String
  public var currentValue: ConfigValue?
  public var options: [CapabilityChoice] = []

  public init(id: String, name: String, description: String? = nil, category: String? = nil, type: String, currentValue: ConfigValue? = nil, options: [CapabilityChoice] = []) {
    self.id = id
    self.name = name
    self.description = description
    self.category = category
    self.type = type
    self.currentValue = currentValue
    self.options = options
  }
}

public struct Capability: Codable, Equatable, Sendable {
  public var machineId: String
  /// The agent config (ACP provider) this was probed for. Capabilities are per config, as web:
  /// two providers of one agent type offer different models. Nil from older runtimes.
  public var agentConfigId: String?
  public var cliType: String
  public var agentType: String
  public var models: [CapabilityChoice] = []
  public var modes: [CapabilityChoice] = []
  public var legacyModes: [CapabilityChoice]?
  public var reasoningEfforts: [String: [String]] = [:]
  public var fastModes: [String: Bool]?
  public var reasoningEffortConfigId: String?
  public var configOptions: [ConfigOption]?
  public var steer: Bool?

  public init(machineId: String, agentConfigId: String? = nil, cliType: String, agentType: String, models: [CapabilityChoice] = [], modes: [CapabilityChoice] = [], legacyModes: [CapabilityChoice]? = nil, reasoningEfforts: [String: [String]] = [:], reasoningEffortConfigId: String? = nil, fastModes: [String: Bool]? = nil, configOptions: [ConfigOption]? = nil, steer: Bool? = nil) {
    self.machineId = machineId
    self.agentConfigId = agentConfigId
    self.cliType = cliType
    self.agentType = agentType
    self.models = models
    self.modes = modes
    self.legacyModes = legacyModes
    self.reasoningEfforts = reasoningEfforts
    self.fastModes = fastModes
    self.reasoningEffortConfigId = reasoningEffortConfigId
    self.configOptions = configOptions
    self.steer = steer
  }
}

public struct CreationOptions: Codable, Equatable, Sendable {
  public var availability: String? = nil
  public var sessionId: String
  public var project: CreateProject?
  public var agents: [CreationAgent]
  public var capabilities: [Capability]

  public init(availability: String? = nil, sessionId: String, project: CreateProject? = nil, agents: [CreationAgent], capabilities: [Capability]) {
    self.availability = availability
    self.sessionId = sessionId
    self.project = project
    self.agents = agents
    self.capabilities = capabilities
  }
}

public struct ModelChoice: Codable, Equatable, Sendable {
  public var modelId: String?
  public var effort: String?
  public var modeId: String?
  public var configOptionValues: [String: ConfigValue]?

  public init(modelId: String? = nil, effort: String? = nil, modeId: String? = nil, configOptionValues: [String: ConfigValue]? = nil) {
    self.modelId = modelId
    self.effort = effort
    self.modeId = modeId
    self.configOptionValues = configOptionValues
  }
}

public struct ProjectPrefs: Codable, Equatable, Sendable {
  public var modelId: String?
  public var effort: String?
  public var modeId: String?
  public var configOptionValues: [String: ConfigValue]?
  public var machineId: String?
  public var agentKey: String?

  public var choice: ModelChoice {
    ModelChoice(modelId: modelId, effort: effort, modeId: modeId, configOptionValues: configOptionValues)
  }

  public init(modelId: String? = nil, effort: String? = nil, modeId: String? = nil, configOptionValues: [String: ConfigValue]? = nil, machineId: String? = nil, agentKey: String? = nil) {
    self.modelId = modelId
    self.effort = effort
    self.modeId = modeId
    self.configOptionValues = configOptionValues
    self.machineId = machineId
    self.agentKey = agentKey
  }
}

/// One whole run configuration a new chat was started with (web `RecentRunConfigRecord`): the
/// agent, its full choice and the Role it ran as. Device-local; recorded on Send only.
public struct RecentRunConfig: Codable, Equatable, Sendable {
  public var machineId: String
  public var agentKey: String
  public var choice: ModelChoice
  /// A Role is not interchangeable with the values it set, so it is part of the identity.
  public var agentRoleId: String?
  public var usedAt: Double

  public init(machineId: String, agentKey: String, choice: ModelChoice, agentRoleId: String? = nil, usedAt: Double) {
    self.machineId = machineId
    self.agentKey = agentKey
    self.choice = choice
    self.agentRoleId = agentRoleId
    self.usedAt = usedAt
  }
}

public struct CreatePrefs: Codable, Equatable, Sendable {
  public var branches: [String: String]?
  public var projectId: String?
  public var context: String?
  public var projects: [String: ProjectPrefs]?
  public var modelChoices: [String: ModelChoice]?
  /// The last agent and choice used on each computer, by machine id: picking a computer again
  /// restores them instead of its first agent.
  public var machines: [String: ProjectPrefs]?
  /// Most recent first, capped at `CreateLogic.maxStoredRecents`.
  public var recents: [RecentRunConfig]?

  public init(projectId: String? = nil, context: String? = nil, projects: [String: ProjectPrefs]? = nil, modelChoices: [String: ModelChoice]? = nil) {
    self.projectId = projectId
    self.context = context
    self.projects = projects
    self.modelChoices = modelChoices
  }
}

public enum CreateJSON {
  public static func encode<Value: Encodable>(_ value: Value) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    guard let data = try? encoder.encode(value) else { return "null" }
    return String(decoding: data, as: UTF8.self)
  }

  public static func decode<Value: Decodable>(_ type: Value.Type, _ text: String) -> Value? {
    try? JSONDecoder().decode(type, from: Data(text.utf8))
  }
}

// Credential-free pages can also be read by the offline Share Extension.
public struct CreateBranches: Codable, Equatable, Sendable {
  public var names: [String]
  public var defaultBranch: String?
  public var nextPage: Int?

  public func matching(_ query: String) -> [String] {
    let term = query.trimmingCharacters(in: .whitespacesAndNewlines)
    return names.filter { term.isEmpty || $0.localizedCaseInsensitiveContains(term) }.sorted {
      if $0 == $1 { return false }
      if $0 == defaultBranch { return true }
      if $1 == defaultBranch { return false }
      return $0.localizedStandardCompare($1) == .orderedAscending
    }
  }

  public mutating func append(_ page: CreateBranches) {
    names = Array(Set(names + page.names))
    defaultBranch = page.defaultBranch ?? defaultBranch
    nextPage = page.nextPage
  }

  public init(names: [String], defaultBranch: String? = nil, nextPage: Int? = nil) {
    self.names = names
    self.defaultBranch = defaultBranch
    self.nextPage = nextPage
  }
}
