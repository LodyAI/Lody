import UIKit

// Both layouts render the same catalog projection and keep one owner for actions.
// iPhone uses `ChatListView` (the mobile design-system list); the iPad sidebar keeps `LodySidebar`.
@MainActor
final class SessionListView: UIView {
  private let grouped = ChatListView(frame: .zero)
  private let sidebar = LodySidebar(frame: .zero)
  private let retry = UIButton(type: .system)
  private var retryAction: (() -> Void)?
  var forwarded: ((String, [String: Any]) -> Void)?
  var selectedSessionId = "" { didSet { sidebar.setSelectedRowId(selectedSessionId) } }
  private var sections: [LodyListSection] = []
  private var regular: Bool { traitCollection.horizontalSizeClass == .regular }
  override init(frame: CGRect) {
    super.init(frame: frame)
    retry.setTitle(String(localized: "workspace.mode.retry", bundle: .lody), for: .normal)
    retry.accessibilityIdentifier = "workspace-mode-retry"
    retry.isHidden = true
    retry.addAction(UIAction { [weak self] _ in self?.retryAction?() }, for: .primaryActionTriggered)
    addSubview(retry)
    grouped.forwarded = { [weak self] name, body in self?.forwarded?(name, body) }
    sidebar.onRowPress = { [weak self] body in self?.forwarded?("rowPress", body) }
    sidebar.onRowAction = { [weak self] body in self?.forwarded?("rowAction", body) }
    registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (self: Self, _: UITraitCollection) in self.applyLayout() }
    applyLayout()
  }
  required init?(coder: NSCoder) { fatalError() }
  convenience init() { self.init(frame: .zero) }
  override func layoutSubviews() {
    super.layoutSubviews(); grouped.frame = bounds; sidebar.frame = bounds
    retry.frame = CGRect(x: 20, y: bounds.midY + 60, width: max(0, bounds.width - 40), height: 44)
  }
  func setRetry(_ action: (() -> Void)?) {
    retryAction = action
    retry.isHidden = action == nil || sections.contains { !$0.rows.isEmpty }
  }
  private func applyLayout() {
    let active: UIView = regular ? sidebar : grouped
    let retired: UIView = regular ? grouped : sidebar
    retired.removeFromSuperview()
    if active.superview == nil { addSubview(active) }
    active.frame = bounds; active.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    bringSubviewToFront(retry)
    render()
  }
  var scrollView: UIScrollView { regular ? sidebar.scrollView : grouped.collection }
  var sidebarScrollView: UIScrollView { sidebar.scrollView }
  func setOwners(_ value: [String: WorkspaceMember]) { grouped.owners = value }
  func setContentStyle(_ value: Bool) {}
  /// Archived mode restyles both layouts: darker, greyer page and grey rows.
  func setArchivedStyle(_ value: Bool) { grouped.archivedStyle = value; sidebar.archivedStyle = value }
  func setPreviewUserId(_ value: String) { sidebar.previewUserId = value }
  func setPreviewWorkspaceId(_ value: String) { sidebar.previewWorkspaceId = value }
  /// Home pins the current group's label; search results keep labels in the flow.
  func setProjectIndexEnabled(_ value: Bool) { grouped.projectIndexEnabled = value }
  func setPinsGroupLabels(_ value: Bool) { grouped.pinsGroupLabels = value }
  func setPlaceholder(_ value: String) { grouped.setPlaceholder(value); sidebar.setPlaceholder(value) }
  func setSections(_ value: [LodyListSection]) { sections = value; setRetry(retryAction); render() }
  private func render() {
    if regular { sidebar.setSections(sections) }
    else { grouped.setSections(sections) }
  }
}
