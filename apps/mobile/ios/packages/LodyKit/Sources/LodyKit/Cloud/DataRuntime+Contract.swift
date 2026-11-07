import LodyCore
import Foundation

extension DataRuntime {
  enum ReplySink {
    case continuation(CheckedContinuation<String, Error>)

    func resolve(_ value: Any?) {
      switch self {
      case .continuation(let continuation):
        if let text = value as? String {
          continuation.resume(returning: text)
        } else if value == nil {
          continuation.resume(returning: "")
        } else {
          continuation.resume(returning: String(describing: value as Any))
        }
      }
    }

    func reject(_ error: Error) {
      switch self {
      case .continuation(let continuation):
        continuation.resume(throwing: error)
      }
    }
  }

  func fail(_ sink: ReplySink, _ code: String, _ message: String) {
    sink.reject(Self.failure(code, message))
  }

  static func failure(_ code: String, _ message: String) -> NSError {
    NSError(domain: "LodyKit.DataRuntime", code: 1, userInfo: [NSLocalizedDescriptionKey: "\(code): \(message)"])
  }

  static func scope(_ payload: String) -> [String: Any]? {
    payload.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
  }
  func inOpenSession(_ payload: String, sink: ReplySink) -> Bool {
    guard Self.scope(payload)?["sessionId"] as? String == sessionId else {
      fail(sink, "not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
      return false
    }
    return true
  }
  func inWorkspace(_ payload: String, sink: ReplySink) -> Bool {
    guard let workspace, Self.scope(payload)?["workspaceId"] as? String == workspace else {
      fail(sink, "not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
      return false
    }
    return true
  }
  func callJSON<C: RuntimeCall>(_ call: C.Type, payload: String, inject: [String: Any] = [:], sink: ReplySink, timeout: Double? = nil,
    project: @escaping @MainActor (C.Result) -> any Encodable = { $0 }) where C.Params: Decodable, C.Result: Encodable {
    guard let params = decodeParams(C.self, payload: payload, inject: inject, sink: sink) else { return }
    self.call(C.self, params, sink: sink, timeout: timeout) { result in
      (try? JSONEncoder().encode(project(result))).map { String(decoding: $0, as: UTF8.self) }
    }
  }
  func decodeParams<C: RuntimeCall>(_ call: C.Type, payload: String, inject: [String: Any] = [:], sink: ReplySink) -> C.Params? where C.Params: Decodable {
    guard let data = payload.data(using: .utf8), data.count <= 128 * 1024,
          var object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      fail(sink, "not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
      return nil
    }
    object.merge(inject) { _, injected in injected }
    do { return try RuntimeJSON.decode(C.Params.self, from: object) }
    catch {
      fail(sink, "command_failed", "invalid_params: \(C.method)")
      return nil
    }
  }
  func call<C: RuntimeCall>(_ call: C.Type, _ params: C.Params, sink: ReplySink, timeout: Double? = nil,
    failed: @escaping @MainActor () -> Void = {}, resolve: @escaping @MainActor (C.Result) -> Any?) {
    guard health.ready, contractReady, channel != nil else {
      failed()
      fail(sink, "not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
      return
    }
    Task { @MainActor in
      do {
        sink.resolve(resolve(try await self.perform(C.self, params, timeout: timeout)))
      } catch {
        failed()
        sink.reject(error)
      }
    }
  }

  func perform<C: RuntimeCall>(_ call: C.Type, _ params: C.Params, timeout: Double? = nil) async throws -> C.Result {
    guard health.ready, contractReady, let channel else {
      throw Self.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody))
    }
    do {
      return try await channel.call(C.self, params, timeout: timeout)
    } catch let failure as RuntimeFailure {
      switch failure.code {
      case "timeout": throw Self.failure("send_timeout", String(localized: "native.runtime.sendTimeout", bundle: .lody))
      case "runtime_replaced": throw Self.failure("runtime_replaced", String(localized: "native.runtime.replaced", bundle: .lody))
      default: throw Self.failure("command_failed", failure.detail ?? failure.code)
      }
    } catch {
      throw Self.failure("command_failed", error.localizedDescription)
    }
  }

  func workspaceCall<C: RuntimeCall>(
    _ call: C.Type, timeout: Double? = nil, _ params: (_ workspaceId: String, _ userId: String) -> C.Params
  ) async throws -> C.Result {
    guard let workspace else { throw Self.failure("not_ready", String(localized: "native.runtime.sessionNotSynced", bundle: .lody)) }
    return try await perform(C.self, params(workspace, userId), timeout: timeout)
  }
}
