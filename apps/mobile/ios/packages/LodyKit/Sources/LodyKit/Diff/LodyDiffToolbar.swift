import UIKit
import WebKit

/// Bounds discovery to this diff surface; never searches another screen's WebView.
final class LodyDiffSurface: UIView {
  private weak var scrollOwner: UIViewController?
  private weak var documentScroll: UIScrollView?
  private weak var toolbar: LodyDiffToolbar?

  override var backgroundColor: UIColor? {
    didSet { toolbar?.setNeedsLayout() }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { detachScrollView() }
    else { setNeedsLayout() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard window != nil else { return }
    let nextToolbar = descendant(LodyDiffToolbar.self, in: self)
    let nextScroll = descendant(WKWebView.self, in: self)?.scrollView
    if toolbar !== nextToolbar { toolbar?.attachScrollEdge(to: nil) }
    toolbar = nextToolbar
    guard let nextScroll else {
      detachScrollView()
      return
    }
    let changedDocument = documentScroll !== nextScroll
    if changedDocument { detachScrollView() }
    documentScroll = nextScroll
    toolbar = nextToolbar
    var responder: UIResponder? = next
    while let current = responder {
      if let owner = current as? UIViewController {
        if let previous = scrollOwner, previous !== owner {
          LodyScrollEdges.unbind(nextScroll, from: previous)
        }
        scrollOwner = owner
        LodyScrollEdges.bind(nextScroll, to: owner)
        if changedDocument {
          nextScroll.contentInsetAdjustmentBehavior = .automatic
          LodyScrollEdges.navigation(nextScroll)
        }
        toolbar?.attachScrollEdge(to: nextScroll)
        return
      }
      responder = current.next
    }
  }

  private func detachScrollView() {
    toolbar?.attachScrollEdge(to: nil)
    if let scrollOwner, let documentScroll {
      LodyScrollEdges.unbind(documentScroll, from: scrollOwner)
    }
    scrollOwner = nil
    documentScroll = nil
  }

  private func descendant<T: UIView>(_ type: T.Type, in root: UIView) -> T? {
    for child in root.subviews {
      if let found = child as? T { return found }
      if child is WKWebView { continue }
      if let found = descendant(type, in: child) { return found }
    }
    return nil
  }
}

final class LodyDiffToolbar: UIView {
  var onStyleChange: ([String: Any]) -> Void = { _ in }
  var styleChanged: ((String) -> Void)?
  private let container = UIView()
  private let statsGlass: UIVisualEffectView
  private let stats = UILabel()
  private let segment = UISegmentedControl(items: ["Unified", "Split"])
  var pendingAdd = 0
  var pendingDel = 0
  var pendingBase = ""
  private let edgeFade = LodyEdgeFade()

  func attachScrollEdge(to scrollView: UIScrollView?) {
    scrollView?.bottomEdgeEffect.isHidden = true
    edgeFade.isHidden = scrollView == nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let top = container.frame.minY - LodyEdgeFade.overlap
    let bottom = superview.map { convert($0.bounds, from: $0).maxY } ?? bounds.maxY
    edgeFade.frame = CGRect(x: 0, y: top, width: bounds.width, height: max(0, bottom - top))
    edgeFade.color = superview?.backgroundColor ?? .lodyBackground
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    statsGlass = UIVisualEffectView(effect: UIGlassEffect())
    statsGlass.cornerConfiguration = .capsule()
    super.init(frame: frame)
    edgeFade.isHidden = true
    addSubview(edgeFade)
    backgroundColor = .clear
    stats.font = .monospacedDigitSystemFont(ofSize: 13, weight: .semibold)
    stats.adjustsFontForContentSizeCategory = true
    statsGlass.isAccessibilityElement = true
    statsGlass.accessibilityIdentifier = "diff-toolbar-stats"
    segment.selectedSegmentIndex = 0
    segment.addTarget(self, action: #selector(segmentChanged), for: .valueChanged)

    addSubview(container)
    container.addSubview(statsGlass)
    container.addSubview(segment)
    statsGlass.contentView.addSubview(stats)
    for view in [container, statsGlass, stats, segment] { view.translatesAutoresizingMaskIntoConstraints = false }
    NSLayoutConstraint.activate([
      container.centerXAnchor.constraint(equalTo: centerXAnchor),
      container.centerYAnchor.constraint(equalTo: centerYAnchor),
      statsGlass.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      statsGlass.topAnchor.constraint(equalTo: container.topAnchor),
      statsGlass.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      segment.leadingAnchor.constraint(equalTo: statsGlass.trailingAnchor, constant: 8),
      segment.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      segment.topAnchor.constraint(equalTo: container.topAnchor),
      segment.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      stats.leadingAnchor.constraint(equalTo: statsGlass.contentView.leadingAnchor, constant: 16),
      stats.trailingAnchor.constraint(equalTo: statsGlass.contentView.trailingAnchor, constant: -16),
      stats.centerYAnchor.constraint(equalTo: statsGlass.contentView.centerYAnchor),
    ])
  }

  func applyStats() { setStats(add: pendingAdd, del: pendingDel, base: pendingBase) }

  func setStats(add: Int, del: Int, base: String) {
    let text = NSMutableAttributedString()
    if add > 0 {
      text.append(NSAttributedString(string: "+\(add)", attributes: [.foregroundColor: UIColor.systemGreen]))
    }
    if del > 0 {
      if text.length > 0 { text.append(NSAttributedString(string: " ")) }
      text.append(NSAttributedString(string: "−\(del)", attributes: [.foregroundColor: UIColor.systemRed]))
    }
    if !base.isEmpty {
      if text.length > 0 { text.append(NSAttributedString(string: " ")) }
      text.append(NSAttributedString(string: base, attributes: [.foregroundColor: UIColor.secondaryLabel]))
    }
    stats.attributedText = text
    statsGlass.accessibilityLabel = text.string
    statsGlass.isHidden = text.length == 0
  }

  func setStyle(_ value: String) {
    segment.selectedSegmentIndex = value == "split" ? 1 : 0
  }

  @objc private func segmentChanged() {
    let style = segment.selectedSegmentIndex == 1 ? "split" : "unified"
    onStyleChange(["style": style])
    styleChanged?(style)
  }
}
