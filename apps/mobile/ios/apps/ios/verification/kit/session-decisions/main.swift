import Foundation
import LodyCore

func plan(_ overrides: [String: Any] = [:]) -> [String: Any] {
  let item: [String: Any] = [
    "type": "proposed_plan", "itemId": "plan", "turnId": "turn", "status": "completed", "isLatest": true, "markdown": "# Plan",
  ]
  return ["id": "answer", "role": "assistant", "items": [item.merging(overrides) { $1 }]]
}

func failure(_ reason: String = "acp_provider_overloaded", id: String = "failure") -> [String: Any] {
  ["id": id, "role": "system", "items": [["itemId": "error", "type": "system_notice", "name": "chat_failed", "meta": ["reason": reason]]]]
}

let user: [String: Any] = ["id": "user", "role": "user", "items": []]
let target = SessionTranscriptFacts.latestProposedPlan([plan()])
precondition(target == SessionItemTarget(entryId: "answer", itemId: "plan", detail: "turn"))
for patch: [String: Any] in [["status": "delta"], ["status": "cleared"], ["isLatest": false], ["markdown": "  "]] {
  precondition(SessionTranscriptFacts.latestProposedPlan([plan(), plan(patch)]) == nil)
}
precondition(SessionTranscriptFacts.latestProposedPlan([plan(), user]) == nil)
print("PASS: only the current completed nonempty plan before new user input is actionable")

let choice = ModelChoice(modelId: "model", effort: "high", modeId: "read-only", configOptionValues: [
  "plan_mode": .bool(true), "permission_mode": .string("read-only"), "fast": .bool(true),
])
var expected = choice
expected.configOptionValues?["plan_mode"] = .bool(false)
precondition(SessionDecision.planExecutionChoice(choice, nil) == expected)
precondition(SessionDecision.planExecutionChoice(ModelChoice(modeId: "plan"), nil).modeId == "plan")
let legacy = SessionDecision.planExecutionChoice(
  ModelChoice(modeId: "plan", configOptionValues: ["collaboration_mode": .string("plan"), "permission_mode": .string("ask")]),
  Capability(machineId: "", cliType: "", agentType: "", legacyModes: [CapabilityChoice(id: "plan", name: ""), CapabilityChoice(id: "default", name: "")])
)
precondition(legacy.modeId == "default")
precondition(legacy.configOptionValues == ["collaboration_mode": .string("default"), "permission_mode": .string("ask")])
let core = Capability(machineId: "", cliType: "", agentType: "", configOptions: [
  ConfigOption(id: "plan_mode", name: "", type: "boolean", currentValue: .bool(true)),
])
precondition(SessionDecision.planExecutionChoice(ModelChoice(), core).configOptionValues?["plan_mode"] == .bool(false))
let custom = Capability(machineId: "", cliType: "", agentType: "", configOptions: [
  ConfigOption(id: "custom", name: "", category: "collaboration_mode", type: "select", currentValue: .string("plan"),
               options: [CapabilityChoice(id: "default", name: "")]),
])
precondition(SessionDecision.planExecutionChoice(ModelChoice(), custom).configOptionValues?["custom"] == .string("default"))
print("PASS: execution exits core and legacy planning while preserving model, effort and permissions")

@MainActor final class Gate {
  var continuation: CheckedContinuation<String, Error>?
  var calls: [String] = []
}

