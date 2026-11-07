import UIKit

@MainActor
final class HTMLPreviewIssuesController: UIViewController {
  private let path: String
  private let issues: [[String: String]]
  private let send: @MainActor (String) async throws -> PreviewFeedbackResult
  private let openSession: @MainActor () -> Void
  private let list = LodyGroupedList(frame: .zero)
  private let footer = UIStackView()
  private let status = UILabel()
  private let button = UIButton(configuration: .filled())
  private var sending = false
  private var attempted = false

  init(
    path: String, issues: [[String: String]], send: @escaping @MainActor (String) async throws -> PreviewFeedbackResult,
    openSession: @escaping @MainActor () -> Void
  ) {
    self.path = path
    self.issues = issues
    self.send = send
    self.openSession = openSession
    super.init(nibName: nil, bundle: nil)
    title = String(localized: "html.issues.title", bundle: .lody)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyBackground
    list.frame = view.bounds
    list.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(list)
    list.setSections(issues.enumerated().map { index, issue in
      var row = LodyListRow()
      row.id = "html-issue-\(index)"
      row.title = HTMLPreviewText.issue(issue)
      row.subtitle = issue["path"] ?? ""
      row.subtitleMono = true
      row.wrapSubtitle = true
      row.image = "exclamationmark.triangle"
      row.imageTint = "warning"
      var section = LodyListSection()
      section.id = "issue-\(index)"
      section.header = issue["reference"] ?? ""
      section.rows = [row]
      return section
    })
    status.numberOfLines = 0
    status.font = .preferredFont(forTextStyle: .body)
    status.adjustsFontForContentSizeCategory = true
    status.isHidden = true
    button.configuration?.cornerStyle = .capsule
    button.addAction(UIAction { [weak self] _ in self?.pressed() }, for: .primaryActionTriggered)
    footer.axis = .vertical
    footer.spacing = 12
    footer.addArrangedSubview(status)
    footer.addArrangedSubview(button)
    footer.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(footer)
    NSLayoutConstraint.activate([
      footer.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      footer.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      footer.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -16),
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: 50),
    ])
    render()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    list.setBottomInset(view.bounds.maxY - footer.frame.minY)
  }

  override func didMove(toParent parent: UIViewController?) {
    super.didMove(toParent: parent)
    guard let host = parent?.navigationItem else { return }
    let close = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.close() })
    close.accessibilityIdentifier = "html-issues-close"
    close.accessibilityLabel = String(localized: "native.close", bundle: .lody)
    host.leftBarButtonItems = [close]
  }

  private func render() {
    let conversation = attempted && !sending
    button.accessibilityIdentifier = conversation ? "html-feedback-conversation" : "html-feedback-send"
    var key = sending ? "html.feedback.sending" : "html.feedback.send"
    if conversation { key = "html.feedback.conversation" }
    button.configuration?.title = String(localized: String.LocalizationValue(key), bundle: .lody)
    button.configuration?.baseBackgroundColor = conversation ? .secondarySystemFill : .systemBlue
    button.configuration?.baseForegroundColor = conversation ? .systemBlue : .white
    button.isEnabled = !sending
    view.setNeedsLayout()
  }

  private func show(_ text: String, error: Bool) {
    status.text = text
    status.accessibilityIdentifier = error ? "html-feedback-error" : "html-feedback-status"
    status.textColor = error ? .systemRed : .label
    status.isHidden = false
  }

  private func pressed() {
    if attempted, !sending {
      openSession()
      return
    }
    guard !sending, !attempted else { return }
    sending = true
    attempted = true
    status.isHidden = true
    render()
    let report = HTMLPreviewText.report(path: path, issues: issues)
    Task { [weak self, send] in
      let result: Result<PreviewFeedbackResult, Error>
      do { result = .success(try await send(report)) } catch { result = .failure(error) }
      guard let self else { return }
      switch result {
      case .success(let value):
        self.show(String(localized: String.LocalizationValue("html.feedback." + value.rawValue), bundle: .lody), error: false)
      case .failure(let error):
        self.show(String(localized: String.LocalizationValue(error as? PreviewFeedbackError == .pendingSend ? "html.feedback.pending" : "html.feedback.failed"), bundle: .lody), error: true)
      }
      self.sending = false
      self.render()
    }
  }

  private func close() {
    (navigationController ?? self).presentingViewController?.dismiss(animated: true)
  }
}
