import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
    let split = UISplitViewController(style: .doubleColumn)
    split.primaryBackgroundStyle = .sidebar
    split.preferredDisplayMode = .oneBesideSecondary
    let sidebar = Sidebar()
    let navigation = UINavigationController(rootViewController: sidebar)
    navigation.view.accessibilityIdentifier = "poc-column"
    split.setViewController(navigation, for: .primary)
    let detail = UIViewController()
    detail.view.backgroundColor = .systemBackground
    let label = UILabel()
    label.text = "Detail remains outside the sidebar"
    label.textAlignment = .center
    label.translatesAutoresizingMaskIntoConstraints = false
    detail.view.addSubview(label)
    NSLayoutConstraint.activate([
      label.centerXAnchor.constraint(equalTo: detail.view.safeAreaLayoutGuide.centerXAnchor),
      label.centerYAnchor.constraint(equalTo: detail.view.centerYAnchor),
    ])
    split.setViewController(UINavigationController(rootViewController: detail), for: .secondary)
    window = UIWindow(frame: UIScreen.main.bounds)
    window?.rootViewController = split
    window?.makeKeyAndVisible()
    return true
  }
}

final class Sidebar: UITableViewController, UIViewControllerTransitioningDelegate {
  let modes = ["System formSheet", "System sourceView", "System compact traits", "Custom local presentation", "Toggle bottom Glass search"]
  let search = UISearchController(searchResultsController: nil)
  var customSearch: UIVisualEffectView?
  init() { super.init(style: .insetGrouped) }
  required init?(coder: NSCoder) { fatalError() }
  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Sidebar POC"
    view.accessibilityIdentifier = "poc-sidebar"
    tableView.backgroundColor = .clear
    search.searchBar.placeholder = "Search projects"
    search.obscuresBackgroundDuringPresentation = false
    navigationItem.searchController = search
    navigationItem.preferredSearchBarPlacement = .integrated
    navigationItem.hidesSearchBarWhenScrolling = false
    let add = UIBarButtonItem(systemItem: .add, primaryAction: UIAction { [weak self] _ in self?.showSheet(1) })
    add.accessibilityLabel = "New Session"
    add.sharesBackground = false
    toolbarItems = [navigationItem.searchBarPlacementBarButtonItem, .fixedSpace(6), add]
    navigationController?.setToolbarHidden(false, animated: false)
    definesPresentationContext = true
  }
  override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { modes.count }
  override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
    let cell = UITableViewCell(style: .default, reuseIdentifier: nil)
    cell.textLabel?.text = modes[indexPath.row]
    cell.textLabel?.font = .preferredFont(forTextStyle: .subheadline)
    cell.accessibilityIdentifier = "mode-\(indexPath.row)"
    return cell
  }
  override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
    tableView.deselectRow(at: indexPath, animated: true)
    if indexPath.row == 4 { toggleSearch(); return }
    showSheet(indexPath.row)
  }
  func showSheet(_ mode: Int) {
    let content = Form()
    let sheet = UINavigationController(rootViewController: content)
    sheet.preferredContentSize = CGSize(width: view.bounds.width, height: 600)
    if mode == 3 {
      view.endEditing(true)
      navigationController?.view.endEditing(true)
      definesPresentationContext = false
      navigationController?.definesPresentationContext = true
      sheet.modalPresentationStyle = .custom
      sheet.transitioningDelegate = self
    } else {
      sheet.modalPresentationStyle = .formSheet
      let presentation = sheet.sheetPresentationController!
      presentation.detents = [.medium(), .large()]
      presentation.prefersGrabberVisible = true
      if mode >= 1 { presentation.sourceView = navigationController!.view }
      if mode == 2 { presentation.overrideTraitCollection = UITraitCollection(horizontalSizeClass: .compact) }
    }
    if mode == 3 {
      navigationController?.present(sheet, animated: true)
    } else {
      definesPresentationContext = true
      present(sheet, animated: true)
    }
  }
  func toggleSearch() {
    if let customSearch {
      customSearch.removeFromSuperview()
      self.customSearch = nil
      navigationItem.searchController = search
      navigationController?.setToolbarHidden(false, animated: false)
      return
    }
    navigationItem.searchController = nil
    navigationController?.setToolbarHidden(true, animated: false)
    let container = UIVisualEffectView(effect: UIGlassContainerEffect())
    container.translatesAutoresizingMaskIntoConstraints = false
    let field = UISearchTextField()
    field.placeholder = "Search projects"
    field.borderStyle = .none
    field.backgroundColor = .clear
    field.accessibilityIdentifier = "bottom-search"
    let glass = UIVisualEffectView(effect: UIGlassEffect(style: .regular))
    glass.cornerConfiguration = .capsule()
    glass.contentView.addSubview(field)
    field.translatesAutoresizingMaskIntoConstraints = false
    let add = UIButton(configuration: .glass(), primaryAction: UIAction { [weak self] _ in self?.showSheet(3) })
    add.setImage(UIImage(systemName: "plus"), for: .normal)
    add.accessibilityLabel = "Glass New Session"
    let stack = UIStackView(arrangedSubviews: [glass, add])
    stack.spacing = 8
    stack.translatesAutoresizingMaskIntoConstraints = false
    container.contentView.addSubview(stack)
    navigationController!.view.addSubview(container)
    NSLayoutConstraint.activate([
      container.leadingAnchor.constraint(equalTo: navigationController!.view.leadingAnchor, constant: 12),
      container.trailingAnchor.constraint(equalTo: navigationController!.view.trailingAnchor, constant: -12),
      container.bottomAnchor.constraint(equalTo: navigationController!.view.keyboardLayoutGuide.topAnchor, constant: -8),
      container.heightAnchor.constraint(equalToConstant: 48),
      stack.leadingAnchor.constraint(equalTo: container.contentView.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: container.contentView.trailingAnchor),
      stack.topAnchor.constraint(equalTo: container.contentView.topAnchor),
      stack.bottomAnchor.constraint(equalTo: container.contentView.bottomAnchor),
      add.widthAnchor.constraint(equalToConstant: 48),
      field.leadingAnchor.constraint(equalTo: glass.contentView.leadingAnchor, constant: 12),
      field.trailingAnchor.constraint(equalTo: glass.contentView.trailingAnchor, constant: -12),
      field.centerYAnchor.constraint(equalTo: glass.contentView.centerYAnchor),
    ])
    customSearch = container
  }
  func presentationController(forPresented presented: UIViewController, presenting: UIViewController?, source: UIViewController) -> UIPresentationController? {
    LocalPresentation(presentedViewController: presented, presenting: presenting, sidebar: navigationController!.view)
  }
}

