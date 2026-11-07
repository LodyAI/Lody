import ChatKit
import UIKit

/// The flying copy and collection content keep independent layer lifecycles.
final class ChatMessageContent: UIView {
  let label = CKTextView()
  let numericText = ChatNumericTextHost()
  static let maximumCollapsedHeight: CGFloat = 140
  static let bubbleRadius: CGFloat = 19
  let bubble = UIView()
  let disclosure = UIButton(type: .system)
  private let fade = CAGradientLayer()
  var folded: Bool { expandable && !expanded }
  var expandable = false
  var expanded = false

  static func height(textHeight: CGFloat, limit: CGFloat, expanded: Bool) -> CGFloat {
    let full = textHeight + 20
    guard full > maximumCollapsedHeight else { return full }
    return expanded ? full + 44 : limit
  }

  static func applyBubbleCorners(to layer: CALayer, size: CGSize) {
    layer.cornerCurve = .circular
    let minSide = min(size.width, size.height)
    layer.cornerRadius = minSide > 0 ? min(bubbleRadius, minSide / 2) : bubbleRadius
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    clipsToBounds = true
    bubble.backgroundColor = .lodyUserBubble
    Self.applyBubbleCorners(to: bubble.layer, size: .zero)
    addSubview(bubble)
    addSubview(label)
    numericText.isHidden = true
    addSubview(numericText)
    disclosure.titleLabel?.font = .preferredFont(forTextStyle: .caption1)
    disclosure.setTitleColor(.secondaryLabel, for: .normal)
    disclosure.contentHorizontalAlignment = .right
    addSubview(disclosure)
    fade.colors = [UIColor.black.cgColor, UIColor.black.cgColor, UIColor.clear.cgColor]
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layoutSubviews() {
    super.layoutSubviews()
    bubble.frame = bounds
    bubble.backgroundColor = .lodyUserBubble
    Self.applyBubbleCorners(to: bubble.layer, size: bounds.size)
    // Process rows own the label frame so the chevron keeps its 8pt gap.
    // Bubble insets are only for the user send handoff.
    guard !bubble.isHidden else { return }
    UIView.performWithoutAnimation {
      let title = expanded ? "native.chat.message.collapse" : "native.chat.message.expand"
      disclosure.setTitle(String(localized: String.LocalizationValue(title), bundle: .lody), for: .normal)
      disclosure.isHidden = !expandable
      disclosure.frame = CGRect(x: 13, y: bounds.height - 44, width: bounds.width - 26, height: 44)
      label.frame = bounds.insetBy(dx: 13, dy: 10)
      if expanded && expandable { label.frame.size.height -= 44 }
      numericText.isHidden = true
      label.isHidden = false
      label.layer.mask = folded ? fade : nil
      label.linkHitHeight = folded ? max(0, label.bounds.height - 58) : label.bounds.height
      fade.frame = label.bounds
      let h = max(1, label.bounds.height)
      fade.locations = [0, NSNumber(value: Double(max(0, h - 58) / h)), NSNumber(value: Double(max(0, h - 30) / h))]
      label.layer.displayIfNeeded()
    }
  }
}

@MainActor
protocol ChatSendHandoffSettling: AnyObject {
  func handoffDidSettle(_ id: String)
}

@MainActor
final class ChatSendHandoff {
  private static var active: [String: ChatSendHandoff] = [:]
  let content = ChatMessageContent(frame: .zero)
  private var expiry: DispatchWorkItem?
  private let concealment = CALayer()
  private var sourceSnapshot: UIView?
  private let sourceBackground = UIColor.clear
  private var probe: ChatThrowProbe?
  private var delivering = false
  private var straight = false
  private weak var target: UIView?
  private weak var owner: ChatSendHandoffSettling?

  static func hasWaitingAttachments(id: String) -> Bool {
    active.contains { $0.key.hasPrefix(id + ":attachment:") && !$0.value.delivering }
  }

  static func cancelWaitingAttachments(id: String) {
    for key in active.keys.filter({ $0.hasPrefix(id + ":attachment:") && active[$0]?.delivering == false }) {
      cancel(id: key)
    }
  }

  static func sourceHeight(id: String) -> CGFloat? { active[id]?.content.bounds.height }

  static var onSettled: ((String) -> Void)?

  static func isWaiting(id: String) -> Bool {
    guard let handoff = active[id] else { return false }
    return !handoff.delivering
  }

