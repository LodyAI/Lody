import UIKit

enum LodySidebarCellBackground {
  static func configuration(for state: UICellConfigurationState) -> UIBackgroundConfiguration {
    var background = UIBackgroundConfiguration.clear()
    background.cornerRadius = 10
    background.backgroundInsets = .init(top: 2, leading: 0, bottom: 2, trailing: 0)
    if state.isSelected {
      background.backgroundColor = .lodySelection
    } else if state.isHighlighted {
      background.backgroundColor = .lodyPress
    }
    return background
  }
}
