import Foundation

func first(_ json: String) throws -> SessionPermission? {
  let entries = try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [[String: Any]]
  return try SessionPermission.first(in: entries)
}

let pending = #"[{"id":"entry","items":[{"type":"tool_call","itemId":"tool","kind":"execute","title":"Run checks","permission":{"pending":true,"requestId":"request","options":[{"optionId":"allow","name":"Allow once","kind":"allow_once"},{"optionId":"custom","name":"Custom choice"}]}}]}]"#
let target = try first(pending)!
precondition(target.requestId == "request" && target.options?.count == 2)
precondition(target.options?[1].kind == nil)
let resolved = try first(pending.replacingOccurrences(of: "true", with: "false"))
precondition(resolved == nil)
do {
  _ = try first(pending.replacingOccurrences(of: "\"requestId\":\"request\",", with: ""))
  fatalError("Malformed pending request was hidden")
} catch {}

var gate = SessionPermissionGate()
precondition(gate.shouldOpen())
gate.opened()
precondition(!gate.shouldOpen("request"))
gate.closed(answer: "request")
precondition(!gate.shouldOpen("request") && gate.shouldOpen("next"))
precondition(!gate.shouldOpen(), "Reconnecting must not reopen a waiting sheet after an answer")
gate.opened()
gate.closed(cancelled: true)
precondition(!gate.shouldOpen("next"))
precondition(SessionPermissionGate().shouldOpen("next"), "Returning to the session creates a fresh visit")
var remote = SessionPermissionGate()
remote.opened()
remote.closed()
precondition(!remote.shouldOpen(), "A stale awaiting timestamp cannot reopen a resolved sheet")
precondition(remote.shouldOpen("next"), "Remote resolution must not suppress the next request")

let questions = try JSONDecoder().decode(SessionPermission.Questions.self, from: Data(#"{"allowCustomAnswer":false,"questions":[{"id":"same","header":"Header","question":"Same question","options":[],"multiSelect":false},{"id":"same","header":"Unique","question":"Same question","options":[],"multiSelect":false},{"header":"Header","question":"Same question","options":[{"label":"A"}],"multiSelect":true},{"id":"secret","header":"Secret","question":"Token","options":[],"multiSelect":false,"isSecret":true}]}"#.utf8))
precondition(questions.key(at: 0) == "0")
precondition(questions.key(at: 1) == "Unique")
precondition(questions.key(at: 2) == "2")
precondition(questions.key(at: 3) == "secret")
precondition(questions.allowsText(at: 0) && !questions.allowsText(at: 2))
print("PASS: pending requests, malformed input, per-visit gate, remote resolution and question answer keys")

let projected = SessionEnvelope.prepare("{\"v\":1,\"revision\":1,\"status\":\"live\",\"entries\":" + pending + "}")!
precondition(projected.transcript.permission == target)
let malformed = pending.replacingOccurrences(of: "\"requestId\":\"request\",", with: "")
let rejected = SessionEnvelope.prepare("{\"entries\":" + malformed + "}")!
precondition(rejected.transcript.permission == nil && rejected.transcript.permissionError != nil)

// The passive page starts from the latest projection and rejects old runtime replies.
var projection = PermissionProjection()
func envelope(_ revision: Int, _ entries: String = pending, status: String = "live") -> String {
  "{\"v\":1,\"revision\":\(revision),\"status\":\"\(status)\",\"entries\":\(entries)}"
}
projection.receive(generation: 1, phase: "live", json: envelope(1))
precondition(projection.state == .ready(target))
projection.receive(generation: 1, phase: "live", json: envelope(0, "[]"))
precondition(projection.state == .ready(target))
projection.receive(generation: 2, phase: "starting", json: nil)
precondition(projection.state == .waiting)
projection.receive(generation: 1, phase: "live", json: envelope(99))
precondition(projection.state == .waiting)
projection.receive(generation: 2, phase: "live", json: envelope(0, status: "syncing"))
precondition(projection.state == .waiting)
projection.receive(generation: 2, phase: "live", json: envelope(1))
precondition(projection.state == .ready(target))
projection.receive(generation: 2, phase: "background", json: nil)
precondition(projection.state == .waiting)
projection.receive(generation: 2, phase: "live", json: envelope(2))
precondition(projection.state == .ready(target))
projection.receive(generation: 2, phase: "live", json: envelope(3, malformed))
guard case .invalid = projection.state else { fatalError("Malformed permissions must fail visibly") }
projection.receive(generation: 2, phase: "live", json: envelope(4, "[]"))
precondition(projection.state == .ready(nil))
projection.receive(generation: 2, phase: "live", json: #"{"v":1,"overflow":true}"#)
guard case .invalid = projection.state else { fatalError("Overflow must not resolve a pending request") }
print("PASS: passive permission projection, generation recovery, revision ordering and visible contract errors")
