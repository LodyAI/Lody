import UIKit

final class ChatPlanCell: UICollectionViewCell {
  static let previewHeight: CGFloat = 240
  private let card = UIView()
  private let icon = UIImageView(image: UIImage(systemName: "doc.text"))
  private let title = UILabel()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let copy = UIButton(type: .system)
  private let viewport = UIView()
  private let previewMask = CAGradientLayer()
  private let toggle = UIButton(type: .system)
  private let review = UIButton(type: .system)
  private let execute = UIButton(type: .system)
  private let discuss = UIButton(type: .system)
  private let decisionMessage = UILabel()
  var onDecision: ((String) -> Void)?
  private var markdown: ChatMarkdownView?
  private var row: ChatRow?
  var expanded = false { didSet { setNeedsLayout() } }
  var onToggle: (() -> Void)?
  var onReview: (() -> Void)?

  static func height(body: CGFloat, expanded: Bool, review: Bool, decision: ChatPlanDecisionState? = nil) -> CGFloat {
    12 + 44 + (expanded ? body : min(body, previewHeight))
      + (body <= previewHeight && !review && decision == nil ? 16 : 0)
      + (body > previewHeight && decision == nil ? 44 : 0) + (review ? 44 : 0) + (decision == nil ? 0 : 64)
      + (decision?.message.isEmpty == false ? 60 : 0) + 12
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    card.backgroundColor = .secondarySystemGroupedBackground
    card.layer.cornerRadius = 16
    card.layer.borderWidth = 1 / traitCollection.displayScale
    card.clipsToBounds = true
    contentView.addSubview(card)
    for view in [icon, title, spinner, copy, viewport, toggle, review, execute, discuss, decisionMessage] { card.addSubview(view) }
    icon.tintColor = .secondaryLabel
    icon.contentMode = .scaleAspectFit
    title.font = .preferredFont(forTextStyle: .subheadline)
    title.textColor = .secondaryLabel
    viewport.clipsToBounds = true
    previewMask.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
    viewport.isAccessibilityElement = true
    viewport.accessibilityTraits = .staticText
    copy.setImage(UIImage(systemName: "doc.on.doc"), for: .normal)
    copy.setPreferredSymbolConfiguration(UIImage.SymbolConfiguration(font: title.font), forImageIn: .normal)
    copy.tintColor = .secondaryLabel
    copy.accessibilityLabel = String(localized: "native.chat.proposedPlan.copy", bundle: .lody)
    copy.addAction(UIAction { [weak self] _ in
      guard let text = self?.row?.text else { return }
      UIPasteboard.general.string = text
    }, for: .touchUpInside)
    toggle.tintColor = .secondaryLabel
    review.tintColor = .label
    toggle.titleLabel?.font = .preferredFont(forTextStyle: .subheadline)
    review.titleLabel?.font = .preferredFont(forTextStyle: .subheadline)
    toggle.addAction(UIAction { [weak self] _ in self?.onToggle?() }, for: .touchUpInside)
    review.addAction(UIAction { [weak self] _ in self?.onReview?() }, for: .touchUpInside)
    review.setTitle(String(localized: "native.chat.proposedPlan.review", bundle: .lody), for: .normal)
    execute.setTitle(String(localized: "native.chat.proposedPlan.execute", bundle: .lody), for: .normal)
    for button in [execute, discuss] {
      var configuration: UIButton.Configuration = button === execute ? .prominentGlass() : .glass()
      configuration.baseForegroundColor = button === execute ? .white : .label
      if button === execute { configuration.baseBackgroundColor = .systemBlue }
      configuration.cornerStyle = .capsule
      configuration.background.backgroundInsets = NSDirectionalEdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0)
      configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
      configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { [isPrimary = button === execute] attributes in
        var result = attributes
        result.font = isPrimary
          ? UIFontMetrics(forTextStyle: .footnote).scaledFont(for: .systemFont(ofSize: 13, weight: .bold))
          : .preferredFont(forTextStyle: .footnote)
        return result
      }
      button.configuration = configuration
    }
    discuss.setTitle(String(localized: "native.chat.proposedPlan.discuss", bundle: .lody), for: .normal)
    execute.addAction(UIAction { [weak self] _ in self?.onDecision?("execute") }, for: .touchUpInside)
    discuss.addAction(UIAction { [weak self] _ in self?.onDecision?("discuss") }, for: .touchUpInside)
    decisionMessage.font = .preferredFont(forTextStyle: .footnote)
    decisionMessage.textColor = .secondaryLabel
    decisionMessage.numberOfLines = 0
    registerForTraitChanges([UITraitUserInterfaceStyle.self, UITraitAccessibilityContrast.self]) { (self: ChatPlanCell, _) in
      self.card.layer.borderColor = UIColor.separator.cgColor
    }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: ChatRow, markdown: ChatMarkdownView, expanded: Bool) {
    self.row = row
    self.expanded = expanded
    if self.markdown !== markdown {
      clearSelection()
      if self.markdown?.superview === viewport { self.markdown?.removeFromSuperview() }
      self.markdown = markdown
      viewport.addSubview(markdown)
    }
    title.text = String(localized: String.LocalizationValue(row.planIsLatest ? "native.chat.proposedPlan.title" : "native.chat.proposedPlan.earlier"), bundle: .lody)
    if row.streaming { spinner.startAnimating() } else { spinner.stopAnimating() }
    card.layer.borderColor = UIColor.separator.cgColor
    viewport.accessibilityLabel = SessionProse.text(row.text, role: "assistant")
    viewport.accessibilityIdentifier = row.id
    viewport.accessibilityCustomActions = markdown.fileActions
    review.isHidden = row.planPermissionItemID.isEmpty
    execute.isHidden = row.planDecision == nil
    discuss.isHidden = execute.isHidden
    execute.isEnabled = row.planDecision?.enabled == true
    discuss.isEnabled = execute.isEnabled
    execute.setTitle(String(localized: String.LocalizationValue(row.planDecision?.pending == true ? "native.chat.proposedPlan.sending" : "native.chat.proposedPlan.executeCompact"), bundle: .lody), for: .normal)
    execute.accessibilityLabel = String(localized: String.LocalizationValue(row.planDecision?.pending == true ? "native.chat.proposedPlan.sending" : "native.chat.proposedPlan.execute"), bundle: .lody)
    decisionMessage.text = row.planDecision?.message
    decisionMessage.isHidden = row.planDecision?.message.isEmpty != false
    setNeedsLayout()
  }

  func clearSelection() {
    if markdown?.superview === viewport { markdown?.clearSelection() }
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    clearSelection()
    if markdown?.superview === viewport {
      markdown?.onLink = nil
      markdown?.removeFromSuperview()
    }
    markdown = nil
    row = nil
    onToggle = nil
    onReview = nil
    onDecision = nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let markdown else { return }
    let width = contentView.bounds.width
    markdown.measure(width: max(1, width - 32))
    let body = markdown.measuredHeight
    let visibleBody = expanded ? body : min(body, Self.previewHeight)
    card.frame = contentView.bounds.insetBy(dx: 0, dy: 12)
    icon.frame = CGRect(x: 16, y: 14, width: 16, height: 16)
    title.frame = CGRect(x: 40, y: 0, width: max(1, width - 128), height: 44)
    spinner.frame = CGRect(x: width - 76, y: 12, width: 20, height: 20)
    copy.frame = CGRect(x: width - 52, y: 0, width: 44, height: 44)
    viewport.frame = CGRect(x: 16, y: 44, width: width - 32, height: visibleBody)
    markdown.frame = CGRect(x: 0, y: 0, width: width - 32, height: body)
    previewMask.frame = viewport.bounds
    previewMask.locations = [0, NSNumber(value: Double(max(0, 1 - 24 / max(1, visibleBody)))), 1]
    viewport.layer.mask = !expanded && body > Self.previewHeight ? previewMask : nil
    var y = 44 + visibleBody
    let hasDecision = row?.planDecision != nil
    toggle.isHidden = body <= Self.previewHeight || (hasDecision && expanded)
    let toggleKey = expanded ? "native.chat.proposedPlan.collapse" : "native.chat.proposedPlan.expand"
    toggle.accessibilityLabel = String(localized: String.LocalizationValue(toggleKey), bundle: .lody)
    toggle.setTitle(String(localized: String.LocalizationValue(hasDecision ? "native.chat.proposedPlan.expandCompact" : toggleKey), bundle: .lody), for: .normal)
    toggle.contentHorizontalAlignment = hasDecision ? .leading : .center
    toggle.frame = CGRect(x: 0, y: y, width: width, height: 44)
    if !toggle.isHidden && !hasDecision { y += 44 }
    review.frame = CGRect(x: 0, y: y, width: width, height: 44)
    if !review.isHidden { y += 44 }
    if hasDecision { y += 8 }
    let executeWidth = max(44, execute.sizeThatFits(CGSize(width: width, height: 44)).width)
    let discussWidth = max(44, discuss.sizeThatFits(CGSize(width: width, height: 44)).width)
    let actionX = width - 16 - discussWidth - 8 - executeWidth
    discuss.frame = CGRect(x: actionX, y: y, width: discussWidth, height: 44)
    execute.frame = CGRect(x: width - 16 - executeWidth, y: y, width: executeWidth, height: 44)
    if hasDecision { toggle.frame = CGRect(x: 16, y: y, width: max(44, actionX - 24), height: 44) }
    decisionMessage.frame = CGRect(x: 16, y: y + 44, width: width - 32, height: 60)
    var elements: [UIView] = [title, copy, viewport]
    if !toggle.isHidden { elements.append(toggle) }
    if !review.isHidden { elements.append(review) }
    if !execute.isHidden { elements.append(contentsOf: [discuss, execute]) }
    if !decisionMessage.isHidden { elements.append(decisionMessage) }
    card.accessibilityElements = elements
    var ancestor: UIView? = superview
    while let view = ancestor, !(view is UIScrollView) { ancestor = view.superview }
    markdown.trackedScrollView = ancestor as? UIScrollView
    ChatTableViewport.apply(to: markdown)
  }
}
