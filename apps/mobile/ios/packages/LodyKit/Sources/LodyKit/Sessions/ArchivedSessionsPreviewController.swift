import UIKit

@MainActor
final class ArchivedSessionsPreviewController: ArchivedSessionsController {
  private let fixture: ArchivedSessionsFixture
  private let probe = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))

  init() {
    let fixture = ArchivedSessionsFixture()
    self.fixture = fixture
    super.init(source: SessionSource(
      changes: [ArchivedSessionsFixture.change], read: { fixture.state },
      write: { _, id, write in try await fixture.write(id, write) }
    ))
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    probe.isAccessibilityElement = true
    probe.accessibilityIdentifier = "archived-preview-writes"
    super.viewDidLoad()
    view.addSubview(probe)
  }

  override func render() {
    super.render()
    probe.accessibilityValue = fixture.writes.joined(separator: ",")
  }
}

@MainActor
private final class ArchivedSessionsFixture {
  static let change = Notification.Name("LodyArchivedSessionsFixture")
  private(set) var writes: [String] = []
  private var failedDelete = false
  private var catalog: SessionCatalog

  init(now: Double = LodyRelativeTime.now()) {
    let hour = 3_600_000.0
    catalog = SessionCatalog(
      projects: [
        SessionProject(id: "preview-lody", name: "Lody", rootPath: "/Users/preview/lody"),
        SessionProject(id: "preview:unassigned", name: "Chat"),
      ],
      sessions: [
        SessionItem(
          id: "archived-release", title: "Prepare release notes", status: "completed", archived: true,
          projectId: "preview-lody", lastMessageAt: now - 2 * hour, lastReadAt: now - 3 * hour,
          branchName: "release/2.4", modelName: "GPT-5", diff: ["add": 12, "del": 3]
        ),
        SessionItem(
          id: "archived-release-check", title: "Check changelog links", status: "completed", archived: true,
          projectId: "preview-lody", openedBySessionId: "archived-release", lastMessageAt: now - 5 * hour,
          modelNeverRan: true
        ),
        SessionItem(
          id: "archived-chat", title: "Weekend reading list", status: "idle", archived: true,
          projectId: "preview:unassigned", lastMessageAt: now - 30 * 24 * hour
        ),
        SessionItem(
          id: "active-session", title: "Active work stays in the inbox", status: "running",
          projectId: "preview-lody", lastMessageAt: now
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
      if !failedDelete {
        failedDelete = true
        record("delete-failed:\(id)")
        throw DataRuntime.failure("offline_fixture", "offline_fixture")
      }
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
