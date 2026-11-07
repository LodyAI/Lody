import CoreText
import Litext
import MarkdownParser
import MarkdownView
import UIKit

// Decorate parsed links, never regex-rewrite Markdown source (code fences and
// escaped text must remain literal). Sizing and visible views use this together.
final class FileMarkdownView: MarkdownTextView {
  private static let marker = "\u{F0000}lody-file:"
  private static let imageMarker = "\u{F0000}lody-image:"
  private static let htmlMarker = "\u{F0000}lody-html:"
  static let searchExcluded = NSAttributedString.Key("lody-search-excluded")

  static func content(_ source: MarkdownContent, streaming: Bool = false) -> MarkdownContent {
    let ruby = MarkdownRuby.blocks(source.blocks)
    let rendered = streaming ? ruby : MarkdownMermaid.blocks(ruby)
    let blocks = rendered.rewrite { (node: MarkdownInlineNode) -> [MarkdownInlineNode] in
      if case let .image(source, _) = node { return [.text(imageMarker + source)] }
      if case let .html(source) = node { return [.text(htmlMarker + source)] }
      guard case let .link(destination, children) = node,
        ChatFileLink(destination) != nil else { return [node] }
      return [.link(destination: destination, children: [.text(marker + destination)] + children)]
    }
    return MarkdownContent(blocks: blocks, rendered: source.rendered, highlightMaps: source.highlightMaps, locale: source.locale)
  }

  override func layoutSubviews() {
    MarkdownMermaid.resize(textLabelView, width: bounds.width)
    super.layoutSubviews()
    ChatTableViewport.apply(to: self)
    ChatContextViewProbe.record(self)
    MarkdownMermaid.record(self)
  }

  override func boundingSize(for width: CGFloat) -> CGSize {
    MarkdownMermaid.resize(textLabelView, width: width)
    return super.boundingSize(for: width)
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard !isHidden, alpha > 0.01, isUserInteractionEnabled else { return nil }
    for table in ChatTableViewport.tables(in: self) {
      let local = table.convert(point, from: self)
      if table.bounds.contains(local), let hit = table.hitTest(local, with: event) { return hit }
    }
    return super.hitTest(point, with: event)
  }

  override func decorate(inlineText text: NSAttributedString, theme: MarkdownTheme) -> NSAttributedString {
    if let diagram = MarkdownMermaid.attachment(text.string, label: textLabelView, traits: traitCollection) {
      return diagram.attributedString(attributes: [.font: theme.fonts.body])
    }
    if let ruby = MarkdownRuby.decode(text.string) {
      // The marker starts with a private-use glyph, whose cached fallback is LastResort.
      var attributes: [NSAttributedString.Key: Any] = [.font: theme.fonts.body, .foregroundColor: theme.colors.body]
      if !ruby.reading.isEmpty {
        attributes[NSAttributedString.Key(kCTRubyAnnotationAttributeName as String)] =
          CTRubyAnnotationCreateWithAttributes(.auto, .auto, .before, ruby.reading as CFString,
            [kCTRubyAnnotationSizeFactorAttributeName: 0.5] as CFDictionary)
      }
      return NSAttributedString(string: ruby.base, attributes: attributes)
    }
    for prefix in [Self.imageMarker, Self.htmlMarker] where text.string.hasPrefix(prefix) {
      let source = String(text.string.dropFirst(prefix.count))
      var attributes: [NSAttributedString.Key: Any] = [Self.searchExcluded: true]
      if prefix == Self.imageMarker {
        attributes.merge([.link: source, .font: theme.fonts.body, .foregroundColor: theme.colors.body]) { _, new in new }
      } else {
        attributes.merge([.font: theme.fonts.codeInline, .foregroundColor: theme.colors.code,
          .backgroundColor: theme.colors.codeBackground.withAlphaComponent(0.05)]) { _, new in new }
      }
      return NSAttributedString(string: source, attributes: attributes)
    }
    guard text.string.hasPrefix(Self.marker) else { return text }
    let href = String(text.string.dropFirst(Self.marker.count))
    guard let target = ChatFileLink(href) else { return text }
    let icon = FileLinkButton(type: .system)
    icon.setImage(MaterialFileIcon.image(for: target.path), for: .normal)
    icon.imageView?.contentMode = .scaleAspectFit
    icon.tintColor = .lodyAccent
    icon.accessibilityLabel = (target.path as NSString).lastPathComponent
    icon.addAction(UIAction { [weak self] _ in
      self?.linkHandler?(.string(href), NSRange(location: 0, length: 0), .zero)
    }, for: .touchUpInside)
    let attachment = TextLabel.Attachment()
    attachment.size = CGSize(width: theme.fonts.body.pointSize + 5, height: theme.fonts.body.pointSize)
    attachment.view = icon
    let result = NSMutableAttributedString(attributedString: attachment.attributedString(attributes: text.attributes(at: 0, effectiveRange: nil)))
    // The run delegate supplies the icon's width; no placeholder glyph is drawn.
    result.replaceCharacters(in: NSRange(location: 0, length: result.length), with: "\u{200B}")
    return result
  }

