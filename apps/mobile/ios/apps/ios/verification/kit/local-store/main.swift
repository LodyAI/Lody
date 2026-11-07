import Foundation
import SQLite3
import MarkdownParser

let markdown = "# **Hello** *world*\n\n[visible](https://hidden.invalid/token) ![alt](https://image.invalid)\n\n`**literal**`\n\n| Left | Right |\n| --- | --- |\n| body | value |\n\n```swift\nlet x = \"**kept**\"\n```"
let plain = MarkdownPlainText.string(markdown)
assert(plain.contains("Hello world"))
assert(plain.contains("visible"))
assert(!plain.contains("hidden.invalid") && !plain.contains("image.invalid") && !plain.contains("alt"))
assert(plain.contains("**literal**") && plain.contains("**kept**"))
assert(plain.contains("Left\tRight") && plain.contains("body\tvalue"))
assert(MarkdownPlainText.string("跨**格式**正文") == "跨格式正文")
assert(MarkdownPlainText.string(#"\*字面星号\*"#) == "*字面星号*")
assert(TextSearch.ranges(in: "👨‍👩‍👧 café CAFE 中文中文", query: "cafe").count == 2)
assert(TextSearch.ranges(in: "中文中文", query: "中文") == [NSRange(location: 0, length: 2), NSRange(location: 2, length: 2)])
assert(TextSearch.ranges(in: "anything", query: " ").isEmpty)
let longLead = String(repeating: "context ", count: 12) + "needle and the rest of the message continues for a while longer"
let leadSnippet = TextSearch.snippet(longLead, query: "needle")!
assert(leadSnippet.hasPrefix("…") && (leadSnippet as NSString).range(of: "needle").location <= 24,
       "The match stays near the start of a snippet so one line shows it: \(leadSnippet)")
assert(leadSnippet.dropFirst().hasPrefix("context ") || leadSnippet.dropFirst().hasPrefix("needle"), "Snippets start on a whole word: \(leadSnippet)")
assert(TextSearch.snippet(String(repeating: "中文", count: 30) + "needle", query: "needle")!.hasSuffix("needle"), "Unspaced scripts keep the plain cut")
for (text, query) in [("ＣＡＦＥ café", "cafe"), ("İstanbul istanbul", "istanbul"), ("中文你好", "你好"), ("e\u{301}", "é")] {
  assert(TextSearch.ranges(in: text, query: query).first == text.localizedStandardRange(of: query).map { NSRange($0, in: text) })
}
assert(MarkdownPlainText.string("Before $x+y$ after") == "Before x+y after")
print("PASS: readable Markdown tokens, literal code, Unicode matching and no hidden metadata")

let ruby = "<ruby>日本語<rp>(</rp><rt>にほんご</rt><rp>)</rp></ruby>"
assert(MarkdownPlainText.string(ruby) == "日本語")
assert(MarkdownPlainText.string("**" + ruby + "**") == "日本語")
assert(MarkdownPlainText.string("`" + ruby + "`") == ruby)
assert(MarkdownPlainText.string("```html\n" + ruby + "\n```").trimmingCharacters(in: .newlines) == ruby)
assert(MarkdownPlainText.string(#"\<ruby>literal\</ruby>"#) == "<ruby>literal</ruby>")
let rubyFixtures = [
  ruby,
  "- " + ruby,
  "## " + ruby,
  "| Word |\n| --- |\n| " + ruby + " |",
  "[" + ruby + "](https://example.com)",
  "**" + ruby + "**",
]
for source in rubyFixtures {
  var found: [MarkdownRuby.Annotation] = []
  _ = MarkdownRuby.blocks(MarkdownParser().parse(source).document).rewrite { (node: MarkdownInlineNode) -> [MarkdownInlineNode] in
    if case .text(let text) = node, let annotation = MarkdownRuby.decode(text) { found.append(annotation) }
    return [node]
  }
  assert(found.count == 1 && found[0].base == "日本語" && found[0].reading == "にほんご", source)
}
assert(MarkdownPlainText.string("<ruby>日<rt>に</rt>本<rt>ほん</rt></ruby>") == "日本")
for source in ["<ruby>日本語<rt>にほん", "`" + ruby + "`", #"\<ruby>日本語<rt>にほんご</rt></ruby>"#,
               "<ruby>日本語<script>alert(1)</script><rt>にほんご</rt></ruby>"] {
  let blocks = MarkdownParser().parse(source).document
  assert(MarkdownRuby.blocks(blocks) == blocks, source)
}
print("PASS: Ruby base/reading parsing, lists/headings/tables/links, fallback parentheses, literal code and incomplete input")

let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathComponent("catalog.sqlite")
defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
let account = #"{"user":{"id":"a"},"workspaces":[{"id":"first"},{"id":"second"}]}"#
do {
  let store = LocalStore(url: url)
  try store.write("account", account)
  try store.write("workspace:a", #""second""#)
  try store.write("catalog:a:second", #"{"catalog":{"sessions":[{"id":"cached"}]}}"#)
  try store.write("catalog:b:second", "other-user")
  try store.writeSession("before", userId: "a", workspace: "second", id: "会话/1")
  try store.writeSession("synced offscreen", userId: "a", workspace: "second", id: "会话/1")
  try store.writeSession("another account", userId: "b", workspace: "second", id: "会话/1")
}
let reopened = LocalStore(url: url)
let restoredSession = try reopened.read(#"session:["a","second","会话/1"]"#)
assert(restoredSession == "synced offscreen")
let otherSession = try reopened.read(#"session:["b","second","会话/1"]"#)
assert(otherSession == "another account")
let boot = try reopened.startup()
assert(boot["workspace"] == "second")
assert(boot["catalog"]?.contains("cached") == true)
try reopened.write("workspace:a", #""removed""#)
let fallback = try reopened.startup()
assert(fallback["workspace"] == "first")
try reopened.clear()
let cleared = try reopened.startup()
assert(cleared.isEmpty)
let clearedSession = try reopened.read(#"session:["a","second","会话/1"]"#)
assert(clearedSession == nil)
let issued = reopened.generation
try reopened.write("fenced", "current", generation: issued)
try reopened.clear()
try reopened.write("fenced", "old account", generation: issued)
try reopened.write("unfenced", "next account", generation: nil)
let droppedWrite = try reopened.read("fenced")
let unfencedWrite = try reopened.read("unfenced")
assert(droppedWrite == nil && unfencedWrite == "next account")
try reopened.write("fenced", "next account", generation: reopened.generation)
let currentWrite = try reopened.read("fenced")
assert(currentWrite == "next account")
try reopened.clear()
print("PASS: durable reopen, selected workspace, account isolation, removed selection, logout and generation fence")

func envelope(_ text: String) -> String {
  let object: [String: Any] = ["v": 1, "entries": [["id": "entry", "role": "assistant", "items": [
    ["itemId": "body", "type": "text", "text": text],
    ["itemId": "thought", "type": "thought", "text": "折叠思路"],
    ["itemId": "tool", "type": "tool_call", "title": "读取工具", "text": "不该命中"],
  ]]]]
  return String(data: try! JSONSerialization.data(withJSONObject: object), encoding: .utf8)!
}
func sessions(_ store: LocalStore, _ query: String, user: String = "a", workspace: String = "w") throws -> [[String: Any]] {
  try store.searchInbox(userID: user, workspaceID: workspace, query: query)["sessions"] as! [[String: Any]]
}
func check(_ condition: @autoclosure () throws -> Bool) rethrows {
  let result = try condition()
  assert(result)
}
var database: OpaquePointer?
assert(sqlite3_open(url.path, &database) == SQLITE_OK)
defer { sqlite3_close(database) }
@MainActor func sql(_ statement: String, _ values: [String] = []) {
  var prepared: OpaquePointer?
  assert(sqlite3_prepare_v2(database, statement, -1, &prepared, nil) == SQLITE_OK)
  defer { sqlite3_finalize(prepared) }
  for (index, value) in values.enumerated() {
    sqlite3_bind_text(prepared, Int32(index + 1), value, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
  }
  assert(sqlite3_step(prepared) == SQLITE_DONE)
}
// Old installs have KV envelopes but no prose rows or completed migration.
sql("INSERT INTO cache VALUES (?, ?)", [#"session:["a","w","old"]"#, envelope("用**项目**分组。")])
sql("INSERT INTO cache VALUES (?, ?)", [#"session:["b","w","other"]"#, envelope("别人的秘密")])
sql("INSERT INTO cache VALUES (?, ?)", [#"session:["a","other-workspace","elsewhere"]"#, envelope("另一个工作区")])
sql("INSERT INTO cache VALUES (?, ?)", [#"session:["a","w","broken"]"#, "not an envelope"])
sql("INSERT INTO cache VALUES (?, ?)", ["session:invalid", envelope("invalid key")])
sql("CREATE TRIGGER fail_prose BEFORE INSERT ON session_prose BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
do { _ = try sessions(reopened, "项目"); assertionFailure("Migration should fail") } catch {}
try check(try reopened.read("session-prose-version") == nil)
sql("DROP TRIGGER fail_prose")
let backfilled = try sessions(reopened, "项目分组")
assert(backfilled.count == 1 && backfilled[0]["id"] as? String == "old")
assert(backfilled[0]["snippet"] as? String == "用项目分组。")
try check(try sessions(reopened, "折叠思路").count == 1)
try check(try sessions(reopened, "读取工具").isEmpty)
try check(try sessions(reopened, "不该命中").isEmpty)
try check(try sessions(reopened, "别人的秘密").isEmpty)
try check(try sessions(reopened, "另一个工作区").isEmpty)
try reopened.write("catalog:a:w", #"{"catalog":{"projects":[{"id":"p","name":"Project","rootPath":"/local/repo"}],"sessions":[{"id":"old","projectId":"p","title":"项目分组","branchName":"feature/search","archived":true}]}}"#)
try check(try sessions(reopened, "项目分组")[0]["snippet"] is NSNull)
try check(try sessions(reopened, "feature/search").count == 1)
try check(try reopened.searchInbox(userID: "a", workspaceID: "w", query: "/local")["projectIds"] as? [String] == ["p"])
let previous = try reopened.read(#"session:["a","w","old"]"#)
sql("CREATE TRIGGER fail_prose BEFORE INSERT ON session_prose BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
do { try reopened.writeSession(envelope("new value"), userId: "a", workspace: "w", id: "old"); assertionFailure("Write should fail") } catch {}
try check(try reopened.read(#"session:["a","w","old"]"#) == previous)
// Already migrated: searching must not insert anything even after reopening.
try check(try sessions(LocalStore(url: url), "项目").count == 1)
sql("DROP TRIGGER fail_prose")
try reopened.writeSession(envelope("replacement"), userId: "a", workspace: "w", id: "old")
try check(try sessions(reopened, "replacement").count == 1)
try check(try sessions(reopened, "用项目").isEmpty)
try reopened.clear()
try check(try sessions(reopened, "replacement").isEmpty)
try check(try sessions(reopened, "别人的秘密", user: "b").isEmpty)
print("PASS: legacy backfill, retry, atomic writes, native field matching, scope isolation, replacement and logout")

let planProse = SessionProse.extract(##"{"v":1,"entries":[{"id":"plan","role":"assistant","items":[{"itemId":"doc","type":"proposed_plan","markdown":"# Read [lighthouse](https://hidden.example)","status":"completed"},{"itemId":"removed","type":"proposed_plan","markdown":"Gone","status":"cleared"},{"itemId":"tasks","type":"plan","entries":[]}]}]}"##)
assert(planProse.count == 1 && planProse[0].itemID == "doc")
assert(planProse[0].text.contains("lighthouse") && !planProse[0].text.contains("hidden.example"))

let searchablePlan = #"{"v":1,"entries":[{"id":"plan","role":"assistant","items":[{"itemId":"doc","type":"proposed_plan","markdown":"Hidden lighthouse paragraph","status":"completed"}]}]}"#
try reopened.writeSession(searchablePlan, userId: "a", workspace: "w", id: "plan-session")
try check(try sessions(reopened, "lighthouse").count == 1)
try reopened.writeSession(searchablePlan.replacingOccurrences(of: "completed", with: "cleared"), userId: "a", workspace: "w", id: "plan-session")
try check(try sessions(reopened, "lighthouse").isEmpty)
print("PASS: proposed document prose is searchable and clearing removes persisted matches")
