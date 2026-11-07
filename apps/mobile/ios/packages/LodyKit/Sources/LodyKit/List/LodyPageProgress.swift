import Foundation

enum LodyPageProgress {
  /// `UIPageViewController(transitionStyle: .scroll)` rests at `offset.x ≈ width`.
  /// Negative walks to the previous page; positive walks to the next.
  static func signedProgress(offsetX: CGFloat, width: CGFloat) -> CGFloat {
    guard width > 0 else { return 0 }
    return (offsetX - width) / width
  }

  static func selectionPosition(page: Int, signedProgress: CGFloat, pageCount: Int) -> CGFloat {
    let upper = CGFloat(max(pageCount - 1, 0))
    return min(max(CGFloat(page) + signedProgress, 0), upper)
  }
}
