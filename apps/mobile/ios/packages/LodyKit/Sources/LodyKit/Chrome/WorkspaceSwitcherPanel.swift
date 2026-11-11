import UIKit

/// The workspace switcher: a menu-like popover anchored to the workspace capsule (never adapted
/// to a sheet). It keeps the native menu's look (account email heading, leading checkmark, logo,
/// name) but each name stays on one line and fades out at the trailing edge when it is too long,
/// which a `UIMenu` cannot do. Choosing a row closes the panel before switching.
@MainActor
final class WorkspaceSwitcherPanel: UIViewController, UIPopoverPresentationControllerDelegate {
  private static let rowHeight: CGFloat = 48
  private static let headerHeight: CGFloat = 40
  private static let avatarSide: CGFloat = 28
  private static let checkSlot: CGFloat = 20
  private static let inset: CGFloat = 8
  private static let maxVisibleRows: CGFloat = 8
  private var items: [LodyMenuItem]
  private var accountEmail: String
  private let maxWidth: CGFloat
  private let picked: (String) -> Void
  private let scroll = UIScrollView()
  private let stack = UIStackView()

  init(items: [LodyMenuItem], accountEmail: String, maxWidth: CGFloat, picked: @escaping (String) -> Void) {
    self.items = items
    self.accountEmail = accountEmail
    self.maxWidth = maxWidth
    self.picked = picked
    super.init(nibName: nil, bundle: nil)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.alwaysBounceVertical = false
    scroll.showsHorizontalScrollIndicator = false
    scroll.accessibilityIdentifier = "workspace-panel"
    view.addSubview(scroll)
    stack.axis = .vertical
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      scroll.topAnchor.constraint(equalTo: view.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: Self.inset),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -Self.inset),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
    ])
    rebuild()
  }

  func update(items next: [LodyMenuItem], accountEmail email: String) {
    guard next != items || email != accountEmail else { return }
    items = next
    accountEmail = email
    guard isViewLoaded else { return }
    rebuild()
  }

  private func rebuild() {
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    if !accountEmail.isEmpty {
      let header = UILabel()
      header.text = accountEmail
      header.font = .preferredFont(forTextStyle: .footnote)
      header.adjustsFontForContentSizeCategory = true
      header.textColor = .secondaryLabel
      header.textAlignment = .center
      header.lineBreakMode = .byTruncatingMiddle
      header.accessibilityTraits = .header
      header.heightAnchor.constraint(equalToConstant: Self.headerHeight).isActive = true
      stack.addArrangedSubview(header)
    }
    for item in items {
      let row = WorkspaceSwitcherRow(item: item, avatarSide: Self.avatarSide, checkSlot: Self.checkSlot) { [weak self] in
        self?.rebuild()
      }
      row.heightAnchor.constraint(equalToConstant: Self.rowHeight).isActive = true
      row.addAction(UIAction { [weak self] _ in self?.choose(item.id) }, for: .primaryActionTriggered)
      stack.addArrangedSubview(row)
    }
    resize()
  }

  private func resize() {
    let font = UIFont.preferredFont(forTextStyle: .body)
    let names = items.map { ceil(($0.title as NSString).size(withAttributes: [.font: font]).width) }
    // Leading margin, checkmark, gap, logo, gap, name, trailing margin.
    let natural = (names.max() ?? 0) + 16 + Self.checkSlot + 8 + Self.avatarSide + 12 + 20
    let width = min(max(natural, 240), max(240, min(320, maxWidth)))
    let header = accountEmail.isEmpty ? 0 : Self.headerHeight
    let rows = min(CGFloat(items.count), Self.maxVisibleRows) * Self.rowHeight
    preferredContentSize = CGSize(width: width, height: header + rows + Self.inset * 2)
  }

  private func choose(_ id: String) {
    let picked = picked
    let current = items.first(where: { $0.id == id })?.selected == true
    dismiss(animated: true) {
      if !current { picked(id) }
    }
  }

  // A menu-like panel on iPhone too: never adapt the popover into a sheet.
  func adaptivePresentationStyle(for controller: UIPresentationController, traitCollection: UITraitCollection) -> UIModalPresentationStyle {
    .none
  }

  func adaptivePresentationStyle(for controller: UIPresentationController) -> UIModalPresentationStyle {
    .none
  }
}

