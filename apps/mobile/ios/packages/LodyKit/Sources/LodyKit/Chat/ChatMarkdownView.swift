import Litext
import MarkdownParser
import MarkdownView
import UIKit

/// Immutable block identity lets unchanged paragraphs keep both their view and
/// CoreText layout. Source is still parsed as one document (reference links and
/// math can change earlier blocks); only unequal blocks get new render content.
final class ChatMarkdownBlock {
  let node: MarkdownBlockNode
  let content: MarkdownContent

  init(node: MarkdownBlockNode, content: MarkdownContent) {
    self.node = node
    self.content = content
  }
}

/// One view serves measurement and display. A growing tail never assigns a new
/// attributed string to the completed blocks above it.
final class ChatMarkdownView: UIView {
  @MainActor
  private final class Block {
    let label = ChatFadeLabelView()
    let view: FileMarkdownView
    var source: ChatMarkdownBlock?
    var width: CGFloat = 0
    var height: CGFloat = 0
    var topSpacing: CGFloat = 0
    var bottomSpacing: CGFloat = 0
    var settle = false
    var fileActions: [UIAccessibilityCustomAction] = []

    init() {
      view = FileMarkdownView(textLabelView: label)
      view.throttleInterval = nil
    }
  }

  var selectionLabels: [TextLabelView] { blocks.map(\.label) }

  func clearSelection() {
    func clear(_ view: UIView) {
      (view as? TextLabelView)?.clearSelection()
      for child in view.subviews { clear(child) }
    }
    clear(self)
  }

  private var blocks: [Block] = []
  private var theme: MarkdownTheme?
  private var measuredWidth: CGFloat = 0
  private(set) var measuredHeight: CGFloat = 0
  var isAnimating: Bool {
    window != nil && !UIAccessibility.isReduceMotionEnabled && blocks.contains {
      $0.label.isFading || $0.view.layer.animation(forKey: "stream-block") != nil
    }
  }
  var onLink: ((String) -> Void)?
  weak var trackedScrollView: UIScrollView? {
    didSet {
      guard trackedScrollView !== oldValue else { return }
      for block in blocks { block.view.trackedScrollView = trackedScrollView }
    }
  }

  // A visible prefix of a long reply does not make its changing block visible.
  var tailFrame: CGRect? { blocks.last?.view.frame }

  func setShine(_ on: Bool) {
    for block in blocks { block.label.setShine(on) }
  }

  func update(_ sources: [ChatMarkdownBlock], theme: MarkdownTheme, streaming: Bool, width: CGFloat, animateChanges: Bool = true) {
    let sameTheme = self.theme == theme
    let animate = animateChanges && window != nil && streaming && !UIAccessibility.isReduceMotionEnabled
    self.theme = theme
    while blocks.count > sources.count { blocks.removeLast().view.removeFromSuperview() }
    for (index, source) in sources.enumerated() {
      if index == blocks.count {
        let block = Block()
        block.view.linkHandler = { [weak self] payload, _, _ in
          switch payload {
          case .url(let url): self?.onLink?(url.absoluteString)
          case .string(let string): self?.onLink?(string)
          }
        }
        block.view.trackedScrollView = trackedScrollView
        blocks.append(block)
        addSubview(block.view)
      }
      let block = blocks[index]
      guard block.source !== source || !sameTheme else { continue }
      let isNew = block.source == nil
      // Only newly inserted complete blocks fade as a whole. Long live text
      // keeps its animated tail; code and tables own separate native labels.
      var blockAnimation = isNew && index < sources.count - 1
      if case .codeBlock = source.node { blockAnimation = true }
      if case .table = source.node { blockAnimation = true }
      block.label.prepare(animate: animate && !blockAnimation, reset: isNew)
      // MarkdownView lays out synchronously inside setContentImmediately, adding
      // fresh code/table views at .zero. Completion folds the reply inside a
      // UIView animation block, which would grow them from the top-left corner.
      UIView.performWithoutAnimation { block.view.setContentImmediately(source.content, theme: theme) }
      if blockAnimation {
        block.label.prepare(animate: false, reset: true)
        block.label.finishAnimation()
      }
      if animate && isNew && blockAnimation {
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0
        fade.toValue = 1
        fade.duration = 0.18
        block.view.layer.add(fade, forKey: "stream-block")
      }
      block.source = source
      block.settle = true
      block.fileActions = block.view.fileActions(source.content)
      block.width = 0
      // CoreText's natural height excludes the final paragraph's spacing.
      // Preserve that spacing between independently measured blocks.
      let text = block.label.attributedText
      block.topSpacing = 0
      block.bottomSpacing = 0
      let string = text.string as NSString
      var end = string.length
      while end > 0 && (string.character(at: end - 1) == 10 || string.character(at: end - 1) == 13) { end -= 1 }
      if end > 0 {
        let first = text.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
        let last = text.attribute(.paragraphStyle, at: end - 1, effectiveRange: nil) as? NSParagraphStyle
        block.topSpacing = first?.paragraphSpacingBefore ?? 0
        block.bottomSpacing = (last?.paragraphSpacing ?? 0) + (last?.lineSpacing ?? 0)
      }
    }
    measure(width: width)
  }

  func measure(width: CGFloat) {
    let width = max(1, width)
    var y: CGFloat = 0
    for (index, block) in blocks.enumerated() {
      if index > 0 { y += block.topSpacing }
      if block.width != width {
        block.height = block.view.boundingSize(for: width).height
        block.width = width
      }
      let frame = CGRect(x: 0, y: y, width: width, height: block.height)
      if block.settle {
        block.settle = false
        UIView.performWithoutAnimation {
          block.view.frame = frame
          block.view.layoutIfNeeded()
        }
      } else if block.view.frame != frame {
        block.view.frame = frame
      }
      y += block.height
      if index < blocks.count - 1 { y += block.bottomSpacing }
    }
    measuredWidth = width
    measuredHeight = ceil(y)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if bounds.width != measuredWidth { measure(width: bounds.width) }
    ChatTableViewport.apply(to: self)
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    if super.point(inside: point, with: event) { return true }
    return subviews.contains { $0.point(inside: $0.convert(point, from: self), with: event) }
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard !isHidden, alpha > 0.01, isUserInteractionEnabled else { return nil }
    for subview in subviews.reversed() {
      if let hit = subview.hitTest(subview.convert(point, from: self), with: event) { return hit }
    }
    return super.hitTest(point, with: event)
  }

  var fileActions: [UIAccessibilityCustomAction] {
    blocks.flatMap(\.fileActions)
  }

  var tailLength: Int {
    guard let block = blocks.last else { return 0 }
    if let node = block.source?.node, case let .codeBlock(_, content) = node { return content.utf16.count }
    return block.label.attributedText.length
  }
}
