import UIKit

class LodyAppearanceView: UIView {
  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(lodyAppearanceDidChange),
      name: .lodyAppearanceDidChange,
      object: nil
    )
  }

  deinit { NotificationCenter.default.removeObserver(self) }

  @objc func lodyAppearanceDidChange() {}
}
