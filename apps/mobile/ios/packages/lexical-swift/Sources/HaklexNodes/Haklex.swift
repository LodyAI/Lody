import Lexical
import LexicalLinkPlugin
import LexicalListPlugin
import LexicalMarkdown

public enum Haklex {
  public static func plugins() -> [Plugin] {
    [ListPlugin(), LinkPlugin(), HaklexNodesPlugin()]
  }

  public static let markdown = MarkdownExporter(transformers: markdownTransformers, escapesText: true)

  static let markdownTransformers: [MarkdownTransformer] = [
    .textMatch { node, _, _ in
      guard let mention = node as? MentionNode else { return nil }
      let base = "{\(mention.platform)@\(mention.handle)}"
      return mention.displayName.map { "[\($0)]\(base)" } ?? base
    },
    .textFormat(.underline, tag: "++"),
    .textFormat(.superScript, tag: "^"),
    .textFormat(.subScript, tag: "~"),
    .element { node, _ in
      guard let block = node as? CodeBlockNode else { return nil }
      let fence = String(repeating: "`", count: max(3, longestBacktickRun(block.code) + 1))
      return "\(fence)\(block.language)\n\(block.code)\n\(fence)"
    },
    .element { node, _ in node is HorizontalRuleNode ? "---" : nil },
  ] + MarkdownTransformer.standard
}

private func longestBacktickRun(_ content: String) -> Int {
  var longest = 0
  var current = 0
  for character in content {
    current = character == "`" ? current + 1 : 0
    longest = max(longest, current)
  }
  return longest
}

final class HaklexNodesPlugin: Plugin {
  func setUp(editor: Editor) {
    try? editor.registerNode(nodeType: .haklexMention, class: MentionNode.self)
    try? editor.registerNode(nodeType: .haklexCodeBlock, class: CodeBlockNode.self)
    try? editor.registerNode(nodeType: .horizontalRule, class: HorizontalRuleNode.self)
  }

  func tearDown() {}
}
