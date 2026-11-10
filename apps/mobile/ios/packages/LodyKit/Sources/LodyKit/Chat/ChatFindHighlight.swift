import ChatKit
import Litext
import UIKit

/// Draw on the rendered text geometry. Never mutate Markdown content, syntax
/// colors, selection or streaming text, and never use source-string offsets.
@MainActor enum ChatFindHighlight {
  @discardableResult
  static func apply(to root: UIView, query: String, active: Int?, reveal: Bool = false) -> CGRect? {
    var ordinal = 0
    var activeRect: CGRect?
    func walk(_ view: UIView) {
      view.layer.sublayers?.filter { $0.name == "lody-find" }.forEach { $0.removeFromSuperlayer() }
      var ranges: [NSRange] = []
      var rectangles: @MainActor (NSRange) -> [CGRect] = { _ in [] }
      if !query.isEmpty, let label = view as? TextLabelView {
        ranges = TextSearch.ranges(in: label.attributedText.string, query: query)
        ranges.removeAll { range in
          var excluded = false
          label.attributedText.enumerateAttribute(FileMarkdownView.searchExcluded, in: range) { value, _, _ in
            if value != nil { excluded = true }
          }
          return excluded
        }
        if !ranges.isEmpty {
          let layout = TextLabel.Layout(attributedString: label.attributedText)
          layout.containerSize = label.bounds.size
          rectangles = { range in
            layout.rects(for: range).map { CGRect(x: $0.minX, y: label.bounds.height - $0.maxY, width: $0.width, height: $0.height) }
          }
        }
      } else if !query.isEmpty, let text = view as? CKTextView {
        ranges = TextSearch.ranges(in: text.attributedTextValue.string, query: query)
        rectangles = { text.rectangles(for: $0) }
      }
      for range in ranges {
        let selected = ordinal == active
        ordinal += 1
        let path = UIBezierPath()
        for rect in rectangles(range) {
          path.append(UIBezierPath(roundedRect: rect, cornerRadius: 2))
          if selected, activeRect == nil {
            // Code blocks and tables can scroll horizontally inside a chat row.
            var parent = reveal ? view.superview : nil
            while let ancestor = parent, ancestor !== root {
              if let scroll = ancestor as? UIScrollView {
                scroll.scrollRectToVisible(view.convert(rect, to: scroll), animated: false)
              }
              parent = ancestor.superview
            }
            activeRect = view.convert(rect, to: root)
          }
        }
        let layer = CAShapeLayer()
        layer.name = "lody-find"
        layer.path = path.cgPath
        let color = UIColor.systemBlue.resolvedColor(with: view.traitCollection)
        layer.fillColor = color.withAlphaComponent(selected ? 0.28 : 0.13).cgColor
        layer.strokeColor = selected ? color.cgColor : nil
        layer.lineWidth = selected ? 1 : 0
        view.layer.addSublayer(layer)
      }
      for child in view.subviews { walk(child) }
    }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    walk(root)
    CATransaction.commit()
    return activeRect
  }
}

// UI Verify reads rendered highlight geometry through accessibility; a debugger attach left the app unresponsive.
final class ChatFindProbe: UIView {
  override init(frame: CGRect) {
    super.init(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    isUserInteractionEnabled = false
    isAccessibilityElement = true
    accessibilityIdentifier = "chat-find-probe"
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override var accessibilityValue: String? {
    get {
      var result: [[String: Any]] = []
      var queue = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows) as [UIView]
      while !queue.isEmpty {
        let view = queue.removeFirst()
        for case let shape as CAShapeLayer in view.layer.sublayers ?? [] where shape.name == "lody-find" {
          let rect = view.convert(shape.path?.boundingBoxOfPath ?? .zero, to: nil)
          result.append([
            "active": shape.strokeColor != nil, "x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height,
          ])
        }
        queue += view.subviews
      }
      return (try? JSONSerialization.data(withJSONObject: result)).map { String(decoding: $0, as: UTF8.self) }
    }
    set {}
  }
}
