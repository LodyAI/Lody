import AnchoredOverlayKit
import UIKit

/// App-owned actions/localization; layout and controls belong to the overlay kit.
@MainActor enum ChatAttachmentMenu {
  static var mediaActionAppearance: OverlayActionAppearance {
    .clearGlass(backingColor: .black.withAlphaComponent(0.60))
  }

  enum Action: String, CaseIterable {
    case takePhoto, recentPhotos, files
    var image: String {
      switch self {
      case .takePhoto: return "camera"
      case .recentPhotos: return "photo"
      case .files: return "paperclip"
      }
    }
  }

  static func content(onSelect: @escaping (Action) -> Void) -> UIView {
    OverlayMenuContent(items: Action.allCases.map { action in
      .init(title: String(localized: String.LocalizationValue("native.chat.composer." + action.rawValue), bundle: .lody),
            systemImage: action.image, accessibilityIdentifier: "attachment-menu-" + action.rawValue) {
        onSelect(action)
      }
    })
  }
}
