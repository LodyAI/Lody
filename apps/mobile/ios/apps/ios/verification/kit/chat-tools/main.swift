import Foundation
let toolsJSON = """
[{"id":"tools-live","role":"assistant","status":"running","finished":false,"items":[
{"itemId":"cmd1","type":"tool_call","kind":"execute","title":"first\nsecond","status":"completed"},
{"itemId":"cmd2","type":"tool_call","kind":"execute","title":"second","status":"in_progress"},
{"itemId":"text","type":"text","text":"Update"},
{"itemId":"read","type":"tool_call","kind":"read","path":"a.swift","status":"in_progress"}]}]
"""
let toolsTranscript = ChatTranscript(entries: try JSONDecoder().decode([ChatEntry].self, from: Data(toolsJSON.replacingOccurrences(of: "first\nsecond", with: "first second").utf8)))
assert(toolsTranscript.rows().map(\.kind) == ["summary", "text", "summary"], "Live tools collapse without hiding intervening prose")
assert(toolsTranscript.rows(processEntryID: "tools-live", processStartID: "cmd1").map(\.itemID) == ["cmd1", "cmd2"])
assert(toolsTranscript.rows()[2].processStartID == "read", "Each tool group opens its own calls")
print("Live tool grouping passed")


let completedJSON = """
[{"id":"completed","role":"assistant","status":"completed","finished":true,
"timestamp":"1970-01-01T00:00:00Z","endedAt":164000,
"items":[
{"itemId":"intro","type":"text","text":"I'll update the session branch name first."},
{"itemId":"command","type":"tool_call","kind":"execute","title":"git branch -m session/example","status":"completed","hasDetail":true},
{"itemId":"answer","type":"text","text":"Hi! What would you like to work on?"}]}]
"""
var completed = ChatTranscript(entries: try JSONDecoder().decode([ChatEntry].self, from: Data(completedJSON.utf8)))
let closed = completed.rows(now: 164_000)
assert(closed.first?.kind == "duration")
assert(closed.first?.detail.isEmpty == true, "Completed duration must not carry the tool summary")
completed.expandedWork.insert("completed")
let opened = completed.rows(now: 164_000)
assert(opened.filter { $0.kind != "meta" }.map(\.kind) == ["duration", "text", "summary", "text"], "Expanded tools must remain after the introductory prose")
assert(opened[2].processStartID == "command")
let calls = completed.rows(processEntryID: "completed", processStartID: opened[2].processStartID)
assert(calls.map(\.itemID) == ["command"], "Tool details must not include the introduction or final answer")
assert(calls[0].text == "git branch -m session/example")
print("Completed tool ordering and command details passed")

let untimedJSON = completedJSON.replacingOccurrences(of: "\"endedAt\":164000,", with: "")
let untimed = ChatTranscript(entries: try JSONDecoder().decode([ChatEntry].self, from: Data(untimedJSON.utf8)))
assert(untimed.rows().first?.processStartID == "", "Untimed collapsed history still opens all of its work")

// Hidden thinking calls cannot make the last visible command group look finished.
let thinkingJSON = toolsJSON.replacingOccurrences(of: "first\nsecond", with: "first second")
  .replacingOccurrences(of: "\"status\":\"in_progress\"}]}]", with:
    "\"status\":\"in_progress\"},{\"itemId\":\"thinking\",\"type\":\"tool_call\",\"kind\":\"think\"}]}]")
let thinking = ChatTranscript(entries: try JSONDecoder().decode([ChatEntry].self, from: Data(thinkingJSON.utf8)))
let summaries = thinking.rows().filter { $0.kind == "summary" }
assert(summaries.count == 2)
assert(!summaries[0].shines, "Prose closes the earlier tool group")
assert(summaries[1].shines, "Hidden thinking after the final command preserves shimmer")
let stoppedJSON = thinkingJSON.replacingOccurrences(of: "\"status\":\"running\"", with: "\"status\":\"completed\"")
  .replacingOccurrences(of: "\"finished\":false", with: "\"finished\":true")
