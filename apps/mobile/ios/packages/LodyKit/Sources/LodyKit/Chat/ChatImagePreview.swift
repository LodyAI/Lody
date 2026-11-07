import UIKit

final class ChatImagePageIndicator: UILabel {
  var onIncrement: (() -> Void)?
  var onDecrement: (() -> Void)?
  override var accessibilityTraits: UIAccessibilityTraits {
    get { [.adjustable, .staticText] }
    set {}
  }
  override func accessibilityIncrement() { onIncrement?() }
  override func accessibilityDecrement() { onDecrement?() }
}

final class ChatImagePreview: UIViewController, UIGestureRecognizerDelegate {
  private var items: [ChatImagePreviewItem]
  private var page: Int
  private var workspace: String
  private var session: String
  private var placeholders: [String: UIImage]
  private let sourceView: (String) -> UIView?
  private let backdrop = UIVisualEffectView()
  private let wash = UIView()
  private let dim = UIView()
  private let pagesHost = UIView()
  private var pages: [Int: ChatImagePreviewPage] = [:]
  private let close = UIButton(type: .system)
  private let counter = ChatImagePageIndicator()
  private var chromeVisible = true
  private var pagerOffset: CGFloat = 0
  private var panStart: CGFloat = 0
  private var viewport = CGSize.zero
  private var pagePanRecognizer: UIPanGestureRecognizer?
  private var overlayRevealed = false

  @discardableResult
  static func present(
    from controller: UIViewController,
    image: UIImage?,
    name: String,
    url: URL?,
    sourceView: UIView?
  ) -> ChatImagePreview? {
    let remote = url.flatMap { $0.isFileURL ? nil : $0 }
    let local = url.flatMap { $0.isFileURL ? $0.absoluteString : nil }
    let item = ChatImagePreviewItem(
      id: "single",
      image: ChatImage(
        id: "",
        fileName: name,
        storageSessionId: nil,
        width: image.map { Double($0.size.width) },
        height: image.map { Double($0.size.height) }
      ),
      localURI: local,
      remoteURL: remote
    )
    return present(
      from: controller,
      items: [item],
      index: 0,
      workspace: "",
      session: "",
      placeholders: image.map { ["single": $0] } ?? [:],
      sourceView: { _ in sourceView }
    )
  }

  @discardableResult
  static func present(
    from controller: UIViewController,
    items: [ChatImagePreviewItem],
    index: Int,
    workspace: String,
    session: String,
    placeholders: [String: UIImage],
    sourceView: @escaping (String) -> UIView?
  ) -> ChatImagePreview? {
    guard controller.presentedViewController == nil, !items.isEmpty else { return nil }
    let preview = ChatImagePreview(
      items: items,
      index: index,
      workspace: workspace,
      session: session,
      placeholders: placeholders,
      sourceView: sourceView
    )
    preview.preferredTransition = .zoom { [weak preview] _ in preview?.currentSourceView() }
    controller.present(preview, animated: true)
    return preview
  }

