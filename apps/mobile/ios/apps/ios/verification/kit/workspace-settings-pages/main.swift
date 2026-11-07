import Foundation

let snapshot = VisibilitySnapshot(userId: "owner", rows: [
  VisibilityRow(machineId: "m1", localProjectId: "same", ownerUserId: "owner", sharedWithTeam: false, updatedAt: 1),
  VisibilityRow(machineId: "m2", localProjectId: "same", ownerUserId: "teammate", sharedWithTeam: true, updatedAt: 1),
])
let catalog = SettingsCatalog(projects: [
  SettingsProject(id: "m1:local:same", machineId: "m1", name: "First", rootPath: "/first"),
  SettingsProject(id: "m2:local:same", machineId: "m2", name: "Second", rootPath: "/second"),
  SettingsProject(id: "m1:local:unknown", machineId: "m1", name: "Unknown", rootPath: "/unknown"),
])

let rows = ProjectVisibilitySections.make(snapshot, catalog: catalog, enabled: true).flatMap(\.rows)
let own = rows.first { $0.id == "visibility:m1:same" }!
let foreign = rows.first { $0.id == "visibility:m2:same" }!
precondition(own.title == "First" && own.options.count == 2, "Owners can change their project")
precondition(foreign.title == "Second" && foreign.options.isEmpty && !foreign.action, "Foreign projects are read only")
precondition(!foreign.subtitle.contains("/second"), "Foreign paths stay hidden")
precondition(own.valueSymbol == "lock" && foreign.valueSymbol == "person.2")
precondition(own.subtitle == "/first" && own.subtitleMono && own.image == "folder")
let unknown = rows.first { $0.title == "Unknown" }!
precondition(unknown.id == "unknown:m1:local:unknown" && unknown.options.isEmpty && unknown.valueSymbol == "questionmark.circle")
precondition(ProjectVisibilitySections.make(snapshot, catalog: catalog, enabled: false).flatMap(\.rows).allSatisfy { !$0.action })
precondition(VisibilityRow(machineId: "a b/é", localProjectId: "x:y", ownerUserId: "o", sharedWithTeam: true, updatedAt: 0).id
  == "visibility:a%20b%2F%C3%A9:x%3Ay", "Ids match encodeURIComponent")

