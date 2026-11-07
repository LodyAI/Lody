import ObjectiveC.runtime
import UIKit

// Adapter around the private iOS 26 segmented-control glass state machine:
// _setUseGlass: makes UISegmentedControl host a _UILiquidLensView,
// _highlightSegment: drives the system lift, and the lens frame is
// interpolated manually for continuous pager-progress tracking (re-applied
// after every layout pass via the subclass hook, because UIKit resets it).
// Selectors resolve at runtime; unsupported builds no-op and keep the stock control.
final class LiquidGlassSegmentedControl: UISegmentedControl {
  var applyIndicatorProgressAfterLayout: (() -> Void)?

  private var isApplyingIndicatorProgress = false

  override func layoutSubviews() {
    super.layoutSubviews()
    guard !isApplyingIndicatorProgress else { return }
    isApplyingIndicatorProgress = true
    applyIndicatorProgressAfterLayout?()
    isApplyingIndicatorProgress = false
  }
}

final class LiquidGlassSegmentLiftDriver {
  private struct IndicatorGeometry {
    let leading: CGFloat
    let trailing: CGFloat
    let top: CGFloat
    let bottom: CGFloat
    let segmentCount: Int
  }

  private enum PrivateUIKit {
    static let liquidLens = "_UILiquidLensView"
    static let segment = "UISegment"
    static let setUseGlass = NSSelectorFromString("_setUseGlass:")
    static let highlightSegment = NSSelectorFromString("_highlightSegment:")
    static let setLifted = NSSelectorFromString(
      "setLifted:animated:alongsideAnimations:completion:"
    )
  }

  private typealias SetBoolFunction =
    @convention(c) (AnyObject, Selector, Bool) -> Void
  private typealias SetIntegerFunction =
    @convention(c) (AnyObject, Selector, Int) -> Void
  private typealias SetLiftedFunction =
    @convention(c) (AnyObject, Selector, Bool, Bool, AnyObject?, AnyObject?) -> Void

  private weak var control: UISegmentedControl?
  private var indicatorGeometry: IndicatorGeometry?

  init(control: UISegmentedControl) {
    self.control = control
  }

  @discardableResult
  func prepareGlass() -> Bool {
    guard let control else { return false }
    let forcedGlass = invokeBool(PrivateUIKit.setUseGlass, value: true, on: control)
    invokeInteger(PrivateUIKit.highlightSegment, value: UISegmentedControl.noSegment, on: control)
    control.setNeedsLayout()
    control.layoutIfNeeded()
    return forcedGlass
  }

  @discardableResult
  func setLifted(_ lifted: Bool) -> Bool {
    guard let control else { return false }
    invokeBool(PrivateUIKit.setUseGlass, value: true, on: control)
    control.layoutIfNeeded()

    let highlightedIndex =
      lifted
      ? max(control.selectedSegmentIndex, 0)
      : UISegmentedControl.noSegment
    if invokeInteger(PrivateUIKit.highlightSegment, value: highlightedIndex, on: control) {
      control.layoutIfNeeded()
      return true
    }

    guard
      let lens = firstView(named: PrivateUIKit.liquidLens, below: control),
      lens.responds(to: PrivateUIKit.setLifted)
    else { return false }
    let invoke = unsafeBitCast(lens.method(for: PrivateUIKit.setLifted), to: SetLiftedFunction.self)
    invoke(lens, PrivateUIKit.setLifted, lifted, true, nil, nil)
    return true
  }

  @discardableResult
  func setIndicatorProgress(_ progress: CGFloat) -> Bool {
    guard let control else { return false }
    control.layoutIfNeeded()
    let segments = orderedSegments(below: control)
    guard
      !segments.isEmpty,
      let lens = firstView(named: PrivateUIKit.liquidLens, below: control),
      let lensSuperview = lens.superview
    else { return false }

    captureIndicatorGeometryIfNeeded(control: control)
    guard
      let geometry = indicatorGeometry,
      geometry.segmentCount == segments.count
    else { return false }

    let upperLimit = CGFloat(segments.count - 1)
    let clampedProgress = min(max(progress, 0), upperLimit)
    let lowerIndex = Int(clampedProgress.rounded(.down))
    let upperIndex = min(lowerIndex + 1, segments.count - 1)
    let fraction = clampedProgress - CGFloat(lowerIndex)

    let lowerFrame = segments[lowerIndex].convert(segments[lowerIndex].bounds, to: control)
    let upperFrame = segments[upperIndex].convert(segments[upperIndex].bounds, to: control)
    let segmentFrame = interpolate(from: lowerFrame, to: upperFrame, fraction: fraction)
    let lensFrame = CGRect(
      x: segmentFrame.minX + geometry.leading,
      y: segmentFrame.minY + geometry.top,
      width: segmentFrame.width - geometry.leading - geometry.trailing,
      height: segmentFrame.height - geometry.top - geometry.bottom
    )
    guard lensFrame.width > 0, lensFrame.height > 0 else { return false }

    let center = control.convert(
      CGPoint(x: lensFrame.midX, y: lensFrame.midY),
      to: lensSuperview
    )
    UIView.performWithoutAnimation {
      lens.center = center
      lens.bounds.size = lensFrame.size
      lens.layoutIfNeeded()
    }
    return true
  }

