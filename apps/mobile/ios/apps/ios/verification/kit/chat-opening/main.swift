import ChatKitCore
import Foundation

let json = """
[{"id":"reply","role":"assistant","status":"running","finished":false,"items":[
{"itemId":"intro","type":"thought","text":"先检查"},
{"itemId":"tool","type":"tool_call","title":"读取文件","status":"completed"},
{"itemId":"answer","type":"text","text":"最终答案"}]}]
"""
// Opening a running conversation can deliver an empty history before its first snapshot.
var openingHistory = ChatStream()
openingHistory.receive([], animate: true)
let openingEntries = try JSONDecoder().decode([ChatEntry].self, from: Data(json.utf8))
openingHistory.receive(openingEntries, animate: true, initialSnapshot: true, at: 0)
assert(!openingHistory.hasPending, "First visible history must not replay after an empty snapshot")
assert(openingHistory.presentation[0].items[2].text == "最终答案", "Initial history is complete before a second frame")
var openingGrowth = openingEntries
openingGrowth[0].items[2].text = "最终答案继续输出"
openingHistory.receive(openingGrowth, animate: true, at: 0.1)
assert(openingHistory.hasPending, "New text after initial history must still animate")
openingHistory.finish()
assert(openingHistory.presentation[0].items[2].text == "最终答案继续输出")

print("PASS: initial history is complete; subsequent deltas still animate")

var restored = ChatStream()
restored.receive([], animate: true, at: 0)
restored.receive(openingEntries, animate: true, at: 1)
assert(!restored.hasPending, "Loading placeholder must not turn restored history into a live delta")
assert(ChatTranscript(entries: openingEntries).rows().filter { $0.itemID == "intro" }.allSatisfy { !$0.streaming }, "Earlier prose is settled after a tool")
var batched = ChatStream()
var first = openingEntries
first[0].items = Array(first[0].items.prefix(1))
batched.receive(first, animate: false, at: 0)
batched.receive(openingEntries, animate: true, at: 1)
assert(batched.presentation[0].items[0].text == "先检查")
assert(batched.hasPending, "Only new tail text is paced")
var afterTool = openingEntries
afterTool[0].items.append(try JSONDecoder().decode(ChatItem.self, from: Data(#"{"itemId":"next","type":"tool_call","status":"in_progress"}"#.utf8)))
batched.receive(afterTool, animate: true, at: 1.1)
assert(!batched.hasPending, "A later tool settles the previous text")
print("PASS: restored history and closed text segments never replay")
