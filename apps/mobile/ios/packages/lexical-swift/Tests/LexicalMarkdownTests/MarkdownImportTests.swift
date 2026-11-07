import Foundation
import Lexical
import LexicalLinkPlugin
import LexicalListPlugin
import LexicalMarkdown
import Testing

private let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Fixtures/markdown").standardized
private let semanticKeys: Set<String> = ["type", "text", "tag", "listType", "start", "checked", "url", "title", "language"]

private func project(_ value: Any) -> Any {
  if let list = value as? [Any] { return list.map(project) }
  guard let node = value as? [String: Any] else { return value }
  var output: [String: Any] = [:]
  for (key, raw) in node where semanticKeys.contains(key) {
    if raw is NSNull { continue }
    if key == "language", (raw as? String)?.isEmpty == true { continue }
    output[key] = raw
  }
  let type = node["type"] as? String
  if type == "text" || type == "tab" { output["format"] = node["format"] ?? 0 }
  if let children = node["children"] { output["children"] = project(children) }
  return output
}

private func canonical(_ value: Any) -> String {
  String(data: try! JSONSerialization.data(withJSONObject: project(value), options: [.sortedKeys, .prettyPrinted]), encoding: .utf8)!
}

private func makeEditor() -> Editor {
  Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: [ListPlugin(), LinkPlugin()]))
}

@Test(arguments: try! FileManager.default.contentsOfDirectory(atPath: fixtures.appendingPathComponent("inputs").path).filter { $0.hasSuffix(".md") }.sorted())
func importedNodesMatchWebLexical(_ file: String) throws {
  var markdown = try String(contentsOf: fixtures.appendingPathComponent("inputs/\(file)"), encoding: .utf8)
  if markdown.hasSuffix("\n") { markdown.removeLast() }
  let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("expected/\(file.replacingOccurrences(of: ".md", with: ".json"))")))
  var encoded = Data()
  try makeEditor().update {
    encoded = try JSONEncoder().encode(try MarkdownImporter.gfm.generateNodes(markdown))
  }
  let actual = canonical(try JSONSerialization.jsonObject(with: encoded))
  #expect(actual == canonical(expected))
}

@Test func gfmMarkdownRoundTripsThroughImportAndExport() throws {
  var markdown = try String(contentsOf: fixtures.appendingPathComponent("inputs/agent-reply.md"), encoding: .utf8)
  if markdown.hasSuffix("\n") { markdown.removeLast() }
  let editor = makeEditor()
  try editor.update {
    guard let root = getRoot() else { return }
    try root.getChildren().forEach { try $0.remove() }
    try root.append(try MarkdownImporter.gfm.generateNodes(markdown))
  }
  #expect(try MarkdownExporter.gfm.export(editor) == markdown)
}
