import LodyCore
import UIKit

@MainActor
enum ProjectHistoryPreview {
  static func make() -> UIViewController {
    let fixture = ProjectHistoryFixture()
    let service = ProjectHistoryService(call: { try await fixture.call($0) }, cancel: {})
    return ProjectHistoryController(
      scope: SettingsActor(userId: "preview", workspaceId: "offline-history"), service: { _ in service }
    )
  }
}

@MainActor
private final class ProjectHistoryFixture {
  private static let target = HistoryTarget(
    machineId: "studio", machineName: "Studio Mac", localProjectId: "demo", projectName: "Demo Project",
    rootPath: "/Projects/demo", provider: .init(cliType: .builtin, agentType: "codex")
  )
  private var sessions: [RuntimeContract.LocalProjectsResultHistorySessionsItem] = [
    .init(acpSessionId: "one", title: "Build the project", status: .available),
    .init(acpSessionId: "two", title: "Fix a layout issue", status: .available),
    .init(acpSessionId: "conflict", title: "Changed on both clients", importedSessionId: "imported-conflict", status: .syncConflict),
    .init(acpSessionId: "done", title: "Previously imported", importedSessionId: "imported-done", status: .imported),
  ]
  private var failLoad = true
  private var failImport = true

  func call(_ request: HistoryRequest) async throws -> HistoryResponse {
    switch request {
    case .targets:
      var grok = Self.target
      grok.provider.agentType = "grok"
      var other = Self.target
      other.localProjectId = "other"
      other.projectName = "Other Project"
      other.rootPath = "/Projects/other"
      var laptop = Self.target
      laptop.machineId = "laptop"
      laptop.machineName = "Travel Mac"
      return .targets([Self.target, grok, other, laptop])
    case .sync(let value):
      try await Task.sleep(for: .seconds(4))
      if value.target.provider.agentType == "grok" { return .result(.init(sessions: [])) }
      if failLoad {
        failLoad = false
        throw SettingsError(ProjectHistorySections.text("loadFailed"))
      }
    case .resolve(let value):
      sessions = sessions.map { session in
        var next = session
        if session.acpSessionId == value.acpSessionId { next.status = .imported }
        return next
      }
    case .import(let value):
      let failures = value.acpSessionIds.filter { $0 == "two" && failImport }
        .map { RuntimeContract.LocalProjectsResultHistoryFailuresItem(acpSessionId: $0, message: "Synthetic import failure") }
      failImport = false
      let failed = Set(failures.map(\.acpSessionId))
      sessions = sessions.map { session in
        var next = session
        if value.acpSessionIds.contains(session.acpSessionId), !failed.contains(session.acpSessionId) {
          next.status = .imported
          next.importedSessionId = "imported-\(session.acpSessionId)"
        }
        return next
      }
      return .result(.init(sessions: sessions, failures: failures))
    }
    return .result(.init(sessions: sessions))
  }
}
