import Foundation
import Lexical
import LexicalLinkPlugin
import LexicalListPlugin
import LexicalMarkdown

extension HTMLImport {
  public static let gfm = HTMLImport(conversions: [
    "#text": [always(convertText)],
    "b": [always(convertBold)],
    "code": [always(convertTextFormat), convertMultilineCode],
    "em": [always(convertTextFormat)],
    "i": [always(convertTextFormat)],
    "mark": [always(convertTextFormat)],
    "s": [always(convertTextFormat)],
    "del": [always(convertTextFormat)],
    "strong": [always(convertTextFormat)],
    "sub": [always(convertTextFormat)],
    "sup": [always(convertTextFormat)],
    "u": [always(convertTextFormat)],
    "span": [always(convertSpan), googleDocsTitleSpan],
    "p": [always(convertParagraph), googleDocsTitleParagraph],
    "br": [convertLineBreak],
    "h1": [always(convertHeading)], "h2": [always(convertHeading)], "h3": [always(convertHeading)],
    "h4": [always(convertHeading)], "h5": [always(convertHeading)], "h6": [always(convertHeading)],
    "blockquote": [always { _ in DOMConversionOutput(node: createQuoteNode()) }],
    "ol": [always(convertList)],
    "ul": [always(convertList)],
    "li": [always(convertListItem)],
    "a": [always(priority: 1, convertAnchor)],
    "pre": [always { node in DOMConversionOutput(node: createCodeNode(language: node.attributes["data-language"] ?? "")) }],
    "div": [always(priority: 1, convertCodeDiv)],
    "table": [gitHubCodeTable, always(convertTableFallback)],
    "td": [gitHubCodeNoop],
    "tr": [gitHubCodeNoop],
    "img": [always(convertImageFallback)],
    "hr": [always { _ in DOMConversionOutput(node: paragraph("***")) }],
  ])
}

private func always(priority: Int = 0, _ conversion: @escaping @Sendable (DOMNode) throws -> DOMConversionOutput) -> DOMConversionMatcher {
  { _ in DOMConversion(priority: priority, conversion) }
}

private func paragraph(_ text: String) -> ParagraphNode {
  let paragraph = createParagraphNode()
  try? paragraph.append([createTextNode(text: text)])
  return paragraph
}

private let textFormats: [String: TextFormatType] = [
  "CODE": .code, "EM": .italic, "I": .italic, "MARK": .highlight, "S": .strikethrough, "DEL": .strikethrough,
  "STRONG": .bold, "SUB": .subScript, "SUP": .superScript, "U": .underline,
]

private func convertTextFormat(_ node: DOMNode) -> DOMConversionOutput {
  guard let format = textFormats[node.name] else { return DOMConversionOutput() }
  return DOMConversionOutput(forChild: formatFromStyle(node, applying: format))
}

// Google Docs wraps every copied fragment in <b style="font-weight:normal">.
private func convertBold(_ node: DOMNode) -> DOMConversionOutput {
  DOMConversionOutput(forChild: formatFromStyle(node, applying: node.style("font-weight") == "normal" ? nil : .bold))
}

private func convertSpan(_ node: DOMNode) -> DOMConversionOutput {
  DOMConversionOutput(forChild: formatFromStyle(node, applying: nil))
}

private func formatFromStyle(_ node: DOMNode, applying extra: TextFormatType?) -> (Node, Node?) throws -> Node? {
  let weight = node.style("font-weight")
  let decoration = node.style("text-decoration").split(separator: " ")
  var formats: [TextFormatType] = []
  if weight == "700" || weight == "bold" { formats.append(.bold) }
  if decoration.contains("line-through") { formats.append(.strikethrough) }
  if node.style("font-style") == "italic" { formats.append(.italic) }
  if decoration.contains("underline") { formats.append(.underline) }
  if node.style("vertical-align") == "sub" { formats.append(.subScript) }
  if node.style("vertical-align") == "super" { formats.append(.superScript) }
  if let extra { formats.append(extra) }
  return { lexicalNode, _ in
    guard let text = lexicalNode as? TextNode else { return lexicalNode }
    var format = text.getFormat()
    for type in formats { format.updateFormat(type: type, value: true) }
    return try text.setFormat(format: format)
  }
}

