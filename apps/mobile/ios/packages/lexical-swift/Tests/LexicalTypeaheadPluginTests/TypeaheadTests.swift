import Lexical
import LexicalTypeaheadPlugin
import Testing
import UIKit

private func query(_ text: String) -> TypeaheadQuery {
  TypeaheadQuery(text: text, isFirstInDocument: false)
}

@Test func basicTriggerMatchesLikeLexicalWeb() {
  let at = basicTypeaheadTrigger("@")
  #expect(at(query("hi @ali")) == TypeaheadMatch(leadOffset: 3, matchingString: "ali", replaceableString: "@ali"))
  #expect(at(query("(@a")) == TypeaheadMatch(leadOffset: 1, matchingString: "a", replaceableString: "@a"))
  #expect(at(query("@ali")) == TypeaheadMatch(leadOffset: 0, matchingString: "ali", replaceableString: "@ali"))
  #expect(at(query("email@x")) == nil)
  #expect(at(query("@")) == nil)
  #expect(at(query("@a.b")) == nil)
  #expect(at(query("@ali bob")) == nil)
  #expect(basicTypeaheadTrigger("@", minLength: 0)(query("x @")) == TypeaheadMatch(leadOffset: 2, matchingString: "", replaceableString: "@"))
  #expect(basicTypeaheadTrigger("@", allowWhitespace: true)(query("@ali bo")) == TypeaheadMatch(leadOffset: 0, matchingString: "ali bo", replaceableString: "@ali bo"))
}

@MainActor
private final class Harness {
  var matches: [TypeaheadMatch?] = []
  var queries: [TypeaheadQuery] = []
  let plugin: TypeaheadPlugin
  let view: LexicalView

  init(trigger: @escaping TypeaheadTrigger = basicTypeaheadTrigger("@")) {
    var recorder: ((TypeaheadMatch?) -> Void)?
    var queryRecorder: ((TypeaheadQuery) -> Void)?
    plugin = TypeaheadPlugin(trigger: { query in queryRecorder?(query); return trigger(query) }, onChange: { recorder?($0) })
    view = LexicalView(editorConfig: EditorConfig(theme: Theme(), plugins: [plugin]), featureFlags: FeatureFlags())
    recorder = { [unowned self] in matches.append($0) }
    queryRecorder = { [unowned self] in queries.append($0) }
  }
}

@MainActor
@Test func reportsTheMatchWhileTypingAndClearsIt() throws {
  let harness = Harness()
  harness.view.textView.insertText("hi @al")
  #expect(harness.plugin.match == TypeaheadMatch(leadOffset: 3, matchingString: "al", replaceableString: "@al"))
  #expect(harness.matches.last == TypeaheadMatch(leadOffset: 3, matchingString: "al", replaceableString: "@al"))
  harness.view.textView.insertText(" ")
  #expect(harness.plugin.match == nil)
  #expect(harness.matches.last == .some(nil))
  #expect(harness.matches.filter { $0 == nil }.count == 1)
}

@MainActor
@Test func replaceMatchSwapsTheQueryForNodesAndKeepsTyping() throws {
  let harness = Harness()
  harness.view.textView.insertText("hi @al")
  try harness.plugin.replaceMatch { [createTextNode(text: "X")] }
  #expect(harness.view.textView.text == "hi X")
  #expect(harness.plugin.match == nil)
  harness.view.textView.insertText("!")
  #expect(harness.view.textView.text == "hi X!")
}

@MainActor
@Test func queryKnowsWhetherItStartsTheDocument() throws {
  let harness = Harness(trigger: { _ in nil })
  harness.view.textView.insertText("/")
  #expect(harness.queries.last?.isFirstInDocument == true)
  #expect(harness.queries.last?.text == "/")
  harness.view.textView.insertText("\n")
  harness.view.textView.insertText("/")
  #expect(harness.queries.last?.isFirstInDocument == false)
}
