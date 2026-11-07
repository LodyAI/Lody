import MarkdownParser
import MarkdownView
import UIKit

// NSCache is thread-safe and each parse builds its own parser, so the cache is shared
// between the main actor and the preparation queue without a lock.
final class ChatParseCache: @unchecked Sendable {
  private final class Box {
    let result: MarkdownParser.ParseResult
    init(_ result: MarkdownParser.ParseResult) { self.result = result }
  }
  private let cache = NSCache<NSString, Box>()
  init() {
    cache.countLimit = 256
    cache.totalCostLimit = 8 * 1024 * 1024
  }

  func parse(_ text: String, streaming: Bool = false) -> MarkdownParser.ParseResult {
    let key = "\(streaming)\u{0}\(text)" as NSString
    if let cached = cache.object(forKey: key) { return cached.result }
    // ponytail: full background parsing preserves late reference/math changes;
    // incremental source parsing needs parser-owned invalidation if it dominates.
    let source = streaming ? ChatMarkdownRepair.shared.repair(text) : text
    let result = MarkdownParser().parse(source)
    cache.setObject(Box(result), forKey: key, cost: text.utf8.count)
    return result
  }
}

/// Cached blocks and heights outlive the bounded view pool. Visible rows use the
/// same view that measured them, including the active streaming row.
@MainActor
final class ChatMarkdownStore {
  private struct Entry {
    let text: String
    let secondary: Bool
    let streaming: Bool
    let context: MarkdownContent
    let math: [Int: String]
    let blocks: [ChatMarkdownBlock]
  }
  private struct Height {
    let text: String
    let secondary: Bool
    let streaming: Bool
    let width: CGFloat
    let height: CGFloat
  }
  private static let sizingLimit = 24

  private(set) var updateCount = 0
  var nonAnimatedRows: Set<String> = []
  let parser = ChatParseCache()
  private var entries: [String: Entry] = [:]
  private var views: [String: ChatMarkdownView] = [:]
  private var heights: [String: Height] = [:]
  private var recent: [String] = []
  private(set) var theme: MarkdownTheme
  private(set) var secondaryTheme: MarkdownTheme

  init(traits: UITraitCollection) {
    theme = ChatMarkdownTheme.make(traits: traits, secondary: false)
    secondaryTheme = ChatMarkdownTheme.make(traits: traits, secondary: true)
  }

  func theme(secondary: Bool) -> MarkdownTheme { secondary ? secondaryTheme : theme }

  func tailFrame(id: String) -> CGRect? {
    guard let markdown = views[id], let frame = markdown.tailFrame else { return nil }
    return frame.offsetBy(dx: markdown.frame.minX, dy: markdown.frame.minY)
  }

  func tailLength(id: String) -> Int { views[id]?.tailLength ?? 0 }
  func isAnimating(id: String) -> Bool { views[id]?.isAnimating == true }

  func apply(traits: UITraitCollection) {
    theme = ChatMarkdownTheme.make(traits: traits, secondary: false)
    secondaryTheme = ChatMarkdownTheme.make(traits: traits, secondary: true)
    entries.removeAll()
    heights.removeAll()
    views.removeAll()
    recent.removeAll()
  }

  private func blocks(id: String, text: String, secondary: Bool, streaming: Bool) -> [ChatMarkdownBlock] {
    let previous = entries[id]
    if let previous, previous.text == text, previous.secondary == secondary, previous.streaming == streaming { return previous.blocks }
    updateCount += 1
    let parsed = parser.parse(text, streaming: streaming)
    let sameContext = previous?.secondary == secondary && previous?.math == parsed.mathContext
    let rendered = sameContext ? previous!.context.rendered : parsed.renderedContent(theme: theme(secondary: secondary))
    let context = MarkdownContent(blocks: parsed.document, rendered: rendered,
      highlightMaps: parsed.highlightMaps(theme: theme(secondary: secondary)))
    let blocks: [ChatMarkdownBlock]
    if !streaming, let first = parsed.document.first {
      // Completed messages keep one native selection range across paragraphs.
      blocks = [ChatMarkdownBlock(node: first, content: FileMarkdownView.content(context))]
    } else {
      blocks = parsed.document.enumerated().map { index, node -> ChatMarkdownBlock in
        if sameContext, let previous, previous.streaming == streaming,
           index < previous.blocks.count, previous.blocks[index].node == node {
          return previous.blocks[index]
        }
        let content = MarkdownContent(blocks: [node], rendered: context.rendered, highlightMaps: context.highlightMaps)
        return ChatMarkdownBlock(node: node, content: FileMarkdownView.content(content, streaming: streaming))
      }
    }
    entries[id] = Entry(text: text, secondary: secondary, streaming: streaming, context: context, math: parsed.mathContext, blocks: blocks)
    return blocks
  }

  func view(id: String, text: String, secondary: Bool, streaming: Bool, width: CGFloat) -> ChatMarkdownView {
    let view = views[id] ?? ChatMarkdownView()
    views[id] = view
    view.update(blocks(id: id, text: text, secondary: secondary, streaming: streaming), theme: theme(secondary: secondary), streaming: streaming, width: width, animateChanges: !nonAnimatedRows.contains(id))
    heights[id] = Height(text: text, secondary: secondary, streaming: streaming, width: max(1, width), height: view.measuredHeight)
    recent.removeAll { $0 == id }
    recent.append(id)
    // Do not evict a view still attached to a cell: sizing must not create a
    // second copy of that row. Offscreen views remain bounded by the pool.
    while recent.count > Self.sizingLimit,
          let index = recent.firstIndex(where: { $0 != id && views[$0]?.superview == nil }) {
      views[recent.remove(at: index)] = nil
    }
    return view
  }

  // Flow layout asks every row for its size on each invalidation; only a
  // changed row may touch the bounded sizing pool.
  func height(id: String, text: String, secondary: Bool, streaming: Bool, width: CGFloat) -> CGFloat {
    let width = max(1, width)
    if let cached = heights[id], cached.text == text, cached.secondary == secondary, cached.streaming == streaming, cached.width == width {
      return cached.height
    }
    return view(id: id, text: text, secondary: secondary, streaming: streaming, width: width).measuredHeight
  }

  func retain(_ ids: Set<String>) {
    // Diffable deletion can leave the old cell in UIKit's reuse pool. Retire
    // selection with the row, including the table's independently owned group.
    for (id, view) in views where !ids.contains(id) { view.clearSelection() }
    entries = entries.filter { ids.contains($0.key) }
    heights = heights.filter { ids.contains($0.key) }
    views = views.filter { ids.contains($0.key) }
    recent.removeAll { !ids.contains($0) }
  }
}
