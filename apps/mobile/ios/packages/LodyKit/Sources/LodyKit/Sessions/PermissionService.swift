import Foundation
import LodyCore

@MainActor
struct PermissionService {
  var detail: @MainActor (String, SessionPermission) async throws -> RuntimeContract.ItemDetail
  var respond: @MainActor (RuntimeContract.RespondPermissionParams) async throws -> RuntimeContract.RespondPermissionResultState

  static let live = Self(
    detail: { sessionId, target in
      guard let runtime = DataRuntime.current, runtime.sessionId == sessionId else { throw OutboxError.scopeExpired }
      return try await runtime.perform(RuntimeContract.Calls.ItemDetail.self, .init(
        sessionId: sessionId, entryId: target.entryId, itemId: target.itemId
      ))
    },
    respond: { params in
      guard let runtime = DataRuntime.current, runtime.sessionId == params.sessionId else { throw OutboxError.scopeExpired }
      return try await runtime.perform(RuntimeContract.Calls.RespondPermission.self, params).state
    }
  )
}
