import LodyCore
import Foundation

@MainActor
struct CreateSessionService {
  var options: (_ workspaceId: String, _ projectId: String?) async throws -> CreationOptions
  var repositories: (_ workspaceId: String) async throws -> [String]
  var branches: (_ workspaceId: String, _ repo: String, _ page: Int) async throws -> CreateBranches
  var readPrefs: (_ key: String) async -> CreatePrefs?
  var writePrefs: (_ key: String, _ prefs: CreatePrefs) -> Void
  var put: (_ userId: String, _ workspaceId: String, _ json: String) -> Task<Void, Error>
  var persistShare = true
  var workspaceMode: (String) -> WorkspaceContentMode = { WorkspaceModePins.shared.mode($0) }
  var refreshCapability: (_ workspace: String, _ config: String) async throws -> Void = { _, _ in }
  var cachedOptions: (_ userId: String, _ workspaceId: String, _ projectId: String?) async -> CreationOptions? = { _, _, _ in nil }
  /// Agent Roles readable by this user (runtime `agentRoles` list); none without a runtime.
  var roles: (_ workspaceId: String) async throws -> [RuntimeContract.AgentRoleItem] = { _ in [] }
  /// The workspace's multi-repository projects (runtime `projectGroups`); none without a runtime.
  var projectGroups: (_ workspaceId: String) async throws -> [RuntimeContract.ProjectGroupItem] = { _ in [] }

  var cachedBranches: (_ userId: String, _ workspaceId: String, _ repo: String) async -> CreateBranches? = { _, _, _ in nil }
  var persistBranches: (_ userId: String, _ workspaceId: String, _ repo: String, _ branches: CreateBranches) -> Void = { _, _, _, _ in }

  static func branchesKey(userId: String, workspaceId: String, repo: String) -> String {
    "creation-branches:v1:" + CreateJSON.encode([userId, workspaceId, repo])
  }

  static func optionsKey(userId: String, workspaceId: String, projectId: String?) -> String {
    "creation-options:v1:" + CreateJSON.encode([userId, workspaceId, projectId ?? ""])
  }

  static func prefsKey(userId: String, workspaceId: String) -> String { "create:\(userId):\(workspaceId)" }

