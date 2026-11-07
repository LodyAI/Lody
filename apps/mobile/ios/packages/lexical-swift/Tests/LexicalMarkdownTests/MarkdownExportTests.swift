import Foundation
import Lexical
import LexicalLinkPlugin
import LexicalListPlugin
import LexicalMarkdown
import Testing

private func text(_ value: String, _ format: Int = 0) -> String {
  #"{"type":"text","version":1,"text":\#(json(value)),"format":\#(format),"detail":0,"mode":"normal","style":""}"#
}

private func element(_ type: String, _ children: [String], extra: String = "") -> String {
  #"{"type":"\#(type)","version":1,"direction":"ltr","format":"","indent":0\#(extra),"children":[\#(children.joined(separator: ","))]}"#
}

private func paragraph(_ children: String...) -> String {
  element("paragraph", children, extra: #","textFormat":0,"textStyle":"""#)
}

private func json(_ value: String) -> String {
  String(data: try! JSONEncoder().encode(value), encoding: .utf8)!
}

private func gfm(_ blocks: String...) throws -> String {
  let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: [ListPlugin(), LinkPlugin()]))
  let state = #"{"root":\#(element("root", blocks))}"#
  try editor.setEditorState(EditorState.fromJSON(json: state, editor: editor))
  return try MarkdownExporter.gfm.export(editor)
}

@Test func plainTextIsSentVerbatim() throws {
  #expect(try gfm(paragraph(text("a **literal** `tick` and \\ slash_x ~y~"))) == "a **literal** `tick` and \\ slash_x ~y~")
}

@Test func formattedRunsGetTags() throws {
  #expect(try gfm(paragraph(text("plain "), text("bold", 1), text(" "), text("it", 2), text(" "), text("gone", 4), text(" "), text("hi", 128))) == "plain **bold** *it* ~~gone~~ ==hi==")
}

@Test func adjacentFormatsShareTags() throws {
  #expect(try gfm(paragraph(text("bold ", 1), text("both", 3), text(" end", 1))) == "**bold *both* end**")
}

@Test func whitespaceStaysOutsideTags() throws {
  #expect(try gfm(paragraph(text("a"), text(" spaced ", 1), text("b"))) == "a **spaced** b")
}

@Test func inlineCodeUsesAContentDerivedFence() throws {
  #expect(try gfm(paragraph(text("x", 0), text("a`b", 16))) == "x`` a`b ``")
  #expect(try gfm(paragraph(text("code", 17))) == "**`code`**")
}

@Test func paragraphsKeepTheNewlinesTheUserTyped() throws {
  #expect(try gfm(paragraph(text("one")), paragraph(text("two"))) == "one\ntwo")
  #expect(try gfm(paragraph(text("one")), paragraph(), paragraph(text("two"))) == "one\n\ntwo")
  #expect(try gfm(paragraph(text("one")), paragraph(), paragraph(), paragraph(text("two"))) == "one\n\n\ntwo")
}

@Test func lineBreaksStayInsideTheParagraph() throws {
  #expect(try gfm(paragraph(text("a"), #"{"type":"linebreak","version":1}"#, text("b"))) == "a\nb")
}

@Test func headingsQuotesAndCode() throws {
  #expect(try gfm(element("heading", [text("Title")], extra: #","tag":"h2""#)) == "## Title")
  #expect(try gfm(element("quote", [text("a"), #"{"type":"linebreak","version":1}"#, text("b")])) == "> a\n> b")
  #expect(try gfm(element("code", [text("let a = 1")], extra: #","language":"swift""#)) == "```swift\nlet a = 1\n```")
  #expect(try gfm(element("code", [text("x ``` y")])) == "````\nx ``` y\n````")
}

@Test func listsNumberFromStartAndMarkChecks() throws {
  let item = { (value: String, extra: String) in element("listitem", [text(value)], extra: extra) }
  #expect(try gfm(element("list", [item("a", #","value":1"#), item("b", #","value":2"#)], extra: #","listType":"bullet","start":1,"tag":"ul""#)) == "- a\n- b")
  #expect(try gfm(element("list", [item("a", #","value":3"#), item("b", #","value":4"#)], extra: #","listType":"number","start":3,"tag":"ol""#)) == "3. a\n4. b")
  #expect(try gfm(element("list", [item("done", #","value":1,"checked":true"#), item("todo", #","value":2,"checked":false"#)], extra: #","listType":"check","start":1,"tag":"ul""#)) == "- [x] done\n- [ ] todo")
  let nested = element("listitem", [element("list", [item("inner", #","value":1"#)], extra: #","listType":"bullet","start":1,"tag":"ul""#)], extra: #","value":2"#)
  #expect(try gfm(element("list", [item("outer", #","value":1"#), nested], extra: #","listType":"bullet","start":1,"tag":"ul""#)) == "- outer\n    - inner")
}

@Test func linksKeepTitlesAndAutolinksStayPlain() throws {
  let link = element("link", [text("docs")], extra: #","url":"https://lexical.dev","rel":null,"target":null,"title":"The \"guide\"""#)
  let auto = element("autolink", [text("https://innei.in")], extra: #","url":"https://innei.in","rel":null,"target":null,"title":null,"isUnlinked":false"#)
  #expect(try gfm(paragraph(link, text(" "), auto)) == #"[docs](https://lexical.dev "The \"guide\"") https://innei.in"#)
}

@Test func codeBlockBeforeAnotherBlockHasNoTrailingBlankLine() throws {
  #expect(try gfm(element("code", [text("a")]), paragraph(text("b"))) == "```\na\n```\nb")
}

@Test func paragraphAfterQuoteOrListStartsItsOwnBlock() throws {
  let list = element("list", [element("listitem", [text("a")], extra: #","value":1"#)], extra: #","listType":"bullet","start":1,"tag":"ul""#)
  #expect(try gfm(element("quote", [text("quoted")]), paragraph(text("reply"))) == "> quoted\n\nreply")
  #expect(try gfm(list, paragraph(text("after"))) == "- a\n\nafter")
  #expect(try gfm(element("quote", [text("quoted")]), paragraph(), paragraph(text("reply"))) == "> quoted\n\nreply")
  #expect(try gfm(paragraph(text("before")), element("quote", [text("quoted")])) == "before\n> quoted")
}
