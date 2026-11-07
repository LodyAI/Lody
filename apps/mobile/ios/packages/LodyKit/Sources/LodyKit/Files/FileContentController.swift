import UIKit

@MainActor
class FileContentController: UIViewController {
  private static let errors = [
    "too_large": "native.file.error.tooLarge",
    "file_not_found": "native.file.error.notFound",
    "permission_denied": "native.file.error.permissionDenied",
    "path_not_allowed": "native.file.error.pathNotAllowed",
    "decode_error": "native.file.error.decode",
  ]

  let sessionId: String
  let path: String
  let line: Int?
  let feedback: PreviewFeedback?
  let service: FileContentService
  private let html: Bool
  private let markdown: Bool
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let notice = UIContentUnavailableView(configuration: .empty())
  private let summary = FileIssuesSummary()
  private let content = UIView()
  private var body: UIView?
  private var handle: String?
  private var text: String?
  private var error = ""
  private var issues: [[String: String]] = []
  private var source: Bool
  private var load: Task<Void, Never>?
  private var opening = false
  private var probeWrite: Task<Void, Never>?

  init(sessionId: String, path: String, line: Int? = nil, preview: Bool = false, feedback: PreviewFeedback? = nil, service: FileContentService = .live) {
    self.sessionId = sessionId
    self.path = path
    self.line = line
    self.feedback = feedback
    self.service = service
    html = HTMLPreviewText.isHTML(path)
    markdown = ["md", "markdown", "mdx"].contains((path as NSString).pathExtension.lowercased())
    source = (line ?? 0) > 0 || (html && !preview)
    super.init(nibName: nil, bundle: nil)
    title = FilePathText.basename(path)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    load?.cancel()
    probeWrite?.cancel()
  }

  static func open(
    sessionId: String, path: String, line: Int? = nil, feedback: PreviewFeedback? = nil,
    service: FileContentService = .live, from controller: UIViewController
  ) async {
    guard !sessionId.isEmpty, !path.isEmpty else { return }
    if await service.quickLook(sessionId, path, controller) { return }
    let content = FileContentController(sessionId: sessionId, path: path, line: line, feedback: feedback, service: service)
    LodyShell.shared.presentDetail(content, title: FilePathText.basename(path), from: controller, detents: [1])
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyBackground
    spinner.accessibilityIdentifier = "file-loading"
    for subview in [spinner, notice] {
      subview.frame = content.bounds
      subview.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      content.addSubview(subview)
    }
    summary.addAction(UIAction { [weak self] _ in self?.showIssues() }, for: .primaryActionTriggered)
    let stack = UIStackView(arrangedSubviews: [content, summary])
    stack.axis = .vertical
    stack.frame = view.bounds
    stack.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(stack)
    reload()
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    renderHeader()
  }

  private func reload() {
    load?.cancel()
    handle = nil
    text = nil
    error = ""
    issues = []
    render()
    load = Task { [weak self, sessionId, path, html, service] in
      do {
        let read = try await service.read(sessionId, path)
        guard !Task.isCancelled, let self else { return }
        switch read {
        case .failed(let code):
          if html { self.issues = [["reference": path, "path": path, "kind": "document", "code": code]] }
          self.error = String(localized: String.LocalizationValue(Self.errors[code] ?? "native.file.error.read"), bundle: .lody)
        case .ok(let handle):
          guard let data = ContentStore.shared.get(handle)?.data, let contents = String(data: data, encoding: .utf8) else {
            self.error = String(localized: "native.file.error.stale", bundle: .lody)
            break
          }
          self.handle = handle
          self.text = contents
        }
        self.render()
      } catch {
        guard !Task.isCancelled, let self else { return }
        self.error = String(localized: "native.file.error.read", bundle: .lody)
        if html { self.issues = [["reference": path, "path": path, "kind": "document", "code": HTMLPreviewText.readError(error)]] }
        self.render()
      }
    }
  }

