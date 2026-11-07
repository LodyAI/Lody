import Foundation

let resource = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .deletingLastPathComponent().deletingLastPathComponent()
  .appendingPathComponent("../.generated/Resources/MarkdownRepair.js")
let script = try String(contentsOf: resource, encoding: .utf8)
let repair = ChatMarkdownRepair(script: script)
for (source, expected) in [
  ("Read **bold", "Read **bold**"),
  ("Read *italic", "Read *italic*"),
  ("Read `code", "Read `code`"),
  ("Read ~~old", "Read ~~old~~"),
  ("Read **中文 👩🏽‍💻", "Read **中文 👩🏽‍💻**"),
  ("Visit [Apple](https://exam", "Visit Apple"),
  ("Visit [Apple](https://example.com)", "Visit [Apple](https://example.com)"),
  ("Literal \\*asterisk and file_name", "Literal \\*asterisk and file_name"),
  ("`**literal**`", "`**literal**`"),
  ("```swift\nlet value = \"**literal\"", "```swift\nlet value = \"**literal\""),
  ("Price $20 and $30", "Price $20 and $30"),
  ("'); throw Error('not executable'); //", "'); throw Error('not executable'); //"),
] {
  let actual = repair.repair(source)
  precondition(actual == expected, "\(source.debugDescription): got \(actual.debugDescription)")
}
let source = "Stable paragraph.\n\nRead **bold"
precondition(repair.repair(source).hasPrefix("Stable paragraph.\n\n"))
precondition(ChatMarkdownRepair(script: "globalThis.repairMarkdown = () => { throw Error('failure') }").repair(source) == source)
precondition(ChatMarkdownRepair(script: "").repair(source) == source)
precondition(ChatMarkdownRepair(script: "globalThis.repairMarkdown = () => 42").repair(source) == source)
DispatchQueue.concurrentPerform(iterations: 64) { index in
  precondition(repair.repair("**item \(index)") == "**item \(index)**")
}
let long = String(repeating: "Plain text **bold** and `code`. ", count: 500) + "**tail"
let start = ProcessInfo.processInfo.systemUptime
for _ in 0..<100 { precondition(repair.repair(long).hasSuffix("**tail**")) }
print("Markdown repair: incomplete inline syntax, safe links, literal code/escapes, Unicode, fallback and concurrent callers passed")
print("Markdown repair: 15 KB source mean ms = \((ProcessInfo.processInfo.systemUptime - start) * 10)")
