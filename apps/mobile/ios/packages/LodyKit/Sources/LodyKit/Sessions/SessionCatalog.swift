import Foundation

struct SessionPullRequest: Decodable, Equatable, Sendable {
  var repository: String
  var number: Int
  var status: String
  var ci: String?
  var url: String? = nil
  /// GitHub merge state: `c` clean, `b` blocked, `d` conflicts, `h` behind, `u` unstable.
  var merge: String? = nil
}

struct SessionItem: Equatable, Sendable {
  var id: String
  var title = ""
  var status = "idle"
  var archived = false
  var isTabClosed = false
  var pinned = false
  /// The owning Lody user; nil from runtimes older than the field.
  var userId: String?
  /// The agent config (ACP provider) the session runs; picks its model capability.
  var agentConfigId: String?
  var projectId = ""
  var createdAt = ""
  var openedBySessionId: String?
  var openedByRootSessionId: String?
  var childSessionPlacement: String?
  var parentSessionId: String?
  var lastMessageAt: Double?
  var lastReadAt: Double?
  var awaitingUserSince: Double?
  var branchName: String?
  /// Web `session.baseBranch || project.branch`; the Copy menu offers it beside a different current branch.
  var baseBranch: String?
  var modelName: String?
  var modelNeverRan = false
  var diff: [String: Int] = [:]
  var lastViewedMessageAt: Double?
  var machineId = ""
  var cliType = ""
  var agentType = ""
  var resume: String?
  var pullRequests: [SessionPullRequest] = []
  var iosSimulatorPreviewRequestId: String?
  /// Uncommitted changes / local commits the remote lacks (the action bar's Commit & Push).
  var workspaceDirty = false
  var workspaceUnpushed = false

  var activityAt: Double { lastMessageAt ?? SessionItem.parse(createdAt) }

  private static func parse(_ value: String) -> Double {
    let precise = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    guard let date = (try? precise.parse(value)) ?? (try? Date.ISO8601FormatStyle().parse(value)) else { return .nan }
    return date.timeIntervalSince1970 * 1000
  }
}

extension SessionItem: Decodable {
  private enum CodingKeys: String, CodingKey {
    case id, title, status, isTabClosed, archived, pinned, projectId, createdAt, openedBySessionId, openedByRootSessionId
    case childSessionPlacement, parentSessionId, lastMessageAt, lastReadAt, awaitingUserSince, branchName, baseBranch, lastModel, diff, machineId
    case cliType, agentType, resume, pullRequests, iosSimulatorPreviewRequestId, userId, agentConfigId
    case workspaceDirty, workspaceUnpushed
  }

  private struct Model: Decodable {
    var modelId: String?
    var name: String?
  }

  private struct Diff: Decodable {
    var add: Int?
    var del: Int?
  }

  init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    func present(_ text: String?) -> String? { text?.isEmpty == false ? text : nil }
    func value<T: Decodable>(_ key: CodingKeys) -> T? { (try? values.decodeIfPresent(T.self, forKey: key)) ?? nil }
    id = try values.decode(String.self, forKey: .id)
    title = value(.title) ?? ""
    status = value(.status) ?? "idle"
    archived = value(.archived) ?? false
    isTabClosed = value(.isTabClosed) ?? false
    pinned = value(.pinned) ?? false
    userId = present(value(.userId))
    agentConfigId = present(value(.agentConfigId))
    projectId = value(.projectId) ?? ""
    createdAt = value(.createdAt) ?? ""
    openedBySessionId = present(value(.openedBySessionId))
    openedByRootSessionId = present(value(.openedByRootSessionId))
    parentSessionId = present(value(.parentSessionId))
    childSessionPlacement = present(value(.childSessionPlacement))
    lastMessageAt = value(.lastMessageAt)
    lastReadAt = value(.lastReadAt)
    awaitingUserSince = value(.awaitingUserSince)
    branchName = present(value(.branchName))
    baseBranch = present(value(.baseBranch))
    machineId = value(.machineId) ?? ""
    cliType = value(.cliType) ?? ""
    agentType = value(.agentType) ?? ""
    resume = present(value(.resume))
    pullRequests = value(.pullRequests) ?? []
    iosSimulatorPreviewRequestId = present(value(.iosSimulatorPreviewRequestId))
    workspaceDirty = value(.workspaceDirty) ?? false
    workspaceUnpushed = value(.workspaceUnpushed) ?? false
    modelNeverRan = values.contains(.lastModel) && ((try? values.decodeNil(forKey: .lastModel)) ?? false)
    if let model: Model = value(.lastModel) {
      modelName = [model.name, model.modelId].compactMap { $0 }.first { !$0.isEmpty } ?? ""
    }
    if let diff: Diff = value(.diff), let add = diff.add, let del = diff.del { self.diff = ["add": add, "del": del] }
  }
}

