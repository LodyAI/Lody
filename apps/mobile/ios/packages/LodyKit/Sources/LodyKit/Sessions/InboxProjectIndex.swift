import UIKit

/// Scroll-revealed project index, following innei-dev/lody-ios. The list keeps its full width.
@MainActor
final class InboxProjectIndex: UIView {
  struct Item: Equatable {
    let id: String
    let title: String
    let symbol: String
    let tint: String
    var image = ""
  }

  var jump: ((String) -> Void)?
  var reduceMotion: () -> Bool = { UIAccessibility.isReduceMotionEnabled }
  private(set) var visibilityAnimator: UIViewPropertyAnimator?
  private var presented = false
  private var animationGeneration = 0
  // Inject scheduling so expiry and stale callbacks can be verified without wall-clock sleeps.
  var scheduleDismiss: (TimeInterval, @escaping () -> Void) -> () -> Void = { delay, action in
    let work = DispatchWorkItem(block: action)
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    return { work.cancel() }
  }
  private(set) var items: [Item] = []
  private(set) var rail = CGRect.zero
  private(set) var touching = false
  private var scrolling = false
  private var usable = false
  private var current: String?
  private var scrubbed: Int?
  private var scrubOrigin: (y: CGFloat, index: Int)?
  private var generation = 0
  private var cancelDismiss: (() -> Void)?
  private let surface = UIView()
  private var cells: [UIView] = []
  private let selection = UIView()
  private let feedback = UISelectionFeedbackGenerator()
  private weak var scroll: UIScrollView?
  private var backgroundObserver: NSObjectProtocol?

