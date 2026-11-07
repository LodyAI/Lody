import ChatKitCore
import Foundation

// Provider-proven continuation: the original prompt stays outside; guides retain their process position.
let guidedJSON = """
[
{"id":"root","role":"user","status":"handled","finished":true,"executionId":"root","executionFinished":true,"items":[{"itemId":"u","type":"text","text":"Original task"}]},
{"id":"before","role":"assistant","status":"handled","finished":true,"executionId":"root","executionFinished":true,"items":[{"itemId":"intro","type":"text","text":"Earlier partial answer"},{"itemId":"tool","type":"tool_call","title":"Inspect","hasDetail":true}]},
{"id":"guide","role":"user","status":"handled","finished":true,"executionId":"root","executionFinished":true,"items":[{"itemId":"u","type":"text","text":"Guide one"}]},
{"id":"after","role":"assistant","status":"handled","finished":true,"executionId":"root","executionFinished":true,"steerCount":1,"items":[{"itemId":"work","type":"thought","text":"Later process"},{"itemId":"answer1","type":"text","text":"Final answer part one"},{"itemId":"answer2","type":"text","text":"Final answer part two"}]}]
"""
var guidedEntries = try JSONDecoder().decode([ChatEntry].self, from: Data(guidedJSON.utf8))
let guidedRows = ChatTranscript(entries: guidedEntries).rows()
assert(guidedRows.map(\.kind) == ["user", "summary", "text", "text", "meta"])
assert(guidedRows.first?.entryID == "root")
assert(!guidedRows.contains { $0.entryID == "guide" })
let guidedProcess = ChatTranscript(entries: guidedEntries).rows(processEntryID: "after", processStartID: "__execution__")
assert(guidedProcess.map(\.itemID) == ["intro", "tool", "", "work"])
assert(guidedProcess[1].entryID == "before" && guidedProcess[1].actionable)
assert(guidedProcess[2].kind == "user" && guidedProcess[2].entryID == "guide")
assert(!guidedProcess.contains { $0.entryID == "root" })
let shared = ChatMessageShare.content(in: ChatTranscript(entries: guidedEntries), entryID: "after")!
assert(shared.text == "Final answer part one\n\nFinal answer part two", "Sharing includes all final blocks, never the earlier process")
assert(ChatMessageShare.content(in: ChatTranscript(entries: guidedEntries), entryID: "root") == nil)
var runningShare = guidedEntries
runningShare[runningShare.count - 1].finished = false
assert(ChatMessageShare.content(in: ChatTranscript(entries: runningShare), entryID: "after") == nil)
assert(ChatMessageShare.accepts(height: 6000) && !ChatMessageShare.accepts(height: 6001))
assert(!ChatMessageShare.accepts(height: .infinity))
let roundTrip = try JSONDecoder().decode(ChatMessageShare.self, from: JSONEncoder().encode(shared))
assert(roundTrip.text == shared.text)
for i in guidedEntries.indices { guidedEntries[i].executionFinished = false }
let continuing = ChatTranscript(entries: guidedEntries).rows()
assert(continuing.contains { $0.itemID == "intro" })
assert(!continuing.contains { $0.id == "root:execution" })
assert(continuing.filter { $0.kind == "user" }.map(\.entryID) == ["root", "guide"])
print("Steer: guides stay in chronological process order, original prompt and final answer stay outside")

