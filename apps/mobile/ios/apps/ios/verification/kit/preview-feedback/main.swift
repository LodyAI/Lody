import Foundation

struct SessionItem {
  var id = "session"
  var archived = false
  var outboxValue: [String: OutboxValue] { ["id": .string(id)] }
}
extension Notification.Name { static let lodyOutboxDidChange = Notification.Name("feedback-check") }

@main struct FeedbackCheck {
  @MainActor static func main() async throws {
    for phase in ["accepted", "queued", "unknown", "failed", "removed", "timeout", "offline"] {
      let store = OutboxStore(key: "test", generation: 0,
        persistence: .init(generation: { 0 }, read: { _ in nil }, write: { _, _, _ in }), awaitingConfirmation: "unknown")
      store.onChange = { [weak store] in
        guard let store else { return }
        NotificationCenter.default.post(name: .lodyOutboxDidChange, object: store)
      }
      while !store.snapshot.ready { await Task.yield() }
      let feedback = PreviewFeedback.outbox(store: store, session: SessionItem(), connected: { phase != "offline" },
        timeout: .milliseconds(80), openSession: {})
      let send = Task { try await feedback.send("report") }
      while store.snapshot.records.isEmpty { await Task.yield() }
      let record = store.snapshot.records[0]
      precondition(record.sessionId == "session" && record.send["preserveDraft"] == .bool(true))
      precondition(record.send["text"] == .string("report") && record.send["attachments"] == .array([]))
      if phase == "removed" { try await store.remove("session").value }
      else if !["timeout", "offline"].contains(phase) { try await store.put(record.with(phase: phase)).value }
      do {
        let outcome = try await send.value
        let expected: [String: PreviewFeedbackResult] = ["accepted": .sent, "queued": .queued, "unknown": .unknown,
          "removed": .unknown, "timeout": .unknown, "offline": .queued]
        precondition(outcome == expected[phase])
      } catch { precondition(phase == "failed" && error as? PreviewFeedbackError == .failed("send_failed")) }
      if !store.snapshot.records.isEmpty {
        do { _ = try await feedback.send("duplicate"); preconditionFailure("pending report replayed") }
        catch { precondition(error as? PreviewFeedbackError == .pendingSend) }
      }
    }
    print("PASS: durable preview feedback preserves drafts, waits for delivery, exposes failure and prevents duplicate sends")
  }
}