  static func isInFlight(id: String) -> Bool {
    active.keys.contains { $0 == id || $0.hasPrefix(id + ":attachment:") }
  }

  private static func turnID(from key: String) -> String {
    guard let range = key.range(of: ":attachment:") else { return key }
    return String(key[..<range.lowerBound])
  }

  private static func enclosingChat(_ view: UIView) -> ChatSendHandoffSettling? {
    var current: UIView? = view
    while let view = current {
      if let chat = view as? ChatSendHandoffSettling { return chat }
      current = view.superview
    }
    return nil
  }

  private static func didSettle(_ key: String, owner: ChatSendHandoffSettling?) {
    let turn = turnID(from: key)
    guard !isInFlight(id: turn) else { return }
    owner?.handoffDidSettle(turn)
    onSettled?(turn)
  }

  static func hold(id: String, target: UIView, visualOnly: Bool = false) {
    let waiting = active[id] != nil
    // Attachment buttons retain their accessibility identity while their copy flies.
    if visualOnly { target.layer.mask = active[id]?.concealment }
    else { target.isHidden = waiting }
    active[id]?.target = target
  }

  static func begin(id: String, source: UIView, straight: Bool = false) {
    guard let window = source.window, active[id] == nil else { return }
    let frame = source.convert(source.bounds, to: window)
    // Reuse rendered pixels, including glass, rather than drawing the entire
    // window synchronously just to sample one background pixel.
    let snapshot = window.resizableSnapshotView(from: frame, afterScreenUpdates: false, withCapInsets: .zero)
      ?? source.snapshotView(afterScreenUpdates: false)
    let handoff = ChatSendHandoff()
    handoff.straight = straight
    handoff.content.frame = frame
    handoff.content.isUserInteractionEnabled = false
    handoff.content.accessibilityElementsHidden = true
    if let snapshot { handoff.keep(snapshot, from: source, frame: source.bounds) }
    handoff.owner = enclosingChat(source)
    active[id] = handoff
    let expiry = DispatchWorkItem { cancel(id: id) }
    handoff.expiry = expiry
    DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: expiry)
  }

  private func keep(_ snapshot: UIView, from source: UIView, frame: CGRect) {
    guard let host = source.window else { return }
    snapshot.frame = source.convert(frame, to: host)
    snapshot.isUserInteractionEnabled = false
    snapshot.accessibilityElementsHidden = true
    sourceSnapshot = snapshot
    host.addSubview(snapshot)
  }

  private func takeSource(in window: UIWindow) -> CGRect? {
    guard let snapshot = sourceSnapshot, snapshot.window === window else { return nil }
    var ancestor: UIView? = snapshot
    while let view = ancestor, view !== window {
      guard !view.isHidden, view.alpha > 0.01 else { return nil }
      ancestor = view.superview
    }
    let layer = snapshot.layer.presentation() ?? snapshot.layer
    let frame = layer.convert(layer.bounds, to: window.layer.presentation() ?? window.layer)
    guard frame.intersects(window.bounds) else { return nil }
    snapshot.removeFromSuperview()
    snapshot.frame = frame
    window.addSubview(snapshot)
    return frame
  }

  private static func reveal(id: String, target: UIView, attachment: Bool = false) {
    cancel(id: id, includingAttachments: false)
    target.isHidden = false
    target.layer.mask = nil
  }

