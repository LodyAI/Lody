import Foundation

enum PreviewFeedbackResult: String {
  case sent, queued, unknown
}

enum PreviewFeedbackError: Error, Equatable {
  case unavailable
  case pendingSend
  case failed(String)
}

@MainActor
struct PreviewFeedback {
  let send: @MainActor (String) async throws -> PreviewFeedbackResult
  let openSession: @MainActor () -> Void

  static func outbox(
    store: OutboxStore, session: SessionItem, connected: @escaping @MainActor () -> Bool,
    timeout: Duration = .seconds(15), openSession: @escaping @MainActor () -> Void
  ) -> PreviewFeedback {
    PreviewFeedback(
      send: { text in
        let snapshot = store.snapshot
        guard snapshot.ready, !session.archived else { throw PreviewFeedbackError.unavailable }
        guard !snapshot.records.contains(where: { $0.sessionId == session.id }) else { throw PreviewFeedbackError.pendingSend }
        let id = UUID().uuidString.lowercased()
        let send: [String: OutboxValue] = [
          "id": .string(id), "text": .string(text), "startedAt": .number(Date().timeIntervalSince1970 * 1000),
          "attachments": .array([]), "choice": .object([:]), "preserveDraft": .bool(true), "phase": .string("waiting"),
        ]
        try await store.put(OutboxRecord(session: session.outboxValue, send: send)).value
        guard connected() else { return .queued }
        return try await settled(store: store, id: id, timeout: timeout)
      },
      openSession: openSession
    )
  }

  private static func settled(store: OutboxStore, id: String, timeout: Duration) async throws -> PreviewFeedbackResult {
    let outcome = Outcome()
    return try await withCheckedThrowingContinuation { continuation in
      outcome.continuation = continuation
      outcome.observer = NotificationCenter.default.addObserver(forName: .lodyOutboxDidChange, object: store, queue: .main) { _ in
        MainActor.assumeIsolated { outcome.check(store, id) }
      }
      outcome.timer = Task { @MainActor in
        try? await Task.sleep(for: timeout)
        outcome.finish(.success(.unknown))
      }
      outcome.check(store, id)
    }
  }
}

@MainActor
private final class Outcome {
  var continuation: CheckedContinuation<PreviewFeedbackResult, Error>?
  var observer: NSObjectProtocol?
  var timer: Task<Void, Never>?

  func check(_ store: OutboxStore, _ id: String) {
    guard let record = store.snapshot.records.first(where: { $0.sendId == id }) else {
      finish(.success(.unknown))
      return
    }
    switch record.phase {
    case "accepted": finish(.success(.sent))
    case "queued": finish(.success(.queued))
    case "unknown": finish(.success(.unknown))
    case "failed": finish(.failure(PreviewFeedbackError.failed(record.send["reason"]?.string ?? "send_failed")))
    default: break
    }
  }

  func finish(_ result: Result<PreviewFeedbackResult, Error>) {
    guard let continuation else { return }
    self.continuation = nil
    timer?.cancel()
    observer.map(NotificationCenter.default.removeObserver)
    continuation.resume(with: result)
  }
}
