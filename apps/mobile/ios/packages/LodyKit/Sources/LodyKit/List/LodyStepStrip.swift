import UIKit

final class LodyStepStrip: UIControl {
  private(set) var selectedIndex = 0
  private let stack = UIStackView()
  private var titles: [String] = []
  private var done: [Bool] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    stack.axis = .horizontal
    stack.distribution = .fillEqually
    stack.spacing = 6
    addSubview(stack)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    stack.frame = bounds
  }

  override func tintColorDidChange() {
    super.tintColorDidChange()
    refresh()
  }

  func setTitles(_ value: [String]) {
    guard value != titles else { return }
    titles = value
    stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
    for index in value.indices {
      let step = Step()
      step.tag = index
      step.accessibilityIdentifier = "list-step-\(index)"
      step.addTarget(self, action: #selector(tapped(_:)), for: .touchUpInside)
      stack.addArrangedSubview(step)
    }
    refresh()
  }

  func setDone(_ value: [Bool]) {
    done = value
    refresh()
  }

  func setSelectedIndex(_ value: Int) {
    selectedIndex = value
    refresh()
  }

  private func refresh() {
    for case let (index, step as Step) in stack.arrangedSubviews.enumerated() {
      step.apply(
        title: titles[index],
        done: done.indices.contains(index) && done[index],
        current: index == selectedIndex,
        tint: tintColor
      )
    }
  }

  @objc private func tapped(_ sender: UIControl) {
    guard sender.tag != selectedIndex else { return }
    selectedIndex = sender.tag
    refresh()
    sendActions(for: .valueChanged)
  }
}

private final class Step: UIControl {
  private let bar = UIView()
  private let title = UILabel()
  private let check = UIImageView(
    image: UIImage(
      systemName: "checkmark",
      withConfiguration: UIImage.SymbolConfiguration(textStyle: .caption2, scale: .small)
    )
  )
  private let label = UIStackView()

  init() {
    super.init(frame: .zero)
    bar.layer.cornerRadius = 2
    bar.layer.cornerCurve = .continuous
    title.font = .preferredFont(forTextStyle: .footnote)
    title.adjustsFontForContentSizeCategory = true
    title.lineBreakMode = .byTruncatingTail
    check.setContentHuggingPriority(.required, for: .horizontal)
    label.addArrangedSubview(title)
    label.addArrangedSubview(check)
    label.spacing = 3
    label.alignment = .center
    for view in [bar, label] as [UIView] {
      view.isUserInteractionEnabled = false
      addSubview(view)
    }
    isAccessibilityElement = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }

  override func layoutSubviews() {
    super.layoutSubviews()
    bar.frame = CGRect(x: 0, y: 6, width: bounds.width, height: 4)
    let size = label.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
    label.frame = CGRect(x: 0, y: 17, width: min(size.width, bounds.width), height: size.height)
  }

  func apply(title text: String, done: Bool, current: Bool, tint: UIColor) {
    title.text = text
    title.textColor = current ? .label : .secondaryLabel
    title.font = UIFontMetrics(forTextStyle: .footnote).scaledFont(
      for: .systemFont(ofSize: 13, weight: current ? .semibold : .regular)
    )
    check.isHidden = !done
    check.tintColor = tint
    bar.backgroundColor = done || current ? tint : .tertiarySystemFill
    accessibilityLabel = text
    accessibilityValue = done ? String(localized: "native.list.answered", bundle: .lody) : nil
    accessibilityTraits = current ? [.button, .selected] : .button
    setNeedsLayout()
  }
}