  static func beginAttachments(id: String, attachments: [ChatAttachment], source: ChatAttachmentBar) {
    guard source.window != nil else { return }
    for attachment in attachments {
      guard let frame = source.attachmentFrame(id: attachment.id), frame.intersects(source.bounds),
            let snapshot = source.snapshot(id: attachment.id) else { continue }
      let handoff = ChatSendHandoff()
      handoff.keep(snapshot, from: source, frame: frame)
      let key = id + ":attachment:" + attachment.id
      handoff.owner = enclosingChat(source)
      active[key] = handoff
      let expiry = DispatchWorkItem { cancel(id: key) }
      handoff.expiry = expiry
      DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: expiry)
    }
  }

  static func deliverAttachment(id: String, to target: UIView, scrollDistance: CGFloat) {
    guard let window = target.window, let handoff = active[id], !handoff.delivering,
          let source = handoff.sourceSnapshot else { return }
    // A partially clipped cell is not a landing destination. It may still be
    // moving into the viewport as UIKit resolves the list's automatic insets.
    var ancestor = target.superview
    while let view = ancestor {
      if let list = view as? UICollectionView {
        let landing = target.convert(target.bounds, to: list).offsetBy(dx: 0, dy: -scrollDistance)
        guard list.bounds.contains(landing) else { return }
        break
      }
      ancestor = view.superview
    }
    guard let start = handoff.takeSource(in: window) else { reveal(id: id, target: target, attachment: true); return }
    handoff.delivering = true
    handoff.target = target
    handoff.expiry?.cancel()
    guard !UIAccessibility.isReduceMotionEnabled else { cancel(id: id); return }
    // Render synchronously without committing a visible destination frame first.
    let rendered = UIGraphicsImageRenderer(size: target.bounds.size).image { context in
      target.layer.mask = nil
      target.layoutIfNeeded()
      target.layer.render(in: context.cgContext)
      target.layer.mask = handoff.concealment
    }
    let destinationCopy = UIImageView(image: rendered)
    let destination = target.convert(target.bounds, to: window).offsetBy(dx: 0, dy: -scrollDistance)
    let host = UIView(frame: start)
    host.isUserInteractionEnabled = false
    host.accessibilityElementsHidden = true
    host.clipsToBounds = true
    host.layer.cornerRadius = 12
    source.removeFromSuperview()
    source.frame = host.bounds
    source.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    destinationCopy.frame = host.bounds
    destinationCopy.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    destinationCopy.alpha = 0
    host.addSubview(source)
    host.addSubview(destinationCopy)
    window.addSubview(host)
    handoff.sourceSnapshot = host
    target.layer.mask = handoff.concealment
    UIView.animate(withDuration: ChatThrowCurve.duration, delay: 0, options: [.curveEaseInOut]) {
      host.frame = destination
      source.alpha = 0
      destinationCopy.alpha = 1
    } completion: { _ in
      guard active[id] === handoff else { return }
      active.removeValue(forKey: id)
      let landed = handoff.target ?? target
      landed.layer.mask = nil
      host.removeFromSuperview()
      UIAccessibility.post(notification: .layoutChanged, argument: nil)
      handoff.probe?.didLand(on: landed)
      didSettle(id, owner: handoff.owner)
    }
    if LodyUIVerify.throwProbe {
      handoff.probe = ChatThrowProbe(content: host, target: target, source: start, destination: destination,
        track: ChatThrowCurve.straightTrack(from: CGPoint(x: start.midX, y: start.midY), to: CGPoint(x: destination.midX, y: destination.midY)),
        sourceBackground: .clear, destinationBackground: .clear, attachment: true)
    }
  }

  static func cancel(id: String, includingAttachments: Bool = true) {
    if includingAttachments {
      for key in active.keys.filter({ $0.hasPrefix(id + ":attachment:") }) { cancel(id: key) }
    }
    guard let handoff = active.removeValue(forKey: id) else { return }
    handoff.expiry?.cancel()
    handoff.probe?.stop(cancelled: true)
    handoff.target?.isHidden = false
    handoff.target?.layer.mask = nil
    handoff.content.layer.removeAllAnimations()
    handoff.content.removeFromSuperview()
    handoff.sourceSnapshot?.removeFromSuperview()
    didSettle(id, owner: handoff.owner)
  }

  static func deliver(id: String, to target: ChatMessageContent, scrollDistance: CGFloat = 0) {
    guard let window = target.window, let handoff = active[id], !handoff.delivering else { return }
    guard let sourceFrame = handoff.takeSource(in: window) else { reveal(id: id, target: target); return }
    handoff.delivering = true
    handoff.target = target
    handoff.expiry?.cancel()
    let destination = target.convert(target.bounds, to: window).offsetBy(dx: 0, dy: -scrollDistance)
    let destinationBackground = UIColor.lodyUserBubble.resolvedColor(with: target.traitCollection)
    handoff.content.label.setText(target.label.attributedTextValue)
    handoff.content.expandable = target.expandable
    handoff.content.expanded = target.expanded
    target.isHidden = true
    let finish = {
      handoff.sourceSnapshot?.removeFromSuperview()
      guard active[id] === handoff else { handoff.content.removeFromSuperview(); return }
      active.removeValue(forKey: id)
      // Match the demo: reveal the cell's existing content. Reparenting a layer
      // from UIWindow to a cell leaves one presentation frame in window coordinates.
      UIView.performWithoutAnimation {
        handoff.target?.isHidden = false
        handoff.target?.layer.mask = nil
        handoff.content.removeFromSuperview()
      }
      handoff.probe?.didLand(on: handoff.target ?? target)
      didSettle(id, owner: handoff.owner)
    }
    if UIAccessibility.isReduceMotionEnabled { finish(); return }
    // Independent position, compression, bounds and text tracks.
    let duration = ChatThrowCurve.duration
    let start = CGPoint(x: sourceFrame.midX, y: sourceFrame.midY)
    let end = CGPoint(x: destination.midX, y: destination.midY)
    let track = handoff.straight
      ? ChatThrowCurve.straightTrack(from: start, to: end)
      : ChatThrowCurve.positionTrack(from: start, to: end)
    let content = handoff.content
    window.addSubview(content)
    // Sheet dismissal can carry an enclosing UIView animation into this callback.
    // Only the explicit throw tracks may animate the window-space content.
    UIView.performWithoutAnimation {
      content.isHidden = false
      content.frame = destination
      // The flying view hides its bubble layer, but still needs user-text insets.
      content.bubble.isHidden = false
      content.setNeedsLayout()
      content.layoutIfNeeded()
      content.backgroundColor = destinationBackground
      ChatMessageContent.applyBubbleCorners(to: content.layer, size: content.bounds.size)
      content.bubble.isHidden = true
    }
    if let snapshot = handoff.sourceSnapshot { window.bringSubviewToFront(snapshot) }

    CATransaction.begin()
    CATransaction.setDisableActions(true)
    CATransaction.setCompletionBlock(finish)
    let background = CABasicAnimation(keyPath: "backgroundColor")
    background.fromValue = handoff.sourceBackground.cgColor
    background.toValue = destinationBackground.cgColor
    background.duration = duration
    background.timingFunction = ChatThrowCurve.timingFunction
    content.layer.add(background, forKey: "throw.background")
    for view in [content, handoff.sourceSnapshot].compactMap({ $0 }) {
      view.layer.position = CGPoint(x: destination.midX, y: destination.midY)
      view.layer.add(ChatThrowCurve.positionAnimation(track), forKey: "throw.position")
      if !handoff.straight { view.layer.add(ChatThrowCurve.scaleAnimation(), forKey: "throw.scale") }
    }
    let size = CABasicAnimation(keyPath: "bounds.size")
    size.fromValue = NSValue(cgSize: sourceFrame.size)
    size.toValue = NSValue(cgSize: destination.size)
    size.duration = duration
    size.speed = ChatThrowCurve.boundsSpeed
    size.timingFunction = CAMediaTimingFunction(controlPoints: 0.54195118, 0, 0.58, 1)
    content.layer.add(size, forKey: "throw.bounds")
    if let snapshot = handoff.sourceSnapshot {
      for (layer, from, to) in [(snapshot.layer, Float(1), Float(0)), (content.label.layer, Float(0), Float(1)), (content.disclosure.layer, Float(0), Float(1))] {
        layer.opacity = to
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = from
        fade.toValue = to
        fade.duration = duration * 0.3
        fade.timingFunction = CAMediaTimingFunction(controlPoints: 0.5, 0, 0.5, 1)
        layer.add(fade, forKey: "throw.opacity")
      }
    }
    CATransaction.commit()
    if LodyUIVerify.throwProbe {
      handoff.probe = ChatThrowProbe(content: content, target: target, source: sourceFrame, destination: destination, track: track, sourceBackground: handoff.sourceBackground, destinationBackground: destinationBackground)
    }
  }
}

