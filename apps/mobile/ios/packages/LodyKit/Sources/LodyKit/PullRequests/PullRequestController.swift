import UIKit

@MainActor
class PullRequestController: UIViewController {
  enum Page { case overview, checks, check(PullRequestCheck, String) }
  let store: PullRequestStore
  let list = LodyGroupedList(frame: .zero)
  private let page: Page
  var investigate: ((String) async throws -> Void)?
  var external: (() -> Void)?

  init(store: PullRequestStore, page: Page = .overview) {
    self.store = store
    self.page = page
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    SettingsPage.host(list, in: self) { [weak self] name, body in
      if name == "rowPress", let id = body["id"] as? String { self?.press(id) }
    }
    store.watch(self) { [weak self] in self?.render() }
    render()
    if store.data == nil, !store.loading, store.error == nil { store.refresh() }
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    if isViewLoaded { render() }
  }

  func render() {
    let data = store.data
    var sections: [LodyListSection] = []
    if data == nil || store.error != nil {
      sections.append(section("load-state", [row("pr-retry", store.error.map(PullRequestStore.errorText) ?? text("loading"),
        subtitle: store.error == nil ? "" : text("retry"), action: store.error != nil)], footer: data == nil ? "" : text("stale")))
    }
    switch page {
    case .overview:
      if let data { sections += overview(data) }
    case .checks:
      if let data { sections += checks(data) }
    case .check(let original, let sha):
      let check = data?.headSha == sha ? data?.checks.first { $0.id == original.id } ?? original : original
      if let error = data?.checksError { sections.append(section("check-error", [row("pr-check-error", PullRequestStore.errorText(error))])) }
      if data != nil {
        var line = row("pr-check-detail", check.name, subtitle: check.appName ?? "", value: text("check." + check.state))
        line.image = check.symbol; line.imageTint = "secondary"
        var footer = String.localizedStringWithFormat(String(localized: "pr.head", bundle: .lody), String(describing: String(sha.prefix(7))))
        if data?.headSha != sha { footer += "\n" + text("previousHead") }
        sections.append(section("check-state", [line], footer: footer))
      }
      sections.append(section("check-output", [row("pr-check-limit", text("logsHint"))], header: text("details")))
    }
    list.setSections(sections)
    renderHeader()
  }

  private func overview(_ data: PullRequestSnapshot) -> [LodyListSection] {
    var identity = row("pr-title", data.title, subtitle: [text("state." + data.state), data.author].filter { !$0.isEmpty }.joined(separator: " · "))
    identity.imageAsset = ["merged": "lody-git-merge", "closed": "lody-git-pull-request-closed", "draft": "lody-git-pull-request-draft"][data.state] ?? "lody-git-pull-request"
    identity.imageTint = ["merged": "purple", "closed": "danger", "draft": "secondary"][data.state] ?? "blue"
    let summary = data.summary
    let value = summary == "failed" ? String.localizedStringWithFormat(String(localized: "pr.failedCount", bundle: .lody), String(describing: data.checks.filter(\.failed).count)) : text("summary." + summary)
    var checks = row("pr-checks", text("checks"), value: value, action: true)
    checks.disclosure = true; checks.navigates = true
    checks.image = summary == "passed" ? "checkmark.circle" : "exclamationmark.circle"
    checks.imageTint = summary == "failed" ? "warning" : "secondary"
    var files = row("pr-files", text("files"))
    files.image = "doc.text"
    files.valueSegments = [("\(data.changedFiles) · ", ""), ("+\(data.additions)", "green"), (" −\(data.deletions)", "danger")].map { value, tint in
      var segment = LodyListValueSegment(); segment.text = value; segment.tint = tint; return segment
    }
    var commits = row("pr-commits", text("commits"), value: String(data.commits)); commits.imageAsset = "lody-git-commit"
    let comments = data.comments.map { row("pr-comment-\($0.id)", $0.body.isEmpty ? "—" : $0.body, subtitle: $0.author) }
    return [
      section("identity", [identity], header: data.repository, footer: "\(data.headRef) → \(data.baseRef)"),
      section("summary", [checks, files, commits], footer: String.localizedStringWithFormat(String(localized: "pr.head", bundle: .lody), String(describing: String(data.headSha.prefix(7))))),
      section("description", [row("pr-body", data.body.isEmpty ? text("noDescription") : data.body)], header: text("description")),
      section("activity", comments.isEmpty ? [row("pr-empty-comments", data.commentsError.map(PullRequestStore.errorText) ?? text("noComments"))] : comments,
              header: text("activity"), footer: text(data.commentsTruncated == true ? "moreComments" : "commentsScope")),
    ]
  }

  private func checks(_ data: PullRequestSnapshot) -> [LodyListSection] {
    var sections = [section("commit", [], footer: "\(data.repository) · #\(data.number)\n" + String.localizedStringWithFormat(String(localized: "pr.head", bundle: .lody), String(describing: String(data.headSha.prefix(7)))))]
    if data.checks.isEmpty || store.error != nil || data.checksError != nil || data.checksTruncated == true {
      let notice = (store.error ?? data.checksError).map(PullRequestStore.errorText) ?? text(data.checksTruncated == true ? "summary.partial" : "summary.empty")
      sections.append(section("check-notice", [row("pr-checks-notice", notice)]))
    }
    let groups = [("failed", data.checks.filter(\.failed)), ("active", data.checks.filter { $0.status != "completed" }),
                  ("completed", data.checks.filter { $0.status == "completed" && !$0.failed })]
    for (id, checks) in groups where !checks.isEmpty {
      sections.append(section(id, checks.map { check in
        var line = row("pr-check-\(check.id)", check.name, subtitle: [text("check." + check.state), check.appName ?? ""].filter { !$0.isEmpty }.joined(separator: " · "), action: true)
        line.image = check.symbol; line.imageTint = check.failed ? "danger" : "secondary"
        line.disclosure = true; line.navigates = true
        return line
      }, header: "\(text(id)) · \(checks.count)"))
    }
    return sections
  }

