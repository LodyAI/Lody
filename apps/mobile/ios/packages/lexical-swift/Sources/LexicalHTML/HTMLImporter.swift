import Foundation
import Lexical

public struct DOMConversionOutput {
  public var nodes: [Node]
  public var after: (([Node]) throws -> [Node])?
  public var forChild: ((Node, Node?) throws -> Node?)?
  public var consumesChildren: Bool

  public init(nodes: [Node] = [], after: (([Node]) throws -> [Node])? = nil, forChild: ((Node, Node?) throws -> Node?)? = nil, consumesChildren: Bool = false) {
    self.nodes = nodes
    self.after = after
    self.forChild = forChild
    self.consumesChildren = consumesChildren
  }

  public init(node: Node?) {
    self.init(nodes: node.map { [$0] } ?? [])
  }
}

public struct DOMConversion: Sendable {
  public let priority: Int
  public let conversion: @Sendable (DOMNode) throws -> DOMConversionOutput

  public init(priority: Int = 0, _ conversion: @escaping @Sendable (DOMNode) throws -> DOMConversionOutput) {
    self.priority = priority
    self.conversion = conversion
  }
}

public typealias DOMConversionMatcher = @Sendable (DOMNode) -> DOMConversion?

public struct HTMLImport: Sendable {
  public let conversions: [String: [DOMConversionMatcher]]

  public init(conversions: [String: [DOMConversionMatcher]]) {
    self.conversions = conversions
  }

  public func adding(_ extra: [String: [DOMConversionMatcher]]) -> HTMLImport {
    HTMLImport(conversions: conversions.merging(extra) { $0 + $1 })
  }
}

public func generateNodes(fromHTML html: String, using preset: HTMLImport = .gfm) throws -> [Node] {
  try generateNodes(from: DOMDocument.parse(html: html), using: preset)
}

public func generateNodes(from body: DOMNode, using preset: HTMLImport = .gfm) throws -> [Node] {
  let run = ImportRun(preset: preset)
  var nodes: [Node] = []
  for child in body.children {
    nodes += try run.createNodes(child, hasBlockAncestor: false, forChild: [], parent: nil)
  }
  try run.unwrapArtificialNodes()
  return nodes
}

private final class ArtificialNode: ElementNode {
  override init() {
    super.init()
  }

  override required init(_ key: NodeKey?) {
    super.init(key)
  }

  required init(from decoder: Decoder) throws {
    try super.init(from: decoder)
  }

  override class func getType() -> NodeType {
    NodeType(rawValue: "artificial")
  }

  override func clone() -> Self {
    Self(key)
  }
}

private typealias ChildConversion = (name: String, apply: (Node, Node?) throws -> Node?)

private final class ImportRun {
  let preset: HTMLImport
  var artificialNodes: [ArtificialNode] = []

  init(preset: HTMLImport) {
    self.preset = preset
  }

  func conversion(for node: DOMNode) -> DOMConversion? {
    var current: DOMConversion?
    for matcher in preset.conversions[node.name.lowercased()] ?? [] {
      guard let candidate = matcher(node) else { continue }
      if current == nil || (current?.priority ?? 0) <= candidate.priority {
        current = candidate
      }
    }
    return current
  }

