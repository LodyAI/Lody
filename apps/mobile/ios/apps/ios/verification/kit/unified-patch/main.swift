import Foundation

let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  .appendingPathComponent("../../../tests/fixtures").standardized
let cases = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("unified-patch.json"))) as! [[String: String]]
let golden = try JSONSerialization.jsonObject(with: Data(contentsOf: fixtures.appendingPathComponent("unified-patch.golden.json"))) as! [String: String]

for item in cases {
  let name = item["name"]!
  let patch = UnifiedPatch.make(path: item["path"]!, old: item["old"]!, new: item["new"]!)
  precondition(patch.utf8.elementsEqual(golden[name]!.utf8), "\(name) differs from jsdiff:\n\(patch)")
}
print("PASS: UnifiedPatch matches jsdiff createTwoFilesPatch for \(cases.count) cases")
