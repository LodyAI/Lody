import LodyDesignSystem
import UIKit

/// The blurred backdrop behind a list's pinned group label, shared by Home Chats and Schedules.
/// Its host adds it to the collection view at zPosition 1, under headers at zPosition 2.
/// Keep a blurred base under the upper gradient: fading a single blur view mixes
/// sharp source text back in. Only the tail below the label fades to clear.
final class LodyPinnedLabelBackdrop: UIView {
  private let base = LodyPinnedLabelBlur(intensity: 0.2)
  private let upper = LodyPinnedLabelBlur(intensity: 0.75)
  var archived = false { didSet { if archived != oldValue { updateTone() } } }

  init() {
    super.init(frame: .zero)
    isUserInteractionEnabled = false
    addSubview(base)
    addSubview(upper)
    updateTone()
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: LodyPinnedLabelBackdrop, _: UITraitCollection) in
      view.updateTone()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  /// One continuous backdrop runs from the pinned label to the window top.
  /// Keep UIKit's original supplementary label, including its native push-off.
  /// Call from the collection view's finished layout pass (see `ChatListCollectionView`):
  /// `scrollViewDidScroll` still sees pinned header frames from the previous offset.
  func update(in collection: UICollectionView, pinsLabels: Bool) {
    let top = collection.contentOffset.y + collection.adjustedContentInset.top
    // At rest the first label already sits at the top edge; it only counts as pinned (and
    // brings the blur) once content has actually scrolled under it.
    let scrolled = top > 0.5
    // During a diffable update UIKit can still display headers from the old snapshot.
    // Their index paths are not valid in the new layout. Read the actual visible views'
    // frames instead of asking UICollectionView to resolve transitional index paths.
    let headers = collection.visibleSupplementaryViews(ofKind: UICollectionView.elementKindSectionHeader)
    let active = headers.filter { header in
      pinsLabels && scrolled && header.frame.minY <= top + 1
    }.max { $0.frame.minY < $1.frame.minY }
    // A departing header falls behind the continuous backdrop as it moves above the slot.
    for header in headers {
      header.layer.zPosition = pinsLabels && header.frame.minY < top - 1 ? 0 : 2
    }
    // A second system edge would introduce a seam in the middle of the gradient.
    collection.topEdgeEffect.isHidden = active != nil
    isHidden = active == nil
    if let header = active {
      frame = CGRect(x: collection.bounds.minX, y: collection.bounds.minY,
                     width: collection.bounds.width,
                     height: collection.adjustedContentInset.top + header.frame.height + LodySpacing.xxl)
    }
  }

  private func updateTone() {
    let dark = traitCollection.userInterfaceStyle == .dark
    // Dark mode keeps its page tint; light mode tints only the archived page's grey.
    let page = archived ? LodyUIColor.bgArchived : LodyUIColor.bgBase
    let (baseAlpha, upperAlpha): (CGFloat, CGFloat) = if dark {
      (0.1, 0.3)
    } else if archived {
      (0.3, 0.6)
    } else {
      (0, 0)
    }
    base.contentView.backgroundColor = baseAlpha > 0 ? page.withAlphaComponent(baseAlpha) : .clear
    upper.contentView.backgroundColor = upperAlpha > 0 ? page.withAlphaComponent(upperAlpha) : .clear
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    base.frame = bounds
    upper.frame = bounds
    let labelEnd = max(0, min(1, (bounds.height - LodySpacing.xxl) / max(1, bounds.height)))
    base.setFade(colors: [1, 0.85, 0], locations: [0, labelEnd, 1])
    upper.setFade(colors: [1, 0, 0], locations: [0, labelEnd, 1])
  }
}

private final class LodyPinnedLabelBlur: UIVisualEffectView {
  private let fadeView = LodyPinnedLabelBlurMask()
  private var animator: UIViewPropertyAnimator?
  private var lastSize = CGSize.zero
  private var lastLocations: [CGFloat] = []

  init(intensity: CGFloat) {
    super.init(effect: nil)
    let animator = UIViewPropertyAnimator(duration: 1, curve: .linear) { [weak self] in
      self?.effect = UIBlurEffect(style: .regular)
    }
    animator.pausesOnCompletion = true
    animator.fractionComplete = intensity
    self.animator = animator
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit { animator?.stopAnimation(true) }

  func setFade(colors: [CGFloat], locations: [CGFloat]) {
    guard lastSize != bounds.size || lastLocations != locations else { return }
    lastSize = bounds.size
    lastLocations = locations
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    fadeView.frame = bounds
    let gradient = fadeView.layer as! CAGradientLayer
    gradient.colors = colors.map { UIColor.black.withAlphaComponent($0).cgColor }
    gradient.locations = locations.map { NSNumber(value: Double($0)) }
    mask = nil
    mask = fadeView
    CATransaction.commit()
  }
}

private final class LodyPinnedLabelBlurMask: UIView {
  override class var layerClass: AnyClass { CAGradientLayer.self }
}