  private func render() {
    body?.removeFromSuperview()
    body = nil
    spinner.stopAnimating()
    notice.isHidden = true
    if !error.isEmpty {
      var configuration = UIContentUnavailableConfiguration.empty()
      configuration.text = error
      configuration.button = .gray()
      configuration.button.title = String(localized: "common.retry", bundle: .lody)
      configuration.buttonProperties.primaryAction = UIAction { [weak self] _ in self?.reload() }
      if html, !issues.isEmpty {
        configuration.secondaryButton = .plain()
        configuration.secondaryButton.title = String(localized: "html.issues.title", bundle: .lody)
        configuration.secondaryButtonProperties.primaryAction = UIAction { [weak self] _ in self?.showIssues() }
      }
      notice.configuration = configuration
      notice.isHidden = false
    } else if let handle, let text {
      let next = makeBody(handle: handle, text: text)
      next.frame = content.bounds
      next.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      content.addSubview(next)
      body = next
    } else {
      spinner.startAnimating()
    }
    renderSummary()
    renderHeader()
  }

  private func makeBody(handle: String, text: String) -> UIView {
    if html, !source {
      let preview = LodyHTMLPreviewView(frame: .zero)
      preview.failed = { [weak self] code in self?.htmlFailed(code) }
      preview.issuesChanged = { [weak self] issues in
        self?.issues = issues
        self?.renderSummary()
      }
      preview.resourceRequested = { [weak self, weak preview] id, path in
        guard let self, let preview else { return }
        self.serve(id: id, path: path, to: preview, handle: handle)
      }
      preview.setHandle(handle)
      return preview
    }
    if markdown, !source {
      let document = LodyMarkdownDocumentView(frame: .zero)
      document.failed = { [weak self] in
        self?.error = String(localized: "native.file.error.stale", bundle: .lody)
        self?.render()
      }
      document.filePressed = { [weak self] href, line in self?.openLink(href, line: line) }
      document.setHandle(handle)
      return document
    }
    let document = DiffDocumentView()
    document.collectionView.contentInsetAdjustmentBehavior = .automatic
    document.collectionView.accessibilityIdentifier = "file-source-loading"
    LodyScrollEdges.navigation(document.collectionView)
    document.onRender = { [weak self, weak document] in
      document?.collectionView.accessibilityIdentifier = "file-source"
      self?.writeProbe(document, handle: handle)
    }
    document.onScroll = { [weak self, weak document] in self?.writeProbe(document, handle: handle) }
    document.show(path: path, old: "", new: text, mode: .file(line: (line ?? 0) > 0 ? line : nil))
    LodyScrollEdges.bind(document.collectionView, to: self)
    return document
  }

  private func serve(id: String, path: String, to preview: LodyHTMLPreviewView, handle: String) {
    Task { [weak self, weak preview, sessionId, service] in
      var reply = ["id": id]
      do {
        switch try await service.read(sessionId, path) {
        case .ok(let resource): reply["handle"] = resource
        case .failed(let code): reply["code"] = code
        }
      } catch {
        reply["code"] = HTMLPreviewText.readError(error)
      }
      guard let self, self.handle == handle, !self.source, let preview else { return }
      preview.respond([reply])
    }
  }

  private func htmlFailed(_ code: String) {
    if issues.isEmpty { issues = [["reference": path, "path": path, "kind": "document", "code": code]] }
    error = String(localized: "html.error.resource", bundle: .lody)
    render()
  }

  private func renderSummary() {
    let visible = html && !source && error.isEmpty && body != nil && !issues.isEmpty
    summary.isHidden = !visible
    if visible { summary.configure(count: issues.count) }
  }