  private init(
    items: [ChatImagePreviewItem],
    index: Int,
    workspace: String,
    session: String,
    placeholders: [String: UIImage],
    sourceView: @escaping (String) -> UIView?
  ) {
    self.items = items
    self.page = min(max(index, 0), items.count - 1)
    self.workspace = workspace
    self.session = session
    self.placeholders = placeholders
    self.sourceView = sourceView
    super.init(nibName: nil, bundle: nil)
    modalPresentationStyle = .overFullScreen
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func updateItems(_ items: [ChatImagePreviewItem], placeholders: [String: UIImage] = [:]) {
    let current = self.items.indices.contains(page) ? self.items[page].id : nil
    self.items = items
    self.placeholders.merge(placeholders) { _, last in last }
    guard let current, let next = ChatImageGallery.index(of: current, in: items) else {
      dismiss(animated: true)
      return
    }
    page = next
    rebuildPages()
    applyPager(animated: false)
    updateChrome()
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    view.accessibilityIdentifier = "chat-image-preview"
    view.accessibilityViewIsModal = true
    dim.isUserInteractionEnabled = false
    wash.isUserInteractionEnabled = false
    backdrop.isUserInteractionEnabled = false
    view.addSubview(dim)
    view.addSubview(backdrop)
    view.addSubview(wash)
    view.addSubview(pagesHost)
    var config = UIButton.Configuration.plain()
    config.image = UIImage(
      systemName: "xmark",
      withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
    )
    config.baseForegroundColor = .label
    config.background.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.8)
    config.cornerStyle = .capsule
    close.configuration = config
    close.accessibilityLabel = String(localized: "native.chat.image.closePreview", bundle: .lody)
    close.addAction(UIAction { [weak self] _ in self?.dismiss(animated: true) }, for: .touchUpInside)
    view.addSubview(close)
    let size = UIFont.preferredFont(forTextStyle: .subheadline).pointSize
    counter.font = UIFont.systemFont(ofSize: size, weight: .medium).withTabularNumbers()
    counter.textColor = .label
    counter.textAlignment = .center
    counter.backgroundColor = UIColor.systemBackground.withAlphaComponent(0.8)
    counter.clipsToBounds = true
    counter.onIncrement = { [weak self] in self?.movePage(1) }
    counter.onDecrement = { [weak self] in self?.movePage(-1) }
    view.addSubview(counter)
    let doubleTap = UITapGestureRecognizer(target: self, action: #selector(zoom(_:)))
    doubleTap.numberOfTapsRequired = 2
    let singleTap = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
    singleTap.require(toFail: doubleTap)
    pagesHost.addGestureRecognizer(doubleTap)
    pagesHost.addGestureRecognizer(singleTap)
    if items.count > 1 {
      let pan = UIPanGestureRecognizer(target: self, action: #selector(pagePan(_:)))
      pan.delegate = self
      pan.maximumNumberOfTouches = 1
      pagePanRecognizer = pan
      view.addGestureRecognizer(pan)
    }
    applyBackdrop()
    overlayAlpha(0)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (controller: ChatImagePreview, _) in
      controller.applyBackdrop()
    }
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    revealOverlay(animated: animated)
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    hideOverlay(animated: animated)
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    dim.frame = view.bounds
    backdrop.frame = view.bounds
    wash.frame = view.bounds
    if viewport != view.bounds.size {
      viewport = view.bounds.size
      pagerOffset = -CGFloat(page) * pageWidth
      rebuildPages()
      applyPager(animated: false)
    }
    layoutChrome()
    updateChrome()
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard let pan = gestureRecognizer as? UIPanGestureRecognizer else { return true }
    return ChatImagePreviewGeometry.shouldPage(
      zoomScale: currentPage?.scroll.zoomScale ?? 1,
      velocity: pan.velocity(in: view),
      count: items.count
    )
  }

  override func accessibilityPerformEscape() -> Bool { dismiss(animated: true); return true }
  override func accessibilityPerformMagicTap() -> Bool { dismiss(animated: true); return true }

  @objc private func tapped(_ gesture: UITapGestureRecognizer) {
    let point = gesture.location(in: view)
    if close.frame.contains(point) || (!counter.isHidden && counter.frame.contains(point)) { return }
    if let photo = currentPage?.photo {
      let frame = photo.convert(photo.bounds, to: view)
      if frame.contains(point) {
        chromeVisible.toggle()
        updateChrome()
        return
      }
    }
    dismiss(animated: true)
  }

  @objc private func zoom(_ gesture: UITapGestureRecognizer) {
    guard let page = currentPage else { return }
    let animated = !UIAccessibility.isReduceMotionEnabled
    guard page.scroll.zoomScale <= 1.01 else { page.scroll.setZoomScale(1, animated: animated); return }
    let point = gesture.location(in: page.photo)
    let size = CGSize(width: page.scroll.bounds.width / 2.5, height: page.scroll.bounds.height / 2.5)
    page.scroll.zoom(
      to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height),
      animated: animated
    )
  }

  @objc private func pagePan(_ pan: UIPanGestureRecognizer) {
    let width = pageWidth
    switch pan.state {
    case .began:
      panStart = pagerOffset
    case .changed:
      let minX = -CGFloat(items.count - 1) * width
      pagerOffset = ChatImagePreviewGeometry.rubberBandClamp(
        panStart + pan.translation(in: view).x, min: minX, max: 0, dimension: width
      )
      applyPager(animated: false)
    case .ended, .cancelled:
      let target = ChatImagePreviewGeometry.snapPage(
        offset: pagerOffset, velocity: pan.velocity(in: view).x, current: page, count: items.count, pageWidth: width
      )
      setPage(target, animated: !UIAccessibility.isReduceMotionEnabled)
    default:
      break
    }
  }

  private func setPage(_ next: Int, animated: Bool) {
    let previous = pages[page]
    page = next
    pagerOffset = -CGFloat(page) * pageWidth
    previous?.resetZoom()
    rebuildPages()
    applyPager(animated: animated)
    updateChrome()
  }

  private func movePage(_ delta: Int) {
    let next = min(max(page + delta, 0), items.count - 1)
    guard next != page else { return }
    setPage(next, animated: !UIAccessibility.isReduceMotionEnabled)
  }