  func fileActions(_ content: MarkdownContent) -> [UIAccessibilityCustomAction] {
    func inlineNodes(_ blocks: [MarkdownBlockNode]) -> [MarkdownInlineNode] {
      blocks.flatMap { block in
        switch block {
        case .paragraph(let content), .heading(_, let content): return content
        case .table(_, let rows): return rows.flatMap { $0.cells.flatMap(\.content) }
        default: return inlineNodes(block.children)
        }
      }
    }
    // Read the parsed content, including tables and the latest streamed links,
    // rather than the label's previous frame while throttled rendering catches up.
    return MarkdownMermaid.actions(content.blocks) + inlineNodes(content.blocks).collect { node -> [UIAccessibilityCustomAction] in
      guard case let .link(href, children) = node, let target = ChatFileLink(href) else { return [] }
      let label = children.collect { child -> [String] in
        switch child {
        case .text(let text) where !text.hasPrefix(Self.marker): return [text]
        case .code(let text): return [text]
        default: return []
        }
      }.joined()
      return [UIAccessibilityCustomAction(name: label.isEmpty ? (target.path as NSString).lastPathComponent : label) { [weak self] _ in
        self?.linkHandler?(.string(href), NSRange(location: 0, length: 0), .zero)
        return true
      }]
    }
  }

}

@MainActor
enum ChatTableViewport {
  static func apply(to root: UIView) {
    for table in tables(in: root) { configure(table) }
  }

  static func markdown(from view: UIView) -> FileMarkdownView? {
    var current: UIView? = view
    while let node = current {
      if let markdown = node as? FileMarkdownView { return markdown }
      current = node.superview
    }
    return nil
  }

  static func isTable(_ view: UIView) -> Bool {
    let name = NSStringFromClass(type(of: view))
    return name.contains("TableView") && !(view is UITableView)
  }

  static func tables(in view: UIView) -> [UIView] {
    var found: [UIView] = []
    if isTable(view) { found.append(view) }
    for subview in view.subviews { found += tables(in: subview) }
    return found
  }

  static func scroll(in table: UIView) -> UIScrollView? {
    table.subviews.compactMap { $0 as? UIScrollView }.first
  }

  static func contentSpan(_ scroll: UIScrollView) -> CGFloat {
    let frames = scroll.subviews.filter { !($0 is UIImageView) }.map(\.frame)
    guard let minX = frames.map(\.minX).min(), let maxX = frames.map(\.maxX).max() else {
      return scroll.contentSize.width
    }
    return max(0, maxX - minX)
  }

  static func configure(_ table: UIView) {
    guard table.window != nil, let scroll = scroll(in: table) else { return }
    // MarkdownView owns the viewport and its selection-aware clipping mask.
    // Widening just the scroller lets text escape the stationary table border.
    scroll.contentInsetAdjustmentBehavior = .never
    scroll.isDirectionalLockEnabled = true
    scroll.accessibilityIdentifier = "markdown-table-scroll"
    watch(scroll)
    dump()
  }

  static func watch(_ scroll: UIScrollView) {
    guard LodyUIVerify.enabled else { return }
    let id = ObjectIdentifier(scroll)
    if offsetWatches[id] == nil {
      offsetWatches[id] = scroll.observe(\.contentOffset, options: [.new]) { _, _ in
        MainActor.assumeIsolated { dump() }
      }
    }
    guard timer == nil else { return }
    timer = Timer.scheduledTimer(withTimeInterval: 0.15, repeats: true) { _ in
      MainActor.assumeIsolated { dump() }
    }
  }

