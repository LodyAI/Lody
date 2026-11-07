import UIKit

final class ChatTranscriptPreviewController: UIViewController {
  private let sessionId: String
  private let sessionTitle: String
  private let userId: String
  private let workspaceId: String
  private let scroll = UIScrollView()
  private let stack = UIStackView()
  private let empty = UILabel()

  init(sessionId: String, title: String, userId: String, workspaceId: String) {
    self.sessionId = sessionId
    self.sessionTitle = title
    self.userId = userId
    self.workspaceId = workspaceId
    super.init(nibName: nil, bundle: nil)
    let size = CGSize(width: ChatTranscriptPreviewMetrics.width, height: 220)
    preferredContentSize = size
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override func loadView() {
    let root = UIView(frame: CGRect(origin: .zero, size: preferredContentSize))
    root.backgroundColor = .lodyBackground
    root.accessibilityIdentifier = "session-preview"
    root.accessibilityLabel = sessionTitle
    view = root
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    scroll.alwaysBounceVertical = true
    scroll.translatesAutoresizingMaskIntoConstraints = false
    stack.axis = .vertical
    stack.spacing = 0
    stack.translatesAutoresizingMaskIntoConstraints = false
    empty.numberOfLines = 0
    empty.textAlignment = .center
    empty.font = .preferredFont(forTextStyle: .subheadline)
    empty.textColor = .secondaryLabel
    empty.text = String(localized: "native.chat.empty.loading", bundle: .lody)
    empty.adjustsFontForContentSizeCategory = true
    empty.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll)
    view.addSubview(empty)
    scroll.addSubview(stack)
    let inset = ChatTranscriptPreviewMetrics.sectionInset
    let itemWidth = ChatTranscriptPreviewMetrics.itemWidth(
      collectionWidth: ChatTranscriptPreviewMetrics.width
    )
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 8),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: inset),
      stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -inset),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -8),
      stack.widthAnchor.constraint(equalToConstant: itemWidth),
      empty.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: inset),
      empty.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -inset),
      empty.centerYAnchor.constraint(equalTo: view.centerYAnchor),
    ])
    loadCache()
  }

  private func loadCache() {
    let userId = userId
    let workspaceId = workspaceId
    let sessionId = sessionId
    LocalStore.queue.async { [weak self] in
      var cache = ""
      if let data = try? JSONSerialization.data(
        withJSONObject: [userId, workspaceId, sessionId],
        options: [.withoutEscapingSlashes]
      ), let suffix = String(data: data, encoding: .utf8) {
        cache = (try? LocalStore.shared.read("session:" + suffix)) ?? ""
      }
      let rows = ChatTranscript.previewRows(from: cache)
      DispatchQueue.main.async {
        self?.apply(rows)
      }
    }
  }

  private func apply(_ rows: [ChatRow]) {
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    empty.text = rows.isEmpty ? String(localized: "native.chat.preview.empty", bundle: .lody) : nil
    empty.isHidden = !rows.isEmpty
    rows.forEach { stack.addArrangedSubview(Self.rowView($0)) }
    view.bounds = CGRect(origin: .zero, size: CGSize(width: ChatTranscriptPreviewMetrics.width, height: 220))
    view.layoutIfNeeded()
    let height = min(420, max(160, scroll.contentSize.height))
    let size = CGSize(width: ChatTranscriptPreviewMetrics.width, height: height)
    preferredContentSize = size
    view.bounds = CGRect(origin: .zero, size: size)
  }

  private static func rowView(_ row: ChatRow) -> UIView {
    let secondary = row.kind == "thought" || row.kind == "summary" || row.kind == "duration"
    let label = UILabel()
    label.text = [row.text, row.detail].filter { !$0.isEmpty }.joined(separator: " · ")
    label.font = messageFont(for: row)
    label.textColor = secondary ? .secondaryLabel : .label
    label.numberOfLines = row.kind == "tool_call" ? 1 : 0
    label.adjustsFontForContentSizeCategory = true
    label.adjustsFontSizeToFitWidth = false
    label.preferredMaxLayoutWidth = ChatTranscriptPreviewMetrics.textWidth(
      itemWidth: ChatTranscriptPreviewMetrics.itemWidth(collectionWidth: ChatTranscriptPreviewMetrics.width),
      hasSymbol: !row.symbol.isEmpty,
    )
    label.accessibilityIdentifier = row.id
    if row.symbol.isEmpty {
      let box = UIView()
      box.addSubview(label)
      label.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate([
        label.topAnchor.constraint(equalTo: box.topAnchor, constant: 8),
        label.leadingAnchor.constraint(equalTo: box.leadingAnchor),
        label.trailingAnchor.constraint(equalTo: box.trailingAnchor),
        label.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -8),
        box.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
      ])
      return box
    }
    let icon = UIImageView(image: UIImage(systemName: row.symbol))
    icon.tintColor = .secondaryLabel  // No warning orange in a conversation.
    icon.contentMode = .scaleAspectFit
    icon.setContentHuggingPriority(.required, for: .horizontal)
    icon.setContentCompressionResistancePriority(.required, for: .horizontal)
    let rowStack = UIStackView(arrangedSubviews: [icon, label])
    rowStack.axis = .horizontal
    rowStack.alignment = .center
    rowStack.spacing = 8
    let box = UIView()
    box.addSubview(rowStack)
    rowStack.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      icon.widthAnchor.constraint(equalToConstant: 20),
      icon.heightAnchor.constraint(equalToConstant: 20),
      rowStack.topAnchor.constraint(equalTo: box.topAnchor, constant: 8),
      rowStack.leadingAnchor.constraint(equalTo: box.leadingAnchor),
      rowStack.trailingAnchor.constraint(equalTo: box.trailingAnchor),
      rowStack.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -8),
      box.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
    ])
    return box
  }

  private static func messageFont(for row: ChatRow) -> UIFont {
    let font = UIFont.preferredFont(forTextStyle: row.kind == "summary" ? .footnote : .body)
    if row.kind == "summary" || row.kind == "duration" {
      return font.withTabularNumbers()
    }
    return font
  }
}
