import UIKit

/// Inline alert content; only the two explicit actions respond to taps.
final class ChatErrorCell: UICollectionViewCell {
  private let card = UIView()
  private let icon = UIImageView()
  private let titleLabel = UILabel()
  private let summaryLabel = UILabel()
  private let retryButton = UIButton(type: .system)
  private let detailButton = UIButton(type: .system)
  private var row: ChatRow?
  var onRetry: (() -> Void)?
  var onDetail: (() -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.addSubview(card)
    card.layer.cornerRadius = 10
    card.layer.cornerCurve = .continuous
    [icon, titleLabel, summaryLabel, retryButton, detailButton].forEach(card.addSubview)
    titleLabel.numberOfLines = 0
    summaryLabel.numberOfLines = 2
    titleLabel.textColor = .label
    summaryLabel.textColor = .secondaryLabel
    icon.image = UIImage(systemName: "exclamationmark.circle", withConfiguration: UIImage.SymbolConfiguration(pointSize: 16))
    icon.contentMode = .scaleAspectFit
    icon.isAccessibilityElement = false
    isAccessibilityElement = false
    retryButton.addTarget(self, action: #selector(retry), for: .primaryActionTriggered)
    detailButton.addTarget(self, action: #selector(detail), for: .primaryActionTriggered)
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (cell: ChatErrorCell, _) in
      if let row = cell.row { cell.configure(row) }
    }
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: ChatRow) {
    self.row = row
    titleLabel.text = row.text
    titleLabel.font = Self.titleFont(traitCollection)
    summaryLabel.text = Self.summary(row)
    summaryLabel.font = Self.bodyFont(traitCollection)
    let tone: UIColor = row.errorMeta?.reason == "acp_provider_overloaded" ? .systemOrange : .systemRed
    icon.tintColor = tone
    card.backgroundColor = UIColor { traits in
      tone.resolvedColor(with: traits).withAlphaComponent(traits.userInterfaceStyle == .dark ? 0.09 : 0.055)
    }
    card.accessibilityIdentifier = row.id
    titleLabel.accessibilityIdentifier = row.id + ":title"
    summaryLabel.accessibilityIdentifier = row.id + ":summary"
    retryButton.accessibilityIdentifier = row.id + ":retry"
    detailButton.accessibilityIdentifier = row.id + ":details"
    let retryState = row.errorRetry
    retryButton.isHidden = retryState?.visible != true
    retryButton.isEnabled = retryState?.enabled == true && retryState?.pending != true
    var retry = buttonConfiguration(String(localized: String.LocalizationValue(retryState?.pending == true ? "native.chat.error.retrying" : "native.chat.error.retry"), bundle: .lody))
    retry.image = UIImage(systemName: "arrow.clockwise")
    retry.showsActivityIndicator = retryState?.pending == true
    retryButton.configuration = retry
    detailButton.isHidden = !ChatFailure.hasDetail(row.errorMeta)
    var details = buttonConfiguration(String(localized: "native.chat.error.details", bundle: .lody))
    details.baseForegroundColor = .secondaryLabel
    detailButton.configuration = details
    // Reconfigured cells keep UIKit's cached accessibility children, which would leave a hidden Retry reachable.
    card.accessibilityElements = [titleLabel, summaryLabel, retryButton, detailButton].filter { !$0.isHidden }
    setNeedsLayout()
  }

  private func buttonConfiguration(_ title: String) -> UIButton.Configuration {
    var config = UIButton.Configuration.plain()
    config.title = title
    config.baseForegroundColor = .systemBlue
    config.contentInsets = .zero
    config.imagePadding = 6
    config.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 13)
    let font = Self.bodyFont(traitCollection)
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var next = attributes
      next.font = font
      return next
    }
    return config
  }

  @objc private func retry() {
    guard row?.errorRetry?.enabled == true, row?.errorRetry?.pending != true else { return }
    // Fence the interval before the JS projection returns its pending state.
    retryButton.isEnabled = false
    onRetry?()
  }
  @objc private func detail() { onDetail?() }

  private static func titleFont(_ traits: UITraitCollection) -> UIFont {
    UIFont.systemFont(ofSize: UIFont.dynamic(of: 14, compatibleWith: traits).pointSize, weight: .medium)
  }
  private static func bodyFont(_ traits: UITraitCollection) -> UIFont {
    UIFont.dynamic(of: 13, compatibleWith: traits)
  }
  private static func summary(_ row: ChatRow) -> String {
    if let message = row.errorRetry?.message, !message.isEmpty { return message }
    return ChatFailure.summary(row.errorMeta)
  }
  private static func textHeight(_ text: String, width: CGFloat, font: UIFont) -> CGFloat {
    ceil((text as NSString).boundingRect(with: CGSize(width: max(1, width), height: .greatestFiniteMagnitude), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: font], context: nil).height)
  }
  private static func titleHeight(_ row: ChatRow, width: CGFloat, traits: UITraitCollection) -> CGFloat {
    max(22, textHeight(row.text, width: width - 48, font: titleFont(traits)))
  }
  private static func summaryHeight(_ row: ChatRow, width: CGFloat, traits: UITraitCollection) -> CGFloat {
    let font = bodyFont(traits)
    return min(ceil(font.lineHeight * 2), textHeight(summary(row), width: width - 48, font: font))
  }
  static func height(_ row: ChatRow, width: CGFloat, traits: UITraitCollection) -> CGFloat {
    let actions = ChatFailure.hasDetail(row.errorMeta) || row.errorRetry?.visible == true
    return 12 + 10 + titleHeight(row, width: width, traits: traits) + 4
      + summaryHeight(row, width: width, traits: traits) + (actions ? 44 : 10)
  }
  override func layoutSubviews() {
    super.layoutSubviews()
    guard let row else { return }
    card.frame = bounds.insetBy(dx: 0, dy: 6)
    let width = card.bounds.width
    let titleHeight = Self.titleHeight(row, width: width, traits: traitCollection)
    icon.frame = CGRect(x: 12, y: 13, width: 16, height: 16)
    titleLabel.frame = CGRect(x: 36, y: 10, width: max(1, width - 48), height: titleHeight)
    summaryLabel.frame = CGRect(x: 36, y: 14 + titleHeight, width: max(1, width - 48), height: Self.summaryHeight(row, width: width, traits: traitCollection))
    let buttonY = summaryLabel.frame.maxY
    let font = Self.bodyFont(traitCollection)
    // Keep the action's hit area stable when its title changes to Retrying.
    let retryWidth = max(44, ["native.chat.error.retry", "native.chat.error.retrying"].map {
      ceil((String(localized: String.LocalizationValue($0), bundle: .lody) as NSString).size(withAttributes: [.font: font]).width) + 22
    }.max() ?? 44)
    let available = max(44, (width - 68) / 2)
    let actionWidth = min(retryWidth, available)
    retryButton.frame = CGRect(x: 36, y: buttonY, width: actionWidth, height: 44)
    retryButton.contentHorizontalAlignment = .leading
    let detailX: CGFloat = retryButton.isHidden ? 36 : 36 + actionWidth + 20
    detailButton.frame = CGRect(x: detailX, y: buttonY, width: max(44, width - detailX - 12), height: 44)
    detailButton.contentHorizontalAlignment = .leading
  }
}
