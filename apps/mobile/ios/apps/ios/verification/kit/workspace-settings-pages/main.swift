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
let expiredPreference = github.first { $0.id == "preference" }!
precondition(expiredPreference.toggle == true && expiredPreference.action, "An expired identity can still be turned off")
var expiredOff = data
expiredOff.personal?.enabled = false
precondition(GitHubSettingsSections.make(expiredOff, enabled: true).flatMap(\.rows).first { $0.id == "preference" }!.action == false, "Expired identity cannot be turned on")
let memberRepo = github.first { $0.id == "repo:LodyAI/Lody" }!
precondition(memberRepo.toggle == true && !memberRepo.action, "Members see repository state but cannot change it")
precondition(memberRepo.repository == "LodyAI/Lody" && memberRepo.title == "Lody", "Repositories show the owner logo and short name")
precondition(!github.contains { $0.id == "install" })
let missing = GitHubSettingsSections.make(nil, enabled: false).flatMap(\.rows)
precondition(missing.first { $0.id == "identity" }!.title == "settings.github.unknown")
var admin = data
admin.canManage = true
admin.repositories = [
  GitHubRepository(repoFullName: "zeta/tools", name: "tools", repositoryId: 2, private: true, enabled: false),
  GitHubRepository(repoFullName: "LodyAI/Lody", name: "Lody", repositoryId: 1, private: false, enabled: true),
]
let adminSections = GitHubSettingsSections.make(admin, enabled: true)
let adminRows = adminSections.flatMap(\.rows)
precondition(adminRows.first { $0.id == "repo:zeta/tools" }!.action && adminRows.contains { $0.id == "install" })
precondition(adminSections.first { $0.id == "repositories" }!.rows.map(\.id) == ["repo:LodyAI/Lody", "repo:zeta/tools"], "Repositories sort by name")
precondition(adminSections.map(\.id) == ["personal", "installation", "repositories"], "Identity, the App, then the long repository list")
precondition(GitHubSettingsSections.make(admin, enabled: false).flatMap(\.rows).allSatisfy { !$0.action }, "Busy pages lock every switch")
let search = GitHubSettingsSections.make(admin, enabled: true, query: "  ZETA ")
precondition(search.map(\.id) == ["repositories"] && search[0].rows.map(\.id) == ["repo:zeta/tools"], "Search keeps only matching repositories")
precondition(!search[0].headerValue.isEmpty, "The enabled count stays while searching")
let noMatch = GitHubSettingsSections.make(admin, enabled: true, query: "absent")
precondition(noMatch[0].rows.isEmpty && !noMatch[0].footer.isEmpty, "An empty search explains itself")
admin.repositories = nil
precondition(GitHubSettingsSections.make(admin, enabled: true).map(\.id).contains("repositories-unavailable"))
admin.repositories = []
precondition(GitHubSettingsSections.make(admin, enabled: true).first { $0.id == "repositories" }!.footer.contains("settings.github.empty"))
var authorized = data
authorized.personal = GitHubPersonal(enabled: false, authorization: GitHubAuthorization(state: .authorized, githubAccountId: "1", profile: .init(login: "octo")))
let authorizedRows = GitHubSettingsSections.make(authorized, enabled: true).flatMap(\.rows)
precondition(authorizedRows[0].title == "octo" && authorizedRows[0].image == "https://avatars.githubusercontent.com/octo?size=96")
precondition(authorizedRows[1].toggle == false && authorizedRows[1].action, "An authorized identity can be turned on")
precondition(GitHubSettingsSections.avatarURL("bad/login") == nil)
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
