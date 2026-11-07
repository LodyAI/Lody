import Foundation
import Lexical
import LexicalListPlugin

public typealias ExportChildren = (ElementNode) -> String
public typealias ExportTextFormat = (TextNode, String) -> String

public enum MarkdownTransformer: Sendable {
  case multilineElement(@Sendable (Node, ExportChildren) -> String?)
  case element(@Sendable (Node, ExportChildren) -> String?)
  case textFormat(TextFormatType, tag: String)
  case textMatch(@Sendable (Node, ExportChildren, ExportTextFormat) -> String?)
}

public struct MarkdownExporter: Sendable {
  public let transformers: [MarkdownTransformer]
  public let escapesText: Bool
  public let preservesNewlines: Bool

  public init(transformers: [MarkdownTransformer], escapesText: Bool, preservesNewlines: Bool = false) {
    self.transformers = transformers
    self.escapesText = escapesText
    self.preservesNewlines = preservesNewlines
  }

  public static let gfm = MarkdownExporter(transformers: MarkdownTransformer.standard, escapesText: false, preservesNewlines: true)

  public func export(_ editor: Editor) throws -> String {
    var output = ""
    try editor.getEditorState().read {
      guard let root = getRoot() else { return }
      output = export(root)
    }
    return output
  }

  public func export(_ root: ElementNode) -> String {
    let run = ExportRun(exporter: self)
    let children = root.getChildren()
    var output: [String] = []
    for (index, child) in children.enumerated() {
      guard let result = run.topLevel(child) else { continue }
      let separated = index > 0 && !isEmptyParagraph(child) && !isEmptyParagraph(children[index - 1])
        && (!preservesNewlines || absorbsNextLine(children[index - 1], before: child))
      output.append(separated ? "\n" + result : result)
    }
    return output.joined(separator: "\n")
  }
}

private struct Tag {
  let format: TextFormatType
  let tag: String
}

private final class TagStack {
  var tags: [Tag] = []
}

private struct ExportRun {
  let exporter: MarkdownExporter
  let elementExports: [(Node, ExportChildren) -> String?]
  let formatTags: [Tag]
  let textMatches: [(Node, ExportChildren, ExportTextFormat) -> String?]

  init(exporter: MarkdownExporter) {
    self.exporter = exporter
    var multiline: [(Node, ExportChildren) -> String?] = []
    var elements: [(Node, ExportChildren) -> String?] = []
    var formats: [Tag] = []
    var matches: [(Node, ExportChildren, ExportTextFormat) -> String?] = []
    for transformer in exporter.transformers {
      switch transformer {
      case .multilineElement(let export): multiline.append(export)
      case .element(let export): elements.append(export)
      case .textFormat(let format, let tag): formats.append(Tag(format: format, tag: tag))
      case .textMatch(let export): matches.append(export)
      }
    }
    elementExports = multiline + elements
    formatTags = formats.filter { $0.format != .code } + formats.filter { $0.format == .code }
    textMatches = matches
  }

  func topLevel(_ node: Node) -> String? {
    for export in elementExports {
      if let result = export(node, { children($0, unclosed: TagStack(), unclosable: []) }) {
        return result
      }
    }
    if let element = node as? ElementNode {
      return children(element, unclosed: TagStack(), unclosable: [])
    }
    if node is DecoratorNode {
      return node.getTextContent()
    }
    return nil
  }

  func children(_ node: ElementNode, unclosed: TagStack, unclosable: [Tag]) -> String {
    var output = ""
    childLoop: for child in node.getChildren() {
      for export in textMatches {
        let result = export(
          child,
          { children($0, unclosed: unclosed, unclosable: unclosable + unclosed.tags) },
          { textFormat($0, $1, unclosed: unclosed, unclosable: unclosable) })
        if let result {
          output += result
          continue childLoop
        }
      }
      if child is LineBreakNode {
        output += (child.getStateString("mdHardLineBreak").flatMap(validHardLineBreak) ?? "") + "\n"
      } else if let text = child as? TextNode {
        output += textFormat(text, text.getTextContent(), unclosed: unclosed, unclosable: unclosable)
      } else if let element = child as? ElementNode {
        output += children(element, unclosed: unclosed, unclosable: unclosable)
      } else if child is DecoratorNode {
        output += child.getTextContent()
      }
    }
    return output
  }