  @discardableResult
  private func invokeBool(_ selector: Selector, value: Bool, on object: NSObject) -> Bool {
    guard object.responds(to: selector) else { return false }
    let invoke = unsafeBitCast(object.method(for: selector), to: SetBoolFunction.self)
    invoke(object, selector, value)
    return true
  }

  private func invokeInteger(_ selector: Selector, value: Int, on object: NSObject) -> Bool {
    guard object.responds(to: selector) else { return false }
    let invoke = unsafeBitCast(object.method(for: selector), to: SetIntegerFunction.self)
    invoke(object, selector, value)
    return true
  }

  private func firstView(named className: String, below view: UIView) -> UIView? {
    let targetClass: AnyClass? = NSClassFromString(className)
    let runtimeName = NSStringFromClass(type(of: view))
    if (targetClass.map { view.isKind(of: $0) } ?? false)
      || runtimeName == className
      || runtimeName.hasSuffix(".\(className)")
    {
      return view
    }
    for subview in view.subviews {
      if let match = firstView(named: className, below: subview) {
        return match
      }
    }
    return nil
  }

  // Geometry must be sampled from a settled, un-lifted lens: capturing while
  // the bar item is still zero-sized or the lens is highlighted bakes the
  // expanded lift insets into every later interpolation.
  private func captureIndicatorGeometryIfNeeded(control: UISegmentedControl) {
    guard control.bounds.width > 0, control.bounds.height > 0 else { return }
    let segments = orderedSegments(below: control)
    guard
      let lens = firstView(named: PrivateUIKit.liquidLens, below: control),
      lens.bounds.width > 0,
      lens.bounds.height > 0,
      !isLensLifted(lens),
      !segments.isEmpty,
      indicatorGeometry?.segmentCount != segments.count
    else { return }

    let selectedIndex = min(max(control.selectedSegmentIndex, 0), segments.count - 1)
    let segment = segments[selectedIndex]
    let segmentFrame = segment.convert(segment.bounds, to: control)
    let lensFrame = lens.convert(lens.bounds, to: control)
    indicatorGeometry = IndicatorGeometry(
      leading: lensFrame.minX - segmentFrame.minX,
      trailing: segmentFrame.maxX - lensFrame.maxX,
      top: lensFrame.minY - segmentFrame.minY,
      bottom: segmentFrame.maxY - lensFrame.maxY,
      segmentCount: segments.count
    )
  }

  private func isLensLifted(_ lens: UIView) -> Bool {
    let selector = NSSelectorFromString("lifted")
    guard lens.responds(to: selector) else { return false }
    return (lens.value(forKey: "lifted") as? Bool) ?? false
  }

  private func orderedSegments(below control: UISegmentedControl) -> [UIView] {
    var matches: [UIView] = []
    func visit(_ view: UIView) {
      if NSStringFromClass(type(of: view)) == PrivateUIKit.segment {
        matches.append(view)
      }
      view.subviews.forEach(visit)
    }
    visit(control)
    return matches.sorted {
      $0.convert($0.bounds, to: control).minX < $1.convert($1.bounds, to: control).minX
    }
  }

  private func interpolate(from start: CGRect, to end: CGRect, fraction: CGFloat) -> CGRect {
    CGRect(
      x: start.minX + (end.minX - start.minX) * fraction,
      y: start.minY + (end.minY - start.minY) * fraction,
      width: start.width + (end.width - start.width) * fraction,
      height: start.height + (end.height - start.height) * fraction
    )
  }
}
