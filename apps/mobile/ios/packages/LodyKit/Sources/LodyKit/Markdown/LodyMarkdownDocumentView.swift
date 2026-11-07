import MarkdownView
import UIKit

final class LodyMarkdownDocumentView: LodyAppearanceView {
  var onFail: ([String: Any]) -> Void = { _ in }
  var onFilePress: ([String: Any]) -> Void = { _ in }
  var failed: (() -> Void)?
  var filePressed: ((_ path: String, _ line: Int) -> Void)?
  private let documentScroll = UIScrollView()
  private let document = FileMarkdownView()
  private weak var scrollOwner: UIViewController?
  private var handle = ""
  private var renderScheduled = false

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .lodyBackground
    documentScroll.alwaysBounceVertical = true
    documentScroll.contentInsetAdjustmentBehavior = .automatic
    documentScroll.accessibilityIdentifier = "file-document"
    document.accessibilityIdentifier = "file-document-content"
    document.accessibilityTraits = .staticText
    documentScroll.addSubview(document)
    document.trackedScrollView = documentScroll
    document.linkHandler = { [weak self] payload, _, _ in
      let href: String = switch payload {
      case .url(let url): url.absoluteString
      case .string(let value): value
      }
      if let target = ChatFileLink(href) {
        self?.onFilePress(["path": target.path, "line": target.line ?? 0])
        self?.filePressed?(target.path, target.line ?? 0)
      } else if let url = URL(string: href), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
        UIApplication.shared.open(url)
      }
    }
    addSubview(documentScroll)
  }

  func setHandle(_ value: String) { handle = value; scheduleRender() }

  private func scheduleRender() {
    guard !renderScheduled else { return }
    renderScheduled = true
    DispatchQueue.main.async { [weak self] in
      self?.renderScheduled = false
      self?.render()
    }
  }

  private func fail() {
    onFail(["message": "content_expired"])
    failed?()
  }

  private func render() {
    guard !handle.isEmpty else { return }
    guard let stored = ContentStore.shared.get(handle), let text = String(data: stored.data, encoding: .utf8) else {
      fail()
      return
    }
    attachScrollOwner()
    setNeedsLayout()
    let theme = ChatMarkdownTheme.make(traits: traitCollection, secondary: false)
    let content = FileMarkdownView.content(MarkdownContent(markdown: text, theme: theme))
    document.setContentImmediately(content, theme: theme)
    document.accessibilityLabel = text
    document.isAccessibilityElement = true
    document.accessibilityCustomActions = document.fileActions(content)
    documentScroll.contentOffset = CGPoint(x: 0, y: -documentScroll.adjustedContentInset.top)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    documentScroll.frame = bounds
    let width = max(1, bounds.width - 32)
    let height = document.boundingSize(for: width).height
    document.frame = CGRect(x: 16, y: 12, width: width, height: height)
    documentScroll.contentSize = CGSize(width: bounds.width, height: height + 36)
    attachScrollOwner()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    attachScrollOwner()
  }

  private func attachScrollOwner() {
    guard window != nil else { return }
    var responder = next
    let scroll = documentScroll
    while let current = responder {
      if let owner = current as? UIViewController {
        owner.setContentScrollView(scroll, for: .top)
        owner.setContentScrollView(scroll, for: .bottom)
        LodyScrollEdges.navigation(scroll)
        scrollOwner = owner
        return
      }
      responder = current.next
    }
  }

  override func willMove(toWindow newWindow: UIWindow?) {
    super.willMove(toWindow: newWindow)
    guard newWindow == nil, let owner = scrollOwner else { return }
    if owner.contentScrollView(for: .top) === documentScroll {
      owner.setContentScrollView(nil, for: .top)
      owner.setContentScrollView(nil, for: .bottom)
    }
    scrollOwner = nil
  }

  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    if previous?.preferredContentSizeCategory != traitCollection.preferredContentSizeCategory { scheduleRender() }
  }

  override func lodyAppearanceDidChange() {
    backgroundColor = .lodyBackground
    scheduleRender()
  }
}
