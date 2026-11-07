import UIKit

struct LodyPagedPage {
  var id: String = ""
  var title: String = ""
  var sections: [LodyListSection] = []
}

final class LodyPagedList: UIView, UIPageViewControllerDataSource, UIPageViewControllerDelegate {
  var onRowPress: ([String: Any]) -> Void = { _ in }
  var onPageChange: ([String: Any]) -> Void = { _ in }
  var forwardedRowPress: (([String: Any]) -> Void)?
  var forwardedPageChange: ((Int) -> Void)?

  private let pager = UIPageViewController(transitionStyle: .scroll, navigationOrientation: .horizontal)
  private let rail = LodyPageSectionRail()
  private var boxes: [PageBox] = []
  private var currentPage = 0
  private var pagingEnabled = true
  private var bottomInset: CGFloat = 0
  private var transparent = false
  private var grouped = false
  private var offsetObservation: NSKeyValueObservation?
  private var titleObservation: NSKeyValueObservation?
  private weak var pageScrollView: UIScrollView?
  private weak var host: UIViewController?

  private final class PageBox {
    let controller: UIViewController
    let list: LodyGroupedList

    init(onPress: @escaping ([String: Any]) -> Void) {
      controller = UIViewController()
      list = LodyGroupedList(frame: .zero)
      list.forwarded = { name, body in
        if name == "rowPress" { onPress(body) }
      }
      list.translatesAutoresizingMaskIntoConstraints = false
      controller.view.addSubview(list)
      NSLayoutConstraint.activate([
        list.topAnchor.constraint(equalTo: controller.view.topAnchor),
        list.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor),
        list.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor),
        list.bottomAnchor.constraint(equalTo: controller.view.bottomAnchor),
      ])
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    pager.dataSource = self
    pager.delegate = self
    rail.onSelect = { [weak self] index in
      self?.show(index, animated: true)
    }
  }

  func setPages(_ pages: [LodyPagedPage]) {
    if boxes.count != pages.count {
      rebuild(pages)
    } else {
      for (index, page) in pages.enumerated() {
        boxes[index].list.setSections(page.sections, animated: false)
      }
      rail.setTitles(pages.map(\.title))
    }
    attachHostIfNeeded()
  }

  func setSelectedPage(_ index: Int) {
    guard boxes.indices.contains(index) else { return }
    show(index, animated: false)
  }

  func setPagingEnabled(_ enabled: Bool) {
    pagingEnabled = enabled
    pageScrollView?.isScrollEnabled = enabled
    if enabled {
      attachRail()
    } else {
      detachRail()
    }
  }

  func setBottomInset(_ value: CGFloat) {
    bottomInset = value
    boxes.forEach { $0.list.setBottomInset(value) }
  }

  func setTransparent(_ value: Bool) {
    transparent = value
    boxes.forEach { $0.list.setTransparent(value) }
  }

  func setGrouped(_ value: Bool) {
    grouped = value
    boxes.forEach { $0.list.setGrouped(value) }
  }

  func setAccent(_ value: String) {
    boxes.forEach { $0.list.setAccent(value) }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      detachHost()
    } else {
      attachHostIfNeeded()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if pagingEnabled { attachRail() }
  }

  private func rebuild(_ pages: [LodyPagedPage]) {
    boxes = pages.map { page in
      let box = PageBox() { [weak self] body in
        self?.onRowPress(body)
        self?.forwardedRowPress?(body)
      }
      box.list.setTransparent(transparent)
      box.list.setGrouped(grouped)
      box.list.setBottomInset(bottomInset)
      box.list.setSections(page.sections)
      return box
    }
    rail.setTitles(pages.map(\.title))
    currentPage = min(currentPage, max(pages.count - 1, 0))
    if let first = boxes[safe: currentPage] {
      pager.setViewControllers([first.controller], direction: .forward, animated: false)
      rail.setSelected(currentPage)
    }
  }

  private func show(_ index: Int, animated: Bool) {
    guard boxes.indices.contains(index) else { return }
    let target = boxes[index].controller
    if pager.viewControllers?.first === target {
      if currentPage != index { commit(index) }
      return
    }
    let direction: UIPageViewController.NavigationDirection
    if index > currentPage {
      direction = .forward
    } else {
      direction = .reverse
    }
    pager.setViewControllers([target], direction: direction, animated: animated) { [weak self] finished in
      if finished { self?.commit(index) }
    }
  }

  private func commit(_ index: Int) {
    currentPage = index
    rail.setSelected(index)
    bindVisibleScrollView()
    onPageChange(["index": index])
    forwardedPageChange?(index)
  }

  private func attachHostIfNeeded() {
    guard window != nil, let owner = owningController() else { return }
    if pager.parent == nil {
      owner.addChild(pager)
      addSubview(pager.view)
      pager.view.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate([
        pager.view.topAnchor.constraint(equalTo: topAnchor),
        pager.view.leadingAnchor.constraint(equalTo: leadingAnchor),
        pager.view.trailingAnchor.constraint(equalTo: trailingAnchor),
        pager.view.bottomAnchor.constraint(equalTo: bottomAnchor),
      ])
      pager.didMove(toParent: owner)
      host = owner
      titleObservation = owner.navigationItem.observe(\.titleView) { [weak self] item, _ in
        MainActor.assumeIsolated {
          guard let self, self.pagingEnabled, item.titleView !== self.rail else { return }
          // Screens can reset the header after a cancelled sheet dismissal.
          self.setNeedsLayout()
        }
      }
      observePageScrollView()
    }
    if pagingEnabled { attachRail() }
    pageScrollView?.isScrollEnabled = pagingEnabled
    bindVisibleScrollView()
  }

  private func bindVisibleScrollView() {
    guard let host, let page = boxes[safe: currentPage] else { return }
    LodyScrollEdges.bind(page.list.contentScrollView, to: host)
    LodyScrollEdges.grouped(page.list.contentScrollView)
  }

  private func detachHost() {
    if let host {
      for box in boxes { LodyScrollEdges.unbind(box.list.contentScrollView, from: host) }
    }
    titleObservation = nil
    detachRail()
    offsetObservation = nil
    pageScrollView = nil
    if pager.parent != nil {
      pager.willMove(toParent: nil)
      pager.view.removeFromSuperview()
      pager.removeFromParent()
    }
    host = nil
  }

  private func attachRail() {
    guard pagingEnabled, boxes.count > 1, let owner = host ?? owningController() else { return }
    if owner.navigationItem.titleView !== rail {
      owner.navigationItem.titleView = rail
    }
  }

  private func detachRail() {
    if host?.navigationItem.titleView === rail {
      host?.navigationItem.titleView = nil
    }
  }

  private func owningController() -> UIViewController? {
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController { return controller }
      responder = current.next
    }
    return nil
  }

  /// UIPageViewController owns this scroll view's delegate. Observe offset only.
  private func observePageScrollView() {
    guard
      let scrollView = pager.view.subviews.compactMap({ $0 as? UIScrollView }).first
    else { return }
    pageScrollView = scrollView
    scrollView.isScrollEnabled = pagingEnabled
    offsetObservation = scrollView.observe(\.contentOffset, options: [.new]) { [weak self] scrollView, _ in
      let offsetX = scrollView.contentOffset.x
      let width = scrollView.bounds.width
      DispatchQueue.main.async { self?.handleScroll(offsetX: offsetX, width: width) }
    }
  }

  private func handleScroll(offsetX: CGFloat, width: CGFloat) {
    guard width > 0, pagingEnabled, boxes.count > 1 else { return }
    let signed = LodyPageProgress.signedProgress(offsetX: offsetX, width: width)
    if abs(signed) > 0.02 { rail.beginInteractiveTransition() }
    rail.setSelectionProgress(
      LodyPageProgress.selectionPosition(
        page: currentPage,
        signedProgress: signed,
        pageCount: boxes.count
      )
    )
  }

  func pageViewController(
    _ pageViewController: UIPageViewController,
    viewControllerBefore viewController: UIViewController
  ) -> UIViewController? {
    guard let index = boxes.firstIndex(where: { $0.controller === viewController }), index > 0 else {
      return nil
    }
    return boxes[index - 1].controller
  }

  func pageViewController(
    _ pageViewController: UIPageViewController,
    viewControllerAfter viewController: UIViewController
  ) -> UIViewController? {
    guard let index = boxes.firstIndex(where: { $0.controller === viewController }),
      index + 1 < boxes.count
    else { return nil }
    return boxes[index + 1].controller
  }

  func pageViewController(
    _ pageViewController: UIPageViewController,
    didFinishAnimating finished: Bool,
    previousViewControllers: [UIViewController],
    transitionCompleted completed: Bool
  ) {
    guard completed, let visible = pageViewController.viewControllers?.first,
      let index = boxes.firstIndex(where: { $0.controller === visible })
    else {
      rail.setSelected(currentPage)
      return
    }
    commit(index)
  }
}

private extension Array {
  subscript(safe index: Int) -> Element? {
    indices.contains(index) ? self[index] : nil
  }
}
