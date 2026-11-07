import Foundation

public struct RuntimeFailure: Error, Equatable, Sendable {
  public let code: String
  public let retryable: Bool
  public let detail: String?

  public init(code: String, retryable: Bool = false, detail: String? = nil) {
    self.code = code
    self.retryable = retryable
    self.detail = detail
  }

  public init(_ error: RuntimeContract.RuntimeError) {
    self.init(code: error.code, retryable: error.retryable, detail: error.detail)
  }
}

@MainActor
public final class RuntimeChannel {
  public typealias Schedule = @MainActor (Double, @escaping @MainActor () -> Void) -> Void

  public let generation: Int
  public var onEvent: (@MainActor (RuntimeContract.Event) -> Void)?
  public var onRequest: (@MainActor (String, RuntimeContract.HostRequest) -> Void)?

  private let post: @MainActor (String) -> Void
  private let schedule: Schedule
  private let makeID: @MainActor () -> String
  private var pending: [String: @MainActor (Result<RuntimeContract.CallResult, RuntimeFailure>) -> Void] = [:]
  private var closed: String?
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(
    generation: Int,
    post: @escaping @MainActor (String) -> Void,
    schedule: @escaping Schedule = RuntimeChannel.sleep,
    makeID: @escaping @MainActor () -> String = { UUID().uuidString }
  ) {
    self.generation = generation
    self.post = post
    self.schedule = schedule
    self.makeID = makeID
  }

  public static func sleep(_ delay: Double, _ work: @escaping @MainActor () -> Void) {
    Task { @MainActor in
      try? await Task.sleep(for: .seconds(delay))
      work()
    }
  }

  public var pendingCount: Int { pending.count }

  public func call<C: RuntimeCall>(_ call: C.Type, _ params: C.Params, timeout: Double? = nil) async throws -> C.Result {
    if let closed { throw RuntimeFailure(code: closed, retryable: true, detail: C.method) }
    let id = makeID()
    let text = try encode(Outbound(v: RuntimeContract.version, gen: generation, kind: "request", id: id, method: C.method, payload: params))
    return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<C.Result, any Error>) in
      pending[id] = { outcome in
        switch outcome {
        case .success(let value):
          if let result = C.result(value) { continuation.resume(returning: result) }
          else { continuation.resume(throwing: RuntimeFailure(code: "invalid_result", detail: C.method)) }
        case .failure(let failure):
          continuation.resume(throwing: failure)
        }
      }
      schedule(timeout ?? C.timeout) { [weak self] in
        self?.settle(id, .failure(RuntimeFailure(code: "timeout", retryable: true, detail: C.method)))
      }
      post(text)
    }
  }

  public func reply<C: RuntimeHostCall>(_ call: C.Type, id: String, _ result: C.Result) {
    guard closed == nil else { return }
    guard let text = try? encode(Outbound(v: RuntimeContract.version, gen: generation, kind: "result", id: id, method: C.method, payload: result)) else {
      fail(id: id, method: C.method, code: "invalid_result")
      return
    }
    post(text)
  }

  public func fail(id: String, method: String, code: String, retryable: Bool = false, detail: String? = nil) {
    guard closed == nil else { return }
    let error = RuntimeContract.RuntimeError(code: code, retryable: retryable, detail: detail)
    guard let text = try? encode(OutboundError(v: RuntimeContract.version, gen: generation, kind: "error", id: id, method: method, error: error)) else { return }
    post(text)
  }

  public func receive(_ text: String) {
    guard closed == nil else { return }
    let data = Data(text.utf8)
    let envelope: RuntimeContract.Envelope
    do {
      envelope = try decoder.decode(RuntimeContract.Envelope.self, from: data)
    } catch {
      rejectMalformed(data, error)
      return
    }
    guard envelope.gen == generation else { return }
    guard envelope.v == RuntimeContract.version else {
      switch envelope.message {
      case .request(let id, let request): fail(id: id, method: request.method, code: "protocol_mismatch")
      case .result(let id, _), .error(let id, _, _): settle(id, .failure(RuntimeFailure(code: "protocol_mismatch")))
      case .unsupported(let kind, let method, let id?): rejectMismatch(kind: kind, method: method, id: id)
      case .event, .unsupported: break
      }
      return
    }
    switch envelope.message {
    case .request(let id, let request):
      if let onRequest { onRequest(id, request) }
      else { fail(id: id, method: request.method, code: "unsupported_method") }
    case .result(let id, let value):
      settle(id, .success(value))
    case .error(let id, _, let error):
      settle(id, .failure(RuntimeFailure(error)))
    case .event(let event):
      onEvent?(event)
    case .unsupported(let kind, let method, let id):
      guard let id else { return }
      if kind == "request" { fail(id: id, method: method, code: "unsupported_method") }
      else if kind == "result" { settle(id, .failure(RuntimeFailure(code: "unsupported_method", detail: method))) }
    }
  }

  public func close(_ code: String = "runtime_restarted") {
    guard closed == nil else { return }
    closed = code
    let waiting = pending
    pending = [:]
    for settle in waiting.values { settle(.failure(RuntimeFailure(code: code, retryable: true))) }
  }

  private func rejectMalformed(_ data: Data, _ error: any Error) {
    guard let header = try? decoder.decode(RuntimeContract.Header.self, from: data),
          header.gen == generation, let id = header.id else { return }
    guard header.v == RuntimeContract.version else {
      rejectMismatch(kind: header.kind, method: header.method ?? "", id: id)
      return
    }
    switch header.kind {
    case "request": fail(id: id, method: header.method ?? "", code: "invalid_params", detail: String(describing: error))
    case "result": settle(id, .failure(RuntimeFailure(code: "invalid_result", detail: header.method)))
    case "error": settle(id, .failure(RuntimeFailure(code: "invalid_error", detail: header.method)))
    default: break
    }
  }

  private func rejectMismatch(kind: String, method: String, id: String) {
    if kind == "request" { fail(id: id, method: method, code: "protocol_mismatch") }
    else if kind == "result" || kind == "error" { settle(id, .failure(RuntimeFailure(code: "protocol_mismatch", detail: method))) }
  }

  private func settle(_ id: String, _ outcome: Result<RuntimeContract.CallResult, RuntimeFailure>) {
    pending.removeValue(forKey: id)?(outcome)
  }

  private func encode<T: Encodable>(_ value: T) throws -> String {
    String(decoding: try encoder.encode(value), as: UTF8.self)
  }
}

private struct Outbound<Payload: Encodable>: Encodable {
  let v: Int
  let gen: Int
  let kind: String
  let id: String
  let method: String
  let payload: Payload
}

private struct OutboundError: Encodable {
  let v: Int
  let gen: Int
  let kind: String
  let id: String
  let method: String
  let error: RuntimeContract.RuntimeError
}
