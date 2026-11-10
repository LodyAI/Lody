import UIKit

@MainActor
final class ChatUsagePanel: UIViewController, UIPopoverPresentationControllerDelegate {
  let usage: ChatSessionUsage
  private let now: () -> Date
  private let stack = UIStackView()

  init(usage: ChatSessionUsage, now: @escaping () -> Date = Date.init) {
    self.usage = usage
    self.now = now
    super.init(nibName: nil, bundle: nil)
  }
  @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .secondarySystemBackground
    view.accessibilityIdentifier = "session-usage-panel"
    stack.axis = .vertical
    stack.spacing = 14
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
      stack.topAnchor.constraint(equalTo: view.topAnchor, constant: 16),
      stack.bottomAnchor.constraint(equalTo: view.bottomAnchor, constant: -16),
    ])
    if usage.isContextCompacting == true {
      stack.addArrangedSubview(label(ChatSessionUsage.text("context")))
      let row = UIStackView()
      row.spacing = 8
      let spinner = UIActivityIndicatorView(style: .medium)
      spinner.startAnimating()
      row.addArrangedSubview(spinner)
      row.addArrangedSubview(label(ChatSessionUsage.text("compacting")))
      stack.addArrangedSubview(row)
    } else if let context = usage.context, let percent = context.percentage {
      let meter = meter(title: ChatSessionUsage.text("context"), percent: percent)
      let used = max(0, context.used.isFinite ? context.used : 0)
      let detail = "\(used.formatted(.number.notation(.compactName))) / \(context.size.formatted(.number.notation(.compactName)))"
      meter.addArrangedSubview(label(detail, secondary: true))
      stack.addArrangedSubview(meter)
    }
    if usage.quota != nil {
      if usage.context?.percentage != nil || usage.isContextCompacting == true {
        let separator = UIView()
        separator.backgroundColor = .separator
        separator.heightAnchor.constraint(equalToConstant: 0.5).isActive = true
        stack.addArrangedSubview(separator)
      }
      stack.addArrangedSubview(label(usage.title, secondary: true))
      for (index, window) in usage.windows.enumerated() {
        let meter = meter(title: ChatSessionUsage.label(window), percent: window.percentage)
        if let epoch = window.resetsAt, epoch.isFinite, epoch != 0 {
          meter.addArrangedSubview(ChatUsageResetRow(epoch: epoch, now: now, index: index))
        }
        stack.addArrangedSubview(meter)
      }
      if usage.windows.isEmpty { stack.addArrangedSubview(label(ChatSessionUsage.text("unavailable"), secondary: true)) }
    }
    let width: CGFloat = 290
    let size = stack.systemLayoutSizeFitting(CGSize(width: width - 32, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
    preferredContentSize = CGSize(width: width, height: size.height + 32)
  }
  func adaptivePresentationStyle(for controller: UIPresentationController) -> UIModalPresentationStyle { .none }
  private func label(_ text: String, secondary: Bool = false) -> UILabel {
    let label = UILabel()
    label.text = text
    label.font = .preferredFont(forTextStyle: .caption1)
    label.adjustsFontForContentSizeCategory = true
    label.textColor = secondary ? .secondaryLabel : .label
    label.numberOfLines = 0
    return label
  }
  private func meter(title: String, percent: Double) -> UIStackView {
    let meter = UIStackView()
    meter.axis = .vertical
    meter.spacing = 6
    let heading = UIStackView()
    heading.spacing = 8
    heading.addArrangedSubview(label(title))
    let value = label(ChatSessionUsage.used(percent), secondary: true)
    value.setContentCompressionResistancePriority(.required, for: .horizontal)
    value.textAlignment = .right
    heading.addArrangedSubview(value)
    meter.addArrangedSubview(heading)
    let progress = UIProgressView(progressViewStyle: .bar)
    progress.progressTintColor = .label
    progress.trackTintColor = .quaternaryLabel
    progress.progress = Float(percent / 100)
    progress.accessibilityLabel = title
    progress.accessibilityValue = ChatSessionUsage.used(percent)
    meter.addArrangedSubview(progress)
    return meter
  }
}

@MainActor
private final class ChatUsageResetRow: UIStackView {
  private var mode = ChatUsageReset()
  private let caption = UILabel()
  private let button = UIButton(type: .system)
  private let epoch: Double
  private let now: () -> Date
  init(epoch: Double, now: @escaping () -> Date, index: Int) {
    self.epoch = epoch
    self.now = now
    super.init(frame: .zero)
    alignment = .center
    spacing = 4
    caption.font = .preferredFont(forTextStyle: .caption2)
    caption.adjustsFontForContentSizeCategory = true
    caption.textColor = .secondaryLabel
    caption.numberOfLines = 0
    addArrangedSubview(caption)
    button.setImage(UIImage(systemName: "arrow.left.arrow.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12)), for: .normal)
    button.tintColor = .secondaryLabel
    button.accessibilityIdentifier = "session-usage-reset-\(index)"
    button.widthAnchor.constraint(equalToConstant: 44).isActive = true
    button.heightAnchor.constraint(equalToConstant: 44).isActive = true
    button.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      self.mode.toggle()
      self.render()
    }, for: .touchUpInside)
    addArrangedSubview(button)
    render()
  }
  @available(*, unavailable) required init(coder: NSCoder) { fatalError() }
  private func render() {
    caption.text = mode.text(epoch: epoch, now: now())
    button.accessibilityLabel = mode.toggleLabel
    button.accessibilityValue = mode.value(epoch: epoch, now: now())
  }
}

@MainActor
enum ChatUsageRing {
  /// The ring beside Send: a 14 pt circle on an 18 pt canvas.
  static let side: CGFloat = 18
  static func image(_ percent: Double) -> UIImage {
    UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { context in
      let center = CGPoint(x: side / 2, y: side / 2)
      let radius = side / 2 - 2
      context.cgContext.setLineWidth(2)
      context.cgContext.setLineCap(.round)
      UIColor.label.withAlphaComponent(0.2).setStroke()
      context.cgContext.strokeEllipse(in: CGRect(x: 2, y: 2, width: radius * 2, height: radius * 2))
      if percent > 0 {
        UIColor.label.setStroke()
        context.cgContext.addArc(center: center, radius: radius, startAngle: -.pi / 2, endAngle: -.pi / 2 + 2 * .pi * min(100, percent) / 100, clockwise: false)
        context.cgContext.strokePath()
      }
    }.withRenderingMode(.alwaysTemplate)
  }
}