  private func renderHeader() {
    guard let parent else { return }
    let githubButton = LodySymbolButton(frame: .zero)
    githubButton.frame = CGRect(x: 0, y: 0, width: 44, height: 44)
    githubButton.widthAnchor.constraint(equalToConstant: 44).isActive = true
    githubButton.heightAnchor.constraint(equalToConstant: 44).isActive = true
    githubButton.setImageAsset("lody-mark-github")
    githubButton.setTint("blue")
    githubButton.setAccessibilityName(text("github"))
    githubButton.pressed = { [weak self] in self?.openGitHub() }
    let github = UIBarButtonItem(customView: githubButton)
    let refresh = UIBarButtonItem(image: UIImage(systemName: "arrow.clockwise"), primaryAction: UIAction { [weak self] _ in self?.store.refresh() })
    refresh.accessibilityLabel = text("refresh"); refresh.isEnabled = !store.loading && store.valid
    var right = [refresh]
    let action: UIBarButtonItem
    switch page {
    case .overview:
      action = UIBarButtonItem(title: text("comment"), primaryAction: UIAction { [weak self] _ in self?.comment() })
      action.isEnabled = store.data != nil && store.error == nil && store.valid
      let share = UIAction(title: text("share"), image: UIImage(systemName: "square.and.arrow.up")) { [weak self] _ in self?.share() }
      let menu = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [share]))
      menu.accessibilityLabel = String(localized: "common.more", bundle: .lody); right.append(menu)
    case .checks, .check:
      action = UIBarButtonItem(title: text("investigate"), primaryAction: UIAction { [weak self] _ in self?.addInvestigation() })
      action.isEnabled = store.data != nil && store.valid
    }
    parent.navigationItem.rightBarButtonItems = right
    parent.toolbarItems = [github, UIBarButtonItem(systemItem: .flexibleSpace), action]
    if navigationController?.topViewController === parent { navigationController?.setToolbarHidden(false, animated: false) }
  }

  private func press(_ id: String) {
    if id == "pr-retry" { store.refresh(); return }
    guard let data = store.data else { return }
    if id == "pr-checks" { push(.checks, title: text("checks")) }
    if let check = data.checks.first(where: { "pr-check-\($0.id)" == id }) { push(.check(check, data.headSha), title: check.name) }
  }

  private func push(_ page: Page, title: String) {
    let next = PullRequestController(store: store, page: page)
    next.investigate = investigate; next.external = external
    LodyShell.shared.pushNative(next, title: title, from: self)
  }

  private func comment() {
    let editor = PullRequestCommentController(store: store)
    LodyShell.shared.presentNative(editor, title: text("comment"), dismissible: false)
  }

  private func openGitHub() {
    guard store.valid else { return }
    if let external { external(); return }
    var url = store.url
    if case .check(let check, _) = page, let raw = check.htmlUrl, let target = URL(string: raw), target.scheme == "https", target.host?.lowercased() == "github.com" { url = target }
    UIApplication.shared.open(url) { [weak self] opened in
      if !opened { Task { @MainActor in self?.alert(self?.text("error.unavailable") ?? "") } }
    }
  }

  private func share() {
    guard store.valid else { return }
    if let external { external(); return }
    let sheet = UIActivityViewController(activityItems: [store.url], applicationActivities: nil)
    sheet.popoverPresentationController?.barButtonItem = parent?.navigationItem.rightBarButtonItems?.last
    present(sheet, animated: true)
  }

  private func addInvestigation() {
    guard store.valid, let data = store.data, let investigate else { return }
    var lines = [text("investigatePrompt"), store.url.absoluteString]
    switch page {
    case .check(let check, let sha):
      lines += ["Commit: \(sha)", "\(check.name): \(check.conclusion ?? check.status)", check.htmlUrl ?? ""]
    default: lines.append("Commit: \(data.headSha)")
    }
    Task { [weak self] in
      do {
        try await investigate(lines.filter { !$0.isEmpty }.joined(separator: "\n"))
        self?.alert(self?.text("draftAdded") ?? "", title: self?.text("investigate"))
      } catch { self?.alert(PullRequestStore.errorText(error.localizedDescription)) }
    }
  }

  func alert(_ message: String, title: String? = nil) {
    let alert = UIAlertController(title: title ?? text("preview"), message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: String(localized: "common.ok", bundle: .lody), style: .default))
    present(alert, animated: true)
  }

  private func text(_ key: String) -> String { String(localized: String.LocalizationValue("pr." + key), bundle: .lody) }
  private func row(_ id: String, _ title: String, subtitle: String = "", value: String = "", action: Bool = false) -> LodyListRow {
    var row = LodyListRow(); row.id = id; row.title = title; row.subtitle = subtitle; row.value = value; row.action = action; return row
  }
  private func section(_ id: String, _ rows: [LodyListRow], header: String = "", footer: String = "") -> LodyListSection {
    var section = LodyListSection(); section.id = id; section.rows = rows; section.header = header; section.footer = footer; return section
  }
}
