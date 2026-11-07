import UIKit

final class LodySymbolButton: UIView {
  var onSymbolPress: ([String: Any]) -> Void = { _ in }
  var onSymbolLongPress: ([String: Any]) -> Void = { _ in }
  var pressed: (() -> Void)?
  var held: (() -> Void)?
  private let button = UIButton(type: .system)
  private let hold = UILongPressGestureRecognizer()
  private var symbol = "circle"
  private var imageAsset = ""
  private var prominent = false
  private var glass = false
  private var loading = false
  private var disabled = false
  private var foreground: UIColor = .label

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    button.addTarget(self, action: #selector(press), for: .primaryActionTriggered)
    hold.addTarget(self, action: #selector(longPressed(_:)))
    hold.minimumPressDuration = 0.6
    hold.isEnabled = false
    button.addGestureRecognizer(hold)
    button.tintColor = .label
    addSubview(button)
    apply()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    button.frame = bounds
  }

  func setSymbol(_ value: String) {
    let previous = symbol
    symbol = value
    apply(byLayer: previous + ".fill" == value || value + ".fill" == previous)
  }

  func setAccessibilityName(_ value: String) {
    button.accessibilityLabel = value
  }

  func setImageAsset(_ value: String) {
    imageAsset = value
    apply()
  }

  func setProminent(_ value: Bool) {
    prominent = value
    apply()
  }

  func setGlass(_ value: Bool) {
    glass = value
    apply()
  }

  func setDisabled(_ value: Bool) {
    disabled = value
    syncEnabled()
  }

  func setLoading(_ value: Bool) {
    guard value != loading else { return }
    loading = value
    syncEnabled()
    apply()
  }

  func setTint(_ value: String) {
    foreground = lodyTint(value) ?? .label
    button.tintColor = foreground
    apply()
  }

  func setLongPress(_ value: Bool) {
    hold.isEnabled = value
  }

  private func apply(byLayer: Bool = false) {
    var configuration = prominent
      ? UIButton.Configuration.filled()
      : UIButton.Configuration.plain()
    if glass { configuration = .glass() }
    if imageAsset.isEmpty {
      configuration.image = UIImage(systemName: symbol)
    } else {
      configuration.image = UIImage(named: imageAsset)?.withRenderingMode(.alwaysTemplate)
    }
    configuration.preferredSymbolConfigurationForImage = UIImage.SymbolConfiguration(
      textStyle: prominent ? .body : .title3,
      scale: .medium
    )
    configuration.contentInsets = .zero
    if !imageAsset.isEmpty { configuration.baseForegroundColor = foreground }
    if prominent || glass { configuration.cornerStyle = .capsule }
    if imageAsset.isEmpty, button.configuration?.image != nil {
      configuration.symbolContentTransition = .init(byLayer ? .replace.byLayer : .replace)
    }
    configuration.showsActivityIndicator = loading
    button.configuration = configuration
    syncEnabled()
  }

  private func syncEnabled() {
    button.isEnabled = !disabled && !loading
  }

  @objc private func press() {
    onSymbolPress([:])
    pressed?()
  }

  @objc private func longPressed(_ recognizer: UILongPressGestureRecognizer) {
    guard recognizer.state == .began else { return }
    UISelectionFeedbackGenerator().selectionChanged()
    onSymbolLongPress([:])
    held?()
  }
}