private func convertText(_ node: DOMNode) -> DOMConversionOutput {
  if hasPreAncestor(node) {
    return DOMConversionOutput(nodes: rawTextNodes(node.text))
  }
  var text = node.text.replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: #"[ \t\n]+"#, with: " ", options: .regularExpression)
  guard !text.isEmpty else { return DOMConversionOutput() }
  if text.hasPrefix(" ") {
    var isStartOfLine = true
    var previous: DOMNode? = node
    while let current = previous, let found = textInLine(from: current, forward: false) {
      previous = found
      guard !inlineText(found).isEmpty else { continue }
      if let last = inlineText(found).last, " \t\n".contains(last) { text.removeFirst() }
      isStartOfLine = false
      break
    }
    if isStartOfLine { text.removeFirst() }
  }
  if text.hasSuffix(" ") {
    var isEndOfLine = true
    var next: DOMNode? = node
    while let current = next, let found = textInLine(from: current, forward: true) {
      next = found
      if !inlineText(found).replacingOccurrences(of: #"^( |\t|\r?\n)+"#, with: "", options: .regularExpression).isEmpty {
        isEndOfLine = false
        break
      }
    }
    if isEndOfLine { text.removeLast() }
  }
  guard !text.isEmpty else { return DOMConversionOutput() }
  return DOMConversionOutput(node: createTextNode(text: text))
}

private func textInLine(from start: DOMNode, forward: Bool) -> DOMNode? {
  var node = start
  while true {
    var sibling = forward ? node.nextSibling : node.previousSibling
    while sibling == nil {
      guard let parent = node.parent else { return nil }
      node = parent
      sibling = forward ? node.nextSibling : node.previousSibling
    }
    node = sibling!
    if node.isElement {
      let display = node.style("display")
      if (display.isEmpty && !isInlineDOMNode(node)) || (!display.isEmpty && !display.hasPrefix("inline")) { return nil }
    }
    while let descendant = forward ? node.firstChild : node.lastChild { node = descendant }
    if node.isText || node.name == "IMG" { return node }
    if node.name == "BR" { return nil }
  }
}

private func inlineText(_ node: DOMNode) -> String {
  node.isText ? node.text : (node.attributes["alt"] ?? "")
}

private func isPre(_ node: DOMNode) -> Bool {
  node.name == "PRE" || node.style("white-space").hasPrefix("pre")
}

private func hasPreAncestor(_ node: DOMNode) -> Bool {
  var parent = node.parent
  while let current = parent {
    if isPre(current) { return true }
    parent = current.parent
  }
  return false
}

private func rawTextNodes(_ text: String) -> [Node] {
  var nodes: [Node] = []
  var part = ""
  func flush() {
    if !part.isEmpty { nodes.append(createTextNode(text: part)) }
    part = ""
  }
  for character in text {
    switch character {
    case "\n", "\r\n":
      flush()
      nodes.append(createLineBreakNode())
    case "\t":
      flush()
      nodes.append(TabNode())
    default:
      part.append(character)
    }
  }
  flush()
  return nodes
}

private func convertParagraph(_ node: DOMNode) -> DOMConversionOutput {
  DOMConversionOutput(node: createParagraphNode())
}

private func isGoogleDocsTitle(_ node: DOMNode) -> Bool {
  node.name == "SPAN" && node.style("font-size") == "26pt"
}

private let googleDocsTitleSpan: DOMConversionMatcher = { node in
  isGoogleDocsTitle(node) ? DOMConversion(priority: 3) { _ in DOMConversionOutput(node: createHeadingNode(headingTag: .h1)) } : nil
}

