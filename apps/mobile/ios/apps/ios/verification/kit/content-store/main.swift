import Foundation
let store = ContentStore(limit: 100)
func content(_ bytes: Int, session: String = "s1", path: String = "a.txt") -> StoredContent {
  StoredContent(data: Data(repeating: 0x61, count: bytes), kind: "text", path: path, session: session, mimeType: nil)
}
let first = store.put(content(40))
let second = store.put(content(40, session: "s2"))
assert(store.get(first) != nil) // Touching moves it to the back of the queue.
let third = store.put(content(40))
assert(store.get(second) == nil) // The least recently used entry goes first.
assert(store.get(first) != nil && store.get(third) != nil)
assert(store.totalBytes == 80)
let oversized = store.put(content(150))
assert(store.get(oversized) != nil) // A single body above the limit still lives until the next put.
assert(store.get(first) == nil && store.get(third) == nil)
let keep = store.put(content(10, session: "s3"))
store.clear(session: "s1")
assert(store.get(oversized) == nil && store.get(keep) != nil)
store.clearAll()
assert(store.get(keep) == nil && store.totalBytes == 0)
assert(ContentStore.classify(path: "README.md", binary: false, mimeType: nil) == "markdown")
assert(ContentStore.classify(path: "src/App.tsx", binary: false, mimeType: nil) == "text")
assert(ContentStore.classify(path: "logo.PNG", binary: true, mimeType: "image/png") == "image")
assert(ContentStore.classify(path: "doc.pdf", binary: true, mimeType: "application/pdf") == "binary")
print("PASS: LRU eviction, session clearing, oversized body, kind classification")
