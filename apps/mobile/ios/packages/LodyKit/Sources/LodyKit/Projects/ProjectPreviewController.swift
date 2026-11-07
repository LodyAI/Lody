import UIKit

@MainActor
final class ProjectPreviewController: ProjectController {
  private let fixture: ProjectFixture
  private let probe = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))

  init(projectId: String = "preview-lody", connected: Bool = true) {
    let fixture = ProjectFixture()
    self.fixture = fixture
    super.init(
      projectId: projectId,
      source: SessionSource(
        changes: [ProjectFixture.change], read: { fixture.state },
        write: { _, id, write in try await fixture.write(id, write) }
      ),
      connected: { connected }
    )
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    probe.isAccessibilityElement = true
    probe.accessibilityIdentifier = "project-preview-writes"
    super.viewDidLoad()
    view.addSubview(probe)
  }

  override func render() {
    super.render()
    probe.accessibilityValue = fixture.writes.joined(separator: ",")
  }
}

@MainActor
private final class ProjectFixture {
  static let change = Notification.Name("LodyProjectFixture")
  private(set) var writes: [String] = []
  private var catalog: SessionCatalog

  init(now: Double = LodyRelativeTime.now()) {
    let hour = 3_600_000.0
    catalog = SessionCatalog(
      projects: [
        SessionProject(id: "preview-lody", name: "Lody", rootPath: "/Users/preview/lody"),
        SessionProject(id: "preview-empty", name: "Empty Project", rootPath: "/Users/preview/empty"),
        SessionProject(id: "preview:unassigned", name: "Chat"),
      ],
      sessions: [
        SessionItem(
          id: "project-live", title: "Refactor the session list", status: "running",
          projectId: "preview-lody", lastMessageAt: now - 0.1 * hour, branchName: "feat/native-project", modelName: "GPT-5",
          diff: ["add": 48, "del": 12]
        ),
        SessionItem(
          id: "project-child", title: "Check the empty state", status: "completed", projectId: "preview-lody",
          openedBySessionId: "project-live", lastMessageAt: now - 0.5 * hour
        ),
        SessionItem(
          id: "project-unread", title: "Review release notes", status: "idle", projectId: "preview-lody",
          lastMessageAt: now - 3 * hour, lastReadAt: now - 4 * hour
        ),
        SessionItem(
          id: "project-archived", title: "Old migration notes", status: "completed", archived: true,
          projectId: "preview-lody", lastMessageAt: now - 72 * hour
        ),
        SessionItem(
          id: "project-chat", title: "Chat stays out of projects", status: "idle", projectId: "preview:unassigned",
          lastMessageAt: now - hour
        ),
      ]
    )
  }

  var state: SessionListState {
    SessionListState(userId: "preview-user", workspaceId: "preview-workspace", catalog: catalog)
  }

  func write(_ id: String, _ write: SessionWrite) async throws {
    try await Task.sleep(for: .milliseconds(300))
    switch write {
    case .archive(let archived):
      update(id) { $0.archived = archived }
      record("archive:\(id):\(archived)")
    case .pin(let pinned):
      update(id) { $0.pinned = pinned }
      record("pin:\(id):\(pinned)")
    case .read(let at):
      update(id) { $0.lastReadAt = at }
      record("read:\(id)")
    case .tabClosed(let closed):
      update(id) { $0.isTabClosed = closed }
    case .rename(let title):
      update(id) { $0.title = title }
      record("rename:\(id)")
    case .delete(let ids):
      catalog.sessions.removeAll { ids.contains($0.id) }
      record("delete:\(ids.joined(separator: "+"))")
    }
  }

  private func update(_ id: String, _ change: (inout SessionItem) -> Void) {
    guard let index = catalog.sessions.firstIndex(where: { $0.id == id }) else { return }
    change(&catalog.sessions[index])
  }

  private func record(_ entry: String) {
    writes.append(entry)
    NotificationCenter.default.post(name: Self.change, object: nil)
  }
}
