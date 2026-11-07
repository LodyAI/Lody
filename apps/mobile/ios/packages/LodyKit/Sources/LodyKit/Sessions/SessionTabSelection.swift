import Foundation

/// Device-local navigation preference, scoped to the signed-in user and workspace.
struct SessionTabSelection {
  var defaults: UserDefaults = .standard

  private func key(user: String, workspace: String, root: String) -> String {
    "session-tab-v1:" + [user, workspace, root].map { "\($0.utf8.count):\($0)" }.joined()
  }

  func remember(_ session: SessionItem, all: [SessionItem], user: String, workspace: String) {
    guard !user.isEmpty, !workspace.isEmpty,
      DirectoryTabs.sessions(current: session, all: all).contains(where: { $0.id == session.id }) else { return }
    let key = key(user: user, workspace: workspace, root: DirectoryTabs.root(session, all: all))
    if defaults.string(forKey: key) != session.id { defaults.set(session.id, forKey: key) }
  }

  /// Used only for opening the containing conversation from a list, never an explicit Tab link.
  func resolve(_ session: SessionItem, all: [SessionItem], user: String, workspace: String) -> String {
    guard !user.isEmpty, !workspace.isEmpty, session.parentSessionId == nil else { return session.id }
    let open = DirectoryTabs.sessions(current: session, all: all)
    let saved = defaults.string(forKey: key(user: user, workspace: workspace, root: DirectoryTabs.root(session, all: all)))
    return open.first(where: { $0.id == saved })?.id ?? open.first?.id ?? session.id
  }
}
