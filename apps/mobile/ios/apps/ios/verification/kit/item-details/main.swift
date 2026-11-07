import Foundation
import LodyCore

@MainActor
final class Harness {
  struct Pending {
    var params: RuntimeContract.ItemDetailParams
    var continuation: CheckedContinuation<RuntimeContract.ItemDetail, Error>
  }
  var requests: [Pending] = []
  var receive: (@MainActor (Int, String?) -> Void)?
  var removals = 0
  var service: ItemDetailService {
    .init(load: { [self] params in
      try await withCheckedThrowingContinuation { requests.append(.init(params: params, continuation: $0)) }
    }, observe: { [self] receive in
      self.receive = receive
      return { [self] in removals += 1; self.receive = nil }
    })
  }
  func event(_ generation: Int = 0, _ revision: Int, status: String = "live", itemRev: Int, nested: Bool = false) {
    let item = "{\"itemId\":\"item\",\"rev\":\(itemRev)}"
    let items = nested ? "{\"itemId\":\"task\",\"rev\":1,\"run\":{\"items\":[\(item)]}}" : item
    receive?(generation, "{\"v\":1,\"revision\":\(revision),\"status\":\"\(status)\",\"entries\":[{\"id\":\"entry\",\"items\":[\(items)]}]}")
  }
  func response(_ index: Int, rev: Int = 1, text: String, truncated: Bool = false, cursor: String? = nil) {
    requests[index].continuation.resume(returning: .init(itemId: "item", rev: rev, blocks: [.string(text)],
                                                        truncated: truncated, nextCursor: cursor))
  }
  func fail(_ index: Int) { requests[index].continuation.resume(throwing: CocoaError(.fileReadUnknown)) }
}

@main
struct Check {
  @MainActor static func settle() async { for _ in 0..<20 { await Task.yield() } }
  @MainActor static func main() async {
    let io = Harness()
    let store = ItemDetailStore(sessionId: "session", entryId: "entry", itemIds: ["item"], generation: 0, service: io.service)
    store.start()
    await settle()
    precondition(io.requests.count == 1)
    io.fail(0)
    await settle()
    precondition(store.items["item"]?.error != nil && store.items["item"]?.loading == false)
    store.retry("item")
    await settle()
    io.response(1, text: "first", truncated: true, cursor: "next")
    await settle()
    store.loadMore("item")
    await settle()
    precondition(io.requests[2].params.cursor == "next")
    io.fail(2)
    await settle()
    precondition(store.items["item"]?.detail?.blocks == [.string("first")])
    store.retry("item")
    await settle()
    precondition(io.requests[3].params.cursor == "next")
    io.response(3, text: "second")
    await settle()
    precondition(store.items["item"]?.detail?.blocks == [.string("first"), .string("second")])

    // A nested subagent projection supersedes an outstanding revision request.
    io.event(0, 1, itemRev: 2, nested: true)
    await settle()
    io.event(0, 2, itemRev: 3, nested: true)
    await settle()
    precondition(io.requests.count == 6)
    io.response(5, rev: 3, text: "new")
    io.response(4, rev: 2, text: "late")
    await settle()
    precondition(store.items["item"]?.detail?.blocks == [.string("new")])
    io.event(0, 1, itemRev: 1)
    await settle()
    precondition(io.requests.count == 6)

    // Recovery waits for live, and a replaced generation can never restore its blocks.
    io.receive?(1, nil)
    precondition(store.items.isEmpty)
    io.event(1, 0, status: "syncing", itemRev: 3)
    io.event(0, 9, itemRev: 8)
    await settle()
    precondition(io.requests.count == 6)
    io.event(1, 1, itemRev: 4)
    await settle()
    precondition(io.requests.count == 7)
    io.response(6, rev: 4, text: "recovered", truncated: true, cursor: "page")
    await settle()
    store.loadMore("item")
    await settle()
    io.response(7, rev: 5, text: "wrong revision")
    await settle()
    precondition(io.requests.count == 9 && io.requests[8].params.cursor == nil)
    io.response(8, rev: 5, text: "fresh")
    await settle()
    precondition(store.items["item"]?.detail?.blocks == [.string("fresh")])

    io.event(1, 2, itemRev: 6)
    await settle()
    store.finish()
    io.response(9, rev: 6, text: "after close")
    await settle()
    precondition(store.items.isEmpty && io.removals == 1)

    // Broken pagination contracts fail visibly instead of reloading page one forever.
    store.start()
    await settle()
    io.response(10, rev: 6, text: "invalid", truncated: true)
    await settle()
    precondition(store.items["item"]?.error?.contains("cursor") == true)
    store.finish()
    // A first projection arriving during the initial read must supersede that read too.
    let initial = Harness()
    let starting = ItemDetailStore(sessionId: "session", entryId: "entry", itemIds: ["item"], generation: 0,
                                   service: initial.service)
    starting.start()
    await settle()
    initial.event(0, 1, itemRev: 2)
    await settle()
    precondition(initial.requests.count == 2)
    initial.response(0, rev: 1, text: "old initial response")
    initial.response(1, rev: 2, text: "current initial response")
    await settle()
    precondition(starting.items["item"]?.detail?.rev == 2 && starting.items["item"]?.error == nil)
    starting.finish()

    let recovery = Harness()
    let recovering = ItemDetailStore(sessionId: "session", entryId: "entry", itemIds: ["item"], generation: 0,
                                     service: recovery.service)
    recovering.start()
    await settle()
    recovery.receive?(1, nil)
    recovery.response(0, text: "old runtime")
    await settle()
    precondition(recovering.items.isEmpty && recovery.requests.count == 1)
    recovery.event(1, 0, itemRev: 1)
    await settle()
    recovery.response(1, text: "new runtime")
    await settle()
    precondition(recovering.items["item"]?.detail?.blocks == [.string("new runtime")])
    recovering.finish()

    let multiple = Harness()
    let multi = ItemDetailStore(sessionId: "session", entryId: "entry", itemIds: ["item", "other"], generation: 0,
                                service: multiple.service)
    multi.start()
    await settle()
    let first = multiple.requests.firstIndex { $0.params.itemId == "item" }!
    let other = multiple.requests.firstIndex { $0.params.itemId == "other" }!
    multiple.response(first, text: "first item")
    await settle()
    precondition(multi.items["item"]?.loading == false && multi.items["other"]?.loading == true)
    multiple.fail(other)
    await settle()
    precondition(multi.items["item"]?.error == nil && multi.items["other"]?.error != nil)
    multi.finish()

    print("Item detail: retry, pagination, nested revisions, stale responses, recovery, close and cursor validation passed")
  }
}
