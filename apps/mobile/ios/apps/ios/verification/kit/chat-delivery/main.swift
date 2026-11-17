import Foundation

// Exercise the decoded history -> visible user-header projection, including
// execution outcomes that prove receipt even when execution did not succeed.
for status in ["seen", "processing", "handled", "failed", "canceled", "completed", "done", "pending", "pending_apply", "not_sent", "unknown"] {
  let json = """
  [{"id":"user","role":"user","finished":true,"status":"\(status)","items":[{"itemId":"text","type":"text","text":"Hi"}]}]
  """
  let transcript = ChatTranscript(entries: try JSONDecoder().decode([ChatEntry].self, from: Data(json.utf8)))
  let row = transcript.rows().first { $0.kind == "user" }
  let delivered = ["seen", "processing", "handled", "failed", "canceled", "completed", "done"].contains(status)
  assert(row?.readState == (delivered ? "seen" : "sent"), "Incorrect user read state for \(status): \(row?.readState ?? "missing")")
}
assert(ChatAuthors.readState("queued") == "queued")
let pendingJSON = #"[{"id":"local","role":"user","finished":true,"status":"pending","inputState":"unknown","items":[{"itemId":"text","type":"text","text":"Hi"}]}]"#
let pending = ChatTranscript(entries: try JSONDecoder().decode([ChatEntry].self, from: Data(pendingJSON.utf8))).rows()
assert(pending.first(where: { $0.kind == "user" })?.readState == "sending")
assert(pending.contains { $0.kind == "delivery" && $0.actionable && $0.attention })
print("User message delivery projection passed")
