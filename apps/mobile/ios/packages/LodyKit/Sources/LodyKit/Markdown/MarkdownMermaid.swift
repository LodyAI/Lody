import BeautifulMermaid
import Litext
import MarkdownParser
import UIKit

@MainActor
enum MarkdownMermaid {
  private static let marker = "\u{F0000}lody-mermaid:"
  private final class Cached: NSObject {
    let graph: PositionedGraph?
    init(_ graph: PositionedGraph?) { self.graph = graph }
  }
  private static let cache: NSCache<NSString, Cached> = {
    let cache = NSCache<NSString, Cached>()
    cache.countLimit = 64
    cache.totalCostLimit = 4 * 1024 * 1024
    return cache
  }()

  static func blocks(_ nodes: [MarkdownBlockNode]) -> [MarkdownBlockNode] {
    // shortcut: MarkdownParser flattens quoted code fences; add upstream block support when quoted diagrams are needed.
    nodes.rewrite { (node: MarkdownBlockNode) -> [MarkdownBlockNode] in
      guard case let .codeBlock(language, source) = node,
        language?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "mermaid",
        layout(source) != nil else { return [node] }
      return [.paragraph(content: [.text(marker + source)])]
    }
  }

  private static func layout(_ source: String) -> PositionedGraph? {
    // Bound model-generated input before the library's parser and graph layout.
    guard source.utf8.count <= 12 * 1024, source.split(whereSeparator: \.isNewline).count <= 128 else { return nil }
    let key = source as NSString
    if let cached = cache.object(forKey: key) { return cached.graph }
    let graph = prepare(source)
    cache.setObject(Cached(graph), forKey: key, cost: source.utf8.count * 8)
    return graph
  }

  private static func prepare(_ source: String) -> PositionedGraph? {
    let header = source.split(whereSeparator: \.isNewline)
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .first { !$0.isEmpty && !$0.hasPrefix("%%") }?
      .split { $0.isWhitespace || $0 == ";" }.first?.lowercased()
    let supported = ["graph", "flowchart", "statediagram", "statediagram-v2", "sequencediagram", "classdiagram", "erdiagram", "xychart", "xychart-beta"]
    guard let header, supported.contains(header), let parsed = try? MermaidRenderer.parse(source) else { return nil }
    switch parsed.typedPayload {
    case .flowchart(let model), .stateDiagram(let model):
      guard !model.nodesInOrder.isEmpty, model.nodesInOrder.count + model.edges.count <= 128 else { return nil }
    default: break
    }
    guard let graph = try? GraphLayout().layout(parsed),
      graph.width.isFinite, graph.height.isFinite,
      graph.width > 0, graph.height > 0,
      graph.width <= 8192, graph.height <= 8192 else { return nil }
    return graph
  }

  static func attachment(_ text: String, label: TextLabelView, traits: UITraitCollection) -> TextLabel.Attachment? {
    guard text.hasPrefix(marker) else { return nil }
    let source = String(text.dropFirst(marker.count))
    guard let graph = layout(source) else { return nil }
    return DiagramAttachment(graph: graph, source: source, theme: theme(traits), label: label)
  }

  static func theme(_ traits: UITraitCollection) -> DiagramTheme {
    // The renderer mixes raw CGColor channels; UIKit gray colors have only two.
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 1
    UIColor.systemBackground.resolvedColor(with: traits).getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    return DiagramTheme(
      background: UIColor(red: red, green: green, blue: blue, alpha: alpha),
      foreground: UIColor.label.resolvedColor(with: traits),
      line: UIColor.secondaryLabel.resolvedColor(with: traits),
      accent: UIColor.systemBlue.resolvedColor(with: traits),
      muted: UIColor.secondaryLabel.resolvedColor(with: traits),
      surface: UIColor.secondarySystemBackground.resolvedColor(with: traits),
      border: UIColor.separator.resolvedColor(with: traits),
      transparent: true
    )
  }

  static func actions(_ nodes: [MarkdownBlockNode]) -> [UIAccessibilityCustomAction] {
    var actions: [UIAccessibilityCustomAction] = []
    _ = nodes.rewrite { (node: MarkdownInlineNode) -> [MarkdownInlineNode] in
      if case let .text(text) = node, text.hasPrefix(marker) {
        let source = String(text.dropFirst(marker.count))
        actions.append(UIAccessibilityCustomAction(name: String(localized: "native.chat.copy", bundle: .lody) + " · Mermaid") { _ in
          UIPasteboard.general.string = source
          return true
        })
      }
      return [node]
    }
    return actions
  }

