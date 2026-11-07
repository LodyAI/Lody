import Foundation

extension PreviewFeedback {
  @MainActor static func live(sessionId: String) -> PreviewFeedback? {
    let source = SessionSource.live
    let state = source.state
    guard let session = state.catalog.session(sessionId),
      let store = OutboxSession.shared.outboxStore(user: state.userId, workspace: state.workspaceId) else { return nil }
    func current() -> Bool { source.state.userId == state.userId && source.state.workspaceId == state.workspaceId }
    let feedback = PreviewFeedback.outbox(store: store, session: session, connected: { source.state.connected }, openSession: {
      guard current(), let json = source.raw(sessionId) else { return }
      LodyShell.shared.sessionIntent("open", ["session": json])
    })
    return PreviewFeedback(send: { report in
      guard current() else { throw OutboxError.scopeExpired }
      return try await feedback.send(report)
    }, openSession: feedback.openSession)
  }
}
