import ChatKit
import UIKit

final class ChatOverlay: UIView {
  enum Slot: Equatable {
    case idle
    case connecting
    case paused
  }

  static let controlSize: CGFloat = 44
  static let visualSize: CGFloat = 30
  static let tasksProcessStartID = "__tasks__"

  static func slot(connection: String) -> Slot {
    if connection == "paused" { return .paused }
    if connection == "connecting" { return .connecting }
    return .idle
  }

  var slot = Slot.idle {
    didSet {
      guard oldValue != slot else { return }
      apply()
    }
  }
  var scrollVisible = false {
    didSet {
      guard oldValue != scrollVisible else { return }
      apply()
    }
  }
  var onReconnect: (() -> Void)?
  var onScrollToBottom: (() -> Void)?

  private let statusSurface = CKGlassSurface(interactive: true)
  private let scrollHost = UIView()
  private let scrollSurface = CKGlassSurface(interactive: true)
  private let statusButton = UIButton(type: .system)
  private let scrollButton = UIButton(type: .system)

  override init(frame: CGRect) {
    super.init(frame: frame)
    isHidden = true
    isUserInteractionEnabled = false
    statusSurface.cornerConfiguration = .capsule()
    scrollSurface.cornerConfiguration = .capsule()
    scrollHost.isUserInteractionEnabled = false
    addSubview(statusSurface)
    addSubview(scrollHost)
    scrollHost.addSubview(scrollSurface)
    for surface in [statusSurface, scrollSurface] {
      surface.onHidden = { [weak self] in
        guard let self else { return }
        self.isHidden = self.statusSurface.isHidden && self.scrollSurface.isHidden
      }
    }
    statusSurface.contentView.addSubview(statusButton)
    scrollSurface.contentView.addSubview(scrollButton)
    [statusSurface, scrollHost, scrollSurface, statusButton, scrollButton].forEach {
      $0.translatesAutoresizingMaskIntoConstraints = false
    }
    var statusConfiguration = UIButton.Configuration.plain()
    statusConfiguration.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12)
    statusConfiguration.titleLineBreakMode = .byTruncatingTail
    statusConfiguration.baseForegroundColor = .label
    statusConfiguration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
      var outgoing = incoming
      outgoing.font = UIFont.preferredFont(forTextStyle: .subheadline)
      return outgoing
    }
    statusButton.configuration = statusConfiguration
    statusButton.accessibilityIdentifier = "chat-overlay-status"
    statusButton.setContentHuggingPriority(.required, for: .horizontal)
    statusSurface.setContentHuggingPriority(.required, for: .horizontal)
    statusButton.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      switch self.slot {
      case .paused: self.onReconnect?()
      default: break
      }
    }, for: .touchUpInside)
    var scrollConfiguration = UIButton.Configuration.plain()
    scrollConfiguration.contentInsets = .zero
    let scrollSymbol = UIImage.SymbolConfiguration(pointSize: 14, weight: .bold, scale: .medium)
    scrollConfiguration.image = UIImage(systemName: "arrow.down", withConfiguration: scrollSymbol)
    scrollConfiguration.preferredSymbolConfigurationForImage = scrollSymbol
    scrollConfiguration.baseForegroundColor = .label
    scrollButton.configuration = scrollConfiguration
    scrollButton.accessibilityLabel = String(localized: "native.chat.scrollToBottom", bundle: .lody)
    scrollButton.accessibilityIdentifier = "chat-scroll-to-bottom"
    scrollButton.addAction(UIAction { [weak self] _ in self?.onScrollToBottom?() }, for: .touchUpInside)
    NSLayoutConstraint.activate([
      statusSurface.centerXAnchor.constraint(equalTo: centerXAnchor),
      statusSurface.bottomAnchor.constraint(equalTo: bottomAnchor),
      statusSurface.trailingAnchor.constraint(lessThanOrEqualTo: scrollHost.leadingAnchor, constant: -8),
      scrollHost.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -2),
      scrollHost.bottomAnchor.constraint(equalTo: bottomAnchor),
      scrollHost.widthAnchor.constraint(equalToConstant: Self.controlSize),
      scrollHost.heightAnchor.constraint(equalToConstant: Self.controlSize),
      scrollSurface.centerXAnchor.constraint(equalTo: scrollHost.centerXAnchor),
      scrollSurface.bottomAnchor.constraint(equalTo: scrollHost.bottomAnchor),
      scrollSurface.widthAnchor.constraint(equalToConstant: Self.visualSize),
      scrollSurface.heightAnchor.constraint(equalToConstant: Self.visualSize),
      statusButton.leadingAnchor.constraint(equalTo: statusSurface.contentView.leadingAnchor),
      statusButton.trailingAnchor.constraint(equalTo: statusSurface.contentView.trailingAnchor),
      statusButton.topAnchor.constraint(equalTo: statusSurface.contentView.topAnchor),
      statusButton.bottomAnchor.constraint(equalTo: statusSurface.contentView.bottomAnchor),
      scrollButton.leadingAnchor.constraint(equalTo: scrollSurface.contentView.leadingAnchor),
      scrollButton.trailingAnchor.constraint(equalTo: scrollSurface.contentView.trailingAnchor),
      scrollButton.topAnchor.constraint(equalTo: scrollSurface.contentView.topAnchor),
      scrollButton.bottomAnchor.constraint(equalTo: scrollSurface.contentView.bottomAnchor),
    ])
    apply(animated: false)
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard !isHidden, isUserInteractionEnabled, alpha > 0.01 else { return nil }
    for button in [scrollButton, statusButton] {
      let visible = button === scrollButton ? scrollVisible : slot.isActionable
      guard visible else { continue }
      let bounds = button.bounds
      let target = bounds.insetBy(
        dx: -max(0, Self.controlSize - bounds.width) / 2,
        dy: -max(0, Self.controlSize - bounds.height) / 2
      )
      if target.contains(button.convert(point, from: self)) { return button }
    }
    let hit = super.hitTest(point, with: event)
    return hit === self ? nil : hit
  }

  private func apply(animated: Bool? = nil) {
    let showStatus = slot != .idle
    let showScroll = scrollVisible
    let active = showStatus || showScroll
    var configuration = statusButton.configuration ?? .plain()
    if showStatus {
      configuration.title = slot.title
      statusButton.configuration = configuration
      statusButton.accessibilityLabel = slot.title
    }
    statusButton.accessibilityTraits = slot.isActionable ? .button : .staticText
    statusButton.isUserInteractionEnabled = slot.isActionable
    let shouldAnimate = (animated ?? (window != nil && !UIAccessibility.isReduceMotionEnabled))
      && UIView.areAnimationsEnabled
    if active { isHidden = false }
    isUserInteractionEnabled = active
    statusSurface.setVisible(showStatus, animated: shouldAnimate)
    scrollSurface.setVisible(showScroll, animated: shouldAnimate)
    isHidden = statusSurface.isHidden && scrollSurface.isHidden
  }
}

private extension ChatOverlay.Slot {
  var isActionable: Bool {
    switch self {
    case .paused: true
    default: false
    }
  }

  var title: String {
    switch self {
    case .paused: String(localized: "native.chat.connection.paused", bundle: .lody)
    case .connecting: String(localized: "native.chat.connection.connecting", bundle: .lody)
    case .idle: ""
    }
  }
}