final class Form: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    title = "New Session"
    view.backgroundColor = .secondarySystemGroupedBackground
    view.accessibilityIdentifier = "poc-form"
    navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
    let field = UITextField()
    field.placeholder = "Describe what you want to do"
    field.borderStyle = .roundedRect
    field.accessibilityIdentifier = "poc-input"
    let label = UILabel()
    label.text = "Project · Lody iOS\n\nAgent · Fixture Agent\n\nModel · Default"
    label.numberOfLines = 0
    [label, field].forEach { view.addSubview($0); $0.translatesAutoresizingMaskIntoConstraints = false }
    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
      label.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 20),
      label.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -20),
      field.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      field.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      field.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor, constant: -12),
      field.heightAnchor.constraint(equalToConstant: 44),
    ])
  }
}

// ponytail: POC has two header-driven detents; scroll handoff belongs in product integration.
final class LocalPresentation: UIPresentationController {
  weak var sidebar: UIView?
  let dimming = UIControl()
  let grabber = UIView()
  var expansion: CGFloat = 0
  var dragStart: CGFloat = 0
  var hiddenBackground: [(UIView, Bool)] = []
  init(presentedViewController: UIViewController, presenting: UIViewController?, sidebar: UIView) {
    self.sidebar = sidebar
    super.init(presentedViewController: presentedViewController, presenting: presenting)
  }
  override var shouldPresentInFullscreen: Bool { false }
  var sidebarFrame: CGRect { sidebar.map { $0.convert($0.bounds, to: containerView) } ?? .zero }
  override var frameOfPresentedViewInContainerView: CGRect {
    let frame = sidebarFrame
    let inset = 10 * (1 - expansion)
    let top = frame.minY + frame.height * 0.38 * (1 - expansion)
    return CGRect(x: frame.minX + inset, y: top, width: frame.width - inset * 2, height: frame.maxY - inset - top)
  }
  override func presentationTransitionWillBegin() {
    // Navigation chrome is outside the child content's modal accessibility scope.
    hiddenBackground = sidebar?.subviews.filter { $0 !== containerView }.map { ($0, $0.accessibilityElementsHidden) } ?? []
    hiddenBackground.forEach { $0.0.accessibilityElementsHidden = true }
    dimming.backgroundColor = UIColor.black.withAlphaComponent(0.18)
    dimming.addAction(UIAction { [weak self] _ in self?.presentedViewController.dismiss(animated: true) }, for: .touchUpInside)
    containerView?.insertSubview(dimming, at: 0)
    presentedView?.layer.cornerRadius = 24
    presentedView?.clipsToBounds = true
    presentedView?.accessibilityViewIsModal = true
    containerView?.accessibilityViewIsModal = true
    presentedViewController.additionalSafeAreaInsets.top = 14
    grabber.backgroundColor = .tertiaryLabel
    grabber.layer.cornerRadius = 2.5
    grabber.isAccessibilityElement = true
    grabber.accessibilityLabel = "Resize sheet"
    grabber.accessibilityIdentifier = "poc-grabber"
    grabber.accessibilityCustomActions = [
      UIAccessibilityCustomAction(name: "Expand sheet") { [weak self] _ in self?.settle(at: 1); return true },
      UIAccessibilityCustomAction(name: "Collapse sheet") { [weak self] _ in self?.settle(at: 0); return true },
    ]
    presentedView?.addSubview(grabber)
    let pan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
    (presentedViewController as? UINavigationController)?.navigationBar.addGestureRecognizer(pan)
    let grabberPan = UIPanGestureRecognizer(target: self, action: #selector(drag(_:)))
    presentedView?.addGestureRecognizer(grabberPan)
    grabberPan.delegate = self
  }
  override func containerViewWillLayoutSubviews() {
    super.containerViewWillLayoutSubviews()
    dimming.frame = sidebarFrame
    presentedView?.frame = frameOfPresentedViewInContainerView
    grabber.frame = CGRect(x: (presentedView?.bounds.midX ?? 0) - 18, y: 5, width: 36, height: 5)
    presentedView?.bringSubviewToFront(grabber)
    presentedView?.layer.cornerRadius = 24 * (1 - expansion)
  }
  @objc func drag(_ gesture: UIPanGestureRecognizer) {
    let travel = sidebarFrame.height * 0.38
    guard travel > 0 else { return }
    if gesture.state == .began { dragStart = expansion }
    expansion = min(1, max(0, dragStart - gesture.translation(in: containerView).y / travel))
    containerViewWillLayoutSubviews()
    if gesture.state == .ended || gesture.state == .cancelled {
      let projected = expansion - gesture.velocity(in: containerView).y / travel * 0.15
      settle(at: projected > 0.5 ? 1 : 0)
    }
  }
  func settle(at value: CGFloat) {
    expansion = value
    UIView.animate(withDuration: 0.35, delay: 0, usingSpringWithDamping: 0.9, initialSpringVelocity: 0) {
      self.containerViewWillLayoutSubviews()
      self.presentedView?.layoutIfNeeded()
    }
  }
  override func dismissalTransitionDidEnd(_ completed: Bool) {
    if completed {
      dimming.removeFromSuperview()
      hiddenBackground.forEach { $0.0.accessibilityElementsHidden = $0.1 }
      hiddenBackground.removeAll()
    }
  }
}

extension LocalPresentation: UIGestureRecognizerDelegate {
  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    touch.location(in: presentedView).y < 14
  }
}
