import UIKit

// Both layouts render the same catalog projection and keep one owner for actions.
// iPhone uses `ChatListView` (the mobile design-system list); the iPad sidebar keeps `LodySidebar`.
@MainActor
final class SessionListView: UIView {
  private let grouped = ChatListView(frame: .zero)
  private let sidebar = LodySidebar(frame: .zero)
  var forwarded: ((String, [String: Any]) -> Void)?
  var selectedSessionId = "" { didSet { sidebar.setSelectedRowId(selectedSessionId) } }
  private var sections: [LodyListSection] = []
  private var regular: Bool { traitCollection.horizontalSizeClass == .regular }
  override init(frame: CGRect) {
    super.init(frame: frame)
    grouped.forwarded = { [weak self] name, body in self?.forwarded?(name, body) }
    sidebar.onRowPress = { [weak self] body in self?.forwarded?("rowPress", body) }
    sidebar.onRowAction = { [weak self] body in self?.forwarded?("rowAction", body) }
    registerForTraitChanges([UITraitHorizontalSizeClass.self]) { (self: Self, _: UITraitCollection) in self.applyLayout() }
    applyLayout()
  }
  required init?(coder: NSCoder) { fatalError() }
  convenience init() { self.init(frame: .zero) }
  override func layoutSubviews() { super.layoutSubviews(); subviews.forEach { $0.frame = bounds } }
  private func applyLayout() {
    let active: UIView = regular ? sidebar : grouped
    let retired: UIView = regular ? grouped : sidebar
    retired.removeFromSuperview()
    if active.superview == nil { addSubview(active) }
    active.frame = bounds; active.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    render()
  }
  var scrollView: UIScrollView { regular ? sidebar.scrollView : grouped.collection }
  var sidebarScrollView: UIScrollView { sidebar.scrollView }
  func setOwners(_ value: [String: WorkspaceMember]) { grouped.owners = value }
  func setContentStyle(_ value: Bool) {}
  func setPreviewUserId(_ value: String) { sidebar.previewUserId = value }
  func setPreviewWorkspaceId(_ value: String) { sidebar.previewWorkspaceId = value }
  /// Home pins the current group's label; search results keep labels in the flow.
  func setPinsGroupLabels(_ value: Bool) { grouped.pinsGroupLabels = value }
  func setPlaceholder(_ value: String) { grouped.setPlaceholder(value); sidebar.setPlaceholder(value) }
  func setSections(_ value: [LodyListSection]) { sections = value; render() }
  private func render() {
    if regular { sidebar.setSections(sections) }
    else { grouped.setSections(sections) }
  }
}
