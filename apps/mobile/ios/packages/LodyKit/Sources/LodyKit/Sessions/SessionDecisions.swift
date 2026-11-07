import Foundation
import LodyCore

@MainActor
final class SessionDecision {
  enum Kind { case plan, retry }

  struct Attempt: Equatable {
    var target: SessionItemTarget
    var sendId = ""
    var phase: String
  }

  typealias Request = @MainActor (_ target: SessionItemTarget, _ id: String) async throws -> String

  let kind: Kind
  var changed: (() -> Void)?
  private(set) var attempt: Attempt?

  init(_ kind: Kind) {
    self.kind = kind
  }

  var pending: Bool { attempt?.phase == "pending" }

  private func same(_ attempt: Attempt?, _ target: SessionItemTarget) -> Bool {
    guard let attempt, attempt.target.entryId == target.entryId else { return false }
    return kind == .plan ? attempt.target.detail == target.detail : attempt.target.itemId == target.itemId
  }

  // One explicit new turn per decision; a write is never replayed or treated as complete from its ACK.
  func decide(target: SessionItemTarget?, enabled: Bool, entryId: String, itemId: String, action: String = "execute",
              id: String, request: Request) async {
    guard let target, enabled, target.entryId == entryId, target.itemId == itemId, !pending else { return }
    if same(attempt, target), attempt?.phase != "failed" { return }
    if kind == .plan, action == "discuss" {
      update(Attempt(target: target, phase: "dismissed"))
      return
    }
    guard action == "execute", !id.isEmpty else { return }
    update(Attempt(target: target, sendId: id, phase: "pending"))
    var phase = "unknown"
    if let result = try? await request(target, id),
       let state = (try? JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any])?["state"] as? String {
      if state == "not_sent" { phase = "failed" }
      if ["accepted", "uploaded", "queued"].contains(state) { phase = "accepted" }
    }
    update(Attempt(target: target, sendId: id, phase: phase))
  }

  private func update(_ next: Attempt) {
    attempt = next
    changed?()
  }

  func state(target: SessionItemTarget?, enabled: Bool, answered: Set<String>) -> [String: Any] {
    var selected = target
    let replied = attempt.map { answered.contains($0.sendId) } ?? false
    if pending || (target == nil && attempt?.phase == "unknown" && !replied) { selected = attempt?.target }
    guard let selected else { return [:] }
    let same = same(attempt, selected)
    let phase = same ? attempt?.phase ?? "" : ""
    var state: [String: Any] = ["entryId": selected.entryId, "itemId": selected.itemId, "pending": pending]
    switch kind {
    case .plan:
      guard !["accepted", "dismissed"].contains(phase), enabled || same else { return [:] }
      state["turnId"] = selected.detail
      state["enabled"] = enabled && !(same && phase != "failed") && !pending
      state["message"] = Self.message(phase, failed: "native.chat.proposedPlan.failed", unknown: "native.chat.proposedPlan.unknown")
    case .retry:
      state["enabled"] = enabled && !pending && !["unknown", "accepted"].contains(phase)
      state["visible"] = phase != "accepted"
      state["message"] = Self.message(phase, failed: "native.chat.error.retryFailed", unknown: "native.chat.error.retryUnknown")
    }
    return state
  }

  private static func message(_ phase: String, failed: String, unknown: String) -> String {
    switch phase {
    case "failed": String(localized: String.LocalizationValue(failed), bundle: .lody)
    case "unknown": String(localized: String.LocalizationValue(unknown), bundle: .lody)
    default: ""
    }
  }

  static let capacityContinuation =
    "Continue working from where you left off. The previous turn stopped because the selected model was at capacity."
  static let errorContinuation =
    "Continue working from where you left off. The previous turn stopped because of an agent error."

  // OSS execution-turn-config: leave planning for this turn while preserving permissions and the model.
  static func planExecutionChoice(_ choice: ModelChoice, _ capability: Capability?) -> ModelChoice {
    var next = choice
    let modes = capability?.legacyModes ?? capability?.modes ?? []
    if choice.modeId == "plan" { next.modeId = modes.first { $0.id != "plan" }?.id ?? choice.modeId }
    var values = choice.configOptionValues ?? [:]
    let options = capability?.configOptions ?? []
    let core = options.first { $0.id == "plan_mode" && $0.type == "boolean" }
    if case .bool? = values["plan_mode"] ?? core?.currentValue {
      values["plan_mode"] = .bool(false)
    } else {
      let selector = options.first {
        $0.type == "select" && ($0.id == "collaboration_mode" || $0.category == "collaboration_mode")
      }
      let id = selector?.id ?? "collaboration_mode"
      let defaultAllowed = selector.map { $0.options.contains { $0.id == "default" } } ?? true
      if values[id] ?? selector?.currentValue == .string("plan"), defaultAllowed { values[id] = .string("default") }
    }
    next.configOptionValues = values
    return next
  }
}
