import Foundation
import Lexical
import LexicalHTML
import LexicalLinkPlugin
import LexicalListPlugin
import Testing

private let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Fixtures/html").standardized
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
  if type == "heading" || type == "list" { output["tag"] = node["tag"] }
  if let children = node["children"] { output["children"] = project(children) }
  return output
}

private func canonical(_ value: Any) -> String {
  String(data: try! JSONSerialization.data(withJSONObject: project(value), options: [.sortedKeys, .prettyPrinted]), encoding: .utf8)!
}

func swiftNodesJSON(_ html: String) throws -> Any {
  let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: [ListPlugin(), LinkPlugin()]))
  var encoded = Data()
  try editor.update {
    let nodes = try generateNodes(fromHTML: html)
    encoded = try JSONEncoder().encode(nodes)
  }
  return try JSONSerialization.jsonObject(with: encoded)
}

@Test(arguments: try! FileManager.default.contentsOfDirectory(atPath: fixtures.appendingPathComponent("inputs").path).filter { $0.hasSuffix(".html") }.sorted())
func generatedNodesMatchWebLexical(_ file: String) throws {
  let html = try String(contentsOf: fixtures.appendingPathComponent("inputs/\(file)"), encoding: .utf8)
  let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("expected/\(file.replacingOccurrences(of: ".html", with: ".json"))")))
  #expect(canonical(try swiftNodesJSON(html)) == canonical(expected))
}
