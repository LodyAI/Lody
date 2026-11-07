import Foundation

@MainActor
final class SessionControl {
  struct State: Equatable {
    var running = false
    var canStop = false
    var controlling = false
    var stopping = false
    var steerID = ""
    var steerInterrupts = false
  }

  typealias Request = @MainActor (_ payload: String) async throws -> String

  var changed: (() -> Void)?
  private let request: Request
  private var inFlight = false
  private var busy = ""
  private var stoppedTurn = ""

  init(request: @escaping Request) {
    self.request = request
  }

  static let live: Request = { payload in
    guard let runtime = DataRuntime.current else { throw OutboxError.scopeExpired }
    return try await withCheckedThrowingContinuation { runtime.controlTurn(payload, sink: .continuation($0)) }
  }

  func state(session: SessionItem, transcript: SessionTranscriptFacts, live: Bool, overflow: Bool, steerable: Bool) -> State {
    let turn = transcript.unfinishedTurnId
    let stopped = turn != nil && stoppedTurn == turn
    return State(
      running: turn != nil || OutboxDispatcher.busy.contains(session.status),
      canStop: canControl(session: session, transcript: transcript, live: live, overflow: overflow),
      controlling: stopped || (!busy.isEmpty && !transcript.delivered.contains(busy)),
      stopping: busy == "stop" || stopped,
      steerID: busy == "stop" ? "" : busy,
      steerInterrupts: !steerable
    )
  }

  func act(_ action: String, messageId: String? = nil, session: SessionItem, transcript: SessionTranscriptFacts,
           live: Bool, overflow: Bool, steerable: Bool) {
    guard canControl(session: session, transcript: transcript, live: live, overflow: overflow), !inFlight,
          let turn = transcript.unfinishedTurnId else { return }
    inFlight = true
    busy = messageId ?? "stop"
    changed?()
    var payload: [String: Any] = [
      "action": action, "sessionId": session.id, "machineId": session.machineId, "turnId": turn,
      "interrupt": action == "steer" && !steerable,
    ]
    payload["messageId"] = messageId
    let request = request
    Task { @MainActor [weak self] in
      do {
        let result = try await request(SessionController.json(payload))
        let state = (try? JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any])?["state"] as? String
        if state == "stopped" { self?.stoppedTurn = turn }
      } catch {
        LodyToastOverlay.shared.show(message: String(localized: "native.chat.composer.controlError", bundle: .lody), kind: "error")
      }
      self?.inFlight = false
      self?.busy = ""
      self?.changed?()
    }
  }

  private func canControl(session: SessionItem, transcript: SessionTranscriptFacts, live: Bool, overflow: Bool) -> Bool {
    guard let turn = transcript.unfinishedTurnId else { return false }
    return live && !session.archived && !overflow && busy.isEmpty && stoppedTurn != turn
  }
}