let live = SettingsMachinePresence(state: "live", onlineMachineIds: ["m1"])
let sections = ProjectVisibilitySections.make(snapshot, catalog: catalog, enabled: true, presence: live)
precondition(sections.map(\.id) == ["m1", "m2"], "Sections follow first appearance")
precondition(sections[0].headerStatus == "online" && sections[0].header == "m1 · devices.online" && sections[0].footer.isEmpty)
precondition(sections[1].headerStatus == "offline")
let quiet = ProjectVisibilitySections.make(snapshot, catalog: catalog, enabled: true)[0]
precondition(quiet.header == "m1" && quiet.headerStatus.isEmpty, "Unknown presence shows only the name")
let named = ProjectVisibilitySections.make(snapshot, catalog: SettingsCatalog(projects: catalog.projects, machineNames: ["m1": "Studio Mac"]), enabled: true)
precondition(named[0].header == "Studio Mac" && named[1].header == "m2")
precondition(snapshot.valid)
precondition(!VisibilitySnapshot(userId: "", rows: []).valid)
precondition((try? JSONDecoder().decode(VisibilitySnapshot.self, from: Data(#"{"userId":"o","rows":[{"machineId":"m","localProjectId":"p","ownerUserId":"o","sharedWithTeam":null,"updatedAt":1}]}"#.utf8))) == nil)
let request = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(VisibilityRequest.list("w"))) as! [String: String]
precondition(request == ["page": "projects", "workspaceId": "w", "action": "list"], "\(request)")

let workspace = SettingsWorkspace.decode(
  state: #"{"userId":"u","workspaceId":"w","connected":true,"presence":{"workspaceId":"w","presence":{"state":"live","onlineMachineIds":["m1"]}}}"#,
  raw: #"{"catalog":{"projects":[{"id":"m1:local:p","machineId":"m1","name":"P","rootPath":"/p"}],"sessions":[],"machineIds":["m1"],"machineNames":{"m1":"Mac"}},"syncedAt":1}"#
)
precondition(workspace.key == "u:w" && workspace.connected && workspace.presence.status(of: "m1") == "online")
precondition(workspace.catalog.projects.count == 1 && workspace.catalog.machineNames == ["m1": "Mac"])
let stale = SettingsWorkspace.decode(
  state: #"{"userId":"u","workspaceId":"w","connected":false,"presence":{"workspaceId":"old","presence":{"state":"live","onlineMachineIds":["m1"]}}}"#,
  raw: "null"
)
precondition(stale.presence == .unknown && stale.catalog.projects.isEmpty && !stale.connected, "Another workspace's presence is ignored")
precondition(SettingsWorkspace.decode(state: #"{"userId":"","workspaceId":"","connected":false}"#, raw: "null").key.isEmpty)

let data = GitHubSettings(
  canManage: false, roleKnown: true,
  repositories: [GitHubRepository(repoFullName: "LodyAI/Lody", name: "Lody", repositoryId: 1, private: false, enabled: true)],
  personal: GitHubPersonal(enabled: true, authorization: GitHubAuthorization(state: .expired)), errors: []
)
let github = GitHubSettingsSections.make(data, enabled: true).flatMap(\.rows)
precondition(github.first { $0.id == "identity" }!.title == "settings.github.expired")
precondition(github.first { $0.id == "preference" }!.options.map(\.id) == ["disabled"], "Expired identity cannot be enabled")
precondition(github.first { $0.id == "repo:LodyAI/Lody" }!.options.isEmpty, "Members cannot manage repositories")
precondition(!github.contains { $0.id == "install" })
let missing = GitHubSettingsSections.make(nil, enabled: false).flatMap(\.rows)
precondition(missing.first { $0.id == "identity" }!.title == "settings.github.unknown")
var admin = data
admin.canManage = true
let adminRows = GitHubSettingsSections.make(admin, enabled: true).flatMap(\.rows)
precondition(adminRows.first { $0.id == "repo:LodyAI/Lody" }!.options.count == 2 && adminRows.contains { $0.id == "install" })
admin.repositories = nil
precondition(GitHubSettingsSections.make(admin, enabled: true).map(\.id).contains("repositories-unavailable"))
admin.repositories = []
precondition(GitHubSettingsSections.make(admin, enabled: true).map(\.id).contains("no-repositories"))
var authorized = data
authorized.personal = GitHubPersonal(enabled: false, authorization: GitHubAuthorization(state: .authorized, githubAccountId: "1", profile: .init(login: "octo")))
let authorizedRows = GitHubSettingsSections.make(authorized, enabled: true).flatMap(\.rows)
precondition(authorizedRows[0].subtitle == "octo" && authorizedRows[1].options.map(\.id) == ["disabled", "enabled"])
precondition(authorized.valid && data.valid)
authorized.personal?.authorization.githubAccountId = nil
precondition(!authorized.valid, "Authorized identity needs an account id")
var badRepo = data
badRepo.repositories?[0].repoFullName = "Lody AI/Lody"
precondition(!badRepo.valid)
badRepo.repositories?[0].repoFullName = "a/b/c"
precondition(!badRepo.valid)

let valid = "https://github.com/apps/lodyai/installations/new?state=abc"
precondition(GitHubSettingsSections.installURL(valid)?.absoluteString == valid)
precondition(GitHubSettingsSections.installURL("https://github.com:443/apps/lodyai/installations/new?state=abc") != nil)
for invalid in [
  "http://github.com/apps/lodyai/installations/new?state=abc",
  "https://github.com.evil.example/apps/lodyai/installations/new?state=abc",
  "https://evil.example/apps/lodyai/installations/new?state=abc",
  "https://user:pass@github.com/apps/lodyai/installations/new?state=abc",
  "https://user@github.com/apps/lodyai/installations/new?state=abc",
  "https://github.com/apps/lodyai/installations/new?state=abc#frag",
  "https://github.com/apps/lodyai/installations/new/?state=abc",
  "https://github.com/apps/other/installations/new?state=abc",
  "https://github.com/apps/lodyai/installations/new",
  "https://github.com/apps/lodyai/installations/new?state=",
  "https://github.com:8443/apps/lodyai/installations/new?state=abc",
  "not a url",
] {
  precondition(GitHubSettingsSections.installURL(invalid) == nil, invalid)
}

print("PASS: project visibility, settings workspace, GitHub sections, install URL validation")