  private func renderHeader() {
    guard let host = parent?.navigationItem else { return }
    host.title = title
    let close = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.close() })
    close.accessibilityIdentifier = "file-back"
    close.accessibilityLabel = String(localized: "native.close", bundle: .lody)
    host.leftBarButtonItems = [close]
    guard handle != nil, error.isEmpty, markdown || html else {
      host.rightBarButtonItems = []
      return
    }
    let label = String(localized: String.LocalizationValue(source ? "file.preview" : "file.source"), bundle: .lody)
    let toggle: UIBarButtonItem
    if html {
      toggle = UIBarButtonItem(image: UIImage(systemName: source ? "eye" : "doc.text"), primaryAction: UIAction { [weak self] _ in self?.toggle() })
    } else {
      toggle = UIBarButtonItem(title: label, primaryAction: UIAction { [weak self] _ in self?.toggle() })
    }
    toggle.accessibilityIdentifier = "file-preview-toggle"
    toggle.accessibilityLabel = label
    host.rightBarButtonItems = [toggle]
  }

  private func toggle() {
    let reload = html && source
    source.toggle()
    if reload { self.reload() } else { render() }
  }

  private func close(then completion: (() -> Void)? = nil) {
    if HomeController.current?.closePanel(from: self) == true { completion?(); return }
    let sheet = navigationController ?? self
    guard let presenter = sheet.presentingViewController else { completion?(); return }
    presenter.dismiss(animated: true, completion: completion)
  }

  private func showIssues() {
    let feedback = feedback
    let send: @MainActor (String) async throws -> PreviewFeedbackResult = { report in
      guard let feedback else { throw PreviewFeedbackError.unavailable }
      return try await feedback.send(report)
    }
    let sheet = HTMLPreviewIssuesController(path: path, issues: issues, send: send) { [weak self] in
      let open = self?.feedback?.openSession
      self?.close { open?() }
    }
    LodyShell.shared.presentNative(sheet, title: String(localized: "html.issues.title", bundle: .lody), grabber: true)
  }

  private func openLink(_ href: String, line: Int) {
    guard !opening else { return }
    let parent = path.replacingOccurrences(of: #"[^/\\]+$"#, with: "", options: .regularExpression)
    let absolute = href.range(of: #"^(/|[A-Za-z]:[\\/])"#, options: .regularExpression) != nil
    opening = true
    Task { [weak self, sessionId, feedback, service] in
      guard let self else { return }
      await Self.open(
        sessionId: sessionId, path: absolute ? href : parent + href, line: line > 0 ? line : nil,
        feedback: feedback, service: service, from: self
      )
      self.opening = false
    }
  }

  private func writeProbe(_ document: DiffDocumentView?, handle: String) {
    guard LodyUIVerify.enabled, let document else { return }
    probeWrite?.cancel()
    probeWrite = Task { [weak document] in
      try? await Task.sleep(for: .milliseconds(100))
      guard !Task.isCancelled, let document else { return }
      var value = document.probe()
      value["handle"] = handle
      guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
      try? data.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("lody-file-source.json"), options: .atomic)
    }
  }
}

private final class FileIssuesSummary: UIButton {
  private let title = UILabel()
  private let detail = UILabel()

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .secondarySystemGroupedBackground
    isAccessibilityElement = true
    accessibilityIdentifier = "html-issues-summary"
    accessibilityTraits = .button
    let warning = UIImageView(image: UIImage(systemName: "exclamationmark.triangle"))
    warning.tintColor = .systemOrange
    let chevron = UIImageView(image: UIImage(systemName: "chevron.right"))
    chevron.tintColor = .tertiaryLabel
    title.font = .preferredFont(forTextStyle: .body)
    detail.font = .preferredFont(forTextStyle: .footnote)
    detail.textColor = .secondaryLabel
    detail.text = String(localized: "html.issues.incomplete", bundle: .lody)
    for label in [title, detail] {
      label.numberOfLines = 0
      label.adjustsFontForContentSizeCategory = true
    }
    let labels = UIStackView(arrangedSubviews: [title, detail])
    labels.axis = .vertical
    labels.spacing = 4
    let row = UIStackView(arrangedSubviews: [warning, labels, chevron])
    row.alignment = .center
    row.spacing = 12
    row.isUserInteractionEnabled = false
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      warning.widthAnchor.constraint(equalToConstant: 24),
      chevron.widthAnchor.constraint(equalToConstant: 12),
      row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
      row.topAnchor.constraint(equalTo: topAnchor, constant: 16),
      row.bottomAnchor.constraint(equalTo: safeAreaLayoutGuide.bottomAnchor, constant: -16),
      heightAnchor.constraint(greaterThanOrEqualToConstant: 56),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func configure(count: Int) {
    title.text = String.localizedStringWithFormat(String(localized: "html.issues.count", bundle: .lody), count)
    accessibilityLabel = title.text
  }
}
