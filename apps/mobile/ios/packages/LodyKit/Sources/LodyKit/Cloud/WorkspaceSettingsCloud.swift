import Foundation

/// A small allowlist of official settings operations. Credentials stay native.
@MainActor enum WorkspaceSettingsCloud {
  typealias Call = (String, String, [String: Any]) async throws -> Any

  static func run(_ payload: String) async throws -> String {
    guard let token = try AuthKeychain.read(), !token.isEmpty,
          let data = payload.data(using: .utf8), data.count <= 16 * 1024,
          let args = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          let workspace = args["workspaceId"] as? String, !workspace.isEmpty, workspace.count <= 200 else { throw GitHubCloud.failure() }
    let session = try await GitHubCloud.request("https://backend.lody.ai/api/auth/get-session", token: token) as? [String: Any]
    guard try AuthKeychain.read() == token,
          let user = (session?["user"] as? [String: Any])?["id"] as? String, !user.isEmpty else { throw GitHubCloud.failure() }
    var role: String?
    if args["page"] as? String == "github" {
      var url = URLComponents(string: "https://backend.lody.ai/api/auth/organization/get-full-organization")!
      url.queryItems = [URLQueryItem(name: "organizationId", value: workspace)]
      let organization = try? await GitHubCloud.request(url.url!.absoluteString, token: token) as? [String: Any]
      if organization?["id"] as? String == workspace,
         let members = organization?["members"] as? [[String: Any]] {
        role = members.first(where: { $0["userId"] as? String == user })?["role"] as? String
      }
    }
    let value = try await execute(args, workspace: workspace, user: user, role: role) { kind, path, fields in
      guard try AuthKeychain.read() == token else { throw GitHubCloud.failure() }
      return try await GitHubCloud.call(kind, path: path, args: fields)
    }
    guard try AuthKeychain.read() == token else { throw GitHubCloud.failure() }
    return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
  }

  static func projectRows(_ value: Any) throws -> [[String: Any]] {
    guard let rows = value as? [[String: Any]], rows.count <= 10000 else { throw GitHubCloud.failure() }
    var keys = Set<String>()
    var projected: [[String: Any]] = []
    for row in rows {
      guard let machine = row["machineId"] as? String, !machine.isEmpty,
            let project = row["localProjectId"] as? String, !project.isEmpty,
            let owner = row["ownerUserId"] as? String, !owner.isEmpty,
            let shared = row["sharedWithTeam"] as? Bool, let date = row["updatedAt"] as? Double, date.isFinite, date >= 0,
            keys.insert("\(machine.utf8.count):\(machine)\(project)").inserted else { throw GitHubCloud.failure() }
      projected.append(["machineId": machine, "localProjectId": project, "ownerUserId": owner, "sharedWithTeam": shared, "updatedAt": date])
    }
    return projected
  }

