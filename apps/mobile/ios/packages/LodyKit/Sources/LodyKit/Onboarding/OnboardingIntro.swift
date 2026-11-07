import UIKit

@MainActor
final class OnboardingIntro {
  private static let rise: CGFloat = 14
  private static let timing = UICubicTimingParameters(controlPoint1: CGPoint(x: 0.45, y: 0), controlPoint2: CGPoint(x: 0.55, y: 1))

  let probe: UIView?
  private var animators: [(animator: UIViewPropertyAnimator, view: UIView)] = []
  private var running = 0
  private var plays = 0

  init() {
    guard LodyUIVerify.enabled else {
      probe = nil
      return
    }
    let probe = UIView()
    probe.isAccessibilityElement = true
    probe.accessibilityIdentifier = "onboarding-intro"
    probe.accessibilityLabel = "plays 0"
    probe.accessibilityValue = "pending"
    self.probe = probe
  }

  func play(_ blocks: [(view: UIView, step: Int)]) {
    for (animator, view) in animators {
      animator.stopAnimation(true)
      Self.settle(view)
    }
    animators = []
    running = 0
    plays += 1
    probe?.accessibilityLabel = "plays \(plays)"
    guard !UIAccessibility.isReduceMotionEnabled else {
      blocks.forEach { Self.settle($0.view) }
      probe?.accessibilityValue = "reduced"
      return
    }
    probe?.accessibilityValue = "running"
    for (view, step) in blocks {
      view.alpha = 0
      view.transform = CGAffineTransform(translationX: 0, y: Self.rise)
      let animator = UIViewPropertyAnimator(duration: 0.5, timingParameters: Self.timing)
      animator.addAnimations { Self.settle(view) }
      animator.addCompletion { [weak self] _ in
        MainActor.assumeIsolated { self?.finished(blocks.map(\.view)) }
      }
      running += 1
      animators.append((animator, view))
      animator.startAnimation(afterDelay: 0.3 + Double(step) * 0.09)
    }
  }

  private func finished(_ views: [UIView]) {
    running -= 1
    guard running == 0 else { return }
    animators = []
    let final = views.allSatisfy { $0.alpha == 1 && $0.transform == .identity }
    probe?.accessibilityValue = final ? "settled" : "unsettled"
  }

  private static func settle(_ view: UIView) {
    view.alpha = 1
    view.transform = .identity
  }
}
