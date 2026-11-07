import UIKit

@MainActor
class LodyFormController: UIViewController {
  let scroll = UIScrollView()
  let stack = UIStackView()

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyGround
    scroll.translatesAutoresizingMaskIntoConstraints = false
    scroll.contentInsetAdjustmentBehavior = .automatic
    scroll.keyboardDismissMode = .interactive
    scroll.delaysContentTouches = false
    scroll.alwaysBounceVertical = true
    LodyScrollEdges.navigation(scroll)
    view.addSubview(scroll)
    stack.axis = .vertical
    stack.spacing = LodyDesign.Rail.groupGap
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.topAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -16),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor),
    ])
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    LodyScrollEdges.bind(scroll, to: self)
  }

  var header: UINavigationItem? { parent?.navigationItem }

  func closeForm() {
    view.endEditing(true)
    dismiss(animated: true)
  }

  static func barButton(
    title: String? = nil, symbol: String? = nil, label: String, prominent: Bool = false,
    action: @escaping @MainActor () -> Void
  ) -> UIBarButtonItem {
    let item = UIBarButtonItem(primaryAction: UIAction(title: title ?? "", image: symbol.flatMap { UIImage(systemName: $0) }) { _ in
      action()
    })
    item.accessibilityLabel = label
    if prominent {
      item.style = .prominent
      item.tintColor = .lodyAccent
    }
    return item
  }
}

final class LodyFormGroup: UIStackView {
  static let margin: CGFloat = 16
  private let footerLabel = LodyFormGroup.caption(size: 12.5)

  init(header: String? = nil, footer: String? = nil, _ rows: UIView...) {
    super.init(frame: .zero)
    axis = .vertical
    spacing = 0
    if let header {
      let title = UILabel()
      title.text = header
      title.font = .dynamic(of: 13, weight: .semibold)
      title.textColor = .lodySecondary
      title.numberOfLines = 0
      title.accessibilityTraits = .header
      addArrangedSubview(Self.inset(title, bottom: 6))
    }
    addArrangedSubview(Self.hairline())
    var labels: [UILabel] = []
    for row in rows {
      let content = Self.row(for: row)
      if let labeled = content as? LodyFormRow { labels.append(labeled.label) }
      addArrangedSubview(content)
      addArrangedSubview(Self.hairline())
    }
    if let first = labels.first {
      first.widthAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
      first.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, multiplier: 0.4).isActive = true
      for label in labels.dropFirst() {
        label.widthAnchor.constraint(equalTo: first.widthAnchor).isActive = true
      }
    }
    addArrangedSubview(Self.inset(footerLabel, top: 8))
    self.footer = footer
  }

  @available(*, unavailable)
  required init(coder: NSCoder) { fatalError() }

  var footer: String? {
    get { footerLabel.text }
    set {
      footerLabel.text = newValue
      footerLabel.superview?.isHidden = newValue?.isEmpty ?? true
    }
  }

  private static func row(for view: UIView) -> UIView {
    if let field = view as? LodyFormField {
      return LodyFormRow(label: field.accessibilityLabel ?? "", content: field)
    }
    if let button = view as? UIButton {
      button.contentHorizontalAlignment = .leading
      button.configuration?.contentInsets.leading = margin
      button.configuration?.contentInsets.trailing = margin
      button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
    }
    return view
  }

  static func hairline() -> UIView {
    let container = UIView()
    let line = UIView()
    line.backgroundColor = .lodyLine
    line.isUserInteractionEnabled = false
    line.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(line)
    NSLayoutConstraint.activate([
      container.heightAnchor.constraint(equalToConstant: 0.5),
      line.topAnchor.constraint(equalTo: container.topAnchor),
      line.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      line.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: margin),
      line.trailingAnchor.constraint(equalTo: container.trailingAnchor),
    ])
    return container
  }

  static func caption(color: UIColor = .lodySecondary, size: CGFloat = 13) -> UILabel {
    let label = UILabel()
    label.font = .dynamic(of: size)
    label.textColor = color
    label.numberOfLines = 0
    return label
  }

  static func inset(_ label: UIView, top: CGFloat = 0, bottom: CGFloat = 0) -> UIView {
    let container = UIView()
    label.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(label)
    NSLayoutConstraint.activate([
      label.topAnchor.constraint(equalTo: container.topAnchor, constant: top),
      label.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -bottom),
      label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: margin),
      label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -margin),
    ])
    return container
  }
}

final class LodyFormRow: UIView {
  let label = UILabel()
  private let content: UIView

