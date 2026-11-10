import UIKit

@MainActor
final class ActivityPreviewController: ActivityController {
  init(scenario: String) {
    let fixture = ActivityFixture(scenario: scenario)
    let userId = scenario == "wrong-account" ? "other-user" : "preview-user"
    super.init(
      workspaceId: "preview-activity", userId: userId,
      source: SessionSource(changes: [ActivityFixture.change], read: { fixture.state }, write: { _, _, _ in }),
      localReady: { true }, select: { fixture.select($0) }
    )
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

@MainActor
private final class ActivityFixture {
  static let change = Notification.Name("LodyActivityFixture")
  private var workspaceId = "preview-other"
  private let scenario: String
  private let catalog: SessionCatalog

  init(scenario: String, now: Double = LodyRelativeTime.now()) {
    self.scenario = scenario
    let hour = 3_600_000.0
    catalog = SessionCatalog(
      projects: [SessionProject(id: "preview-lody", name: "Lody", rootPath: "/Users/preview/lody")],
      sessions: scenario == "offline" ? [] : [
        SessionItem(id: "activity-running", title: "Running build", status: "running", projectId: "preview-lody", lastMessageAt: now - 0.1 * hour),
        SessionItem(
          id: "activity-waiting", title: "Waiting for approval", status: "idle", projectId: "preview-lody",
          lastMessageAt: now - 0.5 * hour, awaitingUserSince: now - 0.5 * hour
        ),
        SessionItem(id: "activity-done", title: "Finished work", status: "completed", projectId: "preview-lody", lastMessageAt: now - hour),
        SessionItem(
          id: "activity-archived", title: "Archived running", status: "running", archived: true, projectId: "preview-lody",
          lastMessageAt: now - 2 * hour
        ),
      ]
    )
  }

  var state: SessionListState {
    SessionListState(
      userId: "preview-user", workspaceId: workspaceId, connected: scenario != "offline",
      workspaces: [
        AuthWorkspace(id: "preview-activity", name: "Preview", slug: nil, image: nil),
        AuthWorkspace(id: "preview-other", name: "Other", slug: nil, image: nil),
      ],
      catalog: catalog
    )
  }

  func select(_ id: String) {
    Task {
      try? await Task.sleep(for: .milliseconds(400))
      workspaceId = id
      NotificationCenter.default.post(name: Self.change, object: nil)
    }
  }
}
