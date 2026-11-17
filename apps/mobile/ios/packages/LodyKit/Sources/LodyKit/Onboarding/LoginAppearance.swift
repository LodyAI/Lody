import UIKit

/// The web sign-in page's palette (`login-page.tsx` on `@lody/ui` tokens), as
/// dynamic colours. Dark values are measured from the shipped web page; light
/// values come from the same product palette's light theme.
@MainActor
enum LoginPalette {
  private static func dynamic(light: UInt32, dark: UInt32, alpha: CGFloat = 1) -> UIColor {
    UIColor { traits in
      let value = traits.userInterfaceStyle == .dark ? dark : light
      return UIColor(red: CGFloat((value >> 16) & 0xff) / 255, green: CGFloat((value >> 8) & 0xff) / 255,
                     blue: CGFloat(value & 0xff) / 255, alpha: alpha)
    }
  }

  static let page = dynamic(light: 0xF9F9FA, dark: 0x131416)
  /// The visual's paper: a step off the page.
  static let visualPaper = dynamic(light: 0xEEEEEF, dark: 0x1B1C1E)
  /// The visual's ink: the page's ink, dimmed toward black in dark mode.
  static let visualInk = dynamic(light: 0x1C1C1C, dark: 0xB5B6B7)
  static let label = dynamic(light: 0x1C1C1C, dark: 0xD7D8D9)
  static let secondaryLabel = dynamic(light: 0x6B6B6B, dark: 0x9C9FA3)
  static let tertiaryLabel = dynamic(light: 0x949495, dark: 0x6F7174)
  static let separator = dynamic(light: 0xDBDBDB, dark: 0x2B2D31)
  /// `Button` secondary: the raised surface, lit from above.
  static let raisedTop = dynamic(light: 0xFFFFFF, dark: 0x25272A)
  static let raisedBottom = dynamic(light: 0xFCFCFC, dark: 0x1D1F22)
  static let raisedEdge = dynamic(light: 0x000000, dark: 0xFFFFFF, alpha: 0.07)
  static let raisedSheen = dynamic(light: 0xFFFFFF, dark: 0xFFFFFF, alpha: 0.08)
  static let pressedFill = dynamic(light: 0x1C1C1C, dark: 0xD7D8D9, alpha: 0.06)
  /// `Badge` neutral: a film over whatever holds it.
  static let badgeFill = dynamic(light: 0x1C1C1C, dark: 0xD7D8D9, alpha: 0.07)
  /// The one recessed well every value holder uses.
  static let well = dynamic(light: 0x1C1C1C, dark: 0xD7D8D9, alpha: 0.04)
  static let wellEdge = dynamic(light: 0x1C1C1C, dark: 0xD7D8D9, alpha: 0.1)
  static let danger = UIColor.systemRed
  static let dangerFill = UIColor.systemRed.withAlphaComponent(0.06)
  static let dangerEdge = UIColor.systemRed.withAlphaComponent(0.3)
  static let mutedCircle = dynamic(light: 0x1C1C1C, dark: 0xD7D8D9, alpha: 0.07)
}

@MainActor
enum LoginType {
  static func font(_ size: CGFloat, _ weight: UIFont.Weight, style: UIFont.TextStyle) -> UIFont {
    UIFontMetrics(forTextStyle: style).scaledFont(for: .systemFont(ofSize: size, weight: weight))
  }

  static var title: UIFont { font(28, .semibold, style: .title1) }
  static var description: UIFont { font(15, .regular, style: .subheadline) }
  static var control: UIFont { font(15, .medium, style: .body) }
  static var fieldLabel: UIFont { font(13, .medium, style: .footnote) }
  static var field: UIFont { font(16, .regular, style: .body) }
  static var small: UIFont { font(13, .regular, style: .footnote) }
  static var smallStrong: UIFont { font(13, .medium, style: .footnote) }
  static var legal: UIFont { font(12, .regular, style: .caption1) }
  static var badge: UIFont { font(11, .medium, style: .caption2) }
}

/// Web `Button` at `size="large"`: `secondary` is a raised surface, `ghost` has
/// no surface until pressed, and `primary` is filled with the page's ink. The
/// method rows lead with an 18 pt mark, then the label, then the badge.
@MainActor
final class LoginButton: UIButton {
  enum Variant { case primary, secondary, ghost }

  static let height: CGFloat = 44

  let variant: Variant
  private let gradient = CAGradientLayer()
  private let sheen = CALayer()
  private let mark = UIImageView()
  private let title = UILabel()
  private let trailing = UIStackView()
  private let spinner = UIActivityIndicatorView(style: .medium)
  private let row = UIStackView()

