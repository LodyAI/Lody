import Foundation

extension CreateSessionService {
  /// Admission precedes invoking the outbox port, which can publish and queue a write immediately.
  func submit(user: String, workspace: String, json: String) throws -> Task<Void, Error> {
    guard workspaceMode(workspace) == .plaintext else { throw WorkspaceContentError.blocked }
    return put(user, workspace, json)
  }
}
