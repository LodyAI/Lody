import Foundation
import Lexical
import LexicalMarkdown

public struct RichPaste: Sendable {
  public let html: HTMLImport
  public let markdown: MarkdownImporter
  public let exporter: MarkdownExporter

  public static let maxHTMLBytes = 2 * 1024 * 1024
  public static let maxNodes = 5000

  public static let gfm = RichPaste(html: .gfm, markdown: .gfm, exporter: .gfm)

  public init(html: HTMLImport, markdown: MarkdownImporter, exporter: MarkdownExporter) {
    self.html = html
    self.markdown = markdown
    self.exporter = exporter
  }

  public struct Trial: Sendable {
    public let source: PasteKind
    public let nodes: Data
    public let markdown: String
    public let plainText: String?
  }

  public enum PasteError: Error {
    case nothingToPaste
    case noSelection
  }

  // Runs on a headless peer so the target editor is untouched until insert(_:into:).
  public func trial(_ sources: [PasteSource], for editor: Editor) throws -> Trial {
    let registrations = editor.registeredNodeTypes
    let hasPlainText = sources.contains { $0.kind == .plain && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    for source in sources {
      if source.kind == .html && source.text.utf8.count > Self.maxHTMLBytes { continue }
      let peer = Editor.createHeadless(editorConfig: EditorConfig(theme: Theme(), plugins: []))
      for (type, klass) in registrations where peer.registeredNodeTypes[type] == nil {
        try? peer.registerNode(nodeType: type, class: klass)
      }
      guard let trial = try? makeTrial(source, in: peer) else { continue }
      if source.kind != .plain && hasPlainText && trial.markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
      return trial
    }
    throw PasteError.nothingToPaste
  }

  private func makeTrial(_ source: PasteSource, in peer: Editor) throws -> Trial? {
    var result: Trial?
    try peer.update {
      guard let root = getRoot() else { return }
      let nodes: [Node]
      switch source.kind {
      case .html: nodes = try generateNodes(fromHTML: source.text, using: html)
      case .markdown: nodes = try markdown.generateNodes(source.text)
      case .plain: nodes = try plainTextNodes(source.text)
      }
      guard !nodes.isEmpty, source.kind == .plain || count(nodes) <= Self.maxNodes else { return }
      try flattenNestedCode(nodes)
      let encoded = try JSONEncoder().encode(nodes)
      try root.getChildren().forEach { try $0.remove() }
      try root.append(wrapInlines(nodes))
      let plain = source.kind == .plain ? source.text.replacingOccurrences(of: "\r\n", with: "\n") : nil
      result = Trial(source: source.kind, nodes: encoded, markdown: exporter.export(root), plainText: plain)
    }
    return result
  }

  public func insert(_ trial: Trial, into editor: Editor) throws {
    try editor.update {
      guard let selection = try getSelection() as? RangeSelection else { throw PasteError.noSelection }
      // Plain text keeps the caret's block and format, so lines stay inside code blocks and list items.
      if let plainText = trial.plainText {
        try selection.insertText(plainText)
        return
      }
      let nodes = try JSONDecoder().decode(SerializedNodeArray.self, from: trial.nodes).nodeArray
      if nodes.allSatisfy(isInline) {
        _ = try selection.insertNodes(nodes: nodes, selectStart: false)
      } else {
        try insertGeneratedNodes(editor: editor, nodes: nodes, selection: selection)
      }
    }
  }

  public func prefersPlainText(in editor: Editor) throws -> Bool {
    var inCode = false
    try editor.read {
      guard let selection = try getSelection() as? RangeSelection, let node = try? selection.anchor.getNode() else { return }
      if let text = node as? TextNode, text.getFormat().code {
        inCode = true
        return
      }
      var current: Node? = node
      while let candidate = current {
        if candidate is CodeNode {
          inCode = true
          return
        }
        current = candidate.getParent()
      }
    }
    return inCode
  }
}

private func isInline(_ node: Node) -> Bool {
  if let element = node as? ElementNode { return element.isInline() }
  return node is TextNode || node is LineBreakNode
}

private func plainTextNodes(_ text: String) throws -> [Node] {
  let lines = text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
  if lines.count == 1 { return [createTextNode(text: text)] }
  return try lines.map { line in
    let paragraph = createParagraphNode()
    if !line.isEmpty { try paragraph.append([createTextNode(text: line)]) }
    return paragraph
  }
}

private func count(_ nodes: [Node]) -> Int {
  var total = 0
  var stack = nodes
  while let node = stack.popLast() {
    total += 1
    if let element = node as? ElementNode { stack += element.getChildren() }
  }
  return total
}

private func flattenNestedCode(_ nodes: [Node]) throws {
  var stack = nodes
  while let node = stack.popLast() {
    guard let element = node as? ElementNode else { continue }
    for child in element.getChildren() {
      if element is CodeNode, let inner = child as? CodeNode {
        for grandchild in inner.getChildren() { _ = try inner.insertBefore(nodeToInsert: grandchild) }
        try inner.remove()
      } else {
        stack.append(child)
      }
    }
  }
}

private func wrapInlines(_ nodes: [Node]) throws -> [Node] {
  var blocks: [Node] = []
  var current: ParagraphNode?
  for node in nodes {
    if isInline(node) {
      if current == nil {
        let paragraph = createParagraphNode()
        blocks.append(paragraph)
        current = paragraph
      }
      try current?.append([node])
    } else {
      blocks.append(node)
      current = nil
    }
  }
  return blocks
}