  private func rebuildPages() {
    let width = view.bounds.width
    let height = view.bounds.height
    let step = pageWidth
    let keep = Set((max(page - 1, 0)...min(page + 1, items.count - 1)))
    let stale = pages.keys.filter { !keep.contains($0) }
    for index in stale {
      pages[index]?.removeFromSuperview()
      pages[index] = nil
    }
    for index in keep {
      let pageView = pages[index] ?? ChatImagePreviewPage()
      if pages[index] == nil {
        pagesHost.addSubview(pageView)
        pages[index] = pageView
      }
      pageView.frame = CGRect(x: CGFloat(index) * step, y: 0, width: width, height: height)
      let item = items[index]
      pageView.configure(
        item: item,
        placeholder: placeholders[item.id],
        workspace: workspace,
        session: session,
        safeTop: view.safeAreaInsets.top,
        safeBottom: view.safeAreaInsets.bottom
      )
      if let pan = pagePanRecognizer {
        pageView.scroll.panGestureRecognizer.require(toFail: pan)
      }
    }
    pagesHost.frame.size = CGSize(width: step * CGFloat(max(items.count, 1)), height: height)
    pagesHost.frame.origin.y = 0
  }

  private func applyPager(animated: Bool) {
    let apply = { self.pagesHost.frame.origin = CGPoint(x: self.pagerOffset, y: 0) }
    if animated {
      UIView.animate(withDuration: 0.2, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: apply)
    } else {
      apply()
    }
  }

  private func updateChrome() {
    close.isUserInteractionEnabled = chromeVisible
    close.accessibilityElementsHidden = !chromeVisible
    let paging = items.count > 1
    counter.isHidden = !paging
    counter.text = paging
      ? String.localizedStringWithFormat(String(localized: "native.chat.image.page", bundle: .lody), String(describing: page + 1), String(describing: items.count))
      : nil
    counter.accessibilityLabel = counter.text
    counter.isUserInteractionEnabled = false
    counter.accessibilityElementsHidden = !(chromeVisible && paging)
    layoutChrome()
    guard transitionCoordinator == nil else { return }
    let revealed: CGFloat = overlayRevealed ? 1 : 0
    let closeAlpha: CGFloat = chromeVisible ? revealed : 0
    let counterAlpha: CGFloat = chromeVisible && paging ? revealed : 0
    UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState]) {
      self.close.alpha = closeAlpha
      self.counter.alpha = counterAlpha
    }
  }

  private func layoutChrome() {
    let top = view.safeAreaInsets.top + 8
    close.frame = CGRect(x: view.safeAreaInsets.left + 16, y: top, width: 44, height: 44)
    let chipHeight: CGFloat = 28
    let chipWidth = max(counter.sizeThatFits(CGSize(width: 160, height: chipHeight)).width + 24, 44)
    counter.layer.cornerRadius = chipHeight / 2
    counter.frame = CGRect(
      x: (view.bounds.width - chipWidth) / 2,
      y: top + (44 - chipHeight) / 2,
      width: chipWidth,
      height: chipHeight
    )
  }

  private func overlayAlpha(_ value: CGFloat) {
    backdrop.alpha = value
    wash.alpha = value
    dim.alpha = value
    if !overlayRevealed || !chromeVisible {
      close.alpha = 0
      counter.alpha = 0
      return
    }
    close.alpha = value
    counter.alpha = items.count > 1 ? value : 0
  }

  private func revealOverlay(animated: Bool) {
    overlayRevealed = true
    guard animated, let coordinator = transitionCoordinator else {
      overlayAlpha(1)
      return
    }
    overlayAlpha(0)
    coordinator.animate(alongsideTransition: { _ in self.overlayAlpha(1) })
  }

  private func hideOverlay(animated: Bool) {
    overlayRevealed = false
    guard animated, let coordinator = transitionCoordinator else {
      overlayAlpha(0)
      return
    }
    coordinator.animate(alongsideTransition: { _ in
      self.overlayAlpha(0)
    }, completion: { context in
      if context.isCancelled {
        self.overlayRevealed = true
        self.overlayAlpha(1)
      }
    })
  }

  private func applyBackdrop() {
    let reduce = UIAccessibility.isReduceTransparencyEnabled
    backdrop.isHidden = reduce
    wash.isHidden = reduce
    dim.isHidden = !reduce
    if reduce {
      dim.backgroundColor = UIColor.black.withAlphaComponent(0.6)
    } else {
      backdrop.effect = UIBlurEffect(style: .systemThinMaterial)
      wash.backgroundColor = UIColor.black.withAlphaComponent(0.1)
    }
  }

  private var pageWidth: CGFloat {
    view.bounds.width + ChatImagePreviewGeometry.pageGap
  }

  private var currentPage: ChatImagePreviewPage? { pages[page] }

  private func currentSourceView() -> UIView? {
    guard items.indices.contains(page) else { return nil }
    let view = sourceView(items[page].id)
    guard let view, view.window != nil else { return nil }
    return view
  }
}
