import UIKit

final class ChatComposerGrabber: UIView {
  static let height: CGFloat = 20
  var onToggle: (() -> Void)?
  var onPan: ((UIPanGestureRecognizer) -> Void)?
  private let handle = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    accessibilityIdentifier = "session-grabber"
    isAccessibilityElement = true
    accessibilityTraits = .button
    handle.backgroundColor = .tertiaryLabel
    handle.layer.cornerRadius = 2.5
    handle.isUserInteractionEnabled = false
    handle.translatesAutoresizingMaskIntoConstraints = false
    addSubview(handle)
    NSLayoutConstraint.activate([
      handle.centerXAnchor.constraint(equalTo: centerXAnchor),
      handle.centerYAnchor.constraint(equalTo: centerYAnchor),
      handle.widthAnchor.constraint(equalToConstant: 36),
      handle.heightAnchor.constraint(equalToConstant: 5),
    ])
    addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tap)))
    addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(pan(_:))))
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func accessibilityActivate() -> Bool {
    onToggle?()
    return true
  }

  @objc private func tap() { onToggle?() }
  @objc private func pan(_ recognizer: UIPanGestureRecognizer) { onPan?(recognizer) }
}