/// One workspace: leading checkmark slot, round logo (its initial until the logo loads) and the
/// name on a single line that fades out at the trailing edge instead of wrapping or truncating.
@MainActor
private final class WorkspaceSwitcherRow: UIControl {
  private let check = UIImageView()
  private let avatar = UIImageView()
  private let name = LodyFadingLabel()

  init(item: LodyMenuItem, avatarSide: CGFloat, checkSlot: CGFloat, photoLoaded: @escaping () -> Void) {
    super.init(frame: .zero)
    check.image = UIImage(systemName: "checkmark", withConfiguration: UIImage.SymbolConfiguration(textStyle: .body, scale: .medium).applying(UIImage.SymbolConfiguration(weight: .semibold)))
    check.tintColor = .lodyInk
    check.contentMode = .center
    check.isHidden = !item.selected
    avatar.image = Self.avatar(item, side: avatarSide, loaded: photoLoaded)
    avatar.layer.cornerRadius = avatarSide / 2
    avatar.clipsToBounds = true
    name.text = item.title
    for view in [check, avatar, name] as [UIView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      view.isUserInteractionEnabled = false
      addSubview(view)
    }
    NSLayoutConstraint.activate([
      check.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      check.centerYAnchor.constraint(equalTo: centerYAnchor),
      check.widthAnchor.constraint(equalToConstant: checkSlot),
      avatar.leadingAnchor.constraint(equalTo: check.trailingAnchor, constant: 8),
      avatar.centerYAnchor.constraint(equalTo: centerYAnchor),
      avatar.widthAnchor.constraint(equalToConstant: avatarSide),
      avatar.heightAnchor.constraint(equalToConstant: avatarSide),
      name.leadingAnchor.constraint(equalTo: avatar.trailingAnchor, constant: 12),
      name.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
      name.topAnchor.constraint(equalTo: topAnchor),
      name.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    isAccessibilityElement = true
    accessibilityIdentifier = "workspace-row:" + item.id
    accessibilityLabel = item.title
    accessibilityTraits = item.selected ? [.button, .selected] : [.button]
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var isHighlighted: Bool {
    didSet { backgroundColor = isHighlighted ? UIColor.label.withAlphaComponent(0.08) : .clear }
  }

  /// The cached logo, else the initial while the logo loads (the panel redraws when it arrives).
  private static func avatar(_ item: LodyMenuItem, side: CGFloat, loaded: @escaping () -> Void) -> UIImage {
    if let url = LodyListPhoto.url(item.photo),
      let photo = LodyListPhoto.image(for: url, ready: { _ in loaded() })
    {
      return photo
    }
    return LodyListPhoto.monogram(item.monogram, side: side)
  }
}

/// A single-line label whose overflow fades out at the trailing edge (no ellipsis).
@MainActor
final class LodyFadingLabel: UIView {
  private static let fadeWidth: CGFloat = 28
  private let label = UILabel()
  private let fade = CAGradientLayer()

  var text: String? {
    get { label.text }
    set {
      label.text = newValue
      setNeedsLayout()
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    isAccessibilityElement = false
    label.font = .preferredFont(forTextStyle: .body)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = .lodyInk
    label.numberOfLines = 1
    label.lineBreakMode = .byClipping
    addSubview(label)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func layoutSubviews() {
    super.layoutSubviews()
    let natural = ceil(label.sizeThatFits(CGSize(width: CGFloat.greatestFiniteMagnitude, height: bounds.height)).width)
    let width = max(bounds.width, natural)
    let rtl = effectiveUserInterfaceLayoutDirection == .rightToLeft
    label.frame = CGRect(x: rtl ? bounds.width - width : 0, y: 0, width: width, height: bounds.height)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    if natural > bounds.width, bounds.width > 0 {
      fade.frame = bounds
      fade.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
      fade.locations = [0, NSNumber(value: Double(max(0, 1 - Self.fadeWidth / bounds.width))), 1]
      fade.startPoint = CGPoint(x: rtl ? 1 : 0, y: 0.5)
      fade.endPoint = CGPoint(x: rtl ? 0 : 1, y: 0.5)
      layer.mask = fade
    } else {
      layer.mask = nil
    }
    CATransaction.commit()
  }
}
