import Foundation
import HaklexNodes
import Lexical
import Testing

struct HaklexFixture: CustomTestStringConvertible, Sendable {
  let name: String
  let json: String
  var testDescription: String { name }

  static let all: [HaklexFixture] = {
    let directory = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .appendingPathComponent("../../Fixtures/haklex/expected")
      .standardized
    let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }.compactMap { url in
      (try? String(contentsOf: url, encoding: .utf8)).map { HaklexFixture(name: url.deletingPathExtension().lastPathComponent, json: $0) }
    }
  }()
}

@Test func fixturesArePresent() {
  #expect(HaklexFixture.all.count >= 40)
}

@Test(arguments: HaklexFixture.all)
func jsonRoundTripIsLossless(_ fixture: HaklexFixture) throws {
  let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: Haklex.plugins()))
  let state = try EditorState.fromJSON(json: fixture.json, editor: editor)
  try editor.setEditorState(state)
  let exported = try editor.getEditorState().toJSON()
  let expected = try JSONSerialization.jsonObject(with: Data(fixture.json.utf8))
  let actual = try JSONSerialization.jsonObject(with: Data(exported.utf8))
  let differences = JSONDiff.compare(expected, actual, path: "$")
  #expect(differences.isEmpty, "\(fixture.name): \(differences.prefix(8).joined(separator: "\n"))")
}

enum JSONDiff {
  static func compare(_ lhs: Any, _ rhs: Any, path: String) -> [String] {
    switch (lhs, rhs) {
    case let (l as [String: Any], r as [String: Any]):
      var out: [String] = []
      for key in Set(l.keys).union(r.keys).sorted() {
        switch (l[key], r[key]) {
        case let (lv?, rv?): out += compare(lv, rv, path: "\(path).\(key)")
        case (_?, nil): out.append("\(path).\(key) missing")
        case (nil, _?): out.append("\(path).\(key) unexpected")
        default: break
        }
      }
      return out
    case let (l as [Any], r as [Any]):
      guard l.count == r.count else { return ["\(path) count \(l.count) != \(r.count)"] }
      return zip(l, r).enumerated().flatMap { compare($1.0, $1.1, path: "\(path)[\($0)]") }
    case let (l as NSNumber, r as NSNumber):
      let lb = CFGetTypeID(l) == CFBooleanGetTypeID(), rb = CFGetTypeID(r) == CFBooleanGetTypeID()
      return lb == rb && l == r ? [] : ["\(path) \(l) != \(r)"]
    case let (l as String, r as String):
      return l == r ? [] : ["\(path) \"\(l)\" != \"\(r)\""]
    case (is NSNull, is NSNull):
      return []
    default:
      return ["\(path) \(lhs) != \(rhs)"]
    }
  }
}

private func roundTrip(_ json: String, edit: (() throws -> Void)? = nil) throws -> [String] {
  let editor = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: Haklex.plugins()))
  try editor.setEditorState(EditorState.fromJSON(json: json, editor: editor))
  if let edit { try editor.update(edit) }
  let exported = try editor.getEditorState().toJSON()
  return JSONDiff.compare(
    try JSONSerialization.jsonObject(with: Data(json.utf8)),
    try JSONSerialization.jsonObject(with: Data(exported.utf8)),
    path: "$")
}

@Test func undecodableKnownNodeIsKeptVerbatim() throws {
  let json = """
    {"root":{"type":"root","version":1,"direction":"ltr","format":"","indent":0,"children":[
      {"type":"heading","version":1,"tag":"h9","direction":"ltr","format":"","indent":0,"children":[]},
      {"type":"paragraph","version":1,"direction":"ltr","format":"","indent":0,"textFormat":0,"textStyle":"","children":[]}
    ]}}
    """
  #expect(try roundTrip(json).isEmpty)
}

@Test func editingAParsedNodeKeepsItsSerializedFields() throws {
  let json = """
    {"root":{"type":"root","version":1,"direction":"ltr","format":"","indent":0,"children":[
      {"type":"paragraph","version":1,"direction":"rtl","format":"center","indent":2,"textFormat":1,"textStyle":"color: red;","$":{"blockId":"b1"},"children":[
        {"type":"text","version":1,"text":"hi","format":1664,"detail":1,"mode":"normal","style":"color: blue;","$":{"k":1}}
      ]}
    ]}}
    """
  let differences = try roundTrip(json) {
    guard let paragraph = getRoot()?.getFirstChild() as? ElementNode, let text = paragraph.getFirstChild() else { return }
    _ = try paragraph.getWritable()
    _ = try text.getWritable()
  }
  #expect(differences.isEmpty, "\(differences)")
}