  static func dump() {
    guard LodyUIVerify.enabled else { return }
    guard let window = UIApplication.shared.connectedScenes
      .compactMap({ $0 as? UIWindowScene })
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)
    else { return }
    var rows: [[String: Double]] = []
    var labels: [[String: Any]] = []
    var systemSelections: [[String: Any]] = []
    var customHandles = 0
    func walk(_ view: UIView) {
      if let handle = view as? SelectionHandle, !handle.isHidden, handle.window === window {
        customHandles += 1
      }
      if #available(iOS 17.0, *) {
        for interaction in view.interactions.compactMap({ $0 as? UITextSelectionDisplayInteraction }) where interaction.isActivated {
          let handles = interaction.handleViews.filter { !$0.isHidden && $0.window === window }
          guard !handles.isEmpty else { continue }
          systemSelections.append([
            "handles": handles.map { handle in
              let frame = handle.convert(handle.bounds, to: window)
              return ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
            },
            "rectCount": interaction.highlightView.selectionRects.count,
          ])
        }
      }
      if let label = view as? TextLabelView {
        let frame = label.convert(label.bounds, to: window)
        var item: [String: Any] = ["text": label.attributedText.string,
          "x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
        if let range = label.selectionRange {
          item["selected"] = label.selectedPlainText() ?? ""
          item["rects"] = label.textLayout.rects(for: range).map { rect in
            let box = label.convert(label.viewRect(fromLayoutRect: rect), to: window)
            return ["x": box.minX, "y": box.minY, "width": box.width, "height": box.height]
          }
        }
        labels.append(item)
      }
      if let scroll = view as? UIScrollView, scroll.accessibilityIdentifier == "markdown-table-scroll" {
        let frame = scroll.convert(scroll.bounds, to: window)
        let tableFrame = scroll.superview.map { $0.convert($0.bounds, to: window) } ?? frame
        rows.append([
          "x": Double(frame.minX),
          "y": Double(frame.minY),
          "width": Double(frame.width),
          "height": Double(frame.height),
          "offsetX": Double(scroll.contentOffset.x),
          "contentWidth": Double(scroll.contentSize.width),
          "boundsWidth": Double(scroll.bounds.width),
          "naturalWidth": Double(contentSpan(scroll)),
          "tableWidth": Double(scroll.bounds.width),
          "borderX": Double(tableFrame.minX),
          "borderWidth": Double(tableFrame.width),
          "contentLeft": Double(scroll.subviews.filter { !($0 is UIImageView) }.map(\.frame.minX).min() ?? 0),
        ])
      }
      for subview in view.subviews { walk(subview) }
    }
    walk(window)
    let selectionURL = FileManager.default.temporaryDirectory.appendingPathComponent("lody-markdown-selection.json")
    try? JSONSerialization.data(withJSONObject: labels).write(to: selectionURL, options: .atomic)
    let displayURL = FileManager.default.temporaryDirectory.appendingPathComponent("lody-system-selection.json")
    try? JSONSerialization.data(withJSONObject: ["displays": systemSelections, "customHandles": customHandles]).write(to: displayURL, options: .atomic)
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("lody-table-bleed.json")
    guard let data = try? JSONSerialization.data(withJSONObject: rows) else { return }
    try? data.write(to: url, options: .atomic)
  }

  private static var offsetWatches: [ObjectIdentifier: NSKeyValueObservation] = [:]
  private static var timer: Timer?
}

