import Foundation
import Lexical
import LexicalHTML
import LexicalLinkPlugin
import LexicalListPlugin
import LexicalMarkdown
import Testing
import UIKit
import UniformTypeIdentifiers

private func provider(_ representations: [(String, String)]) -> NSItemProvider {
  let provider = NSItemProvider()
  for (type, value) in representations {
    provider.registerDataRepresentation(forTypeIdentifier: type, visibility: .all) { completion in
      completion(Data(value.utf8), nil)
      return nil
    }
  }
  return provider
}

private func rtf(_ html: String) throws -> String {
  let attributed = try NSAttributedString(data: Data(html.utf8), options: [.documentType: NSAttributedString.DocumentType.html], documentAttributes: nil)
  let data = try attributed.data(from: NSRange(location: 0, length: attributed.length), documentAttributes: [.documentType: NSAttributedString.DocumentType.rtf])
  return String(decoding: data, as: UTF8.self)
}

private func makeEditor(_ text: String = "") throws -> Editor {
  let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: [ListPlugin(), LinkPlugin()]))
  try editor.update {
    guard let root = getRoot() else { return }
    try root.getChildren().forEach { try $0.remove() }
    let paragraph = createParagraphNode()
    try paragraph.append([createTextNode(text: text)])
    try root.append([paragraph])
  }
  return editor
}

private func select(_ editor: Editor, offset: Int) throws {
  try editor.update {
    guard let paragraph = getRoot()?.getFirstChild() as? ElementNode else { return }
    guard let text = paragraph.getFirstChild() as? TextNode else {
      _ = try paragraph.selectStart()
      return
    }
    _ = try text.select(anchorOffset: offset, focusOffset: offset)
  }
}

private func markdown(_ editor: Editor) throws -> String {
  try MarkdownExporter.gfm.export(editor)
}

@Test func sourcesFollowMarkdownHTMLRTFPlainPriority() async throws {
  let markdownType = "net.daringfireball.markdown"
  let all = await PasteboardReader.sources([provider([(UTType.utf8PlainText.identifier, "plain"), (UTType.html.identifier, "<b>h</b>"), (markdownType, "**m**")])])
  #expect(all.map(\.kind) == [.markdown, .html, .plain])
  let rich = await PasteboardReader.sources([provider([(UTType.rtf.identifier, try rtf("<b>bold</b> rest")), (UTType.utf8PlainText.identifier, "bold rest")])])
  #expect(rich.map(\.kind) == [.html, .plain])
  let plainOnly = await PasteboardReader.sources([provider([(UTType.html.identifier, "<b>h</b>"), (UTType.utf8PlainText.identifier, "p")])], plainTextOnly: true)
  #expect(plainOnly.map(\.kind) == [.plain])
}

@Test func rtfIsImportedThroughHTML() async throws {
  let sources = await PasteboardReader.sources([provider([(UTType.rtf.identifier, try rtf("<b>bold</b> rest"))])])
  let editor = try makeEditor()
  let trial = try RichPaste.gfm.trial(sources, for: editor)
  #expect(trial.markdown.hasPrefix("**bold**"))
}

@Test func trialsReportTheMarkdownTheyWouldSend() throws {
  let editor = try makeEditor()
  let html = try RichPaste.gfm.trial([PasteSource(kind: .html, text: "<ul><li>a</li><li><b>b</b></li></ul>")], for: editor)
  #expect(html.markdown == "- a\n- **b**")
  let plain = try RichPaste.gfm.trial([PasteSource(kind: .plain, text: "keep **stars**\nsecond")], for: editor)
  #expect(plain.markdown == "keep **stars**\nsecond")
  let md = try RichPaste.gfm.trial([PasteSource(kind: .markdown, text: "# T\n- [x] done")], for: editor)
  #expect(md.markdown == "# T\n- [x] done")
}

@Test func oversizedOrEmptyRepresentationsFallBackToPlainText() throws {
  let editor = try makeEditor()
  let huge = "<p>" + String(repeating: "x", count: 2_100_000) + "</p>"
  #expect(try RichPaste.gfm.trial([PasteSource(kind: .html, text: huge), PasteSource(kind: .plain, text: "fallback")], for: editor).source == .plain)
  let many = String(repeating: "<p>x</p>", count: 5001)
  #expect(try RichPaste.gfm.trial([PasteSource(kind: .html, text: many), PasteSource(kind: .plain, text: "fallback")], for: editor).source == .plain)
  let imageOnly = "<img src=\"x.png\">"
  #expect(try RichPaste.gfm.trial([PasteSource(kind: .html, text: imageOnly), PasteSource(kind: .plain, text: "caption")], for: editor).source == .plain)
}

