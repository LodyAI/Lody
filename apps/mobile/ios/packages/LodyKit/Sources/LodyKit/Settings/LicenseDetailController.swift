import UIKit

@MainActor
final class LicenseDetailController: UIViewController {
  private let name: String
  private let scroll = UIScrollView()
  private let stack = UIStackView()

  init(name: String) {
    self.name = name
    super.init(nibName: nil, bundle: nil)
    title = name
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    scroll.frame = view.bounds
    scroll.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    scroll.contentInsetAdjustmentBehavior = .automatic
    scroll.alwaysBounceVertical = true
    LodyScrollEdges.navigation(scroll)
    view.addSubview(scroll)
    stack.axis = .vertical
    stack.spacing = 12
    stack.translatesAutoresizingMaskIntoConstraints = false
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -16),
      stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -16),
    ])
    guard let entry = LodyLicenses.entry(name) else {
      stack.addArrangedSubview(label(String(localized: "settings.licenses.missing", bundle: .lody), size: 15, color: .secondaryLabel))
      return
    }
    stack.addArrangedSubview(label(entry.name, size: 20, weight: .semibold, color: .label))
    let meta = [entry.version.map { "v\($0)" }, entry.license].compactMap { $0 }.joined(separator: " · ")
    stack.addArrangedSubview(label(meta, size: 15, color: .secondaryLabel))
    if let url = entry.url {
      stack.addArrangedSubview(LicenseText(url, font: .dynamic(of: 15), color: .secondaryLabel))
    }
    let mono = UIFont(name: "Menlo", size: 13 * UIFont.dynamicScale()) ?? .monospacedSystemFont(ofSize: 13, weight: .regular)
    stack.addArrangedSubview(
      LicenseText(LodyLicenses.text(entry), font: mono, color: .label, lineHeight: 20 * UIFont.dynamicScale())
    )
  }

  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    LodyScrollEdges.bind(scroll, to: self)
  }

  private func label(_ text: String, size: CGFloat, weight: UIFont.Weight = .regular, color: UIColor) -> UILabel {
    let label = UILabel()
    label.text = text
    label.font = .dynamic(of: size, weight: weight)
    label.textColor = color
    label.numberOfLines = 0
    return label
  }
}

// Selectable, yet VoiceOver reads it once as a label rather than as an editable value.
private final class LicenseText: UITextView {
  init(_ text: String, font: UIFont, color: UIColor, lineHeight: CGFloat = 0) {
    super.init(frame: .zero, textContainer: nil)
    let paragraph = NSMutableParagraphStyle()
    paragraph.minimumLineHeight = lineHeight
    paragraph.maximumLineHeight = lineHeight
    attributedText = NSAttributedString(
      string: text, attributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph]
    )
    isEditable = false
    isScrollEnabled = false
    backgroundColor = .clear
    textContainerInset = .zero
    textContainer.lineFragmentPadding = 0
    dataDetectorTypes = .link
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override var accessibilityLabel: String? {
    get { text }
    set {}
  }

  override var accessibilityValue: String? {
    get { nil }
    set {}
  }
}
