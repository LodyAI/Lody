import Foundation
import Lexical
import LexicalListPlugin

public struct BlockShortcut: Sendable {
  public let pattern: String
  public let replace: @Sendable (_ paragraph: ElementNode, _ remainder: [Node], _ match: [String]) throws -> Void

  public init(pattern: String, replace: @escaping @Sendable (ElementNode, [Node], [String]) throws -> Void) {
    self.pattern = pattern
    self.replace = replace
  }
}

extension BlockShortcut {
  public static let bulletList = BlockShortcut(pattern: #"^(\s*)[-*+]\s"#) { paragraph, remainder, _ in
    try replaceWithList(paragraph, remainder, type: .bullet, start: 1)
  }

  public static let orderedList = BlockShortcut(pattern: #"^(\s*)(\d{1,})\.\s"#) { paragraph, remainder, match in
    try replaceWithList(paragraph, remainder, type: .number, start: Int(match[2]) ?? 1)
  }

  public static let heading = BlockShortcut(pattern: #"^(#{1,6})\s"#) { paragraph, remainder, match in
    let tags: [HeadingTagType] = [.h1, .h2, .h3, .h4, .h5, .h6]
    let heading = createHeadingNode(headingTag: tags[match[1].count - 1])
    try heading.append(remainder)
    _ = try paragraph.replace(replaceWith: heading)
    _ = try heading.selectStart()
  }

  public static let quote = BlockShortcut(pattern: #"^>\s"#) { paragraph, remainder, _ in
    let quote = createQuoteNode()
    try quote.append(remainder)
    _ = try paragraph.replace(replaceWith: quote)
    _ = try quote.selectStart()
  }

  public static let codeFence = BlockShortcut(pattern: #"^([ \t]*`{3,})([\w-]+)?[ \t]?"#) { paragraph, remainder, match in
    let code = createCodeNode(language: match[2])
    try code.append(remainder)
    _ = try paragraph.replace(replaceWith: code)
    _ = try code.selectStart()
  }

  public static let composer: [BlockShortcut] = [heading, bulletList, orderedList, quote, codeFence]
}

private func replaceWithList(_ paragraph: ElementNode, _ remainder: [Node], type: ListType, start: Int) throws {
  let item = ListItemNode()
  try item.append(remainder)
  if let previous = paragraph.getPreviousSibling() as? ListNode, previous.getListType() == type {
    try previous.append([item])
    try paragraph.remove()
  } else {
    let list = createListNode(listType: type, start: start)
    try list.append([item])
    _ = try paragraph.replace(replaceWith: list)
  }
  _ = try item.selectStart()
}

public final class MarkdownShortcutPlugin: Plugin {
  private let blocks: [BlockShortcut]
  private let formats: [(TextFormatType, String)]
  private var removeTransform: (() -> Void)?

  public static let composerFormats: [(TextFormatType, String)] = [(.bold, "**"), (.italic, "*"), (.code, "`"), (.strikethrough, "~~")]

  public init(blocks: [BlockShortcut] = BlockShortcut.composer, formats: [(TextFormatType, String)] = MarkdownShortcutPlugin.composerFormats) {
    self.blocks = blocks
    self.formats = formats.sorted { $0.1.count > $1.1.count }
  }

  public func setUp(editor: Editor) {
    removeTransform = editor.addNodeTransform(nodeType: .text) { [weak self, weak editor] node in
      guard let self, let editor else { return }
      try self.transform(node, editor: editor)
    }
  }

  public func tearDown() {
    removeTransform?()
    removeTransform = nil
  }

  private func transform(_ node: Node, editor: Editor) throws {
    guard !editor.isComposing(), let text = node as? TextNode, text.isSimpleText(), !text.getFormat().code,
      let selection = try getSelection() as? RangeSelection, selection.isCollapsed(),
      selection.anchor.type == .text, selection.anchor.key == text.key,
      let previous = editor.getEditorState().selection as? RangeSelection,
      let parent = text.getParent(), !(parent is CodeNode)
    else { return }
    let offset = selection.anchor.offset
    guard offset == 1 || offset <= previous.anchor.offset + 1 else { return }
    if try runBlocks(parent, text, offset) { return }
    _ = try runFormats(text, offset)
  }

