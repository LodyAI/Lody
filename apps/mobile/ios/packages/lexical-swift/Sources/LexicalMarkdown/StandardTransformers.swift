import Foundation
import Lexical
import LexicalLinkPlugin
import LexicalListPlugin

extension MarkdownTransformer {
  public static let heading = MarkdownTransformer.element { node, exportChildren in
    guard let heading = node as? HeadingNode else { return nil }
    let level = Int(heading.getTag().rawValue.dropFirst()) ?? 1
    return String(repeating: "#", count: level) + " " + exportChildren(heading)
  }

  public static let quote = MarkdownTransformer.element { node, exportChildren in
    guard let quote = node as? QuoteNode else { return nil }
    return exportChildren(quote).components(separatedBy: "\n").map { "> " + $0 }.joined(separator: "\n")
  }

  public static let code = MarkdownTransformer.multilineElement { node, _ in
    guard let code = node as? CodeNode else { return nil }
    let content = inlineText(code)
    var fence = code.getStateString("mdCodeFence").flatMap { $0.range(of: #"^`{3,}$"#, options: .regularExpression) != nil ? $0 : nil } ?? "```"
    if content.contains(fence), let longest = backtickRuns(content).filter({ $0 >= 3 }).max() {
      fence = String(repeating: "`", count: longest + 1)
    }
    return fence + code.getLanguage() + (content.isEmpty ? "" : "\n" + content) + "\n" + fence
  }

  public static let list = MarkdownTransformer.element { node, exportChildren in
    guard let list = node as? ListNode else { return nil }
    return exportList(list, exportChildren, depth: 0)
  }

  public static let link = MarkdownTransformer.textMatch { node, exportChildren, _ in
    guard let link = node as? LinkNode, !(link is AutoLinkNode) else { return nil }
    let content = exportChildren(link)
    guard let title = link.title, !title.isEmpty else { return "[\(content)](\(link.getURL()))" }
    let escaped = title.replacingOccurrences(of: #"([\\"])"#, with: #"\\$1"#, options: .regularExpression)
    return "[\(content)](\(link.getURL()) \"\(escaped)\")"
  }

  public static let textFormats: [MarkdownTransformer] = [
    .textFormat(.code, tag: "`"),
    .textFormat(.bold, tag: "**"),
    .textFormat(.highlight, tag: "=="),
    .textFormat(.italic, tag: "*"),
    .textFormat(.strikethrough, tag: "~~"),
  ]

  public static let standard: [MarkdownTransformer] = [heading, quote, list, code] + textFormats + [link]
}

private func exportList(_ list: ListNode, _ exportChildren: ExportChildren, depth: Int) -> String {
  var output: [String] = []
  var index = 0
  let marker = list.getStateString("mdListMarker").flatMap { ["-", "*", "+"].contains($0) ? $0 : nil } ?? "-"
  for case let item as ListItemNode in list.getChildren() {
    if item.getChildrenSize() == 1, let nested = item.getChildren().first as? ListNode {
      let nestedOutput = exportList(nested, exportChildren, depth: depth + 1)
      if !nestedOutput.isEmpty { output.append(nestedOutput) }
      continue
    }
    let prefix: String
    switch list.getListType() {
    case .number: prefix = "\(list.getStart() + index). "
    case .check: prefix = "\(marker) [\(item.getChecked() == true ? "x" : " ")] "
    case .bullet: prefix = marker + " "
    }
    var content = exportChildren(item)
    if list.getListType() != .number {
      content = content.replacingOccurrences(of: #"^(\s{0,3}\d+)(\.\s)"#, with: #"$1\\$2"#, options: .regularExpression)
    }
    output.append(String(repeating: " ", count: depth * 4) + prefix + content)
    index += 1
  }
  return output.joined(separator: "\n")
}

// ElementNode.getTextContent includes the reconciler's block postamble; Lexical web's code text does not.
func inlineText(_ element: ElementNode) -> String {
  element.getChildren().map { child in
    switch child {
    case is LineBreakNode: "\n"
    case let nested as ElementNode: inlineText(nested)
    default: child.getTextContent()
    }
  }.joined()
}

