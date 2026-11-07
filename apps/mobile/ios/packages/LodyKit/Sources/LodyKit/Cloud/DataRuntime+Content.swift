import LodyCore
import Foundation

extension DataRuntime {
  func readFile(_ payload: String) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      contentCall(RuntimeContract.Calls.ReadFile.self, payload: payload, sink: .continuation(continuation), session: \.sessionId)
    }
  }
  private func contentCall<C: RuntimeCall>(_ call: C.Type, payload: String, sink: ReplySink,
    session: (C.Params) -> String) where C.Params: Decodable, C.Result: Encodable {
    guard inOpenSession(payload, sink: sink), let params = decodeParams(C.self, payload: payload, sink: sink) else { return }
    let owner = session(params)
    self.call(C.self, params, sink: sink) { result in
      (try? JSONEncoder().encode(result)).map { Self.parkContent(method: C.method, session: owner, json: $0) }
    }
  }
  // Bodies stay in ContentStore; UI state only receives a handle plus metadata.
  private static func parkContent(method: String, session: String, json data: Data) -> String {
    var json: String { String(decoding: data, as: UTF8.self) }
    guard var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          object["status"] as? String == "ok" else { return json }
    let path = object["path"] as? String ?? ""
    if method == "readFile" {
      let binary = object["kind"] as? String == "binary"
      let mimeType = object["mimeType"] as? String
      let body: Data
      if binary {
        guard let decoded = Data(base64Encoded: object["base64"] as? String ?? "") else { return json }
        body = decoded
      } else {
        body = Data((object["text"] as? String ?? "").utf8)
      }
      let kind = ContentStore.classify(path: path, binary: binary, mimeType: mimeType)
      object["kind"] = kind
      object["text"] = nil; object["base64"] = nil
      object["handle"] = ContentStore.shared.put(StoredContent(data: body, kind: kind, path: path, session: session, mimeType: mimeType))
    } else {
      var sides: [String: String] = [:]
      for key in ["old", "new"] {
        let side = object[key] as? [String: Any]
        sides[key] = side?["text"] as? String
        object[key + "Kind"] = side?["kind"] as? String ?? "missing"
        object[key] = nil
      }
      let body = (try? JSONSerialization.data(withJSONObject: sides)) ?? Data()
      object["handle"] = ContentStore.shared.put(StoredContent(data: body, kind: "diff", path: path, session: session, mimeType: nil))
    }
    guard let output = try? JSONSerialization.data(withJSONObject: object), let text = String(data: output, encoding: .utf8) else { return json }
    return text
  }
}