private let googleDocsTitleParagraph: DOMConversionMatcher = { node in
  guard let first = node.firstChild, isGoogleDocsTitle(first) else { return nil }
  return DOMConversion(priority: 3) { _ in DOMConversionOutput() }
}

private func isWhitespaceText(_ node: DOMNode?) -> Bool {
  guard let node, node.isText else { return false }
  return node.text.range(of: #"^( |\t|\r?\n)+$"#, options: .regularExpression) != nil
}

private func isLastInBlock(_ node: DOMNode, _ parent: DOMNode) -> Bool {
  guard let last = parent.lastChild else { return false }
  return last === node || (last.previousSibling === node && isWhitespaceText(last))
}

private let convertLineBreak: DOMConversionMatcher = { node in
  if let parent = node.parent, isBlockDOMNode(parent), isLastInBlock(node, parent) {
    return nil
  }
  return DOMConversion { _ in DOMConversionOutput(node: createLineBreakNode()) }
}

private func convertHeading(_ node: DOMNode) -> DOMConversionOutput {
  let tags: [String: HeadingTagType] = ["H1": .h1, "H2": .h2, "H3": .h3, "H4": .h4, "H5": .h5, "H6": .h6]
  return DOMConversionOutput(node: tags[node.name].map { createHeadingNode(headingTag: $0) })
}

private func isChecklist(_ node: DOMNode) -> Bool {
  if node.attributes["__lexicallisttype"] == "check" || node.classList.contains("contains-task-list") || node.attributes["data-is-checklist"] == "1" {
    return true
  }
  return node.children.contains { $0.isElement && $0.attributes["aria-checked"] != nil }
}

private func convertList(_ node: DOMNode) -> DOMConversionOutput {
  let list: ListNode
  if node.name == "OL" {
    list = createListNode(listType: .number, start: clampedListStart(node.attributes["start"] ?? "") ?? 1)
  } else if isChecklist(node) {
    list = createListNode(listType: .check)
  } else {
    list = createListNode(listType: .bullet)
  }
  return DOMConversionOutput(nodes: [list], after: { children in
    var items: [Node] = []
    for child in children {
      if let item = child as? ListItemNode {
        items.append(item)
        let grandchildren = item.getChildren()
        if grandchildren.count > 1 {
          for nested in grandchildren where nested is ListNode {
            let wrapper = ListItemNode()
            try wrapper.append([nested])
            items.append(wrapper)
          }
        }
      } else {
        let wrapper = ListItemNode()
        try wrapper.append([child])
        items.append(wrapper)
      }
    }
    return items
  })
}

private func listItem(checked: Bool?) throws -> ListItemNode {
  let item = ListItemNode()
  if let checked { try item.setChecked(checked) }
  return item
}

private func convertListItem(_ node: DOMNode) throws -> DOMConversionOutput {
  if node.classList.contains("task-list-item"), let input = node.children.first(where: { $0.name == "INPUT" }) {
    return try checkboxItem(input)
  }
  if node.classList.contains("joplin-checkbox"),
    let wrapper = node.children.first(where: { $0.classList.contains("checkbox-wrapper") }),
    let input = wrapper.children.first(where: \.isElement), input.name == "INPUT"
  {
    return try checkboxItem(input)
  }
  let checked: Bool?
  switch node.attributes["aria-checked"] {
  case "true": checked = true
  case "false": checked = false
  default: checked = nil
  }
  return DOMConversionOutput(nodes: [try listItem(checked: checked)], after: mergeIntoListItem)
}

// Web ListItemNode.append merges paragraph and list item children into the item itself.
private func mergeIntoListItem(_ children: [Node]) -> [Node] {
  children.flatMap { child -> [Node] in
    guard child is ParagraphNode || child is ListItemNode, let element = child as? ElementNode else { return [child] }
    return element.getChildren()
  }
}

private func checkboxItem(_ input: DOMNode) throws -> DOMConversionOutput {
  guard input.attributes["type"] == "checkbox" else { return DOMConversionOutput() }
  return DOMConversionOutput(nodes: [try listItem(checked: input.attributes["checked"] != nil)], after: mergeIntoListItem)
}

private let allowedLinkSchemes: Set<String> = ["http", "https", "mailto"]

private func convertAnchor(_ node: DOMNode) -> DOMConversionOutput {
  guard !node.textContent.isEmpty || node.children.contains(where: \.isElement) else { return DOMConversionOutput() }
  let href = node.attributes["href"] ?? ""
  guard let scheme = URL(string: href)?.scheme?.lowercased(), allowedLinkSchemes.contains(scheme) else { return DOMConversionOutput() }
  let link = LinkNode(url: href, key: nil)
  link.rel = node.attributes["rel"]
  link.target = node.attributes["target"]
  link.title = node.attributes["title"]
  return DOMConversionOutput(node: link)
}

private func hasDescendant(_ node: DOMNode, named name: String) -> Bool {
  var stack = node.children
  while let current = stack.popLast() {
    if current.name == name { return true }
    stack += current.children
  }
  return false
}

private let convertMultilineCode: DOMConversionMatcher = { node in
  guard node.textContent.contains("\n") || hasDescendant(node, named: "BR") else { return nil }
  return DOMConversion(priority: 1) { node in DOMConversionOutput(node: createCodeNode(language: node.attributes["data-language"] ?? "")) }
}

private func isCodeElement(_ node: DOMNode) -> Bool {
  node.style("font-family").contains("monospace")
}

private func convertCodeDiv(_ node: DOMNode) -> DOMConversionOutput {
  isCodeElement(node) ? DOMConversionOutput(node: createCodeNode()) : DOMConversionOutput()
}

private func isGitHubCodeTable(_ node: DOMNode?) -> Bool {
  node?.classList.contains("js-file-line-container") == true
}

private func closestTable(_ node: DOMNode) -> DOMNode? {
  var parent = node.parent
  while let current = parent {
    if current.name == "TABLE" { return current }
    parent = current.parent
  }
  return nil
}

private let gitHubCodeTable: DOMConversionMatcher = { node in
  isGitHubCodeTable(node) ? DOMConversion(priority: 3) { _ in DOMConversionOutput(node: createCodeNode()) } : nil
}

private let gitHubCodeNoop: DOMConversionMatcher = { node in
  guard node.classList.contains("js-file-line") || isGitHubCodeTable(closestTable(node)) else { return nil }
  return DOMConversion(priority: 3) { _ in DOMConversionOutput() }
}

private func convertTableFallback(_ node: DOMNode) -> DOMConversionOutput {
  var rows: [[String]] = []
  var stack: [DOMNode] = [node]
  while let current = stack.popLast() {
    if current.name == "TR" {
      rows.append(current.children.filter { $0.name == "TD" || $0.name == "TH" }.map(cellText))
    } else if current.name != "TABLE" || current === node {
      stack += current.children.reversed()
    }
  }
  guard let header = rows.first else { return DOMConversionOutput(consumesChildren: true) }
  let width = rows.map(\.count).max() ?? header.count
  func line(_ cells: [String]) -> String {
    "| " + (cells + Array(repeating: "", count: width - cells.count)).joined(separator: " | ") + " |"
  }
  var lines = [line(header), line(Array(repeating: "---", count: width))]
  lines += rows.dropFirst().map(line)
  return DOMConversionOutput(nodes: lines.map(paragraph), consumesChildren: true)
}

private func cellText(_ cell: DOMNode) -> String {
  cell.textContent
    .replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
    .trimmingCharacters(in: .whitespaces)
    .replacingOccurrences(of: "|", with: "\\|")
}

private func convertImageFallback(_ node: DOMNode) -> DOMConversionOutput {
  guard let alt = node.attributes["alt"]?.trimmingCharacters(in: .whitespacesAndNewlines), !alt.isEmpty else { return DOMConversionOutput() }
  return DOMConversionOutput(node: createTextNode(text: alt))
}