struct SessionProject: Decodable, Equatable, Sendable {
  var id: String
  var name = ""
  var rootPath = ""
  var machineId = ""
  var repoFullName: String?
  /// A multi-repository project's GitHub members (`projectRun`), in member order.
  var repositories: [String] = []

  private enum CodingKeys: String, CodingKey { case id, name, rootPath, repoFullName, machineId, repositories }

  init(id: String, name: String = "", rootPath: String = "", repoFullName: String? = nil) {
    self.id = id
    self.name = name
    self.rootPath = rootPath
    self.repoFullName = repoFullName
  }

  init(from decoder: any Decoder) throws {
    let values = try decoder.container(keyedBy: CodingKeys.self)
    id = try values.decode(String.self, forKey: .id)
    name = (try? values.decodeIfPresent(String.self, forKey: .name)) ?? ""
    rootPath = (try? values.decodeIfPresent(String.self, forKey: .rootPath)) ?? ""
    machineId = (try? values.decodeIfPresent(String.self, forKey: .machineId)) ?? ""
    repoFullName = (try? values.decodeIfPresent(String.self, forKey: .repoFullName)) ?? nil
    repositories = (try? values.decodeIfPresent([String].self, forKey: .repositories)) ?? []
  }

  /// GitHub repositories whose PRs belong to this project: its repository, or a group's members.
  var githubRepositories: [String] {
    var result = repositories
    if let repoFullName, !repoFullName.isEmpty { result.insert(repoFullName, at: 0) }
    if result.isEmpty, id.hasPrefix("github:") { result.append(String(id.dropFirst(7))) }
    return result
  }
}

struct SessionCatalog: Equatable, Sendable {
  var projects: [SessionProject] = []
  var sessions: [SessionItem] = []
  var machineIds: [String] = []
  var machineNames: [String: String] = [:]
  /// Computer id to OS (`darwin` / `win32` / `linux`), for its icon.
  var machineOs: [String: String] = [:]
  var machineSimulators: [String: String] = [:]

  func session(_ id: String) -> SessionItem? { sessions.first { $0.id == id } }

  func viewed(_ views: [String: Double]) -> SessionCatalog {
    guard !views.isEmpty else { return self }
    var next = self
    next.sessions = sessions.map { session in
      var session = session
      session.lastViewedMessageAt = views[session.id]
      return session
    }
    return next
  }

  static func decode(saved: Data, pending: [SessionItem] = []) -> SessionCatalog? {
    struct Shape: Decodable {
      var projects: [Lossy<SessionProject>]
      var sessions: [Lossy<SessionItem>]
      var machineIds: [Lossy<String>]
      var machineNames: Lossy<[String: String]>?
      var machineOs: Lossy<[String: String]>?
      var machineSimulators: Lossy<[String: String]>?
    }
    struct Saved: Decodable { var catalog: Shape }
    guard let shape = try? JSONDecoder().decode(Saved.self, from: saved).catalog else { return nil }
    return SessionCatalog(
      projects: shape.projects.compactMap(\.value), sessions: shape.sessions.compactMap(\.value) + pending,
      machineIds: shape.machineIds.compactMap(\.value), machineNames: shape.machineNames?.value ?? [:], machineOs: shape.machineOs?.value ?? [:], machineSimulators: shape.machineSimulators?.value ?? [:]
    )
  }
}

// A malformed entry is dropped rather than discarding the whole catalog.
struct Lossy<T: Decodable>: Decodable {
  var value: T?

  init(from decoder: any Decoder) throws {
    value = try? T(from: decoder)
  }
}
