import Foundation
import Testing

private func outline(_ html: String) throws -> [String] {
  func describe(_ value: Any) -> String {
    guard let node = value as? [String: Any], let type = node["type"] as? String else { return "?" }
    if type == "text" {
      let format = node["format"] as? Int ?? 0
      return (node["text"] as? String ?? "") + (format == 0 ? "" : "/\(format)")
    }
    let children = (node["children"] as? [Any] ?? []).map(describe).joined(separator: ",")
    let url = (node["url"] as? String).map { " " + $0 } ?? ""
    return "\(type)\(url)[\(children)]"
  }
  return (try swiftNodesJSON(html) as? [Any] ?? []).map(describe)
}

@Test func tablesBecomeGFMTableText() throws {
  let html = "<table><thead><tr><th>Name</th><th>Note</th></tr></thead><tbody><tr><td>a</td><td>x | y</td></tr><tr><td>b</td></tr></tbody></table>"
  let result = try outline(html)
  #expect(result == ["paragraph[| Name | Note |]", "paragraph[| --- | --- |]", "paragraph[| a | x \\| y |]", "paragraph[| b |  |]"])
}

@Test func imagesKeepTheirAltText() throws {
  let result = try outline("<p>see <img src=\"https://x/y.png\" alt=\"diagram\"> here</p><p><img src=\"z.png\"></p>")
  #expect(result == ["paragraph[see ,diagram, here]", "paragraph[]"])
}

@Test func horizontalRulesBecomeAThematicBreakLine() throws {
  let result = try outline("<p>a</p><hr><p>b</p>")
  #expect(result == ["paragraph[a]", "paragraph[***]", "paragraph[b]"])
}

@Test func deletedTextIsStruckThrough() throws {
  let result = try outline("<p><del>old</del></p>")
  #expect(result == ["paragraph[old/4]"])
}

@Test func onlyWebAndMailLinksSurvive() throws {
  let html = "<p><a href=\"javascript:alert(1)\">js</a> <a href=\"/relative\">rel</a> <a href=\"data:text/html,x\">data</a> <a href=\"HTTPS://ok.example\">ok</a></p>"
  let result = try outline(html)
  #expect(result == ["paragraph[js, ,rel, ,data, ,link HTTPS://ok.example[ok]]"])
}
