import UIKit

enum LodyFlatRows {
  static let iconCenter = LodyDesign.Rail.center
  static let iconSize: CGFloat = 18
  static let iconBox: CGFloat = 28
  static let avatarSize: CGFloat = 40
  static let readingMargin: CGFloat = 16

  static func sectionHasIcons(_ rows: [LodyListRow]) -> Bool {
    rows.contains { !$0.image.isEmpty || !$0.imageAsset.isEmpty || !$0.filePath.isEmpty }
  }

  static func textLeading(sectionHasIcons: Bool) -> CGFloat {
    sectionHasIcons ? LodyDesign.Rail.text : readingMargin
  }

  static func separatorLeading(textLeading: CGFloat, isLast: Bool) -> CGFloat? {
    isLast ? nil : textLeading
  }

  static func minHeight(hasSubtitle: Bool) -> CGFloat {
    hasSubtitle ? 52 : 44
  }
}