let gate = Gate()
let decision = SessionDecision(.plan)
let waiting: SessionDecision.Request = { _, id in
  gate.calls.append(id)
  return try await withCheckedThrowingContinuation { gate.continuation = $0 }
}
await decision.decide(target: target, enabled: false, entryId: "answer", itemId: "plan", id: "disabled", request: waiting)
await decision.decide(target: target, enabled: true, entryId: "old", itemId: "plan", id: "stale", request: waiting)
let first = Task { await decision.decide(target: target, enabled: true, entryId: "answer", itemId: "plan", id: "one", request: waiting) }
while gate.continuation == nil { await Task.yield() }
await decision.decide(target: target, enabled: true, entryId: "answer", itemId: "plan", id: "two", request: waiting)
precondition(gate.calls == ["one"])
gate.continuation?.resume(returning: #"{"state":"accepted"}"#)
await first.value
await decision.decide(target: target, enabled: true, entryId: "answer", itemId: "plan", id: "three", request: waiting)
precondition(gate.calls == ["one"])
precondition(decision.state(target: target, enabled: true, answered: []).isEmpty, "an accepted plan hides its card")
print("PASS: stale/disabled taps and duplicate pending or accepted execution never send")

var count = 0
let rejected = SessionDecision(.plan)
let notSent: SessionDecision.Request = { _, _ in count += 1; return #"{"state":"not_sent"}"# }
await rejected.decide(target: target, enabled: true, entryId: "answer", itemId: "plan", id: "one", request: notSent)
precondition(rejected.attempt?.phase == "failed")
await rejected.decide(target: target, enabled: true, entryId: "answer", itemId: "plan", id: "two", request: notSent)
precondition(count == 2)
await rejected.decide(target: target, enabled: true, entryId: "answer", itemId: "plan", action: "discuss", id: "", request: notSent)
precondition(rejected.attempt?.phase == "dismissed")
await rejected.decide(target: target, enabled: true, entryId: "answer", itemId: "plan", id: "three", request: notSent)
precondition(count == 2)
for reply in ["", #"{"state":"unknown"}"#, "{broken"] {
  var sent = 0
  let unknown = SessionDecision(.plan)
  let counted: SessionDecision.Request = { _, _ in
    sent += 1
    if reply.isEmpty { throw CancellationError() }
    return reply
  }
  await unknown.decide(target: target, enabled: true, entryId: "answer", itemId: "plan", id: "one", request: counted)
  await unknown.decide(target: target, enabled: true, entryId: "answer", itemId: "plan", id: "two", request: counted)
  precondition(sent == 1 && unknown.attempt?.phase == "unknown")
  let state = unknown.state(target: nil, enabled: true, answered: [])
  precondition(state["message"] as? String == "native.chat.proposedPlan.unknown" && state["enabled"] as? Bool == false)
  precondition(unknown.state(target: nil, enabled: true, answered: ["one"]).isEmpty, "a reply retires an unknown attempt")
}
print("PASS: continue discussing only dismisses; definite failures can retry, unknown delivery cannot")

let errorTarget = SessionTranscriptFacts.latestRetryableError([failure()])
precondition(errorTarget == SessionItemTarget(entryId: "failure", itemId: "error", detail: "acp_provider_overloaded"))
precondition(SessionTranscriptFacts.latestRetryableError([failure(), user]) == nil)
precondition(SessionTranscriptFacts.latestRetryableError([failure(), failure("acp_auth_required", id: "auth")]) == nil)
precondition(SessionTranscriptFacts.latestRetryableError([failure("future_reason")]) == nil)
precondition(SessionTranscriptFacts.latestRetryableError([user, failure()]) == errorTarget)
print("PASS: only the latest recoverable failure before newer user input can retry")

let retryGate = Gate()
let retry = SessionDecision(.retry)
let retryWaiting: SessionDecision.Request = { _, id in
  retryGate.calls.append(id)
  return try await withCheckedThrowingContinuation { retryGate.continuation = $0 }
}
await retry.decide(target: errorTarget, enabled: false, entryId: "failure", itemId: "error", id: "one", request: retryWaiting)
await retry.decide(target: errorTarget, enabled: true, entryId: "old", itemId: "error", id: "one", request: retryWaiting)
precondition(retryGate.calls.isEmpty)
let pendingRetry = Task {
  await retry.decide(target: errorTarget, enabled: true, entryId: "failure", itemId: "error", id: "one", request: retryWaiting)
}
while retryGate.continuation == nil { await Task.yield() }
precondition(retry.attempt?.phase == "pending")
await retry.decide(target: errorTarget, enabled: true, entryId: "failure", itemId: "error", id: "two", request: retryWaiting)
precondition(retryGate.calls == ["one"])
retryGate.continuation?.resume(returning: #"{"state":"accepted"}"#)
await pendingRetry.value
precondition(retry.attempt?.phase == "accepted")
await retry.decide(target: errorTarget, enabled: true, entryId: "failure", itemId: "error", id: "three", request: retryWaiting)
precondition(retryGate.calls == ["one"])
precondition(retry.state(target: errorTarget, enabled: true, answered: [])["visible"] as? Bool == false)
print("PASS: a retry is fenced while pending and after ACK; stale targets and disabled sessions do not dispatch")

var attempts = 0
let ambiguous = SessionDecision(.retry)
let flaky: SessionDecision.Request = { _, _ in
  attempts += 1
  if attempts == 1 { return #"{"state":"not_sent"}"# }
  throw CancellationError()
}
await ambiguous.decide(target: errorTarget, enabled: true, entryId: "failure", itemId: "error", id: "one", request: flaky)
precondition(ambiguous.attempt?.phase == "failed")
await ambiguous.decide(target: errorTarget, enabled: true, entryId: "failure", itemId: "error", id: "two", request: flaky)
precondition(ambiguous.attempt?.phase == "unknown")
await ambiguous.decide(target: errorTarget, enabled: true, entryId: "failure", itemId: "error", id: "three", request: flaky)
precondition(attempts == 2)
precondition(ambiguous.state(target: errorTarget, enabled: true, answered: [])["enabled"] as? Bool == false)
print("PASS: definite rejection allows an explicit new attempt; ambiguous delivery never repeats")

let facts = SessionTranscriptFacts(entries: [
  ["id": "u1", "role": "user", "status": "handled", "items": []],
  ["id": "a1", "role": "assistant", "finished": true, "items": []],
  ["id": "u2", "role": "user", "status": "handled", "items": []],
  ["id": "q", "role": "user", "status": "queued", "items": []],
])
precondition(facts.editableUserId == "u2" && facts.editEligibility.hasPrefix("u2:handled:a1:true"))
precondition(facts.answered == ["u1"], "only entries followed by a reply are answered")
print("PASS: edit eligibility follows the latest delivered user turn and its preceding reply")
