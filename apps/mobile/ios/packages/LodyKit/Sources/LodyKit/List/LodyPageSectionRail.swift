import UIKit

final class LodyPageSectionRail: UIView {
  var onSelect: ((Int) -> Void)?

  private let control = LiquidGlassSegmentedControl(items: [])
  private let driver: LiquidGlassSegmentLiftDriver
  private var selectionPosition: CGFloat = 0
  private var titles: [String] = []

  private static let railHeight: CGFloat = 44
  private static let segmentPadding: CGFloat = 18

  override init(frame: CGRect) {
    driver = LiquidGlassSegmentLiftDriver(control: control)
    super.init(frame: frame)
    accessibilityIdentifier = "create-type"
    control.accessibilityIdentifier = "create-type"
    control.apportionsSegmentWidthsByContent = false
    control.translatesAutoresizingMaskIntoConstraints = false
    control.addAction(
      UIAction { [weak self] _ in self?.segmentSelectionChanged() },
      for: .valueChanged
    )
    control.applyIndicatorProgressAfterLayout = { [weak self] in
      guard let self else { return }
      driver.setIndicatorProgress(visualProgress(for: selectionPosition))
    }
    addSubview(control)
    NSLayoutConstraint.activate([
      control.topAnchor.constraint(equalTo: topAnchor),
      control.leadingAnchor.constraint(equalTo: leadingAnchor),
      control.trailingAnchor.constraint(equalTo: trailingAnchor),
      control.bottomAnchor.constraint(equalTo: bottomAnchor),
      control.heightAnchor.constraint(equalToConstant: Self.railHeight),
    ])
  }

  override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
    super.traitCollectionDidChange(previousTraitCollection)
    applySegmentMetrics()
    invalidateIntrinsicContentSize()
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) is not supported")
  }

  override var intrinsicContentSize: CGSize {
    CGSize(width: control.intrinsicContentSize.width, height: Self.railHeight)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil else { return }
    driver.prepareGlass()
    driver.setIndicatorProgress(visualProgress(for: selectionPosition))
  }

  func setTitles(_ titles: [String]) {
    guard titles != self.titles else { return }
    self.titles = titles
    control.removeAllSegments()
    for (index, title) in titles.enumerated() {
      control.insertSegment(withTitle: title, at: index, animated: false)
    }
    if control.numberOfSegments > 0 {
      control.selectedSegmentIndex = min(Int(selectionPosition.rounded()), titles.count - 1)
    }
    applySegmentMetrics()
    invalidateIntrinsicContentSize()
  }

  func setSelected(_ index: Int) {
    guard titles.indices.contains(index) else { return }
    selectionPosition = CGFloat(index)
    if control.selectedSegmentIndex != index {
      control.selectedSegmentIndex = index
    }
    driver.setLifted(false)
    driver.setIndicatorProgress(visualProgress(for: selectionPosition))
  }

  func setSelectionProgress(_ progress: CGFloat) {
    let upperBound = CGFloat(max(titles.count - 1, 0))
    selectionPosition = min(max(progress, 0), upperBound)
    driver.setIndicatorProgress(visualProgress(for: selectionPosition))
  }

  func beginInteractiveTransition() {
    driver.setLifted(true)
  }

  private func applySegmentMetrics() {
    let font = UIFontMetrics(forTextStyle: .subheadline).scaledFont(
      for: .systemFont(ofSize: 15, weight: .semibold),
      maximumPointSize: 19
    )
    control.setTitleTextAttributes([.font: font], for: .normal)
    for index in 0..<control.numberOfSegments {
      guard let title = control.titleForSegment(at: index) else { continue }
      let width = ceil((title as NSString).size(withAttributes: [.font: font]).width)
      control.setWidth(width + Self.segmentPadding * 2, forSegmentAt: index)
    }
    invalidateIntrinsicContentSize()
  }

  private func segmentSelectionChanged() {
    let index = control.selectedSegmentIndex
    guard titles.indices.contains(index) else { return }
    driver.setLifted(true)
    onSelect?(index)
  }

  private func visualProgress(for position: CGFloat) -> CGFloat {
    guard effectiveUserInterfaceLayoutDirection == .rightToLeft else { return position }
    return CGFloat(max(titles.count - 1, 0)) - position
  }
}
