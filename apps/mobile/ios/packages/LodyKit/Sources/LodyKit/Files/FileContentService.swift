import UIKit

enum FileRead: Equatable {
  case ok(handle: String)
  case failed(code: String)
}

@MainActor
struct FileContentService {
  var read: @MainActor (_ sessionId: String, _ path: String) async throws -> FileRead
  var quickLook: @MainActor (_ sessionId: String, _ path: String, _ from: UIViewController) async -> Bool

  static let live = FileContentService(
    read: { sessionId, path in
      guard let runtime = DataRuntime.current else {
        throw DataRuntime.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
      }
      return parse(try await FilePreview.read(sessionId: sessionId, path: path, runtime: runtime))
    },
    quickLook: { sessionId, path, controller in
      guard let runtime = DataRuntime.current else { return false }
      return await FilePreview.open(sessionId: sessionId, path: path, line: 0, runtime: runtime, from: controller)
    }
  )

  static func parse(_ json: String) -> FileRead {
    let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] ?? [:]
    if object["status"] as? String == "ok", let handle = object["handle"] as? String { return .ok(handle: handle) }
    return .failed(code: object["code"] as? String ?? "read_failed")
  }
}
