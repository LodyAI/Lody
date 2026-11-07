import UIKit

struct LodyProgressRowContent: UIContentConfiguration {
  var row: LodyListRow
  func makeContentView() -> UIView & UIContentView { LodyProgressRowView(self) }
  func updated(for state: UIConfigurationState) -> LodyProgressRowContent { self }
}

final class LodyProgressRowView: UIView, UIContentView {
  private let title = UILabel()
  private let value = UILabel()
  private let subtitle = UILabel()
  private let progress = UIProgressView(progressViewStyle: .default)
  var configuration: UIContentConfiguration { didSet { apply() } }

  init(_ configuration: LodyProgressRowContent) {
    self.configuration = configuration
    super.init(frame: .zero)
    title.font = .preferredFont(forTextStyle: .subheadline)
    value.font = .preferredFont(forTextStyle: .subheadline)
    value.textAlignment = .right
    value.setContentCompressionResistancePriority(.required, for: .horizontal)
    subtitle.font = .preferredFont(forTextStyle: .caption1)
    subtitle.textColor = .secondaryLabel
    for label in [title, value, subtitle] {
      label.adjustsFontForContentSizeCategory = true
      label.numberOfLines = 0
    }
    progress.progressTintColor = .lodyAccent
    progress.trackTintColor = .tertiarySystemFill
    let heading = UIStackView(arrangedSubviews: [title, value])
    heading.spacing = 12
    let stack = UIStackView(arrangedSubviews: [heading, progress, subtitle])
    stack.axis = .vertical
    stack.spacing = 7
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
      stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
      stack.topAnchor.constraint(equalTo: topAnchor, constant: 12),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -12),
      heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])
    apply()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  private func apply() {
    guard let content = configuration as? LodyProgressRowContent else { return }
    let row = content.row
    title.text = row.title
    value.text = row.value
    subtitle.text = row.subtitle
    progress.progress = Float(min(1, max(0, row.progress ?? 0)))
  }
}
