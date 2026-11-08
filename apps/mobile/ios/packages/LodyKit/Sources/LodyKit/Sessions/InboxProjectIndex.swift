import UIKit

/// Project rail inspired by innei-dev/lody-ios's InboxProjectIndex. The same surface
/// owns the visible scrollbar and its hit geometry; no private UIKit indicator lookup.
@MainActor
final class InboxProjectIndex: UIView, UIGestureRecognizerDelegate {
  struct Item: Equatable {
    let id: String
    let title: String
    let symbol: String
    let tint: String
    var image = ""
  }

  var jump: ((String) -> Void)?
  private(set) var items: [Item] = []
  private(set) var expanded = false
  private(set) var thumb = CGRect.zero
  private var rail = CGRect.zero
  private var current: String?
  private var scrubbed: Int?
  private var scrubOffset: CGFloat = 0
  private let surface = UIVisualEffectView(effect: nil)
  private var labels: [UILabel] = []
  private let selection = UIView()
  private let feedback = UISelectionFeedbackGenerator()
  private weak var scroll: UIScrollView?
  private lazy var hold = UILongPressGestureRecognizer(target: self, action: #selector(held))
  private var backgroundObserver: NSObjectProtocol?

  init(scroll: UIScrollView) {
    self.scroll = scroll
    super.init(frame: .zero)
    isUserInteractionEnabled = false // The recognizer observes the list; normal pans remain native.
    isAccessibilityElement = true
    accessibilityIdentifier = "project-index"
    accessibilityTraits = .adjustable
    surface.clipsToBounds = true
    addSubview(surface)
    selection.backgroundColor = .tertiarySystemFill
    surface.contentView.addSubview(selection)
    hold.minimumPressDuration = 0.35
    hold.delegate = self
    scroll.addGestureRecognizer(hold)
    backgroundObserver = NotificationCenter.default.addObserver(
      forName: UIApplication.willResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in MainActor.assumeIsolated { self?.cancel() } }
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  isolated deinit {
    if let backgroundObserver { NotificationCenter.default.removeObserver(backgroundObserver) }
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { cancel() }
  }

  func update(_ next: [Item]) {
    // A projection replacement ends the gesture before section identities can move.
    cancel()
    items = next
    labels.forEach { $0.removeFromSuperview() }
    labels = next.map { item in
      let label = UILabel()
      label.textAlignment = .center
      label.font = .preferredFont(forTextStyle: .caption1)
      label.textColor = .secondaryLabel
      if let image = UIImage(systemName: item.symbol) {
        let attachment = NSTextAttachment()
        attachment.image = image.withTintColor(.secondaryLabel, renderingMode: .alwaysOriginal)
        attachment.bounds = CGRect(x: 0, y: -2, width: 16, height: 16)
        label.attributedText = NSAttributedString(attachment: attachment)
      } else {
        label.text = String(item.title.prefix(1)).uppercased()
      }
      if let url = LodyListPhoto.url(item.image), !item.image.isEmpty {
        let photo = UIImageView()
        photo.tag = 2
        photo.contentMode = .scaleAspectFill
        photo.clipsToBounds = true
        photo.layer.cornerRadius = 4
        label.addSubview(photo)
        if let image = RepositoryImages.image(for: url, ready: { [weak label, weak photo] image in
          photo?.image = image
          label?.text = nil
        }) {
          photo.image = image
          label.text = nil
        }
      }
      let dot = UIView()
      dot.tag = 1
      dot.layer.cornerRadius = 3
      dot.backgroundColor = ["danger": UIColor.systemRed, "warning": .systemOrange, "blue": .systemBlue][item.tint]
      dot.isHidden = item.tint.isEmpty
      label.addSubview(dot)
      surface.contentView.addSubview(label)
      return label
    }
    refresh(current: current)
  }

  func refresh(current: String?) {
    if !expanded { self.current = current }
    guard let scroll else { return }
    let inset = scroll.adjustedContentInset
    let viewport = scroll.bounds.height - inset.top - inset.bottom
    let travel = scroll.contentSize.height - viewport
    let available = bounds.height - inset.top - inset.bottom - 8
    let usable = items.count > 1 && travel > 1 && available >= 44
    isHidden = !usable
    accessibilityElementsHidden = !usable
    if !usable { cancel(); return }
    let height = min(available, max(28, available * viewport / max(1, scroll.contentSize.height)))
    let fraction = min(1, max(0, (scroll.contentOffset.y + inset.top) / travel))
    thumb = CGRect(x: bounds.width - 6, y: inset.top + 4 + fraction * (available - height), width: 3, height: height)
    if !expanded {
      surface.frame = thumb
      surface.layer.cornerRadius = 1.5
    }
    let index = items.firstIndex { $0.id == self.current } ?? 0
    accessibilityValue = items[index].title
    accessibilityFrame = UIAccessibility.convertToScreenCoordinates(thumbTarget, in: self)
    if expanded { layoutRail() }
    else { surface.backgroundColor = .tertiaryLabel }
  }

  private var thumbTarget: CGRect {
    CGRect(x: bounds.width - 44, y: thumb.midY - max(44, thumb.height) / 2,
           width: 44, height: max(44, thumb.height))
  }

  func accepts(_ point: CGPoint) -> Bool {
    !isHidden && !expanded && thumbTarget.contains(point)
  }

  func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
    accepts(touch.location(in: self))
  }

  @objc private func held(_ gesture: UILongPressGestureRecognizer) {
    switch gesture.state {
    case .began: begin(at: gesture.location(in: self).y)
    case .changed: scrub(at: gesture.location(in: self).y)
    case .ended, .cancelled, .failed: retract()
    default: break
    }
  }

  func begin(at y: CGFloat? = nil) {
    guard !isHidden, !expanded, let scroll else { return }
    scroll.setContentOffset(scroll.contentOffset, animated: false)
    expanded = true
    scrubbed = items.firstIndex { $0.id == current }
    let inset = scroll.adjustedContentInset
    let height = min(CGFloat(items.count) * 32 + 16, bounds.height - inset.top - inset.bottom - 8)
    let pitch = (height - 16) / CGFloat(items.count)
    let finger = y ?? thumb.midY
    let desired = finger - 8 - (CGFloat(scrubbed ?? 0) + 0.5) * pitch
    rail = CGRect(x: bounds.width - 48, y: min(bounds.height - inset.bottom - height - 4, max(inset.top + 4, desired)), width: 44, height: height)
    // Preserve the initial selection even when the safe-area clamp moves the rail.
    scrubOffset = rail.minY - desired
    surface.backgroundColor = .clear
    surface.effect = UIGlassEffect()
    layoutRail()
    animate { self.surface.frame = self.rail; self.surface.layer.cornerRadius = 22 }
    feedback.prepare()
  }

  func scrub(at y: CGFloat) {
    guard expanded, !items.isEmpty else { return }
    let pitch = (rail.height - 16) / CGFloat(items.count)
    let index = min(items.count - 1, max(0, Int((y + scrubOffset - rail.minY - 8) / pitch)))
    guard index != scrubbed else { return }
    scrubbed = index
    current = items[index].id
    feedback.selectionChanged()
    layoutRail()
    jump?(items[index].id)
  }

  func cancel() {
    hold.isEnabled = false
    hold.isEnabled = true
    retract()
  }

  func retract() {
    guard expanded else { return }
    expanded = false
    scrubbed = nil
    labels.forEach { $0.isHidden = true }
    selection.isHidden = true
    surface.effect = nil
    surface.backgroundColor = .tertiaryLabel
    animate { self.surface.frame = self.thumb; self.surface.layer.cornerRadius = 1.5 }
  }

  private func animate(_ changes: @escaping () -> Void) {
    if UIAccessibility.isReduceMotionEnabled { changes() }
    else { UIView.animate(withDuration: 0.2, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction], animations: changes) }
  }

  private func layoutRail() {
    let pitch = (rail.height - 16) / CGFloat(max(1, items.count))
    for (index, label) in labels.enumerated() {
      label.isHidden = false
      label.frame = CGRect(x: 4, y: 8 + CGFloat(index) * pitch, width: 36, height: pitch)
      label.clipsToBounds = true
      label.viewWithTag(2)?.frame = CGRect(x: 8, y: (pitch - 20) / 2, width: 20, height: 20)
      label.viewWithTag(1)?.frame = CGRect(x: 28, y: max(0, pitch / 2 - 10), width: 6, height: 6)
      if items[index].id == current {
        selection.frame = label.frame.insetBy(dx: 2, dy: 1)
        selection.layer.cornerRadius = min(16, pitch / 2)
      }
    }
    selection.isHidden = current == nil
  }

  override func accessibilityIncrement() { adjust(1) }
  override func accessibilityDecrement() { adjust(-1) }
  private func adjust(_ delta: Int) {
    guard !isHidden, !items.isEmpty else { return }
    let index = min(items.count - 1, max(0, (items.firstIndex { $0.id == current } ?? 0) + delta))
    current = items[index].id
    accessibilityValue = items[index].title
    jump?(items[index].id)
  }
}