@Test func inlineContentPastesIntoTheCurrentParagraph() throws {
  let editor = try makeEditor("hello world")
  try select(editor, offset: 6)
  let trial = try RichPaste.gfm.trial([PasteSource(kind: .html, text: "<b>bold</b> and ")], for: editor)
  try RichPaste.gfm.insert(trial, into: editor)
  let result = try markdown(editor)
  #expect(result == "hello **bold** andworld")
}

@Test func nestedCodeBlocksAreFlattened() throws {
  let editor = try makeEditor()
  try select(editor, offset: 0)
  let trial = try RichPaste.gfm.trial([PasteSource(kind: .html, text: "<pre><code>let a = 1\nlet b = 2</code></pre>")], for: editor)
  try RichPaste.gfm.insert(trial, into: editor)
  let result = try markdown(editor)
  #expect(result == "```\nlet a = 1\nlet b = 2\n```")
}

@Test func pastingInsideCodeKeepsPlainText() throws {
  let editor = try makeEditor()
  try editor.update {
    guard let root = getRoot() else { return }
    try root.getChildren().forEach { try $0.remove() }
    let code = createCodeNode()
    let text = createTextNode(text: "x")
    try code.append([text])
    try root.append([code])
    _ = try text.select(anchorOffset: 1, focusOffset: 1)
  }
  #expect(try RichPaste.gfm.prefersPlainText(in: editor))
}

@MainActor @Test func pluginTakesOverThePasteCommand() async throws {
  let plugin = RichPastePlugin()
  let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: [ListPlugin(), LinkPlugin(), plugin]))
  try editor.update {
    guard let root = getRoot() else { return }
    try root.getChildren().forEach { try $0.remove() }
    let paragraph = createParagraphNode()
    try root.append([paragraph])
    _ = try paragraph.selectStart()
  }
  #expect(editor.dispatchCommand(type: .paste, payload: UIPasteboard.withUniqueName()))
  plugin.paste([provider([(UTType.html.identifier, "<p><i>styled</i> paste</p>"), (UTType.utf8PlainText.identifier, "styled paste")])])
  var result = ""
  for _ in 0..<100 {
    try await Task.sleep(for: .milliseconds(30))
    result = try MarkdownExporter.gfm.export(editor)
    if !result.isEmpty { break }
  }
  #expect(result == "*styled* paste")
}

@Test func hugePlainTextStillTrials() throws {
  let editor = try makeEditor()
  let log = (1...3000).map { "line \($0)" }.joined(separator: "\n")
  let trial = try RichPaste.gfm.trial([PasteSource(kind: .plain, text: log)], for: editor)
  #expect(trial.source == .plain)
  #expect(trial.markdown == log)
}

@Test func listStartNumbersAreClamped() throws {
  let editor = try makeEditor()
  let html = try RichPaste.gfm.trial([PasteSource(kind: .html, text: "<ol start=\"9223372036854775807\"><li>a</li><li>b</li></ol>")], for: editor)
  #expect(html.markdown == "999999999. a\n1000000000. b")
  let md = try RichPaste.gfm.trial([PasteSource(kind: .markdown, text: "99999999999999999999. a")], for: editor)
  #expect(md.markdown == "999999999. a")
}

@Test func multilinePlainTextStaysInsideCodeAndListItems() throws {
  let editor = try makeEditor()
  try editor.update {
    guard let root = getRoot() else { return }
    try root.getChildren().forEach { try $0.remove() }
    let code = createCodeNode()
    let text = createTextNode(text: "x")
    try code.append([text])
    try root.append([code])
    _ = try text.select(anchorOffset: 1, focusOffset: 1)
  }
  try RichPaste.gfm.insert(try RichPaste.gfm.trial([PasteSource(kind: .plain, text: "a\nb")], for: editor), into: editor)
  let code = try markdown(editor)
  #expect(code == "```\nxa\nb\n```")

  let list = try makeEditor()
  try list.update {
    guard let root = getRoot() else { return }
    try root.getChildren().forEach { try $0.remove() }
    let item = ListItemNode()
    let text = createTextNode(text: "x")
    try item.append([text])
    let node = createListNode(listType: .bullet)
    try node.append([item])
    try root.append([node])
    _ = try text.select(anchorOffset: 1, focusOffset: 1)
  }
  try RichPaste.gfm.insert(try RichPaste.gfm.trial([PasteSource(kind: .plain, text: "a\nb")], for: list), into: list)
  var items = 0
  try list.read { items = (getRoot()?.getFirstChild() as? ElementNode)?.getChildrenSize() ?? 0 }
  #expect(items == 1)
  #expect(try markdown(list).hasPrefix("- xa"))
}
