import UIKit
import LodyDesignSystem

/// Stable, visible touch targets below each message. Copy feedback belongs to the tapped row.
final class ChatMessageActionsCell: UICollectionViewCell {
  let copyButton = UIButton(type: .system)
  let detailsButton = UIButton(type: .system)
  let forkButton = UIButton(type: .system)
  private let label = UILabel()
  private let actions = UIStackView()
  private var identity = ""
  var entryID: String { identity }
  var onCopy: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    label.font = .preferredFont(forTextStyle: .footnote)
    label.textColor = .secondaryLabel
    label.lineBreakMode = .byTruncatingTail
    contentView.addSubview(label)
    actions.axis = .horizontal
    actions.spacing = -LodySpacing.md
    for (button, icon, key) in [
      (copyButton, LodyIcon.copy, "native.chat.message.copy"),
      (detailsButton, LodyIcon.info, "message.details.title"),
      (forkButton, LodyIcon.branch, "message.fork.title"),
    ] {
      button.setImage(Self.image(icon), for: .normal)
      button.tintColor = .secondaryLabel
      button.contentHorizontalAlignment = .left
      button.accessibilityLabel = String(localized: String.LocalizationValue(key), bundle: .lody)
      button.widthAnchor.constraint(equalToConstant: 44).isActive = true
      button.heightAnchor.constraint(equalToConstant: 44).isActive = true
      actions.addArrangedSubview(button)
    }
    copyButton.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.onCopy?()
      let id = self.identity
      self.copyButton.setImage(Self.image(.check), for: .normal)
      Task { [weak self] in
        try? await Task.sleep(for: .seconds(1.6))
        guard let self, self.identity == id else { return }
        self.copyButton.setImage(Self.image(.copy), for: .normal)
      }
    }, for: .touchUpInside)
    contentView.addSubview(actions)
  }
  private static func image(_ icon: LodyIcon) -> UIImage? {
    guard let source = icon.uiImage else { return nil }
    let size = CGSize(width: LodyIconSize.sm, height: LodyIconSize.sm)
    return UIGraphicsImageRenderer(size: size).image { _ in
      source.draw(in: CGRect(origin: .zero, size: size))
    }.withRenderingMode(.alwaysTemplate)
  }
  required init?(coder: NSCoder) { fatalError() }
  func configure(_ row: ChatRow, copyable: Bool) {
    identity = row.entryID
    label.text = row.text
    copyButton.isEnabled = copyable
    copyButton.setImage(Self.image(.copy), for: .normal)
    for (button, suffix) in [(copyButton,"copy"), (detailsButton,"details"), (forkButton,"fork")] {
      button.accessibilityIdentifier = row.id + ":" + suffix
    }
    setNeedsLayout()
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    let count = CGFloat(actions.arrangedSubviews.filter { !$0.isHidden }.count)
    let width = count * 44 + max(0, count - 1) * actions.spacing
    let timeX = width - (44 - LodyIconSize.sm) + LodySpacing.md
    label.frame = CGRect(x: timeX, y: 0, width: max(0, bounds.width - timeX), height: 44)
    actions.frame = CGRect(x: 0, y: 0, width: width, height: 44)
  }
}
