import Foundation
import Lexical

public struct TypeaheadQuery: Equatable, Sendable {
  public let text: String
  public let isFirstInDocument: Bool

  public init(text: String, isFirstInDocument: Bool) {
    self.text = text
    self.isFirstInDocument = isFirstInDocument
  }
}

public struct TypeaheadMatch: Equatable, Sendable {
  public let leadOffset: Int
  public let matchingString: String
  public let replaceableString: String

  public init(leadOffset: Int, matchingString: String, replaceableString: String) {
    self.leadOffset = leadOffset
    self.matchingString = matchingString
    self.replaceableString = replaceableString
  }
}

public typealias TypeaheadTrigger = (TypeaheadQuery) -> TypeaheadMatch?

public let typeaheadPunctuation = #"\.,\+\*\?\$\@\|#{}\(\)\^\-\[\]\\/!%'"~=<>_:;"#

public func basicTypeaheadTrigger(
  _ trigger: String,
  minLength: Int = 1,
  maxLength: Int = 75,
  punctuation: String = typeaheadPunctuation,
  allowWhitespace: Bool = false
) -> TypeaheadTrigger {
  let validChars = "[^" + trigger + punctuation + (allowWhitespace ? "" : #"\s"#) + "]"
  let pattern = #"(^|\s|\()("# + "[" + trigger + "]" + "((?:" + validChars + "){0," + String(maxLength) + "})" + ")$"
  let regex = try? NSRegularExpression(pattern: pattern)
  return { query in
    let text = query.text as NSString
    guard let regex, let match = regex.firstMatch(in: query.text, range: NSRange(location: 0, length: text.length)) else { return nil }
    let matchingString = text.substring(with: match.range(at: 3))
    guard (matchingString as NSString).length >= minLength else { return nil }
    return TypeaheadMatch(
      leadOffset: match.range.location + match.range(at: 1).length,
      matchingString: matchingString,
      replaceableString: text.substring(with: match.range(at: 2)))
  }
}

public final class TypeaheadPlugin: Plugin {
  public private(set) var match: TypeaheadMatch?
  private let trigger: TypeaheadTrigger
  private let onChange: (TypeaheadMatch?) -> Void
  private weak var editor: Editor?
  private var removeListener: (() -> Void)?

  public init(trigger: @escaping TypeaheadTrigger, onChange: @escaping (TypeaheadMatch?) -> Void) {
    self.trigger = trigger
    self.onChange = onChange
  }

  public func setUp(editor: Editor) {
    self.editor = editor
    removeListener = editor.registerUpdateListener { [weak self] state, _, _ in
      self?.refresh(state)
    }
  }

  public func tearDown() {
    removeListener?()
    removeListener = nil
  }

  public func replaceMatch(with makeNodes: () throws -> [Node]) throws {
    guard let match, let editor else { return }
    try editor.update {
      let nodes = try makeNodes()
      guard let first = nodes.first, let queryNode = try splitNodeContainingQuery(match) else { return }
      _ = try queryNode.replace(replaceWith: first)
      var previous: Node = first
      for node in nodes.dropFirst() {
        previous = try previous.insertAfter(nodeToInsert: node)
      }
      if let text = previous as? TextNode {
        let end = text.getTextContentSize()
        _ = try text.select(anchorOffset: end, focusOffset: end)
      } else {
        _ = try previous.selectNext(anchorOffset: 0, focusOffset: 0)
      }
    }
  }

  private func refresh(_ state: EditorState) {
    var query: TypeaheadQuery?
    try? state.read { query = try currentQuery() }
    let next = query.flatMap(trigger)
    guard next != match else { return }
    match = next
    onChange(next)
  }
}

private func anchorTextNode() throws -> (TextNode, Int)? {
  guard let selection = try getSelection() as? RangeSelection, selection.isCollapsed(), selection.anchor.type == .text,
    let node = try selection.anchor.getNode() as? TextNode, node.isSimpleText()
  else { return nil }
  return (node, selection.anchor.offset)
}

private func currentQuery() throws -> TypeaheadQuery? {
  guard let (node, offset) = try anchorTextNode() else { return nil }
  let text = (node.getTextContent() as NSString).substring(to: min(offset, node.getTextContentSize()))
  let block = node.getParent()
  let isFirst = node.getPreviousSibling() == nil && block?.getPreviousSibling() == nil && block?.getParent() is RootNode
  return TypeaheadQuery(text: text, isFirstInDocument: isFirst)
}

private func fullMatchOffset(_ documentText: String, _ entryText: String, _ offset: Int) -> Int {
  let document = documentText as NSString
  let entry = entryText as NSString
  var triggerOffset = offset
  if offset <= entry.length {
    for length in offset...entry.length where length <= document.length {
      if document.substring(from: document.length - length) == entry.substring(to: length) {
        triggerOffset = length
      }
    }
  }
  return triggerOffset
}

private func splitNodeContainingQuery(_ match: TypeaheadMatch) throws -> TextNode? {
  guard let (node, selectionOffset) = try anchorTextNode() else { return nil }
  let text = (node.getTextContent() as NSString).substring(to: min(selectionOffset, node.getTextContentSize()))
  let queryOffset = fullMatchOffset(text, match.matchingString, (match.replaceableString as NSString).length)
  let startOffset = selectionOffset - queryOffset
  guard startOffset >= 0 else { return nil }
  if startOffset == 0 {
    return try node.splitText(splitOffsets: [selectionOffset]).first
  }
  let parts = try node.splitText(splitOffsets: [startOffset, selectionOffset])
  return parts.count > 1 ? parts[1] : nil
}
