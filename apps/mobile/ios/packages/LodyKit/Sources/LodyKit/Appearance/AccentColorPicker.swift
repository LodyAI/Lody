import UIKit

@MainActor
final class AccentColorPicker: NSObject, UIColorPickerViewControllerDelegate {
  private weak var picker: UIColorPickerViewController?

  func present(from controller: UIViewController, title: String) {
    guard picker?.presentingViewController == nil else { return }
    let picker = UIColorPickerViewController()
    picker.title = title
    picker.supportsAlpha = false
    picker.selectedColor = LodyAccentChoice.current.color
    picker.delegate = self
    self.picker = picker
    controller.present(picker, animated: true)
  }

  func colorPickerViewController(_ viewController: UIColorPickerViewController, didSelect color: UIColor, continuously: Bool) {
    LodyAccentChoice.save(LodyAccentChoice.hex(color))
  }

  func dismiss() {
    picker?.delegate = nil
    picker?.dismiss(animated: false)
    picker = nil
  }
}
