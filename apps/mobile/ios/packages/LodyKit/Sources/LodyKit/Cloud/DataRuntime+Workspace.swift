import LodyCore
import Foundation

extension DataRuntime {
  private func workspaceCallJSON<C: RuntimeCall>(_ call: C.Type, payload: String, sink: ReplySink, timeout: Double? = nil,
    project: @escaping @MainActor (C.Result) -> any Encodable = { $0 }) where C.Params: Decodable, C.Result: Encodable {
    guard let workspace, Self.scope(payload)?["workspaceId"] as? String == workspace else {
      fail(sink, "not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
      return
    }
    callJSON(C.self, payload: payload, inject: ["userId": userId], sink: sink, timeout: timeout, project: project)
  }
  func creationOptions(_ payload: String, sink: ReplySink) {
    workspaceCallJSON(RuntimeContract.Calls.CreationOptions.self, payload: payload, sink: sink)
  }

}
