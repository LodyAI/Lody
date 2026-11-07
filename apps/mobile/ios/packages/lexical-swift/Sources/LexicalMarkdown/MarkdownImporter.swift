import Foundation
import Lexical
import LexicalListPlugin

public struct MarkdownElementImport: Sendable {
  public let pattern: String
  public let replace: @Sendable (_ paragraph: ElementNode, _ children: [Node], _ match: [String]) throws -> Bool

  public init(pattern: String, replace: @escaping @Sendable (ElementNode, [Node], [String]) throws -> Bool) {
    self.pattern = pattern
    self.replace = replace
  }
}

public struct MarkdownImporter: Sendable {
  public let elements: [MarkdownElementImport]
  public let formats: [(tag: String, formats: [TextFormatType])]
  public let importsCode: Bool
  public let importsLinks: Bool

  public init(elements: [MarkdownElementImport], formats: [(tag: String, formats: [TextFormatType])], importsCode: Bool, importsLinks: Bool) {
    self.elements = elements
    self.formats = formats
    self.importsCode = importsCode
    self.importsLinks = importsLinks
  }

  public static let gfm = MarkdownImporter(
    elements: [.heading, .quote, .checkList, .bulletList, .orderedList],
    formats: [
      ("`", [.code]), ("***", [.bold, .italic]), ("___", [.bold, .italic]), ("**", [.bold]), ("__", [.bold]),
      ("==", [.highlight]), ("*", [.italic]), ("_", [.italic]), ("~~", [.strikethrough]),
    ],
    importsCode: true,
    importsLinks: true
  )

  // Mirrors $generateNodesFromMarkdownString with shouldPreserveNewLines, the counterpart of MarkdownExporter.gfm.
  public func generateNodes(_ markdown: String) throws -> [Node] {
    let container = ParagraphNode()
    let lines = markdown.components(separatedBy: "\n")
    let inline = InlineImport(formats: formats, importsLinks: importsLinks)
    var index = 0
    while index < lines.count {
      if importsCode, let end = try importCode(lines, index, into: container) {
        index = end + 1
        continue
      }
      try importBlock(lines[index], into: container, inline: inline)
      index += 1
    }
    for child in container.getChildren() {
      guard let element = child as? ElementNode else { continue }
      for text in element.getAllTextNodes() { try splitTabs(text) }
    }
    let nodes = container.getChildren()
    for node in nodes { try node.remove() }
    return nodes
  }

  private func importBlock(_ line: String, into container: ElementNode, inline: InlineImport) throws {
    let text = createTextNode(text: line)
    let paragraph = createParagraphNode()
    try paragraph.append([text])
    try container.append([paragraph])
    let ns = line as NSString
    for element in elements {
      guard let regex = try? NSRegularExpression(pattern: element.pattern, options: [.caseInsensitive]),
        let match = regex.firstMatch(in: line, range: NSRange(location: 0, length: ns.length))
      else { continue }
      try text.setText(ns.substring(from: match.range.length))
      let groups = (0..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? "" : ns.substring(with: match.range(at: $0)) }
      if try element.replace(paragraph, [text], groups) { break }
    }
    try inline.importText(text)
  }

  private func importCode(_ lines: [String], _ start: Int, into container: ElementNode) throws -> Int? {
    let line = lines[start] as NSString
    guard let open = try? NSRegularExpression(pattern: #"^([ \t]*`{3,})([\w-]+)?[ \t]?"#),
      let match = open.firstMatch(in: lines[start], range: NSRange(location: 0, length: line.length))
    else { return nil }
    let fence = line.substring(with: match.range(at: 1))
    let fenceLength = fence.trimmingCharacters(in: .whitespaces).count
    let language = match.range(at: 2).location == NSNotFound ? "" : line.substring(with: match.range(at: 2))
    let afterFence = line.substring(from: match.range(at: 1).location + match.range(at: 1).length) as NSString
    if let close = try? NSRegularExpression(pattern: "`{\(fenceLength),}$"),
      let closeMatch = close.firstMatch(in: afterFence as String, range: NSRange(location: 0, length: afterFence.length))
    {
      try appendCode(language: "", lines: [afterFence.substring(to: closeMatch.range.location)], closed: true, into: container)
      return start
    }
    let afterFullMatch = line.substring(from: match.range.length)
    let close = try NSRegularExpression(pattern: "^[ \\t]*`{\(fenceLength),}$")
    var end = start + 1
    while end < lines.count {
      if close.firstMatch(in: lines[end], range: NSRange(location: 0, length: (lines[end] as NSString).length)) != nil { break }
      end += 1
    }
    var between = Array(lines[min(start + 1, lines.count)..<min(end, lines.count)])
    if !afterFullMatch.isEmpty { between.insert(afterFullMatch, at: 0) }
    let closed = end < lines.count
    try appendCode(language: language, lines: between, closed: closed, into: container)
    return closed ? end : lines.count - 1
  }

  private func appendCode(language: String, lines: [String], closed: Bool, into container: ElementNode) throws {
    var lines = lines
    let code: String
    if lines.count == 1 {
      code = closed || !lines[0].hasPrefix(" ") ? lines[0] : String(lines[0].dropFirst())
    } else {
      if let first = lines.first {
        if first.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
          lines.removeFirst()
        } else if first.hasPrefix(" ") {
          lines[0] = String(first.dropFirst())
        }
      }
      while let last = lines.last, last.isEmpty { lines.removeLast() }
      code = lines.joined(separator: "\n")
    }
    let node = createCodeNode(language: language)
    try node.append([createTextNode(text: code)])
    try container.append([node])
  }

