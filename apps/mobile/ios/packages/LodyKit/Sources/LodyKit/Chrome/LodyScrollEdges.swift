import UIKit

/// Native scroll owners configure UIKit directly.
@MainActor
enum LodyScrollEdges {
  static let ownerChanged = Notification.Name("LodyContentScrollViewChanged")

  static func bind(_ scrollView: UIScrollView, to owner: UIViewController) {
    guard owner.contentScrollView(for: .top) !== scrollView ||
      owner.contentScrollView(for: .bottom) !== scrollView else { return }
    owner.setContentScrollView(scrollView, for: .top)
    owner.setContentScrollView(scrollView, for: .bottom)
    NotificationCenter.default.post(name: ownerChanged, object: owner)
  }

  static func unbind(_ scrollView: UIScrollView, from owner: UIViewController) {
    var changed = false
    for edge in [NSDirectionalRectEdge.top, .bottom] where owner.contentScrollView(for: edge) === scrollView {
      owner.setContentScrollView(nil, for: edge)
      changed = true
    }
    if changed { NotificationCenter.default.post(name: ownerChanged, object: owner) }
  }

  static func navigation(_ scrollView: UIScrollView) {
    scrollView.topEdgeEffect.isHidden = false
    scrollView.topEdgeEffect.style = .soft
    floatingControls(scrollView)
  }

  static func chat(_ scrollView: UIScrollView) {
    scrollView.topEdgeEffect.isHidden = false
    scrollView.topEdgeEffect.style = .soft
    scrollView.bottomEdgeEffect.isHidden = true
  }

  static func grouped(_ scrollView: UIScrollView) {
    navigation(scrollView)
  }

  static func floatingControls(_ scrollView: UIScrollView) {
    scrollView.bottomEdgeEffect.isHidden = false
    scrollView.bottomEdgeEffect.style = .soft
  }
}