  func createNodes(_ node: DOMNode, hasBlockAncestor: Bool, forChild inherited: [ChildConversion], parent: Node?) throws -> [Node] {
    var lexicalNodes: [Node] = []
    var forChild = inherited
    var currentNode: Node?
    var postTransform: (([Node]) throws -> [Node])?
    var consumesChildren = false

    if let output = try conversion(for: node)?.conversion(node) {
      postTransform = output.after
      consumesChildren = output.consumesChildren
      currentNode = output.nodes.last
      if var current = currentNode {
        var survived = true
        for (_, apply) in forChild {
          guard let next = try apply(current, parent) else {
            survived = false
            break
          }
          current = next
        }
        currentNode = survived ? current : nil
        if survived {
          lexicalNodes += output.nodes.count > 1 ? output.nodes : [current]
        }
      }
      if let childConversion = output.forChild {
        if let index = forChild.firstIndex(where: { $0.name == node.name }) {
          forChild[index].apply = childConversion
        } else {
          forChild.append((node.name, childConversion))
        }
      }
    }

    if consumesChildren { return lexicalNodes }

    let childrenHaveBlockAncestor: Bool
    if let currentNode, currentNode is RootNode {
      childrenHaveBlockAncestor = false
    } else {
      childrenHaveBlockAncestor = isBlockElementNode(currentNode) || hasBlockAncestor
    }

    var childNodes: [Node] = []
    for child in node.children {
      childNodes += try createNodes(child, hasBlockAncestor: childrenHaveBlockAncestor, forChild: forChild, parent: currentNode)
    }
    if let postTransform {
      childNodes = try postTransform(childNodes)
    }

    if isBlockDOMNode(node) {
      if childrenHaveBlockAncestor {
        childNodes = try wrapContinuousInlines(node, childNodes) {
          let artificial = ArtificialNode()
          self.artificialNodes.append(artificial)
          return artificial
        }
      } else {
        childNodes = try wrapContinuousInlines(node, childNodes) { createParagraphNode() }
      }
    }

    if let element = currentNode as? ElementNode {
      try element.append(childNodes)
    } else if currentNode == nil {
      if !childNodes.isEmpty {
        lexicalNodes += childNodes
      } else if isBlockDOMNode(node), isBetweenTwoInlineNodes(node) {
        lexicalNodes.append(createLineBreakNode())
      }
    }
    return lexicalNodes
  }

  func wrapContinuousInlines(_ node: DOMNode, _ nodes: [Node], makeWrapper: () -> ElementNode) throws -> [Node] {
    var output: [Node] = []
    var inlines: [Node] = []
    for (index, child) in nodes.enumerated() {
      if isBlockElementNode(child) {
        output.append(child)
        continue
      }
      inlines.append(child)
      if index == nodes.count - 1 || isBlockElementNode(nodes[index + 1]) {
        let wrapper = makeWrapper()
        try wrapper.append(inlines)
        output.append(wrapper)
        inlines = []
      }
    }
    return output
  }

  func unwrapArtificialNodes() throws {
    for node in artificialNodes where node.getParent() != nil && node.getNextSibling() is ArtificialNode {
      _ = try node.insertAfter(nodeToInsert: createLineBreakNode())
    }
    for node in artificialNodes where node.getParent() != nil {
      for child in node.getChildren() {
        _ = try node.insertBefore(nodeToInsert: child)
      }
      try node.remove()
    }
  }
}

func isBlockElementNode(_ node: Node?) -> Bool {
  guard let element = node as? ElementNode else { return false }
  return !element.isInline()
}

private let blockTags: Set<String> = [
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CANVAS", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM",
  "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "NOSCRIPT", "OL", "P", "PRE", "SECTION", "TABLE", "TD", "TFOOT", "UL", "VIDEO",
]

// IMG is inline here, unlike web Lexical: images import as alt text, so the spaces around them must survive.
private let inlineTags: Set<String> = [
  "IMG", "A", "ABBR", "ACRONYM", "B", "CITE", "CODE", "DEL", "EM", "I", "INS", "KBD", "LABEL", "MARK", "OUTPUT", "Q", "RUBY", "S", "SAMP", "SPAN",
  "STRONG", "SUB", "SUP", "TIME", "U", "TT", "VAR", "#TEXT",
]

func isBlockDOMNode(_ node: DOMNode) -> Bool {
  if node.isElement && node.style("display").hasPrefix("inline") { return false }
  return blockTags.contains(node.name)
}

func isInlineDOMNode(_ node: DOMNode) -> Bool {
  if node.isElement && node.style("display").hasPrefix("inline") { return true }
  return inlineTags.contains(node.name.uppercased())
}

private func isBetweenTwoInlineNodes(_ node: DOMNode) -> Bool {
  guard let next = node.nextSibling, let previous = node.previousSibling else { return false }
  return isInlineDOMNode(next) && isInlineDOMNode(previous)
}
