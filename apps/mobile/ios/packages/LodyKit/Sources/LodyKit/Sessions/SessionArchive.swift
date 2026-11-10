import Foundation

/// The write outlives the conversation page; only its original active scope receives errors.
@MainActor
enum SessionArchive {
  @discardableResult
  static func start(
    isCurrent: @escaping @MainActor () -> Bool,
    write: @escaping @MainActor () async throws -> Void,
    returnToList: @MainActor () -> Void,
    failed: @escaping @MainActor () -> Void
  ) -> Task<Void, Never> {
    let operation = Task {
      guard isCurrent() else { return }
      do { try await write() }
      catch { if isCurrent() { failed() } }
    }
    returnToList()
    return operation
  }
}