  private func splitTabs(_ text: TextNode) throws {
    let content = text.getTextPart() as NSString
    var offsets: [Int] = []
    for index in 0..<content.length where content.character(at: index) == 9 {
      offsets += [index, index + 1]
    }
    guard !offsets.isEmpty else { return }
    let parts = try text.splitText(splitOffsets: Array(Set(offsets)).sorted().filter { $0 > 0 && $0 < content.length })
    for part in parts where part.getTextPart() == "\t" {
      _ = try part.replace(replaceWith: TabNode())
    }
  }
}

extension MarkdownElementImport {
  public static let heading = MarkdownElementImport(pattern: #"^(#{1,6})\s"#) { paragraph, children, match in
    let tags: [HeadingTagType] = [.h1, .h2, .h3, .h4, .h5, .h6]
    let heading = createHeadingNode(headingTag: tags[match[1].count - 1])
    try heading.append(children)
    _ = try paragraph.replace(replaceWith: heading)
    return true
  }

  public static let quote = MarkdownElementImport(pattern: #"^>\s"#) { paragraph, children, _ in
    if let previous = paragraph.getPreviousSibling() as? QuoteNode {
      try previous.append([try markdownLineBreak(after: previous)] + children)
      try paragraph.remove()
      return true
    }
    let quote = createQuoteNode()
    try quote.append(children)
    _ = try paragraph.replace(replaceWith: quote)
    return true
  }

  public static let checkList = MarkdownElementImport(pattern: #"^(\s*)(?:[-*+]\s)?\s?(\[(\s|x)?\])\s"#) { paragraph, children, match in
    try importListItem(.check, paragraph, children, match)
  }

  public static let bulletList = MarkdownElementImport(pattern: #"^(\s*)[-*+]\s"#) { paragraph, children, match in
    try importListItem(.bullet, paragraph, children, match)
  }

  public static let orderedList = MarkdownElementImport(pattern: #"^(\s*)(\d{1,})\.\s"#) { paragraph, children, match in
    try importListItem(.number, paragraph, children, match)
  }
}

// Pasted content controls the start number; exporting start + index must not overflow.
public func clampedListStart(_ value: String) -> Int? {
  let digits = value.trimmingCharacters(in: .whitespaces)
  guard !digits.isEmpty, digits.allSatisfy(\.isNumber) else { return Int(digits).map { min(max($0, 0), 999_999_999) } }
  return min(Int(digits) ?? Int.max, 999_999_999)
}

private func importListItem(_ type: ListType, _ paragraph: ElementNode, _ children: [Node], _ match: [String]) throws -> Bool {
  let item = ListItemNode()
  if type == .check { try item.setChecked(match[3] == "x") }
  if let previous = paragraph.getPreviousSibling() as? ListNode, previous.getListType() == type {
    try previous.append([item])
    try paragraph.remove()
  } else {
    let list = createListNode(listType: type, start: type == .number ? clampedListStart(match[2]) ?? 1 : 1)
    try list.append([item])
    _ = try paragraph.replace(replaceWith: list)
  }
  try item.append(children)
  let indent = match[1].filter { $0 == "\t" }.count + match[1].filter { $0 == " " }.count / 4
  if indent > 0 { try item.setIndent(indent) }
  return true
}

// Web keeps the stripped hard-break marker in NodeState; the composer exports plain line breaks, so it is dropped.
private func markdownLineBreak(after previous: ElementNode) throws -> LineBreakNode {
  if let last = previous.getLastChild() as? TextNode {
    let text = last.getTextPart()
    if text.hasSuffix("\\") {
      try last.setText(String(text.dropLast()))
    } else if let range = text.range(of: #"^(.*?\S)( {2,})$"#, options: .regularExpression), range.lowerBound == text.startIndex {
      try last.setText(text.replacingOccurrences(of: #" {2,}$"#, with: "", options: .regularExpression))
    }
  }
  return createLineBreakNode()
}