  static func resize(_ label: TextLabelView, width: CGFloat) {
    guard width > 0, label.preferredMaxLayoutWidth != width else { return }
    var hasDiagram = false
    let text = label.attributedText
    text.enumerateAttribute(.litextAttachment, in: NSRange(location: 0, length: text.length)) { value, _, _ in
      if let attachment = value as? TextLabel.Attachment, attachment.view is DiagramView { hasDiagram = true }
    }
    guard hasDiagram else { return }
    label.preferredMaxLayoutWidth = width
    // A new wrapping width alone does not refresh CoreText's run-delegate metrics.
    label.reloadTextLayout()
  }

  static func record(_ root: UIView) {
    guard LodyUIVerify.enabled, let window = root.window else { return }
    var diagrams: [[String: Any]] = []
    func walk(_ view: UIView) {
      guard !view.isHidden, view.alpha > 0.01 else { return }
      if let diagram = view as? DiagramView {
        let frame = diagram.convert(diagram.bounds, to: window)
        if frame.intersects(window.bounds), frame.width > 0, frame.height > 0 {
          var owner = diagram.superview
          while let view = owner, view.accessibilityIdentifier == nil { owner = view.superview }
          diagrams.append(["owner": owner?.accessibilityIdentifier ?? "", "source": diagram.source, "x": Double(frame.minX), "y": Double(frame.minY), "width": Double(frame.width), "height": Double(frame.height)])
        }
      }
      for child in view.subviews { walk(child) }
    }
    walk(window)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("lody-mermaid.json")
    try? JSONSerialization.data(withJSONObject: diagrams, options: .sortedKeys).write(to: url, options: .atomic)
  }
}

@MainActor
private final class DiagramAttachment: TextLabel.Attachment {
  private weak var label: TextLabelView?
  private let graph: PositionedGraph
  let source: String

  init(graph: PositionedGraph, source: String, theme: DiagramTheme, label: TextLabelView) {
    self.graph = graph
    self.source = source
    self.label = label
    super.init()
    descent = 0
    view = DiagramView(graph: graph, source: source, theme: theme)
  }

  override var size: CGSize {
    get {
      var indent: CGFloat = 0
      if let text = label?.attributedText {
        text.enumerateAttribute(.litextAttachment, in: NSRange(location: 0, length: text.length)) { value, range, _ in
          guard let attachment = value as? TextLabel.Attachment, attachment === self,
            let style = text.attribute(.paragraphStyle, at: range.location, effectiveRange: nil) as? NSParagraphStyle else { return }
          indent = max(style.headIndent, style.firstLineHeadIndent) + max(0, -style.tailIndent)
        }
      }
      let preferred = label?.preferredMaxLayoutWidth ?? 0
      let available = (preferred > 0 ? preferred : CGFloat(graph.width)) - indent
      let width = min(CGFloat(graph.width), max(1, available))
      return CGSize(width: width, height: ceil(width * CGFloat(graph.height / graph.width)))
    }
    set {}
  }

  override func attributedStringRepresentation() -> NSAttributedString {
    NSAttributedString(string: source)
  }
}

@MainActor
private final class DiagramView: UIView, UIContextMenuInteractionDelegate {
  private let graph: PositionedGraph
  let source: String
  private var renderer: DiagramRenderer

  init(graph: PositionedGraph, source: String, theme: DiagramTheme) {
    self.graph = graph
    self.source = source
    renderer = DiagramRenderer(theme: theme)
    super.init(frame: .zero)
    backgroundColor = .clear
    contentMode = .redraw
    accessibilityIdentifier = "markdown-mermaid"
    accessibilityLabel = "Mermaid\n" + source
    accessibilityTraits = .image
    isAccessibilityElement = true
    accessibilityCustomActions = [UIAccessibilityCustomAction(name: String(localized: "native.chat.copy", bundle: .lody)) { [weak self] _ in
      guard let self else { return false }
      UIPasteboard.general.string = self.source
      return true
    }]
    addInteraction(UIContextMenuInteraction(delegate: self))
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (view: DiagramView, _) in
      view.renderer = DiagramRenderer(theme: MarkdownMermaid.theme(view.traitCollection))
      view.setNeedsDisplay()
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    MarkdownMermaid.record(self)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    MarkdownMermaid.record(self)
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext(), bounds.width > 0, bounds.height > 0 else { return }
    MarkdownMermaid.record(self)
    let scale = min(bounds.width / CGFloat(graph.width), bounds.height / CGFloat(graph.height))
    context.saveGState()
    context.scaleBy(x: scale, y: scale)
    renderer.render(graph, in: context, bounds: CGRect(x: 0, y: 0, width: graph.width, height: graph.height))
    context.restoreGState()
  }

  func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
    UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
      UIMenu(children: [UIAction(title: String(localized: "native.chat.copy", bundle: .lody), image: UIImage(systemName: "doc.on.doc")) { _ in
        UIPasteboard.general.string = self?.source
      }])
    }
  }
}
