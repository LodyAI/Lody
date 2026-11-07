import UIKit

/// Reports each finished layout pass. `scrollViewDidScroll` runs before UIKit moves a pinned
/// header, so geometry compared against the current offset must be read from here.
final class ChatListCollectionView: UICollectionView {
  var onLayout: (() -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?()
  }
}
