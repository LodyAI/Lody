import UIKit

// Every size class renders the same `ChatListView` (the mobile design-system list); the
// iPad / iPhone Duo split only adds the highlight of the conversation shown beside it.
@MainActor
final class SessionListView: UIView {
  private let list = ChatListView(frame: .zero)
  private let retry = UIButton(type: .system)
  private var retryAction: (() -> Void)?
  private var hasRows = false
  private var onboarding: HomeOnboardingView?
  /// Presents the first-run guide's share sheet.
  var shareOnboarding: (([Any], UIView) -> Void)?
  var forwarded: ((String, [String: Any]) -> Void)?
  var selectedSessionId: String {
    get { list.selectedRowId }
    set { list.selectedRowId = newValue }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    list.forwarded = { [weak self] name, body in self?.forwarded?(name, body) }
    addSubview(list)
    retry.setTitle(String(localized: "workspace.mode.retry", bundle: .lody), for: .normal)
    retry.accessibilityIdentifier = "workspace-mode-retry"
    retry.isHidden = true
    retry.addAction(UIAction { [weak self] _ in self?.retryAction?() }, for: .primaryActionTriggered)
    addSubview(retry)
  }

  required init?(coder: NSCoder) { fatalError() }
  convenience init() { self.init(frame: .zero) }

  override func layoutSubviews() {
    super.layoutSubviews()
    list.frame = bounds
    retry.frame = CGRect(x: 20, y: bounds.midY + 60, width: max(0, bounds.width - 40), height: 44)
    onboarding?.frame = bounds
  }

  /// The visible scroll view: the first-run guide while it stands in for the empty list.
  var scrollView: UIScrollView { onboarding?.scrollView ?? list.collection }
  /// Replaces the empty Chats list with the first-run guide; returns whether the scroll view changed.
  @discardableResult
  func setOnboarding(_ shown: Bool) -> Bool {
    guard shown != (onboarding != nil) else { return false }
    if shown {
      let guide = HomeOnboardingView(frame: bounds)
      guide.share = { [weak self] items, source in self?.shareOnboarding?(items, source) }
      addSubview(guide)
      onboarding = guide
    } else {
      onboarding?.removeFromSuperview()
      onboarding = nil
    }
    list.isHidden = shown
    return true
  }
  func setRetry(_ action: (() -> Void)?) {
    retryAction = action
    retry.isHidden = action == nil || hasRows
  }
  func setOwners(_ value: [String: WorkspaceMember]) { list.owners = value }
  /// Archived mode: darker, greyer page and grey rows.
  func setArchivedStyle(_ value: Bool) { list.archivedStyle = value }
  func setProjectIndexEnabled(_ value: Bool) { list.projectIndexEnabled = value }
  /// Home pins and collapses group labels; search labels stay in the flow.
  func setPinsGroupLabels(_ value: Bool) { list.pinsGroupLabels = value }
  func setPlaceholder(_ value: String) { list.setPlaceholder(value) }
  func setSections(_ value: [LodyListSection]) {
    hasRows = value.contains { !$0.rows.isEmpty }
    list.setSections(value)
    setRetry(retryAction)
  }
}
