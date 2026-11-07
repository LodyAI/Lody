import Foundation

struct SettingsConnection: Decodable, Equatable, Sendable {
  var state = "syncing"
  var machines = 0
  var syncedAt: Double?
}

struct SettingsState: Equatable, Sendable {
  var account: AuthAccount?
  var workspace: AuthWorkspace?
  var connection = SettingsConnection()
  var busy = false
  var error: String?

  var scope: [String: Any] {
    guard let account, let workspace else { return [:] }
    return ["userId": account.user.id, "workspaceId": workspace.id]
  }
}

@MainActor
final class SettingsSource {
  let changes: [Notification.Name]
  private let read: @MainActor () -> SettingsState
  private let refreshAction: @MainActor () -> Void
  private let logoutAction: @MainActor () async -> Void

  init(
    changes: [Notification.Name], read: @escaping @MainActor () -> SettingsState,
    refresh: @escaping @MainActor () -> Void, logout: @escaping @MainActor () async -> Void
  ) {
    self.changes = changes
    self.read = read
    refreshAction = refresh
    logoutAction = logout
  }

  var state: SettingsState { read() }

  func refresh() { refreshAction() }

  func logout() async { await logoutAction() }

  static let live = SettingsSource(
    changes: [.lodyAuthDidChange, .lodyCatalogDidChange, .lodySettingsPreviewDidChange],
    read: { SettingsPreview.state ?? SettingsSource.published() },
    refresh: { CatalogSession.shared.refresh() },
    logout: { await AuthSession.shared.logout() }
  )

  private static func published() -> SettingsState {
    struct Auth: Decodable {
      var account: AuthAccount?
      var busy: Bool?
      var error: String?
      var initialWorkspace: String?
    }
    struct Catalog: Decodable {
      var userId: String?
      var workspaceId: String?
      var connection: SettingsConnection?
    }
    let auth = try? JSONDecoder().decode(Auth.self, from: Data(AuthSession.published.json.utf8))
    let catalog = try? JSONDecoder().decode(Catalog.self, from: Data(CatalogSession.published.json.utf8))
    var state = SettingsState(
      account: auth?.account, connection: catalog?.connection ?? SettingsConnection(), busy: auth?.busy ?? false,
      error: auth?.error
    )
    if let account = auth?.account {
      let scoped = catalog?.userId == account.user.id
      let selected = scoped ? catalog?.workspaceId : auth?.initialWorkspace
      state.workspace = account.workspaces.first { $0.id == selected } ?? account.workspaces.first
    }
    return state
  }
}

// Native offline fixtures publish their account independently of authenticated services.
@MainActor
enum SettingsPreview {
  private(set) static var state: SettingsState?

  static func set(_ json: String) {
    struct Payload: Decodable {
      var account: AuthAccount?
      var workspaceId: String?
      var connection: SettingsConnection?
    }
    guard LodyUIVerify.enabled else { return }
    let payload = try? JSONDecoder().decode(Payload.self, from: Data(json.utf8))
    state = payload.map { payload in
      SettingsState(
        account: payload.account,
        workspace: payload.account?.workspaces.first { $0.id == payload.workspaceId } ?? payload.account?.workspaces.first,
        connection: payload.connection ?? SettingsConnection(state: "live")
      )
    }
    NotificationCenter.default.post(name: .lodySettingsPreviewDidChange, object: nil)
  }
}

extension Notification.Name {
  static let lodySettingsPreviewDidChange = Notification.Name("LodySettingsPreviewDidChange")
}