  init(_ variant: Variant, title text: String, image: UIImage? = nil, centered: Bool = false) {
    self.variant = variant
    super.init(frame: .zero)
    translatesAutoresizingMaskIntoConstraints = false
    layer.cornerRadius = 10
    layer.cornerCurve = .continuous
    heightAnchor.constraint(greaterThanOrEqualToConstant: Self.height).isActive = true
    if variant == .secondary {
      gradient.cornerRadius = 10
      gradient.cornerCurve = .continuous
      layer.insertSublayer(gradient, at: 0)
      sheen.backgroundColor = LoginPalette.raisedSheen.cgColor
      layer.addSublayer(sheen)
      layer.borderWidth = 1 / UIScreen.main.scale
      layer.shadowOffset = CGSize(width: 0, height: 1)
      layer.shadowRadius = 1.5
    }
    mark.image = image
    mark.contentMode = .scaleAspectFit
    mark.isHidden = image == nil
    mark.setContentHuggingPriority(.required, for: .horizontal)
    NSLayoutConstraint.activate([mark.widthAnchor.constraint(equalToConstant: 18), mark.heightAnchor.constraint(equalToConstant: 18)])
    title.text = text
    title.font = LoginType.control
    title.adjustsFontForContentSizeCategory = true
    title.lineBreakMode = .byTruncatingTail
    title.textAlignment = centered ? .center : .natural
    trailing.axis = .horizontal
    trailing.spacing = 6
    trailing.alignment = .center
    trailing.setContentHuggingPriority(.required, for: .horizontal)
    trailing.setContentCompressionResistancePriority(.required, for: .horizontal)
    trailing.isHidden = true
    spinner.hidesWhenStopped = true
    row.axis = .horizontal
    row.alignment = .center
    row.spacing = 10
    row.isUserInteractionEnabled = false
    row.translatesAutoresizingMaskIntoConstraints = false
    if centered {
      // Spinner, label and trailing mark sit together in the middle.
      row.spacing = 8
      [spinner, mark, title, trailing].forEach(row.addArrangedSubview)
    } else {
      [mark, title, trailing].forEach(row.addArrangedSubview)
      title.setContentHuggingPriority(.defaultLow, for: .horizontal)
    }
    addSubview(row)
    var constraints = [
      row.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 8),
      row.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -8),
      row.centerYAnchor.constraint(equalTo: centerYAnchor),
    ]
    if centered {
      constraints += [
        row.centerXAnchor.constraint(equalTo: centerXAnchor),
        row.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 14),
      ]
    } else {
      constraints += [
        row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 14),
        row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -14),
      ]
    }
    NSLayoutConstraint.activate(constraints)
    accessibilityLabel = text
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: LoginButton, _: UITraitCollection) in view.paint() }
    paint()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  var titleText: String {
    get { title.text ?? "" }
    set {
      title.text = newValue
      accessibilityLabel = newValue
    }
  }

  /// A trailing view after the label: the "Last used" badge or an arrow.
  func setTrailing(_ view: UIView?) {
    trailing.arrangedSubviews.forEach { $0.removeFromSuperview() }
    if let view { trailing.addArrangedSubview(view) }
    trailing.isHidden = view == nil
    paint()
  }

  func setWorking(_ working: Bool) {
    if working { spinner.startAnimating() } else { spinner.stopAnimating() }
  }

  override var isHighlighted: Bool { didSet { paint() } }
  override var isEnabled: Bool { didSet { paint() } }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    gradient.frame = bounds
    sheen.frame = CGRect(x: 10, y: 0, width: max(0, bounds.width - 20), height: 1 / UIScreen.main.scale)
    if variant == .secondary {
      layer.shadowPath = UIBezierPath(roundedRect: bounds, cornerRadius: 10).cgPath
    }
    CATransaction.commit()
  }

  private func paint() {
    let traits = traitCollection
    let ink: UIColor
    switch variant {
    case .primary:
      backgroundColor = LoginPalette.label.withAlphaComponent(isHighlighted ? 0.86 : 1)
      ink = LoginPalette.page
    case .secondary:
      let top = LoginPalette.raisedTop.resolvedColor(with: traits)
      let bottom = LoginPalette.raisedBottom.resolvedColor(with: traits)
      gradient.colors = isHighlighted ? [bottom.cgColor, bottom.cgColor] : [top.cgColor, bottom.cgColor]
      sheen.isHidden = traits.userInterfaceStyle != .dark || isHighlighted
      layer.borderColor = LoginPalette.raisedEdge.resolvedColor(with: traits).cgColor
      layer.shadowColor = UIColor.black.cgColor
      layer.shadowOpacity = traits.userInterfaceStyle == .dark ? 0.35 : 0.06
      ink = LoginPalette.label
    case .ghost:
      backgroundColor = isHighlighted ? LoginPalette.pressedFill : .clear
      ink = isHighlighted ? LoginPalette.label : LoginPalette.secondaryLabel
    }
    title.textColor = ink
    mark.tintColor = ink
    spinner.color = ink
    trailing.arrangedSubviews.compactMap { $0 as? UIImageView }.forEach { $0.tintColor = ink.withAlphaComponent(0.8) }
    alpha = isEnabled ? 1 : 0.5
  }
}

