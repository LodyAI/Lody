import UIKit

@MainActor
protocol ChatComposerSurfaceLayout: AnyObject {
  func activate()
  func update(isFocused: Bool)
  func completeTransition()
}

extension ChatComposerSurfaceLayout {
  func completeTransition() {}
}
