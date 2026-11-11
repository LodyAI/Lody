import LodyDesignSystem
import UIKit

/// The "every N hours / minutes" wheel, shown as a short sheet from the schedule editor. Hours run
/// 1–24 and minutes 1–59 (sixty minutes is one hour); a step that does not divide the clock is
/// stored by the runtime as an anchored interval. Each turn of the wheel applies at once.
@MainActor
final class ScheduleEveryPicker: UIViewController, UIPickerViewDataSource, UIPickerViewDelegate {
  static let hours = Array(1...24)
  static let minutes = Array(1...59)

  private let values: [Int]
  private let label: (Int) -> String
  private let picked: (Int) -> Void
  private let initial: Int
  private let picker = UIPickerView()

  init(title: String, values: [Int], selected: Int, label: @escaping (Int) -> String, picked: @escaping (Int) -> Void) {
    self.values = values
    self.label = label
    self.picked = picked
    initial = values.firstIndex(of: selected) ?? (selected > (values.last ?? 0) ? values.count - 1 : 0)
    super.init(nibName: nil, bundle: nil)
    self.title = title
    modalPresentationStyle = .pageSheet
    if let sheet = sheetPresentationController {
      sheet.detents = [.custom(identifier: .init("scheduleEvery")) { _ in 280 }]
      sheet.prefersGrabberVisible = true
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .lodyGroupedBackground
    let heading = UILabel()
    heading.text = title
    heading.font = .preferredFont(forTextStyle: .headline)
    heading.textColor = .lodyInk
    heading.textAlignment = .center
    picker.dataSource = self
    picker.delegate = self
    picker.accessibilityIdentifier = "schedule-every-wheel"
    let stack = UIStackView(arrangedSubviews: [heading, picker])
    stack.axis = .vertical
    stack.spacing = LodySpacing.sm
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.topAnchor, constant: LodySpacing.xxl),
      stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
      stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
    ])
    picker.selectRow(initial, inComponent: 0, animated: false)
  }

  func numberOfComponents(in pickerView: UIPickerView) -> Int { 1 }

  func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int { values.count }

  func pickerView(_ pickerView: UIPickerView, titleForRow row: Int, forComponent component: Int) -> String? { label(values[row]) }

  func pickerView(_ pickerView: UIPickerView, didSelectRow row: Int, inComponent component: Int) { picked(values[row]) }
}
