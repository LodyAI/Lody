import UIKit

/// Several images from one turn, fanned like a hand of cards instead of a long column.
/// Swiping the top card left sends it to the back (the next image comes up); swiping right
/// brings the previous image back on top. A tap (the collection's selection) opens the preview
/// at the top image, which pages through the whole conversation's images as before.
final class ChatImageStackCell: UICollectionViewCell, UIGestureRecognizerDelegate {
  private var items: [ChatImagePreviewItem] = []
  private var cards: [String: ChatImageCell] = [:]
  private var top = 0
  private var rowID = ""
  private var entryID = ""
  private var workspace = ""
  private var session = ""
  private let counter = UILabel()
  private var dragging: ChatImageCell?
  /// Reports the top image's id so the conversation can restore it after cell reuse.
  var onTopChange: ((String) -> Void)?

  /// Cards beyond this depth stay hidden; they still keep their loaded image.
  private static let visibleDepth = 3
  private static let fanInset: CGFloat = 18
  private static let counterHeight: CGFloat = 26

  override init(frame: CGRect) {
    super.init(frame: frame)
    counter.font = UIFont.preferredFont(forTextStyle: .caption1).withTabularNumbers()
    counter.adjustsFontForContentSizeCategory = true
    counter.textColor = .secondaryLabel
    counter.isAccessibilityElement = false
    contentView.addSubview(counter)
    let pan = UIPanGestureRecognizer(target: self, action: #selector(pan(_:)))
    pan.delegate = self
    pan.maximumNumberOfTouches = 1
    contentView.addGestureRecognizer(pan)
    isAccessibilityElement = true
    accessibilityHint = String(localized: "native.chat.image.stackHint", bundle: .lody)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  static func cardSize(_ items: [ChatImagePreviewItem], width: CGFloat) -> CGSize {
    let cardWidth = min(220, max(1, width * 0.7))
    let portrait = items.filter { ($0.image.height ?? 3) > ($0.image.width ?? 4) }.count
    // Uniform cards keep the fan tidy; most images decide the orientation.
    return portrait * 2 > items.count
      ? CGSize(width: cardWidth, height: cardWidth * 4 / 3)
      : CGSize(width: cardWidth, height: cardWidth * 3 / 4)
  }

  static func height(_ row: ChatRow, width: CGFloat) -> CGFloat {
    cardSize(row.stack, width: width).height + fanInset * 2 + counterHeight
  }

  var topID: String? { items.indices.contains(top) ? items[top].id : nil }
  var topCard: ChatImageCell? { topID.flatMap { cards[$0] } }

  /// The loaded card for an image, whatever its depth (preview placeholders).
  func card(id: String) -> ChatImageCell? { cards[id] }

  /// Brings an image to the top without animation, so the preview zooms back into it.
  func reveal(id: String) -> ChatImageCell? {
    guard let index = items.firstIndex(where: { $0.id == id }) else { return nil }
    if index != top {
      top = index
      loadNearTop()
      layoutCards(animated: false)
      onTopChange?(id)
    }
    return cards[id]
  }

  func configure(_ row: ChatRow, topID: String?, workspace: String, session: String) {
    let changedRow = row.id != rowID
    rowID = row.id
    entryID = row.entryID
    self.workspace = workspace
    self.session = session
    items = row.stack
    let ids = Set(items.map(\.id))
    for (id, card) in cards where !ids.contains(id) {
      card.removeFromSuperview()
      cards[id] = nil
    }
    if let topID, let index = items.firstIndex(where: { $0.id == topID }) {
      top = index
    } else if changedRow || !items.indices.contains(top) {
      top = 0
    }
    for item in items where cards[item.id] == nil {
      let card = ChatImageCell()
      card.compact = true
      card.fills = true
      card.isUserInteractionEnabled = false
      card.isAccessibilityElement = false
      card.layer.shadowColor = UIColor.black.cgColor
      card.layer.shadowOpacity = 0.12
      card.layer.shadowRadius = 6
      card.layer.shadowOffset = CGSize(width: 0, height: 2)
      cards[item.id] = card
      contentView.insertSubview(card, belowSubview: counter)
    }
    loadNearTop()
    setNeedsLayout()
  }

  /// Load the visible cards plus the previous one; the rest load as they come up.
  private func loadNearTop() {
    guard !items.isEmpty else { return }
    let wanted = [-1] + Array(0..<Self.visibleDepth)
    for offset in wanted {
      let item = items[(top + offset + items.count) % items.count]
      guard let card = cards[item.id], card.displayedImage == nil else { continue }
      var row = ChatRow(id: item.id, entryID: entryID, kind: "image", text: "")
      row.image = item.image
      row.localImageURI = item.localURI
      card.configure(row, workspace: workspace, session: session)
    }
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    dragging = nil
    onTopChange = nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard dragging == nil else { return }
    layoutCards(animated: false)
  }

  private var cardSize: CGSize { Self.cardSize(items, width: contentView.bounds.width) }
  private var stackCenter: CGPoint {
    CGPoint(x: Self.fanInset + cardSize.width / 2, y: Self.fanInset + cardSize.height / 2)
  }

  private func depth(of index: Int) -> Int { (index - top + items.count) % max(items.count, 1) }

  /// A fan: the top card upright, the next ones tilted alternately and nudged aside.
  private func transform(depth: Int) -> CGAffineTransform {
    guard depth > 0 else { return .identity }
    let side: CGFloat = depth % 2 == 1 ? 1 : -1
    let angle = side * CGFloat(depth) * 4.5 * .pi / 180
    let scale = 1 - CGFloat(depth) * 0.04
    return CGAffineTransform(translationX: side * CGFloat(depth) * 9, y: CGFloat(depth) * 2)
      .rotated(by: angle).scaledBy(x: scale, y: scale)
  }

  private func layoutCards(animated: Bool) {
    guard !items.isEmpty else { return }
    let size = cardSize
    let center = stackCenter
    // Deepest first so the top card ends up front-most.
    let order = items.indices.sorted { depth(of: $0) > depth(of: $1) }
    for index in order {
      guard let card = cards[items[index].id] else { continue }
      contentView.insertSubview(card, belowSubview: counter)
      let depth = depth(of: index)
      let apply = {
        card.transform = .identity
        card.bounds = CGRect(origin: .zero, size: size)
        card.center = center
        card.transform = self.transform(depth: depth)
        card.alpha = depth < Self.visibleDepth ? 1 : 0
      }
      card.layer.shadowPath = UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: 16).cgPath
      if animated {
        UIView.animate(withDuration: 0.42, delay: 0, usingSpringWithDamping: 0.82, initialSpringVelocity: 0,
                       options: [.beginFromCurrentState, .allowUserInteraction], animations: apply)
      } else {
        apply()
      }
      card.setNeedsLayout()
    }
    counter.text = String.localizedStringWithFormat(
      String(localized: "native.chat.image.page", bundle: .lody),
      String(describing: top + 1), String(describing: items.count)
    )
    counter.frame = CGRect(x: Self.fanInset, y: Self.fanInset * 2 + size.height - 4,
                           width: size.width, height: Self.counterHeight)
    counter.textAlignment = .center
    if let item = items[safe: top] {
      accessibilityLabel = String.localizedStringWithFormat(
        String(localized: "native.chat.image.label", bundle: .lody), String(describing: item.image.fileName)
      )
    }
    accessibilityValue = counter.text
  }

  override var accessibilityTraits: UIAccessibilityTraits {
    get { [.image, .button, .adjustable] }
    set {}
  }
  override func accessibilityIncrement() { move(1, animated: false) }
  override func accessibilityDecrement() { move(-1, animated: false) }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard let pan = gestureRecognizer as? UIPanGestureRecognizer, items.count > 1 else { return false }
    let velocity = pan.velocity(in: contentView)
    // Vertical drags keep scrolling the conversation.
    return abs(velocity.x) > abs(velocity.y) * 1.2
  }