  static func execute(_ request: [String: Any], workspace: String, user: String, role: String? = nil, call: Call) async throws -> [String: Any] {
    if request["page"] as? String == "usage" { return try await WorkspaceUsage.run(request, workspace: workspace, call: call) }
    if request["page"] as? String == "github" { return try await github(request, workspace: workspace, role: role, call: call) }
    guard request["page"] as? String == "projects" else { throw GitHubCloud.failure() }
    let scope: [String: Any] = ["workspaceId": workspace]
    let rows = try projectRows(await call("query", "localProjects:listVisibleLocalProjects", scope))
    if request["action"] as? String == "set" {
      guard let machine = request["machineId"] as? String,
            let project = request["localProjectId"] as? String,
            let shared = request["sharedWithTeam"] as? Bool,
            rows.contains(where: { $0["machineId"] as? String == machine && $0["localProjectId"] as? String == project && $0["ownerUserId"] as? String == user }) else { throw GitHubCloud.failure() }
      let result = try await call("mutation", "localProjects:setLocalProjectSharedWithTeam", ["workspaceId": workspace, "machineId": machine, "localProjectId": project, "sharedWithTeam": shared]) as? [String: Any]
      guard result?["success"] as? Bool == true, result?["sharedWithTeam"] as? Bool == shared else { throw GitHubCloud.failure() }
      let fresh = try projectRows(await call("query", "localProjects:listVisibleLocalProjects", scope))
      guard fresh.contains(where: { $0["machineId"] as? String == machine && $0["localProjectId"] as? String == project && $0["sharedWithTeam"] as? Bool == shared }) else { throw GitHubCloud.failure() }
      return ["rows": fresh, "userId": user]
    }
    guard request["action"] as? String == "list" else { throw GitHubCloud.failure() }
    return ["rows": rows, "userId": user]
  }
  static func github(_ request: [String: Any], workspace: String, role: String?, call: Call) async throws -> [String: Any] {
    let roles = Set((role ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) })
    let canManage = !roles.isDisjoint(with: ["admin", "owner"])
    let scope: [String: Any] = ["workspaceId": workspace]
    let action = request["action"] as? String
    if action == "install" {
      guard canManage,
            let result = try await call("action", "github:createGitHubInstallState", ["workspaceId": workspace, "returnTarget": "web"]) as? [String: Any],
            let state = result["state"] as? String, !state.isEmpty, state.count <= 4096 else { throw GitHubCloud.failure() }
      var url = URLComponents(string: "https://github.com/apps/lodyai/installations/new")!
      url.queryItems = [URLQueryItem(name: "state", value: state)]
      return ["url": url.url!.absoluteString]
    }
    if action == "repository" {
      guard canManage, let repo = request["repoFullName"] as? String, GitHubCloud.validRepository(repo),
            let enabled = request["enabled"] as? Bool else { throw GitHubCloud.failure() }
      let current = try await call("query", "github:listWorkspaceReposWithStatus", scope) as? [[String: Any]]
      guard current?.contains(where: { $0["repoFullName"] as? String == repo }) == true else { throw GitHubCloud.failure() }
      let result = try await call("mutation", "github:setRepoEnabled", ["workspaceId": workspace, "repoFullName": repo, "enabled": enabled]) as? [String: Any]
      guard result?["updated"] is Bool else { throw GitHubCloud.failure() }
      let readback = try await call("query", "github:listWorkspaceReposWithStatus", scope) as? [[String: Any]]
      guard readback?.contains(where: { $0["repoFullName"] as? String == repo && $0["enabled"] as? Bool == enabled }) == true else { throw GitHubCloud.failure() }
    } else if action == "preference" {
      guard let enabled = request["enabled"] as? Bool else { throw GitHubCloud.failure() }
      let current = try await call("query", "github:getPersonalOperationSettings", scope) as? [String: Any]
      if enabled, (current?["authorization"] as? [String: Any])?["state"] as? String != "authorized" { throw GitHubCloud.failure() }
      _ = try await call("mutation", "github:setPersonalOperationPreference", ["workspaceId": workspace, "enabled": enabled])
      let fresh = try await call("query", "github:getPersonalOperationSettings", scope) as? [String: Any]
      guard fresh?["enabled"] as? Bool == enabled else { throw GitHubCloud.failure() }
    } else if action != "list" { throw GitHubCloud.failure() }
    var errors: [String] = []
    var repositories: Any = NSNull(), personal: Any = NSNull()
    do {
      let raw = try await call("query", "github:listWorkspaceReposWithStatus", scope)
      if raw is NSNull { repositories = NSNull() }
      else {
        guard let rows = raw as? [[String: Any]], rows.count <= 10000 else { throw GitHubCloud.failure() }
        repositories = try rows.map { row -> [String: Any] in
          guard let name = row["repoFullName"] as? String, GitHubCloud.validRepository(name),
                let title = row["name"] as? String, let id = row["repositoryId"] as? Int, id > 0,
                let isPrivate = row["private"] as? Bool, let enabled = row["enabled"] as? Bool else { throw GitHubCloud.failure() }
          return ["repoFullName": name, "name": title, "repositoryId": id, "private": isPrivate, "enabled": enabled]
        }
      }
    }
    catch { errors.append("repositories") }
    do {
      guard let raw = try await call("query", "github:getPersonalOperationSettings", scope) as? [String: Any],
            let enabled = raw["enabled"] as? Bool, let auth = raw["authorization"] as? [String: Any],
            let state = auth["state"] as? String, ["missing", "authorized", "expired"].contains(state) else { throw GitHubCloud.failure() }
      // Only identity display fields leave native code; never forward an opaque response.
      if state == "authorized", (auth["githubAccountId"] as? String)?.isEmpty != false { throw GitHubCloud.failure() }
      var authorization: [String: Any] = ["state": state]
      if let account = auth["githubAccountId"] as? String { authorization["githubAccountId"] = account }
      if let profile = auth["profile"] as? [String: Any], let login = profile["login"] as? String { authorization["profile"] = ["login": login] }
      personal = ["enabled": enabled, "authorization": authorization]
    } catch { errors.append("personal") }
    return ["canManage": canManage, "roleKnown": role != nil, "repositories": repositories, "personal": personal, "errors": errors]
  }

}