  static var live: CreateSessionService {
    var branchAttempts: [String: Int] = [:]
    let branchCacheGeneration = LocalStore.shared.generation
    return CreateSessionService(
      options: { workspaceId, projectId in
        var payload: [String: Any] = ["workspaceId": workspaceId]
        if let projectId { payload["projectId"] = projectId }
        let json = String(decoding: (try? JSONSerialization.data(withJSONObject: payload)) ?? Data(), as: UTF8.self)
        if let fixture = MentionFixture.response(json, options: true), let options = CreateJSON.decode(CreationOptions.self, fixture) {
          return options
        }
        guard let runtime = DataRuntime.current, runtime.workspace == workspaceId else {
          throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
        }
        let cacheKey = optionsKey(userId: runtime.userId, workspaceId: workspaceId, projectId: projectId)
        let generation = LocalStore.shared.generation
        let result = try await runtime.workspaceCall(RuntimeContract.Calls.CreationOptions.self) { workspace, _ in
          RuntimeContract.CreationOptionsParams(workspaceId: workspace, projectId: projectId)
        }
        let options = try JSONDecoder().decode(CreationOptions.self, from: JSONEncoder().encode(result))
        guard options.availability != "unknown" else {
          throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
        }
        let value = CreateJSON.encode(options)
        LocalStore.queue.async { try? LocalStore.shared.write(cacheKey, value, generation: generation) }
        return options
      },
      repositories: { workspaceId in
        if workspaceId == "ui-home", LodyUIVerify.mentions { return ["LodyAI/FreshProject"] }
        if LodyUIVerify.enabled, workspaceId == "ui-project-picker" { return (1...20).map { "Owner/Repo\($0)" } }
        return try await GitHubCloud.repositories(workspace: workspaceId)
      },
      branches: { workspaceId, repo, page in
        if LodyUIVerify.enabled {
          let key = "\(repo):\(page)"
          branchAttempts[key, default: 0] += 1
          return try await LodyUIVerify.branches(repo: repo, page: page, attempt: branchAttempts[key] ?? 1)
        }
        return try await GitHubCloud.branches(workspace: workspaceId, repo: repo, page: page)
      },
      readPrefs: { key in
        let raw: String? = await withCheckedContinuation { continuation in
          LocalStore.queue.async { continuation.resume(returning: (try? LocalStore.shared.read(key)) ?? nil) }
        }
        return raw.flatMap { CreateJSON.decode(CreatePrefs.self, $0) }
      },
      writePrefs: { key, prefs in
        let value = CreateJSON.encode(prefs), generation = LocalStore.shared.generation
        LocalStore.queue.async { try? LocalStore.shared.write(key, value, generation: generation) }
      },
      put: { OutboxSession.shared.put(user: $0, workspace: $1, json: $2) },
      refreshCapability: { workspaceId, config in
        guard let runtime = DataRuntime.current, runtime.workspace == workspaceId else { throw CancellationError() }
        _ = try await runtime.workspaceCall(RuntimeContract.Calls.CreationOptions.self) { workspace, _ in
          RuntimeContract.CreationOptionsParams(workspaceId: workspace, agentConfigId: config)
        }
      },
      cachedOptions: { userId, workspaceId, projectId in
        let key = optionsKey(userId: userId, workspaceId: workspaceId, projectId: projectId)
        let raw: String? = await withCheckedContinuation { continuation in
          LocalStore.queue.async { continuation.resume(returning: (try? LocalStore.shared.read(key)) ?? nil) }
        }
        return raw.flatMap { CreateJSON.decode(CreationOptions.self, $0) }
      },
      roles: { workspaceId in
        guard !LodyUIVerify.enabled, let runtime = DataRuntime.current, runtime.workspace == workspaceId else { return [] }
        return try await runtime.workspaceCall(RuntimeContract.Calls.AgentRoles.self) { workspace, userId in
          .list(.init(workspaceId: workspace, userId: userId))
        }.roles
      },
      projectGroups: { workspaceId in
        guard !LodyUIVerify.enabled, let runtime = DataRuntime.current, runtime.workspace == workspaceId else { return [] }
        return try await runtime.workspaceCall(RuntimeContract.Calls.ProjectGroups.self) { workspace, userId in
          RuntimeContract.ProjectGroupsParams(workspaceId: workspace, userId: userId)
        }.groups
      },
      cachedBranches: { userId, workspaceId, repo in
        let key = branchesKey(userId: userId, workspaceId: workspaceId, repo: repo)
        let raw: String? = await withCheckedContinuation { continuation in
          LocalStore.queue.async { continuation.resume(returning: (try? LocalStore.shared.read(key)) ?? nil) }
        }
        return raw.flatMap { CreateJSON.decode(CreateBranches.self, $0) }
      },
      persistBranches: { userId, workspaceId, repo, branches in
        let key = branchesKey(userId: userId, workspaceId: workspaceId, repo: repo)
        let value = CreateJSON.encode(branches)
        guard value.utf8.count <= 1024 * 1024 else { return }
        LocalStore.queue.async { try? LocalStore.shared.write(key, value, generation: branchCacheGeneration) }
      }
    )
  }

  static func githubProject(_ repo: String) -> CreateProject? {
    let parts = repo.split(separator: "/", omittingEmptySubsequences: false)
    guard repo.trimmingCharacters(in: .whitespacesAndNewlines) == repo, parts.count == 2,
          repo.range(of: #"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}$"#, options: .regularExpression) != nil,
          ![".", ".."].contains(String(parts[1])) else { return nil }
    return CreateProject(id: "github:\(repo)", machineId: "", name: repo)
  }
}
