import LodyCore
import UIKit

@MainActor
enum SessionNavigation {
  static func receive(_ json: String) throws {
    let fields = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    try handle(fields["kind"] as! String, fields)
  }

  @discardableResult
  static func handle(_ action: String, _ fields: [String: Any]) throws -> LodyPageController? {
    let source = HomeController.current?.source ?? .live
    let state = source.state
    if let workspace = fields["workspaceId"] as? String, workspace != state.workspaceId { throw OutboxError.scopeExpired }
    if let user = fields["userId"] as? String, user != state.userId { throw OutboxError.scopeExpired }
    switch action {
    case "open":
      let object: [String: Any]
      if let raw = fields["session"] as? String {
        object = try JSONSerialization.jsonObject(with: Data(raw.utf8)) as! [String: Any]
      } else { object = fields["session"] as! [String: Any] }
      let id = object["id"] as! String
      guard state.catalog.session(id) != nil else { throw OutboxError.scopeExpired }
      let query = fields["findQuery"] as? String ?? ""
      let target = query.isEmpty ? SessionTabSelection().resolve(state.catalog.session(id)!, all: state.catalog.sessions, user: state.userId, workspace: state.workspaceId) : id
      open(target, query: query, source: source)
    case "share":
      let id = fields["sessionId"] as! String
      guard state.catalog.session(id) != nil else { throw OutboxError.scopeExpired }
      let content = LodyNativePages.make("session-share", params: SessionController.json(["workspaceId": state.workspaceId, "sessionId": id]))!
      LodyShell.shared.presentNative(content, title: String(localized: "share.title", bundle: .lody), grabber: true)
    case "create":
      guard state.workspace?.resolvedMode == .plaintext else { throw WorkspaceContentError.blocked }
      var params = CreateSessionHostParams()
      params.userId = state.userId; params.workspaceId = state.workspaceId
      // Most recently active first: the new-session project menu offers the first five.
      params.projects = InboxSections.sortProjects(state.catalog.projects, sessions: state.catalog.sessions, sort: .activity).filter { !SessionRows.isChat($0.id) }.map {
        CreateProject(id: $0.id, machineId: $0.machineId, name: $0.name, rootPath: $0.rootPath)
      }
      params.machineNames = state.catalog.machineNames
      params.machineOs = state.catalog.machineOs
      params.projectId = fields["projectId"] as? String; params.context = fields["context"] as? String
      let draft = fields["draft"] as? [String: Any]
      params.initialText = draft?["text"] as? String
      params.initialAttachmentsJSON = draft?["attachmentsJSON"] as? String
      params.relay = true
      let regular = HomeController.current?.traitCollection.horizontalSizeClass == .regular
      // iPhone: like web, new session is its own full screen, pushed over Home (back returns).
      // The form brings its own navigation bar for its pickers, so the shell page hides its own.
      // Shared content keeps the sheet it is handed off in.
      params.pushed = !regular && fields["sheet"] as? Bool != true
      let content = CreateSessionHostController(params: params)
      content.onCreated = { created in
        guard source.state.key == state.key else { throw OutboxError.scopeExpired }
        let session = created["session"] as! [String: Any]
        guard source.state.catalog.session(session["id"] as! String) != nil else { throw OutboxError.scopeExpired }
        let choice = ModelChoice(modelId: created["modelId"] as? String, effort: created["effort"] as? String, modeId: created["modeId"] as? String)
        if params.pushed == true {
          // Prepare Home's destination beneath the form without a second split-view animation.
          UIView.performWithoutAnimation {
            open(session["id"] as! String, choice: choice, source: source)
            HomeController.current?.view.layoutIfNeeded()
          }
        } else {
          open(session["id"] as! String, choice: choice, source: source)
        }
      }
      if params.pushed == true,
        let page = LodyShell.shared.pushRootNative(content, title: String(localized: "create.title", bundle: .lody), headerShown: false) {
        return page
      }
      if !regular, let label = fields["zoomSourceLabel"] as? String { LodySheetZoom.prepare(sourceLabel: label) }
      return LodyShell.shared.presentNative(content, title: String(localized: "create.title", bundle: .lody),
        detents: regular ? [1] : [0.62, 1], grabber: !regular, headerShown: false)
    default: preconditionFailure("Unknown session navigation: \(action)")
    }
    return nil
  }

  private static func open(_ id: String, query: String = "", choice: ModelChoice? = nil, source: SessionSource) {
    if let home = HomeController.current { home.openSession(id, query: query, choice: choice); return }
    let page = SessionController(sessionId: id, findQuery: query, choice: choice, source: source)
    LodyShell.shared.pushRootNative(page, title: "")
  }
}