@MainActor
enum ChatContextViewProbe {
  static func checkHitTesting() {
    guard LodyUIVerify.enabled else { return }
    let store = ChatMarkdownStore(traits: .current)
    let row = ChatRow(id: "hit-test", entryID: "hit-test", kind: "text", text: "Folded process text")
    let markdown = store.view(id: row.id, text: row.text, secondary: false, streaming: false, width: 300)
    let cell = ChatMarkdownCell(frame: CGRect(x: 0, y: 0, width: 320, height: 80))
    cell.configure(row, markdown: markdown)
    cell.layoutIfNeeded()
    let point = CGPoint(x: 30, y: 20)
    var checks: [String: Bool] = [:]
    // UIKit can keep a deleted cell in its reuse pool with its old text attached.
    let host = UIView(frame: cell.frame)
    let button = UIButton(frame: host.bounds)
    host.addSubview(button)
    host.addSubview(cell)
    checks["visibleTextReceivesTouch"] = host.hitTest(point, with: nil)?.isDescendant(of: markdown) == true
    cell.isHidden = true
    checks["hiddenCellPassesToButton"] = host.hitTest(point, with: nil) === button
    cell.isHidden = false
    cell.alpha = 0
    checks["transparentCellPassesToButton"] = host.hitTest(point, with: nil) === button
    cell.alpha = 1
    cell.isUserInteractionEnabled = false
    checks["disabledCellPassesToButton"] = host.hitTest(point, with: nil) === button
    cell.isUserInteractionEnabled = true
    for (name, view) in [("markdown", markdown as UIView), ("block", markdown.subviews[0])] {
      let local = view.convert(point, from: cell)
      view.isHidden = true
      checks[name + "Hidden"] = view.hitTest(local, with: nil) == nil
      view.isHidden = false
      view.alpha = 0
      checks[name + "Transparent"] = view.hitTest(local, with: nil) == nil
      view.alpha = 1
      view.isUserInteractionEnabled = false
      checks[name + "Disabled"] = view.hitTest(local, with: nil) == nil
      view.isUserInteractionEnabled = true
    }
    let next = ChatMarkdownCell(frame: cell.frame)
    next.configure(row, markdown: markdown)
    next.layoutIfNeeded()
    checks["oldCellCannotReachReparentedText"] = cell.hitTest(point, with: nil)?.isDescendant(of: markdown) != true
    let source = "Before <ruby>Tokyo<rt>toh-kee-oh</rt></ruby> after"
    for streaming in [false, true] {
      let rendered = store.view(id: "ruby", text: source, secondary: false, streaming: streaming, width: 300)
      let label = (rendered.subviews.first as! FileMarkdownView).textLabelView
      let text = label.attributedText
      let range = (text.string as NSString).range(of: "Tokyo")
      var reading: String?
      if range.location != NSNotFound,
         let value = text.attribute(NSAttributedString.Key(kCTRubyAnnotationAttributeName as String), at: range.location, effectiveRange: nil) {
        reading = CTRubyAnnotationGetTextForPosition(value as! CTRubyAnnotation, .before) as String?
      }
      checks["rubyReading-\(streaming)"] = reading == "toh-kee-oh"
      checks["rubySelectableBase-\(streaming)"] = text.string.trimmingCharacters(in: .whitespacesAndNewlines) == "Before Tokyo after"
      checks["rubyHeight-\(streaming)"] = rendered.measuredHeight > store.height(id: "plain", text: "Before Tokyo after", secondary: false, streaming: streaming, width: 300)
    }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("lody-markdown-hit-testing.json")
    try? JSONSerialization.data(withJSONObject: checks, options: .sortedKeys).write(to: url, options: .atomic)
  }

  static func record(_ markdown: UIView) {
    guard LodyUIVerify.enabled else { return }
    var grown: [String] = []
    for view in markdown.subviews {
      let name = NSStringFromClass(type(of: view))
      guard name.hasSuffix("CodeView") || ChatTableViewport.isTable(view) else { continue }
      for key in view.layer.animationKeys() ?? [] {
        guard let animation = view.layer.animation(forKey: key) as? CABasicAnimation,
          let path = animation.keyPath, path.hasPrefix("bounds") || path.hasPrefix("position") else { continue }
        grown.append("\(name) \(path) from \(String(describing: animation.fromValue)) frame \(view.frame)")
      }
    }
    guard !grown.isEmpty else { return }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("lody-context-view-grown.json")
    let existing = (try? JSONSerialization.jsonObject(with: Data(contentsOf: url))) as? [String] ?? []
    try? JSONSerialization.data(withJSONObject: existing + grown).write(to: url, options: .atomic)
  }
}

private final class FileLinkButton: UIButton {
  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    bounds.insetBy(dx: min(0, (bounds.width - 44) / 2), dy: min(0, (bounds.height - 44) / 2)).contains(point)
  }
}

enum MaterialFileIcon {
  static func image(for path: String) -> UIImage? {
    let name = "material-\(ChatFileLink.iconName(for: path))"
    let image = UIImage(named: name, in: Bundle.main, compatibleWith: nil)
    return image?.withRenderingMode(.alwaysOriginal)
  }
}