  init(scroll: UIScrollView) {
    self.scroll = scroll
    super.init(frame: .zero)
    isAccessibilityElement = true
    accessibilityIdentifier = "project-index"
    accessibilityTraits = .adjustable
    surface.backgroundColor = .secondarySystemBackground
    surface.layer.cornerRadius = 28
    surface.clipsToBounds = true
    surface.isUserInteractionEnabled = false
    addSubview(surface)
    selection.backgroundColor = .tertiarySystemFill
    surface.addSubview(selection)
    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.cancel() } }
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    cancelDismiss?()
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { cancel() }
  }

  func update(_ next: [Item]) {
    guard next != items else { return }
    cancel()
    items = next
    cells.forEach { $0.removeFromSuperview() }
    cells = next.map { item in
      let cell = UIView()
      let label = UILabel()
      label.tag = 1
      label.textAlignment = .center
      label.font = .preferredFont(forTextStyle: .caption1)
      label.textColor = .secondaryLabel
      label.text = String(item.title.prefix(1)).uppercased()
      let photo = UIImageView()
      photo.tag = 2
      photo.contentMode = .scaleAspectFit
      photo.tintColor = .secondaryLabel
      photo.clipsToBounds = true
      photo.layer.cornerRadius = 4
      if !item.symbol.isEmpty {
        photo.image = UIImage(systemName: item.symbol)
        label.isHidden = true
      } else if let url = LodyListPhoto.url(item.image) {
        // Keep the image in a real image view, independent of UILabel text drawing.
        if let image = LodyListPhoto.image(for: url, shape: .original, ready: { [weak label, weak photo] image in
          photo?.image = image
          label?.isHidden = true
        }) {
          photo.image = image
          label.isHidden = true
        }
      }
      let dot = UIView()
      dot.tag = 3
      dot.layer.cornerRadius = 3
      dot.backgroundColor = ["danger": UIColor.systemRed, "warning": .systemOrange, "blue": .systemBlue][item.tint]
      dot.isHidden = item.tint.isEmpty
      for view in [label, photo, dot] { cell.addSubview(view) }
      surface.addSubview(cell)
      return cell
    }
    refresh(current: current)
  }

  func refresh(current: String?) {
    if !touching { self.current = current }
    guard let scroll else { return }
    let inset = scroll.adjustedContentInset
    let available = bounds.height - inset.top - inset.bottom - 24
    let pitch: CGFloat = 48
    let padding: CGFloat = 12
    let capacity = max(0, Int((available - 2 * padding) / pitch))
    usable = items.count > 1 && scroll.contentSize.height > scroll.bounds.height - inset.top - inset.bottom + 1 && capacity >= 2
    guard usable else { cancel(); return }
    let count = min(items.count, capacity)
    let height = CGFloat(count) * pitch + 2 * padding
    rail = CGRect(x: bounds.width - 64, y: inset.top + 12 + (available - height) / 2, width: 56, height: height)
    surface.bounds = CGRect(origin: .zero, size: rail.size)
    surface.center = CGPoint(x: rail.midX, y: rail.midY)
    // Landmarks stay fixed as selection changes, including throughout a scrub.
    // Omitted destinations remain reachable through anchored scrubbing and VoiceOver.
    let landmarks = (0..<count).map { Int((Double($0) * Double(items.count - 1) / Double(count - 1)).rounded()) }
    let selected = items.firstIndex { $0.id == self.current }
    for (index, cell) in cells.enumerated() {
      guard let slot = landmarks.firstIndex(of: index) else { cell.isHidden = true; continue }
      cell.isHidden = false
      cell.frame = CGRect(x: 4, y: padding + CGFloat(slot) * pitch, width: 48, height: pitch)
      let glyph = CGRect(x: 12, y: 12, width: 24, height: 24)
      cell.viewWithTag(1)?.frame = glyph
      cell.viewWithTag(2)?.frame = glyph
      cell.viewWithTag(3)?.frame = CGRect(x: glyph.maxX - 3, y: glyph.minY, width: 6, height: 6)
      if index == selected {
        selection.frame = cell.frame.insetBy(dx: 4, dy: 4)
        selection.layer.cornerRadius = 20
      }
    }
    selection.isHidden = !landmarks.contains { $0 == selected }
    accessibilityValue = items.first { $0.id == self.current }?.title
    accessibilityFrame = UIAccessibility.convertToScreenCoordinates(rail, in: self)
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    presented && !isHidden && rail.contains(point)
      && (surface.layer.presentation()?.frame ?? surface.frame).contains(point)
  }

  func setScrolling(_ value: Bool) {
    scrolling = value
    if value {
      invalidateDismiss()
      if usable { present(true) }
    } else if !touching && !isHidden { linger() }
  }

  func begin(at y: CGFloat) {
    guard presented, !isHidden, usable else { return }
    invalidateDismiss()
    touching = true
    scroll?.setContentOffset(scroll?.contentOffset ?? .zero, animated: false)
    scrolling = false
    feedback.prepare()
    let localY = y - rail.minY
    let visible = cells.indices.filter { !cells[$0].isHidden }
    guard let index = visible.min(by: { abs(cells[$0].frame.midY - localY) < abs(cells[$1].frame.midY - localY) }) else { return }
    scrubOrigin = (y, index)
    select(index)
  }

  func scrub(at y: CGFloat) {
    guard touching, let origin = scrubOrigin, !items.isEmpty else { return }
    // Keep the tapped landmark anchored. Crossing into scrub mode must not switch
    // to an unrelated absolute proportional index after a one-point finger drift.
    let delta = y - origin.y
    let allowance: CGFloat = 8
    guard abs(delta) > allowance else { select(origin.index); return }
    let distance: CGFloat
    let destinations: Int
    if delta < 0 {
      distance = max(1, origin.y - allowance - rail.minY)
      destinations = -origin.index
    } else {
      distance = max(1, rail.maxY - origin.y - allowance)
      destinations = items.count - 1 - origin.index
    }
    let progress = min(1, (abs(delta) - allowance) / distance)
    select(origin.index + Int((CGFloat(destinations) * progress).rounded()))
  }

  private func select(_ index: Int) {
    guard index != scrubbed else { return }
    if scrubbed != nil { feedback.selectionChanged() }
    scrubbed = index
    current = items[index].id
    refresh(current: current)
    jump?(items[index].id)
  }

  func endTouch() {
    touching = false
    scrubbed = nil
    scrubOrigin = nil
    if !scrolling && !isHidden { linger() }
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    if let touch = touches.first { begin(at: touch.location(in: self).y) }
  }
  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    if let touch = touches.first { scrub(at: touch.location(in: self).y) }
  }
  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { endTouch() }
  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { endTouch() }

  private func invalidateDismiss() {
    generation += 1
    cancelDismiss?()
    cancelDismiss = nil
  }
  private func linger() {
    invalidateDismiss()
    let expected = generation
    cancelDismiss = scheduleDismiss(0.8) { [weak self] in
      guard let self, self.generation == expected, !self.touching, !self.scrolling else { return }
      self.cancelDismiss = nil
      self.present(false)
    }
  }
  func cancel() {
    invalidateDismiss()
    touching = false
    scrolling = false
    scrubbed = nil
    scrubOrigin = nil
    present(false, animated: false)
  }

  private func present(_ shown: Bool, animated: Bool = true) {
    guard shown != presented || !animated else { return }
    presented = shown
    isAccessibilityElement = shown
    accessibilityElementsHidden = !shown
    // Disable interaction at the start of exit, while the capsule is still painted.
    isUserInteractionEnabled = shown
    animationGeneration += 1
    let expected = animationGeneration
    let visibleTransform = surface.layer.presentation()?.affineTransform() ?? surface.transform
    let visibleAlpha = surface.layer.presentation().map { CGFloat($0.opacity) } ?? surface.alpha
    visibilityAnimator?.stopAnimation(true)
    visibilityAnimator = nil
    let away = CGAffineTransform(translationX: 12, y: 0)
    guard animated, !reduceMotion(), window != nil else {
      surface.transform = .identity
      surface.alpha = 1
      isHidden = !shown
      return
    }
    surface.transform = isHidden ? away : visibleTransform
    surface.alpha = isHidden ? 0 : visibleAlpha
    isHidden = false
    let animator = UIViewPropertyAnimator(duration: shown ? 0.2 : 0.16, curve: .easeOut) { [weak self] in
      self?.surface.transform = shown ? .identity : away
      self?.surface.alpha = shown ? 1 : 0
    }
    animator.addCompletion { [weak self] _ in
      guard let self, self.animationGeneration == expected else { return }
      self.visibilityAnimator = nil
      self.isHidden = !shown
      self.surface.transform = .identity
      self.surface.alpha = 1
    }
    visibilityAnimator = animator
    animator.startAnimation()
  }

  override func accessibilityIncrement() { adjust(1) }
  override func accessibilityDecrement() { adjust(-1) }
  private func adjust(_ delta: Int) {
    guard presented, !isHidden, !items.isEmpty else { return }
    let index = min(items.count - 1, max(0, (items.firstIndex { $0.id == current } ?? 0) + delta))
    current = items[index].id
    refresh(current: current)
    jump?(items[index].id)
    if !scrolling && !touching { linger() }
  }
}