  @objc private func pan(_ pan: UIPanGestureRecognizer) {
    let width = max(cardSize.width, 1)
    switch pan.state {
    case .began:
      dragging = topCard
    case .changed:
      guard let card = dragging else { return }
      let x = pan.translation(in: contentView).x
      card.transform = CGAffineTransform(translationX: x, y: abs(x) * 0.06).rotated(by: x / width * 0.2)
    case .ended, .cancelled, .failed:
      guard let card = dragging else { return }
      dragging = nil
      let x = pan.translation(in: contentView).x
      let velocity = pan.velocity(in: contentView).x
      let commits = pan.state == .ended && (abs(x) > width * 0.28 || abs(velocity) > 600)
      guard commits else { layoutCards(animated: !UIAccessibility.isReduceMotionEnabled); return }
      let direction: Int = (abs(velocity) > 600 ? velocity : x) < 0 ? 1 : -1
      UISelectionFeedbackGenerator().selectionChanged()
      if direction == 1, !UIAccessibility.isReduceMotionEnabled {
        // The top card leaves the way it was thrown, then tucks in behind the rest.
        UIView.animate(withDuration: 0.16, delay: 0, options: [.curveEaseIn, .beginFromCurrentState]) {
          card.transform = CGAffineTransform(translationX: -width * 0.9, y: 8).rotated(by: -0.22)
        } completion: { _ in
          self.move(1, animated: true)
        }
      } else {
        move(direction, animated: !UIAccessibility.isReduceMotionEnabled)
      }
    default:
      break
    }
  }

  private func move(_ delta: Int, animated: Bool) {
    guard items.count > 1 else { return }
    top = (top + delta + items.count) % items.count
    loadNearTop()
    if delta < 0, animated, let card = topCard {
      // The previous image slides back in from the right, over the stack.
      contentView.insertSubview(card, belowSubview: counter)
      card.alpha = 1
      card.transform = CGAffineTransform(translationX: cardSize.width * 0.9, y: 8).rotated(by: 0.22)
    }
    layoutCards(animated: animated)
    if let id = topID { onTopChange?(id) }
    UIAccessibility.post(notification: .announcement, argument: counter.text)
  }
}

private extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