// Offline-only presentation-layer samples. Records geometry, never message text.
@MainActor
private final class ChatThrowProbe: NSObject {
  private weak var content: UIView?
  private weak var target: UIView?
  private weak var window: UIWindow?
  private var link: CADisplayLink?
  private let started = CACurrentMediaTime()
  private let duration: Double
  private let track: ChatThrowCurve.PositionTrack
  private let source: CGRect
  private let destination: CGRect
  private let attachment: Bool
  private let reveal: Bool
  private let sourceBackground: UIColor
  private let destinationBackground: UIColor
  private var adoptedAt: Double?
  private var samples: [[String: Any]] = []

  init(content: UIView, target: UIView, source: CGRect, destination: CGRect, track: ChatThrowCurve.PositionTrack, sourceBackground: UIColor, destinationBackground: UIColor, attachment: Bool = false, reveal: Bool = false) {
    self.content = content; self.target = target; self.window = content.window
    self.source = source; self.destination = destination; self.track = track; self.duration = track.duration
    self.sourceBackground = sourceBackground; self.destinationBackground = destinationBackground
    self.attachment = attachment
    self.reveal = reveal
    super.init()
    let link = CADisplayLink(target: self, selector: #selector(tick(_:)))
    let fps = Float(content.window?.screen.maximumFramesPerSecond ?? 60)
    link.preferredFrameRateRange = CAFrameRateRange(minimum: fps, maximum: fps, preferred: fps)
    self.link = link
    link.add(to: .main, forMode: .common)
  }

  private func rgba(_ color: UIColor) -> [Double] {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    color.getRed(&r, green: &g, blue: &b, alpha: &a)
    return [Double(r), Double(g), Double(b), Double(a)]
  }

  private func rect(_ rect: CGRect) -> [Double] {
    [Double(rect.minX), Double(rect.minY), Double(rect.width), Double(rect.height)]
  }

  private func frame(_ view: UIView, presentation: Bool) -> CGRect {
    let layer = presentation ? (view.layer.presentation() ?? view.layer) : view.layer
    let root = presentation ? (window?.layer.presentation() ?? window?.layer) : window?.layer
    return layer.convert(layer.bounds, to: root)
  }

  func didLand(on target: UIView) {
    self.target = target
    content = target
    adoptedAt = CACurrentMediaTime() - started
    sample(event: "adopt", timestamp: CACurrentMediaTime(), budget: 0)
  }

  @objc private func tick(_ link: CADisplayLink) {
    sample(event: "frame", timestamp: link.timestamp, budget: link.targetTimestamp - link.timestamp)
    let elapsed = CACurrentMediaTime() - started
    if elapsed > duration + 0.35 { stop(cancelled: false) }
  }

  private func sample(event: String, timestamp: Double, budget: Double) {
    guard let content, let window, content.window === window else { return }
    let layer = content.layer.presentation() ?? content.layer
    var sample: [String: Any] = [
      "event": event, "t": timestamp - started, "sampleTime": CACurrentMediaTime() - started,
      "budget": budget, "adopted": adoptedAt != nil,
      "frame": rect(frame(content, presentation: true)),
      "modelFrame": rect(frame(content, presentation: false)),
      "scale": layer.value(forKeyPath: "transform.scale.x") as? Double ?? 1,
      "bounds": [Double(layer.bounds.width), Double(layer.bounds.height)],
      "background": rgba(layer.backgroundColor.map { UIColor(cgColor: $0) } ?? destinationBackground),
      "opacity": Double(layer.opacity),
    ]
    if let label = (content as? ChatMessageContent)?.label {
      let textLayer = label.layer.presentation() ?? label.layer
      sample["textBounds"] = [Double(textLayer.bounds.width), Double(textLayer.bounds.height)]
      sample["textOpacity"] = label.isHidden ? 0 : Double(textLayer.opacity)
    }
    if let target, target.window === window {
      sample["targetFrame"] = rect(frame(target, presentation: true))
      sample["targetHidden"] = target.isHidden || target.layer.mask != nil
      var ancestor = target.superview
      while let view = ancestor {
        if let list = view as? UICollectionView {
          sample["listFrame"] = rect(frame(list, presentation: false))
          sample["contentOffsetY"] = Double(list.contentOffset.y)
          sample["contentHeight"] = Double(list.contentSize.height)
          sample["bottomInset"] = Double(list.adjustedContentInset.bottom)
          sample["reservedSpace"] = Double(list.contentInset.bottom - list.verticalScrollIndicatorInsets.bottom)
          break
        }
        ancestor = view.superview
      }
    }
    samples.append(sample)
  }

  func stop(cancelled: Bool) {
    guard link != nil else { return }
    link?.invalidate(); link = nil
    let report: [String: Any] = [
      "metric": "CADisplayLink + Core Animation presentation geometry; not GPU-presented FPS",
      "maximumFPS": window?.screen.maximumFramesPerSecond ?? 0,
      "source": rect(source), "destination": rect(destination), "duration": duration,
      "flight": ChatThrowCurve.duration, "path": track.points.map { [Double($0.x), Double($0.y)] }, "pathTimes": track.times,
      "sourceBackground": rgba(sourceBackground), "destinationBackground": rgba(destinationBackground),
      "cancelled": cancelled, "samples": samples,
      "transition": reveal ? "reveal" : "flight",
    ]
    let prefix = attachment ? "lody-attachment" : "lody-throw"
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
      try? data.write(to: FileManager.default.temporaryDirectory
        .appendingPathComponent("\(prefix)-\(UUID().uuidString).json"), options: .atomic)
    }
  }
}