  private func runBlocks(_ parent: ElementNode, _ text: TextNode, _ offset: Int) throws -> Bool {
    guard parent.getParent() is RootNode, parent is ParagraphNode, parent.getFirstChild()?.key == text.key else { return false }
    let content = text.getTextContent() as NSString
    guard offset >= 1, offset <= content.length, content.substring(with: NSRange(location: offset - 1, length: 1)) == " " else { return false }
    for block in blocks {
      guard let regex = try? NSRegularExpression(pattern: block.pattern),
        let match = regex.firstMatch(in: content as String, range: NSRange(location: 0, length: content.length))
      else { continue }
      let matched = content.substring(with: match.range)
      let expectedLength = matched.hasSuffix(" ") ? offset : offset - 1
      guard (matched as NSString).length == expectedLength else { continue }
      let groups = (0..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? "" : content.substring(with: match.range(at: $0)) }
      let parts = try text.splitText(splitOffsets: [offset])
      let remainder = Array(parts.dropFirst()) + (parts.last?.getNextSiblings() ?? [])
      try block.replace(parent, remainder, groups)
      try parts.first?.remove()
      return true
    }
    return false
  }

  // ponytail: looks for the opening tag only in the node being typed into; web Lexical also walks earlier text siblings.
  private func runFormats(_ text: TextNode, _ offset: Int) throws -> Bool {
    let content = text.getTextContent() as NSString
    guard offset >= 1, offset <= content.length else { return false }
    let closeEnd = offset - 1
    let closeChar = content.substring(with: NSRange(location: closeEnd, length: 1))
    for (format, tag) in formats where tag.hasSuffix(closeChar) {
      let tagLength = (tag as NSString).length
      let closeStart = closeEnd - tagLength + 1
      guard closeStart >= 1, content.substring(with: NSRange(location: closeStart, length: tagLength)) == tag,
        content.substring(with: NSRange(location: closeStart - 1, length: 1)) != " ",
        let openStart = openTagStart(content, before: closeStart, tag: tag),
        openStart + tagLength != closeStart
      else { continue }
      if openStart > 0, content.substring(with: NSRange(location: openStart - 1, length: 1)) == closeChar { continue }

      let baseFormat = text.getFormat()
      let inner = content.substring(with: NSRange(location: openStart + tagLength, length: closeStart - openStart - tagLength))
      let before = content.substring(to: openStart)
      let after = content.substring(from: closeEnd + 1)
      try text.setText(before + inner + after)
      let innerStart = (before as NSString).length
      let innerLength = (inner as NSString).length
      let total = innerStart + innerLength + (after as NSString).length
      let parts = try text.splitText(splitOffsets: [innerStart, innerStart + innerLength].filter { $0 > 0 && $0 < total })
      let target = parts[innerStart > 0 ? 1 : 0]
      var textFormat = baseFormat
      textFormat.updateFormat(type: format, value: true)
      _ = try target.setFormat(format: textFormat)
      let caret = try target.select(anchorOffset: innerLength, focusOffset: innerLength)
      caret.format = baseFormat
      return true
    }
    return false
  }
}

private func openTagStart(_ content: NSString, before maxIndex: Int, tag: String) -> Int? {
  let tagLength = (tag as NSString).length
  var index = maxIndex
  while index >= tagLength {
    let start = index - tagLength
    let afterTag = start + tagLength < content.length ? content.substring(with: NSRange(location: start + tagLength, length: 1)) : ""
    if content.substring(with: NSRange(location: start, length: tagLength)) == tag && afterTag != " " {
      return start
    }
    index -= 1
  }
  return nil
}