/// Web `Badge` (neutral): a 20 pt chip of ink on a film.
@MainActor
final class LoginBadge: UILabel {
  init(_ text: String) {
    super.init(frame: .zero)
    self.text = text
    font = LoginType.badge
    adjustsFontForContentSizeCategory = true
    textColor = LoginPalette.label
    backgroundColor = LoginPalette.badgeFill
    layer.cornerRadius = 5
    layer.cornerCurve = .continuous
    clipsToBounds = true
    textAlignment = .center
    setContentHuggingPriority(.required, for: .horizontal)
    setContentCompressionResistancePriority(.required, for: .horizontal)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var intrinsicContentSize: CGSize {
    let size = super.intrinsicContentSize
    return CGSize(width: size.width + 12, height: max(20, size.height + 4))
  }
}

/// A web `Field`: a small label above a recessed well.
@MainActor
final class LoginField: UIView {
  let field = LoginTextField()
  private let label = UILabel()

  init(label text: String) {
    super.init(frame: .zero)
    let stack = UIStackView(arrangedSubviews: [label, field])
    stack.axis = .vertical
    stack.spacing = 6
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.leadingAnchor.constraint(equalTo: leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    label.text = text
    label.font = LoginType.fieldLabel
    label.adjustsFontForContentSizeCategory = true
    label.textColor = LoginPalette.label
    label.isAccessibilityElement = false
    field.accessibilityLabel = text
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

@MainActor
final class LoginTextField: UITextField {
  init() {
    super.init(frame: .zero)
    font = LoginType.field
    adjustsFontForContentSizeCategory = true
    textColor = LoginPalette.label
    tintColor = LoginPalette.label
    backgroundColor = LoginPalette.well
    layer.cornerRadius = 10
    layer.cornerCurve = .continuous
    layer.borderWidth = 1 / UIScreen.main.scale
    autocapitalizationType = .none
    autocorrectionType = .no
    spellCheckingType = .no
    clearButtonMode = .never
    heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: LoginTextField, _: UITraitCollection) in view.paintEdge() }
    paintEdge()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var placeholder: String? {
    didSet {
      attributedPlaceholder = placeholder.map {
        NSAttributedString(string: $0, attributes: [.foregroundColor: LoginPalette.tertiaryLabel])
      }
    }
  }

  override func becomeFirstResponder() -> Bool {
    let became = super.becomeFirstResponder()
    paintEdge()
    return became
  }

  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    paintEdge()
    return resigned
  }

  private func paintEdge() {
    let color = isFirstResponder ? LoginPalette.secondaryLabel : LoginPalette.wellEdge
    layer.borderColor = color.resolvedColor(with: traitCollection).cgColor
  }

  override func textRect(forBounds bounds: CGRect) -> CGRect { inset(bounds) }
  override func editingRect(forBounds bounds: CGRect) -> CGRect { inset(bounds) }
  override func placeholderRect(forBounds bounds: CGRect) -> CGRect { inset(bounds) }

  override func rightViewRect(forBounds bounds: CGRect) -> CGRect {
    CGRect(x: bounds.width - 44, y: 0, width: 44, height: bounds.height)
  }

  private func inset(_ bounds: CGRect) -> CGRect {
    bounds.inset(by: UIEdgeInsets(top: 0, left: 12, bottom: 0, right: rightView == nil ? 12 : 44))
  }
}

/// An inline text action, as web's underlined text buttons: at least 44 pt tall.
@MainActor
func loginTextButton(_ text: String, strong: Bool, action: @escaping @MainActor () -> Void) -> UIButton {
  var configuration = UIButton.Configuration.plain()
  configuration.contentInsets = NSDirectionalEdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4)
  configuration.attributedTitle = AttributedString(text, attributes: AttributeContainer([
    .font: strong ? LoginType.smallStrong : LoginType.small,
  ]))
  configuration.baseForegroundColor = strong ? LoginPalette.label : LoginPalette.secondaryLabel
  let button = UIButton(configuration: configuration)
  button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
  button.addAction(UIAction { _ in action() }, for: .touchUpInside)
  return button
}