let stopped = ChatTranscript(entries: try JSONDecoder().decode([ChatEntry].self, from: Data(stoppedJSON.utf8)))
assert(!stopped.rows().contains { $0.shines }, "Completed command summaries stop shimmering")

// Group liveness follows the unfinished turn, not individual tool completion or timing.
let timedJSON = thinkingJSON.replacingOccurrences(of: "in_progress", with: "completed")
var timedEntries = try JSONDecoder().decode([ChatEntry].self, from: Data(timedJSON.utf8))
for index in timedEntries[0].items.indices {
  if timedEntries[0].items[index].type == "tool_call" {
    timedEntries[0].items[index].processDurationMs = 1200
  }
}
let timedSummaries = ChatTranscript(entries: timedEntries).rows().filter { $0.kind == "summary" }
assert(!timedSummaries[0].shines, "A recorded earlier group remains inactive after prose")
assert(timedSummaries[1].shines, "The final group shimmers while its turn is unfinished even after every tool completes")
timedEntries[0].finished = true
assert(!ChatTranscript(entries: timedEntries).rows().contains { $0.shines }, "Turn completion stops the timed group's shimmer")
print("Command summary shimmer follows turn completion, independent of tool status and duration")


let operationJSON = """
[{"id":"op-entry","role":"system","status":"completed","finished":true,"items":[
{"itemId":"hidden","type":"operation_completion","operation":{"cards":[],"notices":[]}},
{"itemId":"reply","type":"operation_completion","operation":{"cards":[{"id":"0","kind":"reply","sessionId":"child","label":"Fallback","status":"succeeded","reply":"Full reply\\nSecond line"}],"notices":[]}},
{"itemId":"problem","type":"operation_completion_batch","operation":{"cards":[],"notices":[{"kind":"batchUnknown","count":2},{"kind":"failed","detail":"Unavailable"}]}}
]}]
"""
let operationEntries = try JSONDecoder().decode([ChatEntry].self, from: Data(operationJSON.utf8))
let operationRows = ChatTranscript(entries: operationEntries).rows()
precondition(!operationRows.contains { $0.itemID == "hidden" })
let operationVisible = ChatOperationPresentation.visible(operationRows, expanded: [], titles: ["child": "Live title"])
let replyRow = operationVisible.first { $0.operation != nil }!
precondition(replyRow.text == "Live title" && replyRow.actionable)
precondition(replyRow.operation?.reply == "Full reply\nSecond line")
precondition(operationVisible.filter { $0.kind == "operationNotice" }.count == 2)
let missingTarget = ChatOperationPresentation.visible(operationRows, expanded: [], titles: [:]).first { $0.operation != nil }!
precondition(missingTarget.text == "Fallback" && !missingTarget.actionable)
let creationCards = (0..<7).map { ChatOperationCard(id: String($0), kind: "created", sessionId: "child", label: nil, status: "running", detail: nil, reply: nil) }
let creationRows = ChatOperationPresentation(cards: creationCards, notices: []).rows(entryID: "create", itemID: "progress")
precondition(ChatOperationPresentation.visible(creationRows, expanded: [], titles: ["child":"Child"]).filter { $0.operation != nil }.count == 5)
precondition(ChatOperationPresentation.visible(creationRows, expanded: ["create:progress"], titles: ["child":"Child"]).filter { $0.operation != nil }.count == 7)
print("Operation receipts: hidden successes, live titles, full replies, missing targets and bounded creation groups passed")

let separateCreations = (0..<7).flatMap { index in
  ChatOperationPresentation(cards: [creationCards[index]], notices: []).rows(entryID: "create-" + String(index), itemID: "progress")
}
let groupedCreations = ChatOperationPresentation.visible(separateCreations, expanded: [], titles: ["child":"Child"])
precondition(groupedCreations.filter { $0.kind == "operationHeader" }.count == 1)
precondition(groupedCreations.filter { $0.operation != nil }.count == 5)
precondition(ChatOperationPresentation.visible(separateCreations, expanded: ["create-0:progress"], titles: ["child":"Child"]).filter { $0.operation != nil }.count == 7)
print("Consecutive independent creation receipts share one expandable group")