  init(label text: String, content: UIView, picker: Bool = false) {
    self.content = content
    super.init(frame: .zero)
    label.text = text
    label.font = .dynamic(of: 15)
    label.textColor = .lodySecondary
    label.numberOfLines = 0
    let interactive = Self.containsControl(content)
    label.isAccessibilityElement = interactive && !(content is LodyFormField)
    isAccessibilityElement = !interactive
    accessibilityLabel = text
    label.setContentHuggingPriority(.defaultLow, for: .horizontal)
    label.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
    if let field = content as? LodyFormField {
      field.textAlignment = .right
      field.horizontalInset = 0
    }
    if picker, let button = content as? UIButton { Self.stylePicker(button) }
    content.setContentHuggingPriority(.init(1), for: .horizontal)
    content.setContentCompressionResistancePriority(.init(700), for: .horizontal)
    for view in [label, content] {
      view.translatesAutoresizingMaskIntoConstraints = false
      addSubview(view)
    }
    let margin = LodyFormGroup.margin
    NSLayoutConstraint.activate([
      heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
      label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: margin),
      label.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 12),
      label.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -12),
      label.centerYAnchor.constraint(equalTo: centerYAnchor),
      content.leadingAnchor.constraint(equalTo: label.trailingAnchor, constant: 12),
      content.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -margin),
      content.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 4),
      content.bottomAnchor.constraint(lessThanOrEqualTo: bottomAnchor, constant: -4),
      content.centerYAnchor.constraint(equalTo: centerYAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var accessibilityValue: String? {
    get { Self.texts(in: content).joined(separator: ", ") }
    set {}
  }

  private static func containsControl(_ view: UIView) -> Bool {
    view is UIControl || view.subviews.contains(where: containsControl)
  }

  private static func texts(in view: UIView) -> [String] {
    if let label = view as? UILabel { return [label.text ?? ""].filter { !$0.isEmpty } }
    return view.subviews.flatMap(texts)
  }

  private static func stylePicker(_ button: UIButton) {
    guard var configuration = button.configuration else { return }
    configuration.baseForegroundColor = .lodyInk
    configuration.image = UIImage(systemName: "chevron.up.chevron.down")
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
    configuration.imageColorTransformer = UIConfigurationColorTransformer { _ in .lodyTertiary }
    configuration.imagePlacement = .trailing
    configuration.imagePadding = 6
    configuration.contentInsets = .zero
    configuration.titleAlignment = .trailing
    button.configuration = configuration
    button.contentHorizontalAlignment = .trailing
    button.titleLabel?.numberOfLines = 0
  }
}

final class LodyFormField: UITextField, UITextFieldDelegate {
  private let limit: Int
  var changed: (() -> Void)?
  var horizontalInset: CGFloat = LodyFormGroup.margin { didSet { setNeedsLayout() } }

  init(id: String, label: String, text: String?, limit: Int) {
    self.limit = limit
    super.init(frame: .zero)
    self.text = text
    font = .dynamic(of: 15)
    textColor = .lodyInk
    autocorrectionType = .no
    accessibilityIdentifier = id
    accessibilityLabel = label
    delegate = self
    addAction(UIAction { [weak self] _ in self?.changed?() }, for: .editingChanged)
    heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func textRect(forBounds bounds: CGRect) -> CGRect {
    super.textRect(forBounds: bounds).inset(by: UIEdgeInsets(top: 0, left: horizontalInset, bottom: 0, right: horizontalInset))
  }

  override func editingRect(forBounds bounds: CGRect) -> CGRect {
    super.editingRect(forBounds: bounds).inset(by: UIEdgeInsets(top: 0, left: horizontalInset, bottom: 0, right: horizontalInset))
  }

  override func clearButtonRect(forBounds bounds: CGRect) -> CGRect {
    super.clearButtonRect(forBounds: bounds).offsetBy(dx: -10, dy: 0)
  }

  func textField(_ field: UITextField, shouldChangeCharactersIn range: NSRange, replacementString string: String) -> Bool {
    (field.text ?? "").utf16.count - range.length + string.utf16.count <= limit
  }

  var trimmed: String { (text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
}

final class LodyFormTextView: UITextView, UITextViewDelegate {
  private let limit: Int
  var changed: (() -> Void)?

  init(id: String, label: String, text: String?, limit: Int, minHeight: CGFloat) {
    self.limit = limit
    super.init(frame: .zero, textContainer: nil)
    let font = UIFont.dynamic(of: 15)
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = 21 * font.pointSize / 15
    paragraph.maximumLineHeight = paragraph.minimumLineHeight
    typingAttributes = [.font: font, .foregroundColor: UIColor.lodyInk, .paragraphStyle: paragraph]
    attributedText = NSAttributedString(string: text ?? "", attributes: typingAttributes)
    self.font = font
    textColor = .lodyInk
    backgroundColor = .clear
    isScrollEnabled = false
    autocorrectionType = .no
    textContainer.lineFragmentPadding = 0
    textContainerInset = UIEdgeInsets(top: 11, left: 16, bottom: 11, right: 16)
    accessibilityIdentifier = id
    accessibilityLabel = label
    delegate = self
    heightAnchor.constraint(greaterThanOrEqualToConstant: minHeight).isActive = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
    textView.text.utf16.count - range.length + text.utf16.count <= limit
  }

  func textViewDidChange(_ textView: UITextView) {
    changed?()
  }

  var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
}

final class LodyFormToggle: UIView {
  let toggle = UISwitch()

  init(id: String, title: String, isOn: Bool) {
    super.init(frame: .zero)
    let label = UILabel()
    label.text = title
    label.font = .dynamic(of: 15)
    label.textColor = .lodyInk
    label.numberOfLines = 0
    label.isAccessibilityElement = false
    toggle.isOn = isOn
    toggle.accessibilityIdentifier = id
    toggle.accessibilityLabel = title
    let row = UIStackView(arrangedSubviews: [label, toggle])
    row.alignment = .center
    row.spacing = 12
    row.translatesAutoresizingMaskIntoConstraints = false
    addSubview(row)
    NSLayoutConstraint.activate([
      heightAnchor.constraint(greaterThanOrEqualToConstant: 52),
      row.topAnchor.constraint(equalTo: topAnchor, constant: 10),
      row.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -10),
      row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 16),
      row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -16),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }
}

enum LodyFormButton {
  static func make(id: String, title: String, destructive: Bool = false, action: @escaping @MainActor () -> Void) -> UIButton {
    var configuration = UIButton.Configuration.plain()
    configuration.baseForegroundColor = destructive ? .systemRed : .lodyAccent
    configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
      var next = attributes
      next.font = .dynamic(of: 15)
      return next
    }
    let button = UIButton(configuration: configuration, primaryAction: UIAction { _ in action() })
    button.setTitle(title, for: .normal)
    button.accessibilityIdentifier = id
    button.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    return button
  }
}