  func textFormat(_ node: TextNode, _ content: String, unclosed: TagStack, unclosable: [Tag]) -> String {
    let isCode = hasFormat(node, .code)
    var output = content
    if !isCode && exporter.escapesText {
      output = output.replacingOccurrences(of: #"([*_`~\\])"#, with: #"\\$1"#, options: .regularExpression)
    }

    let leadingSpace: String
    let trimmed: String
    let trailingSpace: String
    let isWhitespaceOnly: Bool
    if isCode {
      let (fence, padded) = codeSpanDelimiter(content)
      leadingSpace = ""
      trailingSpace = ""
      trimmed = fence + padded + fence
      isWhitespaceOnly = false
    } else {
      let parts = splitSurroundingWhitespace(output)
      leadingSpace = parts.leading
      trimmed = parts.core
      trailingSpace = parts.trailing
      isWhitespaceOnly = trimmed.isEmpty
    }

    var opening = ""
    var closingBefore = ""
    var closingAfter = ""
    let previous = node.getPreviousSibling() as? TextNode
    let next = node.getNextSibling() as? TextNode
    var applied: Set<Int> = []

    for tag in formatTags where tag.format != .code {
      guard checkHasFormat(node, tag.format), !applied.contains(tag.format.rawValue) else { continue }
      applied.insert(tag.format.rawValue)
      if !checkHasFormat(previous, tag.format) || !unclosed.tags.contains(where: { $0.tag == tag.tag }) {
        unclosed.tags.append(tag)
        opening += tag.tag
      }
    }

    var index = 0
    while index < unclosed.tags.count {
      let nodeHasFormat = hasFormat(node, unclosed.tags[index].format)
      let nextHasFormat = hasFormat(next, unclosed.tags[index].format)
      if nodeHasFormat && nextHasFormat {
        index += 1
        continue
      }
      var unhandled = unclosed.tags
      while unhandled.count > index {
        let tag = unhandled.removeLast()
        if unclosable.contains(where: { $0.tag == tag.tag }) {
          continue
        }
        if !nodeHasFormat {
          closingBefore += tag.tag
        } else if !nextHasFormat {
          closingAfter += tag.tag
        }
        unclosed.tags.removeLast()
      }
      break
    }

    if isWhitespaceOnly && !isCode {
      return closingBefore + output
    }
    return closingBefore + leadingSpace + opening + trimmed + closingAfter + trailingSpace
  }
}

private func hasFormat(_ node: TextNode?, _ format: TextFormatType) -> Bool {
  node?.getFormat().isTypeSet(type: format) ?? false
}

private func checkHasFormat(_ node: TextNode?, _ format: TextFormatType) -> Bool {
  guard let node, hasFormat(node, format) else { return false }
  if format == .code { return true }
  return !node.getTextContent().allSatisfy(\.isWhitespace)
}

private func validHardLineBreak(_ value: String) -> String? {
  value.range(of: #"^(\\| {2,})$"#, options: .regularExpression) != nil ? value : nil
}

private func splitSurroundingWhitespace(_ value: String) -> (leading: String, core: String, trailing: String) {
  let leading = value.prefix { $0.isWhitespace }
  let rest = value.dropFirst(leading.count)
  let trailing = rest.reversed().prefix { $0.isWhitespace }
  return (String(leading), String(rest.dropLast(trailing.count)), String(trailing.reversed()))
}

func codeSpanDelimiter(_ content: String) -> (fence: String, padded: String) {
  let longestRun = backtickRuns(content).max() ?? 0
  let fence = String(repeating: "`", count: longestRun + 1)
  let padded = content.isEmpty || content.contains("`") || (content.first?.isWhitespace == true && content.last?.isWhitespace == true)
  return (fence, padded ? " \(content) " : content)
}

func backtickRuns(_ content: String) -> [Int] {
  var runs: [Int] = []
  var current = 0
  for character in content {
    if character == "`" {
      current += 1
    } else if current > 0 {
      runs.append(current)
      current = 0
    }
  }
  if current > 0 { runs.append(current) }
  return runs
}

// CommonMark lazy continuation would pull the next line into a quote or list the user already left.
private func absorbsNextLine(_ block: Node, before next: Node) -> Bool {
  (block is QuoteNode || block is ListNode) && type(of: block) != type(of: next)
}

public func isEmptyParagraph(_ node: Node) -> Bool {
  guard let paragraph = node as? ParagraphNode else { return false }
  let children = paragraph.getChildren()
  guard let first = children.first else { return true }
  return children.count == 1 && first is TextNode && first.getTextContent().range(of: #"^\s{0,3}$"#, options: .regularExpression) != nil
}
