import Foundation
import LodyCore

extension DataRuntime {
  @MainActor
  static func settingsCall<C: RuntimeCall, Value: Decodable>(
    _ call: C.Type, _ request: some Encodable, as value: Value.Type, timeout: Double? = nil,
    project: (C.Result) throws -> any Encodable = { $0 }
  ) async throws -> Value where C.Params: Decodable, C.Result: Encodable {
    guard let runtime = current, let workspace = runtime.workspace else {
      throw failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    var object = try RuntimeJSON.object(request)
    guard object["workspaceId"] as? String == workspace else {
      throw failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    object["userId"] = runtime.userId
    guard let params = try? RuntimeJSON.decode(C.Params.self, from: object) else {
      throw failure("command_failed", "invalid_params: \(C.method)")
    }
    let result = try await runtime.perform(C.self, params, timeout: timeout)
    return try JSONDecoder().decode(Value.self, from: JSONEncoder().encode(project(result)))
  }
}
