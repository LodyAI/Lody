import Lexical
import LexicalLinkPlugin
import LexicalListPlugin
import LexicalMarkdown
import Testing
import UIKit

@MainActor
private final class Typist {
  let view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: [ListPlugin(), LinkPlugin(), MarkdownShortcutPlugin()]), featureFlags: FeatureFlags())

  func type(_ text: String) {
    for character in text { view.textView.insertText(String(character)) }
  }

  var markdown: String { (try? MarkdownExporter.gfm.export(view.editor)) ?? "<error>" }
  var text: String { view.textView.text }
}

@MainActor
@Test func inlineShortcutsFormatAndStopAtTheCloseTag() {
  for (typed, expected) in [("**bold** x", "**bold** x"), ("*it* x", "*it* x"), ("`c` x", "`c` x"), ("~~s~~ x", "~~s~~ x")] {
    let typist = Typist()
    typist.type(typed)
    #expect(typist.markdown == expected, "\(typed)")
    #expect(!typist.text.contains("*") && !typist.text.contains("`") && !typist.text.contains("~"), "\(typed) kept its tags: \(typist.text)")
  }
}

@MainActor
@Test func spacedStarsStayLiteral() {
  let typist = Typist()
  typist.type("a * b * c")
  #expect(typist.text == "a * b * c")
}

@MainActor
@Test func pastedMarkdownIsNotConverted() {
  let typist = Typist()
  typist.view.textView.insertText("**x**")
  #expect(typist.text == "**x**")
}

@MainActor
@Test func blockShortcutsConvertTheParagraph() {
  let cases = [("# title", "# title"), ("### three", "### three"), ("#tag", "#tag"), ("- item", "- item"), ("1. first", "1. first"), ("3. third", "3. third"), ("> quoted", "> quoted"), ("```swift let a", "```swift\nlet a\n```")]
  for (typed, expected) in cases {
    let typist = Typist()
    typist.type(typed)
    #expect(typist.markdown == expected, "\(typed)")
  }
}

@MainActor
@Test func formatShortcutsAreIgnoredInsideCode() {
  let typist = Typist()
  typist.type("``` **x**")
  #expect(typist.markdown == "```\n**x**\n```")
}

@MainActor
@Test func markedTextNeverTriggersShortcuts() {
  let typist = Typist()
  typist.type("**a*")
  typist.view.textView.setMarkedText("*", selectedRange: NSRange(location: 1, length: 0))
  #expect(typist.text == "**a**")
}

@MainActor
@Test func headingKeepsTypedCaseAndBackspacesToEmpty() {
  let typist = Typist()
  typist.type("# title")
  #expect(typist.text == "title")
  for _ in 0..<7 { typist.view.textView.deleteBackward() }
  #expect(typist.text == "")
  #expect(typist.markdown == "")
}
