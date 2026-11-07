import Foundation
import HaklexNodes
import Lexical
import Testing

private let t0Types: Set<String> = ["root", "paragraph", "text", "linebreak", "tab", "heading", "quote", "list", "listitem", "link", "autolink", "code", "code-highlight", "code-block", "horizontalrule", "mention"]

private func nodeTypes(_ value: Any, into types: inout Set<String>) {
  guard let object = value as? [String: Any] else { return }
  if let type = object["type"] as? String { types.insert(type) }
  (object["children"] as? [Any])?.forEach { nodeTypes($0, into: &types) }
  if let root = object["root"] { nodeTypes(root, into: &types) }
}

private func isT0(_ fixture: HaklexFixture) -> Bool {
  var types: Set<String> = []
  nodeTypes((try? JSONSerialization.jsonObject(with: Data(fixture.json.utf8))) ?? [:], into: &types)
  return types.isSubset(of: t0Types)
}

private func expectedMarkdown(_ fixture: HaklexFixture) throws -> String {
  let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../../Fixtures/haklex/expected/\(fixture.name).md").standardized
  return try String(contentsOf: url, encoding: .utf8)
}

@Test func markdownParityCoversExactlyTheT0Fixtures() {
  let covered = Set(HaklexFixture.all.filter(isT0).map(\.name))
  #expect(covered == ["node-codeblock", "node-mention", "node-tasklist", "t0-contract"])
}

@Test(arguments: HaklexFixture.all.filter(isT0))
func haklexMarkdownMatchesToMarkdown(_ fixture: HaklexFixture) throws {
  let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: Haklex.plugins()))
  try editor.setEditorState(EditorState.fromJSON(json: fixture.json, editor: editor))
  let markdown = try Haklex.markdown.export(editor)
  let expected = try expectedMarkdown(fixture)
  #expect(markdown == expected)
}

@Test func textIsEscapedLikeWebLexical() throws {
  let json = #"{"root":{"type":"root","version":1,"direction":"ltr","format":"","indent":0,"children":[{"type":"paragraph","version":1,"direction":"ltr","format":"","indent":0,"textFormat":0,"textStyle":"","children":[{"type":"text","version":1,"text":"a*b_c`d~e\\f","format":0,"detail":0,"mode":"normal","style":""}]}]}}"#
  let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: Haklex.plugins()))
  try editor.setEditorState(EditorState.fromJSON(json: json, editor: editor))
  #expect(try Haklex.markdown.export(editor) == #"a\*b\_c\`d\~e\\f"#)
}
