import Foundation

/// Offline states for reviewing the production composer capsules. No network writes.
enum SessionActionBarPreview {
  private static let strings: [String: String] = {
    guard let url = Bundle.lody.url(forResource: "ActionBarReview", withExtension: "json"),
          let data = try? Data(contentsOf: url),
          let strings = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
    return strings
  }()
  static func text(_ key: String) -> String { strings[key] ?? key }

  static func configure(_ catalog: inout SessionCatalog, scenario: String) {
    let repo = "loro-dev/lody"
    catalog.projects[0].id = "github:" + repo
    catalog.projects[0].repoFullName = repo
    catalog.sessions[0].projectId = "github:" + repo
    catalog.sessions[0].title = text("title")
    catalog.machineNames["preview-mac"] = text("machine")
    var session = catalog.sessions[0]
    session.pullRequests = []
    session.branchName = "feature/mobile-ui"
    if scenario == "bar-windows" { catalog.machineOs["preview-mac"] = "win32" }
    if scenario == "bar-linux" { catalog.machineOs["preview-mac"] = "linux" }
    if scenario == "bar-empty" {
      session.projectId = ""
      session.branchName = nil
      catalog.machineNames = [:]
    }
    if scenario == "bar-repo" { session.branchName = nil }
    if scenario == "bar-local" {
      session.projectId = "preview-mac:local:lody"
      catalog.projects[0].id = session.projectId
      catalog.projects[0].repoFullName = nil
    }
    if ["bar-changes", "bar-dirty", "bar-long", "bar-crowded", "bar-running", "bar-local"].contains(scenario) {
      session.diff = ["add": 285, "del": 35]
    }
    if scenario == "bar-zero-line" { session.diff = ["add": 0, "del": 0, "files": 2] }
    if scenario == "bar-mixed" { session.diff = ["add": 12, "del": 3, "files": 3] }
    if scenario == "bar-dirty" { session.workspaceDirty = true }
    if scenario == "bar-long" { session.branchName = "feature/refactor-mobile-conversation-action-capsules" }
    if scenario == "bar-diff-only" {
      session.projectId = "preview-mac:local:lody"
      session.branchName = nil
      session.diff = ["add": 285, "del": 35]
    }
    let states: [String: (String, String?, String?)] = [
      "bar-draft": ("draft", nil, nil), "bar-draft-dirty": ("draft", nil, nil),
      "bar-open": ("open", nil, nil), "bar-ci-pending": ("open", "p", "b"),
      "bar-ci-failed": ("open", "f", "u"), "bar-ci-error": ("open", "e", "u"),
      "bar-conflict": ("open", "s", "d"), "bar-conflict-ci": ("open", "f", "d"),
      "bar-context": ("open", "s", "c"), "bar-merge": ("open", "s", "c"), "bar-unpushed": ("open", "s", "c"),
      "bar-merged": ("merged", "s", "c"), "bar-closed": ("closed", nil, nil),
      "bar-ready-pending": ("open", nil, nil), "bar-merge-pending": ("merged", "s", "c"),
      "bar-crowded": ("open", "f", "d"),
    ]
    if let (status, ci, merge) = states[scenario] {
      session.pullRequests = [.init(repository: repo, number: 128, status: status, ci: ci, merge: merge)]
    }
    if scenario == "bar-draft-dirty" || scenario == "bar-crowded" { session.workspaceDirty = true }
    if scenario == "bar-unpushed" { session.workspaceUnpushed = true }
    if scenario == "bar-context" {
      session.pullRequests = [.init(repository: repo, number: 4223, status: "open", ci: "s", merge: "c")]
      session.branchName = "investigate-billing-cycle"
      session.diff = ["add": 3338, "del": 249]
      session.workspaceDirty = true
    }
    catalog.sessions[0] = session
  }

  static func resources(_ scenario: String, browser: [String: Any]?) -> [[String: Any]] {
    var result: [[String: Any]] = []
    if ["bar-browser", "bar-browser-busy", "bar-crowded"].contains(scenario), var browser {
      browser["busy"] = scenario == "bar-browser-busy"
      result.append(browser)
    }
    if ["bar-simulator", "bar-simulator-busy", "bar-crowded"].contains(scenario) {
      result.append([
        "id": "simulator", "symbol": "iphone", "tap": true, "tint": "primary",
        "busy": scenario == "bar-simulator-busy", "menuTitle": "iPhone 17 Pro",
        "accessibilityLabel": text("simulator"),
        "actions": [["id": "stop", "title": String(localized: "simulator.stop", bundle: .lody), "symbol": "stop.circle", "destructive": true]],
      ])
    }
    return result
  }
}
