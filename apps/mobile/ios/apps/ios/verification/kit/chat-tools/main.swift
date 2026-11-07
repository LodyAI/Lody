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
