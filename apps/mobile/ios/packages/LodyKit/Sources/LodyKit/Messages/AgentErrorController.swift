import UIKit

@MainActor
final class AgentErrorController: UIViewController {
  private let report: String
  private let scroll = UIScrollView()
  private let text = AgentErrorReportView()
  private lazy var copyButton = LodyFormButton.make(id: "agent-error-copy", title: Self.text("copy")) { [weak self] in
    self?.copyReport()
  }

  init(params: [String: Any]) {
    let parts = ["reason", "code", "message"].compactMap { params[$0] as? String }
      .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    report = parts.isEmpty ? Self.text("unknown") : parts.joined(separator: "\n\n")
    super.init(nibName: nil, bundle: nil)
    title = Self.text("detail")
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyBackground
    scroll.alwaysBounceVertical = true
    scroll.translatesAutoresizingMaskIntoConstraints = false
    LodyScrollEdges.navigation(scroll)
    view.addSubview(scroll)
    text.text = report
    text.font = .monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
    text.adjustsFontForContentSizeCategory = true
    text.textColor = .label
    text.backgroundColor = .clear
    text.isEditable = false
    text.isScrollEnabled = false
    text.textContainerInset = .zero
    text.textContainer.lineFragmentPadding = 0
    text.accessibilityIdentifier = "agent-error-report"
    text.accessibilityLabel = report
    copyButton.contentHorizontalAlignment = .leading
    let stack = UIStackView(arrangedSubviews: [copyButton, text])
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -16),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -20),
    ])
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    LodyScrollEdges.bind(scroll, to: self)
  }

  private func copyReport() {
    UIPasteboard.general.string = report
    copyButton.setTitle(Self.text("copied"), for: .normal)
  }

  private static func text(_ key: String) -> String { String(localized: String.LocalizationValue("native.chat.error." + key), bundle: .lody) }
}

private final class AgentErrorReportView: UITextView {
  override var accessibilityValue: String? {
    get { nil }
    set {}
  }
}
