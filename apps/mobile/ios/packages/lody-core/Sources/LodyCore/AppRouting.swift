import Foundation

public enum AppLink: Equatable, Sendable {
  case session(workspace: String, session: String)
  case share
  case page(String, [String: String])

  public static func parse(_ raw: String) -> AppLink? {
    guard raw.count <= 2048, raw.lowercased().hasPrefix("lody://") else { return nil }
    let tail = String(raw.dropFirst(7))
    let path = String(tail.prefix { $0 != "?" && $0 != "#" })
    let pieces = path.split(separator: "/", omittingEmptySubsequences: false)
    let segments = pieces.first == "" ? Array(pieces.dropFirst()) : pieces
    if segments.count == 3, segments[1] == "sessions",
       let workspace = segment(String(segments[0])), let session = segment(String(segments[2])) {
      return .session(workspace: workspace, session: session)
    }
    if segments.count == 2, segments[0] == "share", UUID(uuidString: String(segments[1])) != nil { return .share }
    let query = URLComponents(string: raw)?.queryItems?.reduce(into: [String: String]()) { $0[$1.name] = $1.value ?? "" } ?? [:]
    if segments.count == 1, ["activity", "diagnostics", "debug"].contains(String(segments[0])) {
      return .page(String(segments[0]), query)
    }
    if segments.count == 2, segments[0] == "project", let id = segment(String(segments[1])) {
      return .page("project", ["projectId": id])
    }
    return nil
  }

  private static func segment(_ raw: String) -> String? {
    guard let value = raw.removingPercentEncoding, !value.isEmpty, value != ".", value != "..",
      !value.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 || $0 == "/" || $0 == "\\" }) else { return nil }
    return value
  }
}

public enum NotificationNavigation {
  public struct Context {
    public var ready: Bool
    public var userId: String
    public var workspaces: [(id: String, slug: String?)]
    public var selectedId: String
    public var loading: Bool
    public var connected: Bool
    public var sessionIds: Set<String>

    public init(ready: Bool, userId: String, workspaces: [(String, String?)], selectedId: String,
                loading: Bool, connected: Bool, sessionIds: Set<String>) {
      self.ready = ready; self.userId = userId; self.workspaces = workspaces; self.selectedId = selectedId
      self.loading = loading; self.connected = connected; self.sessionIds = sessionIds
    }
  }

  public enum Failure: String, Sendable { case wrongAccount, unknownRoute, noWorkspace, sessionMissing }
  public enum Destination: Equatable, Sendable { case wait, discard(Failure), workspace(String), session(String) }

  public static func resolve(route: String, recipient: String?, context: Context) -> Destination {
    guard context.ready else { return .wait }
    guard !context.userId.isEmpty, (recipient == nil || recipient == context.userId) else { return .discard(.wrongAccount) }
    guard route.hasPrefix("/"), !route.contains("?"), !route.contains("#"),
      case .session(let slug, let session) = AppLink.parse("lody://" + route) else { return .discard(.unknownRoute) }
    guard let workspace = context.workspaces.first(where: { $0.id == slug || $0.slug == slug }) else { return .discard(.noWorkspace) }
    if workspace.id != context.selectedId { return .workspace(workspace.id) }
    if context.sessionIds.contains(session) { return .session(session) }
    if context.loading || !context.connected { return .wait }
    return .discard(.sessionMissing)
  }
}

public enum ShareInboxRouting {
  public enum Step: Equatable, Sendable { case discard, workspace(String), wait, deliver }

  public static func resolve(user: String, workspaces: [String], selected: String, loading: Bool,
                             entryUser: String, entryWorkspace: String) -> Step {
    guard user == entryUser, workspaces.contains(entryWorkspace) else { return .discard }
    if selected != entryWorkspace { return .workspace(entryWorkspace) }
    if loading { return .wait }
    return .deliver
  }
}
