import LodyCore
import Foundation

/// Display-only member cache. Each request is fenced by account, workspace and store generation.
@MainActor enum WorkspaceMembers {
  static func key(userId: String, workspaceId: String) -> String {
    "workspace-members:v1:" + CreateJSON.encode([userId, workspaceId])
  }

  static func load(userId: String, workspaceId: String, receive: @escaping @MainActor ([String: WorkspaceMember]) -> Void) async {
    let generation = LocalStore.shared.generation
    func ownsScope() -> Bool {
      let account = AuthSession.shared.snapshot.account
      return !Task.isCancelled && LocalStore.shared.generation == generation
        && account?.user.id == userId && account?.workspaces.contains { $0.id == workspaceId } == true
    }
    guard ownsScope() else { return }
    let cacheKey = key(userId: userId, workspaceId: workspaceId)
    let raw: String? = await withCheckedContinuation { continuation in
      LocalStore.queue.async { continuation.resume(returning: (try? LocalStore.shared.read(cacheKey)) ?? nil) }
    }
    guard ownsScope() else { return }
    if let raw, let cached = CreateJSON.decode([WorkspaceMember].self, raw) {
      receive(Dictionary(cached.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new }))
    }
    do {
      guard let token = try AuthKeychain.read(), !token.isEmpty else { return }
      let fresh = try await AuthAPI().members(token: token, workspaceId: workspaceId)
      guard ownsScope(), try AuthKeychain.read() == token else { return }
      receive(Dictionary(fresh.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new }))
      let value = CreateJSON.encode(fresh)
      LocalStore.queue.async { try? LocalStore.shared.write(cacheKey, value, generation: generation) }
    } catch { /* Keep cached identities when the refresh fails. */ }
  }
}
