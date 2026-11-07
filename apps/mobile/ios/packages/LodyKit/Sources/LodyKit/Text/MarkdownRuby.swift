import Foundation
import MarkdownParser

/// Consume only parsed HTML nodes: code and escaped tags must stay literal.
enum MarkdownRuby {
  struct Annotation: Codable {
    let base: String
    let reading: String
  }
  static let marker = "\u{F0000}lody-ruby:"

  static func blocks(_ nodes: [MarkdownBlockNode]) -> [MarkdownBlockNode] {
    nodes.rewrite { (node: MarkdownBlockNode) -> [MarkdownBlockNode] in
      switch node {
      case .paragraph(let children): return [.paragraph(content: inline(children, render: encoded))]
      case .heading(let level, let children): return [.heading(level: level, content: inline(children, render: encoded))]
      case .table(let alignments, let rows):
        return [.table(columnAlignments: alignments, rows: rows.map { row in
          RawTableRow(cells: row.cells.map { RawTableCell(content: inline($0.content, render: encoded)) })
        })]
      default: return [node]
      }
    }
  }

  private static func encoded(_ annotation: Annotation) -> MarkdownInlineNode {
    let data = try! JSONEncoder().encode(annotation)
    return .text(marker + data.base64EncodedString())
  }

  static func decode(_ text: String) -> Annotation? {
    guard text.hasPrefix(marker), let data = Data(base64Encoded: String(text.dropFirst(marker.count))) else { return nil }
    return try? JSONDecoder().decode(Annotation.self, from: data)
  }

  static func inline(_ nodes: [MarkdownInlineNode], render: (Annotation) -> MarkdownInlineNode) -> [MarkdownInlineNode] {
    var result: [MarkdownInlineNode] = []
    var index = 0
    while index < nodes.count {
      if tag(nodes[index]) == "<ruby>",
         let end = nodes[(index + 1)...].firstIndex(where: { tag($0) == "</ruby>" }),
         let annotations = parse(nodes[(index + 1)..<end]) {
        result += annotations.map(render)
        index = end + 1
      } else {
        var node = nodes[index]
        node.children = inline(node.children, render: render)
        result.append(node)
        index += 1
      }
    }
    return result
  }

  private static func tag(_ node: MarkdownInlineNode) -> String? {
    guard case .html(let source) = node else { return nil }
    return source.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  }

  private static func parse(_ nodes: ArraySlice<MarkdownInlineNode>) -> [Annotation]? {
    var result: [Annotation] = []
    var base = ""
    var reading = ""
    var context = "base"
    for node in nodes {
      switch tag(node) {
      case "<rt>" where context == "base" && !base.isEmpty: context = "rt"
      case "</rt>" where context == "rt" && !reading.isEmpty:
        result.append(Annotation(base: base, reading: reading))
        base = ""
        reading = ""
        context = "base"
      case "<rp>" where context == "base": context = "rp"
      case "</rp>" where context == "rp": context = "base"
      case "<rb>" where context == "base", "</rb>" where context == "base": break
      case nil:
        let text: String
        switch node {
        case .text(let value): text = value
        case .softBreak, .lineBreak: text = " "
        default: return nil
        }
        if context == "base" { base += text }
        if context == "rt" { reading += text }
      default: return nil
      }
    }
    guard context == "base", !result.isEmpty else { return nil }
    if !base.isEmpty { result.append(Annotation(base: base, reading: "")) }
    return result
  }
}
