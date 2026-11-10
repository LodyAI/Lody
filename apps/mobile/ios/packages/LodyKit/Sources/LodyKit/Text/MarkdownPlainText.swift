import Foundation
import MarkdownParser

/// Readable Markdown before UI decoration. No link destinations, image metadata,
/// format delimiters or renderer replacement tokens escape into search/copy text.
enum MarkdownPlainText {
  // NSCache owns synchronization; immutable strings are safe across parser queues.
  nonisolated(unsafe) private static let cache: NSCache<NSString, NSString> = {
    let cache = NSCache<NSString, NSString>()
    cache.countLimit = 256
    cache.totalCostLimit = 8 * 1024 * 1024
    return cache
  }()

  static func string(_ source: String) -> String {
    if let saved = cache.object(forKey: source as NSString) { return saved as String }
    let text = blocks(MarkdownParser().parse(source).document)
    cache.setObject(text as NSString, forKey: source as NSString, cost: source.utf8.count + text.utf8.count)
    return text
  }

  static func clearCache() { cache.removeAllObjects() }

  private static func blocks(_ nodes: [MarkdownBlockNode]) -> String {
    nodes.map { node in
      switch node {
      case .paragraph(let children), .heading(_, let children): return inline(children)
      case .blockquote(let children): return blocks(children)
      case .bulletedList(_, let items), .numberedList(_, _, let items):
        return items.map { blocks($0.children) }.joined(separator: "\n")
      case .taskList(_, let items): return items.map { blocks($0.children) }.joined(separator: "\n")
      case .codeBlock(_, let content): return content
      case .table(_, let rows):
        return rows.map { $0.cells.map { inline($0.content) }.joined(separator: "\t") }.joined(separator: "\n")
      case .thematicBreak: return ""
      }
    }.joined(separator: "\n")
  }

  private static func inline(_ nodes: [MarkdownInlineNode]) -> String {
    MarkdownRuby.inline(nodes, render: { .text($0.base) }).map { node in
      switch node {
      case .text(let text), .code(let text): return text
      case .softBreak: return " "
      case .lineBreak: return "\n"
      case .emphasis(let children), .strong(let children), .strikethrough(let children), .link(_, let children):
        return inline(children)
      case .math(let content, _): return content
      case .image, .html: return ""
      }
    }.joined()
  }
}
