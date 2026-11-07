import UIKit

extension SessionController {
  func renderPermission() {
    let state = source.state
    if let scope = permissionScope, scope != (state.userId, state.workspaceId) {
      permissionPage?.update(nil, ready: true)
      return
    }
    guard let session = state.catalog.session(sessionId) else { return }
    let ready = feed?.state.status == "live"
    if ready, let error = feed?.state.transcript.permissionError {
      // A malformed pending request stays visible rather than masquerading as no request.
      if permissionPage == nil, view.window != nil, permissionGate.canPrompt { openPermission(nil) }
      permissionPage?.showInvalidRequest(error)
      return
    }
    let target = ready ? feed?.state.transcript.permission : nil
    if let page = permissionPage {
      page.update(target, ready: ready)
    } else if view.window != nil, permissionGate.shouldOpen(target?.requestId),
              target != nil || (!ready && session.awaitingUserSince != nil) {
      openPermission(target)
    }
  }

  func openPermission(_ target: SessionPermission?) {
    guard permissionPage == nil else { return }
    let page = PermissionController(sessionId: sessionId, service: permissionService)
    permissionPage = page
    permissionScope = (source.state.userId, source.state.workspaceId)
    permissionGate.opened()
    page.onClose = { [weak self, weak page] answer, cancelled in
      guard let self, permissionPage === page else { return }
      permissionPage = nil
      permissionGate.closed(answer: answer, cancelled: cancelled)
      renderPermission()
    }
    LodyShell.shared.presentNative(
      page, title: String(localized: String.LocalizationValue(target?.questionMeta == nil ? "permission.title" : "question.title"), bundle: .lody),
      detents: [0.6, 1], dismissible: false
    )
    if let target { page.update(target, ready: true) }
  }
}
