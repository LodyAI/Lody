import LodyCore
import UIKit

@MainActor
final class SessionSharePreviewController: UIViewController {
  private let list = LodyGroupedList(frame: .zero)
  private let fixture = SessionShareFixture()

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, _ in
      guard name == "rowPress", let self else { return }
      let share = SessionShareController(workspaceId: "fixture", sessionId: "root", service: self.fixture.service())
      LodyShell.shared.presentNative(share, title: String(localized: "share.title", bundle: .lody))
    }
    list.setSections([.group("share-preview", [.item("open-session-share", "Share Design review")])])
  }
}

@MainActor
private final class SessionShareFixture {
  private var failed = false
  private var listener: (@MainActor (ShareProgress) -> Void)?
  private var state = ShareState(
    entry: nil, url: nil,
    candidates: [.init(id: "root", title: "Design review"), .init(id: "child", title: "Accessibility notes")],
    selected: ["root"], pending: false
  )

  func service() -> SessionShareService {
    SessionShareService(
      request: { [self] in try await request($0) },
      subscribe: { [self] next in
        listener = next
        return { [weak self] in self?.listener = nil }
      }
    )
  }

  private func request(_ request: RuntimeContract.SessionSharingParams) async throws -> ShareState? {
    switch request.action {
    case .close:
      return nil
    case .discard:
      state.pending = false
    case .publish:
      for phase in [RuntimeContract.ShareProgressEventPhase.capturing, .uploading, .publishing] {
        listener?(ShareProgress(editorId: request.editorId, phase: phase, percent: 50))
        try await Task.sleep(for: .seconds(2))
        if phase == .uploading, !failed {
          failed = true
          state.pending = true
          state.selected = request.selected ?? ["root"]
          throw SettingsError("offline_fixture")
        }
      }
      state.pending = false
      state.selected = request.selected ?? ["root"]
      state.entry = RuntimeContract.ShareEntry(
        shareId: "offline-preview", rootSessionId: "root", publisherUserId: "fixture", status: .active,
        revision: (state.entry?.revision ?? 0) + 1, credentialVersion: state.entry?.credentialVersion ?? 1,
        canManage: true, canRevoke: true
      )
      state.url = state.url ?? "https://example.invalid/s/offline-preview#access=fixture-v1"
    case .reset:
      guard state.entry != nil else { break }
      state.entry?.credentialVersion += 1
      state.url = "https://example.invalid/s/offline-preview#access=fixture-v2"
    case .revoke:
      guard state.entry != nil else { break }
      state.entry?.status = .revoked
      state.url = nil
    case .read:
      break
    }
    return state
  }
}
