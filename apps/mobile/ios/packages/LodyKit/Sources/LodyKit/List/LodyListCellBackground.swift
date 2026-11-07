import UIKit

enum LodyListCellBackground {
  static func visualState(for state: UICellConfigurationState) -> UICellConfigurationState {
    guard state.isSwiped else { return state }
    var visual = state
    visual.isSwiped = false
    visual.isSelected = false
    visual.isHighlighted = false
    return visual
  }

  static func railConfiguration(for state: UICellConfigurationState) -> UIBackgroundConfiguration {
    var background = UIBackgroundConfiguration.listPlainCell().updated(for: visualState(for: state))
    if !state.isHighlighted && !state.isSelected && !state.isSwiped {
      background.backgroundColor = .clear
    }
    return background
  }
}

/// UIKit rounds each list cell on its own, so a parent that becomes the last
/// row gets bottom corners the instant a collapse starts while its children
/// are still sliding out. One card per section keeps a single outline that
/// UIKit animates with the section frame.
final class LodySectionCardView: UICollectionReusableView {
  static let kind = "lody.section.card"
  static let cornerRadius: CGFloat = 26

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .secondarySystemGroupedBackground
    layer.cornerRadius = Self.cornerRadius
    layer.cornerCurve = .continuous
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { nil }
}
