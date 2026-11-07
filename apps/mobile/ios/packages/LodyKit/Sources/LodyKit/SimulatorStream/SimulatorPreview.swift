import UIKit

/// Retains one stream for its chat; full-screen navigation temporarily borrows it.
@MainActor final class SimulatorPreview: UIView {
  private var stream: SimulatorStreamView?
  private var leaving: SimulatorStreamView?
  private let shadow = UIView()
  private let content = UIView()
  private let zoomAnchor = UIView()
  private let expand = UIButton(type: .system)
  private let close = UIButton(type: .system)
  private var blackout: UIView?
  private var standIn: UIView?
  private var standInHidden = false
  private var display = CGRect.zero
  private var displayRadius: CGFloat = 12
  private var needsEntrance = false
  private var zoomed = false
  private var motion: String?
  private var motionID = 0
  private var area = CGRect.zero
  private var position = CGPoint(x: 1, y: 0)
  private var dragStart = CGPoint.zero
  var onAction: ((String) -> Void)?

  override var isHidden: Bool {
    didSet {
      guard oldValue != isHidden else { return }
      if isHidden { endMotion(); standInHidden = standInHidden || standIn != nil } else { needsEntrance = true; setNeedsLayout() }
    }
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    shadow.isUserInteractionEnabled = false
    shadow.layer.shadowColor = UIColor.black.cgColor
    shadow.layer.shadowOpacity = 0.22
    shadow.layer.shadowRadius = 16
    shadow.layer.shadowOffset = CGSize(width: 0, height: 8)
    addSubview(shadow)
    content.clipsToBounds = true
    content.layer.cornerRadius = 12
    content.layer.cornerCurve = .continuous
    addSubview(content)
    zoomAnchor.isUserInteractionEnabled = false
    addSubview(zoomAnchor)
    for (button, symbol, key, id) in [
      (expand, "arrow.up.left.and.arrow.down.right", "native.simulator.expand", "simulator-preview-expand"),
      (close, "xmark", "native.simulator.close", "simulator-preview-close"),
    ] {
      button.setImage(UIImage(systemName: symbol), for: .normal)
      button.setPreferredSymbolConfiguration(.init(pointSize: 12, weight: .medium), forImageIn: .normal)
      button.adjustsImageSizeForAccessibilityContentSizeCategory = true
      button.imageView?.clipsToBounds = false
      button.imageView?.layer.shadowOpacity = 1
      button.imageView?.layer.shadowRadius = 3
      button.imageView?.layer.shadowOffset = .zero
      button.tintColor = .label
      button.accessibilityLabel = String(localized: String.LocalizationValue(key), bundle: .lody)
      button.accessibilityIdentifier = id
      addSubview(button)
    }
    expand.addAction(UIAction { [weak self] _ in self?.onAction?("expand") }, for: .touchUpInside)
    close.addAction(UIAction { [weak self] _ in self?.hide() }, for: .touchUpInside)
    content.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(open)))
    addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(drag)))
    accessibilityIdentifier = "simulator-preview"
    isHidden = true
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  isolated deinit { stream?.stop(); leaving?.stop() }

  func setSource(_ json: String) {
    let next = SimulatorStreamView.shared(json)
    guard next !== stream else { return }
    let previous = stream
    stream = next
    next?.preview = self
    if let previous, next == nil, motion != "hide", !isHidden, window != nil, previous.superview === content {
      powerOff(previous)
    } else {
      endMotion()
      previous?.stop()
      previous?.removeFromSuperview()
    }
    if next == nil, motion == nil { isHidden = true }
    if next != nil { attach() }
    superview?.setNeedsLayout()
  }

  // A zoom transition already carried the device here, so returning skips the entrance.
  func attach(returning: Bool = false) {
    guard let stream, stream.fullscreen?.window == nil else { return }
    if motion == "stop" { endMotion() }
    stream.compact = true
    content.addSubview(stream)
    stream.frame = content.bounds
    let landed = returning && zoomed
    if returning { recordLanding(zoomed: landed) }
    dropStandIn()
    zoomed = false
    isHidden = false
    if landed { needsEntrance = false }
    setNeedsLayout()
    superview?.setNeedsLayout()
  }

  func zoomSource(fitting size: CGSize) -> UIView? {
    guard window != nil, bounds.height > 48, size.width > 0, size.height > 0 else { return nil }
    layoutIfNeeded()
    if display == .zero || display == content.frame {
      let scale = min(content.frame.width / size.width, content.frame.height / size.height)
      let fitted = CGSize(width: size.width * scale, height: size.height * scale)
      display = CGRect(x: content.frame.midX - fitted.width / 2, y: content.frame.midY - fitted.height / 2,
                       width: fitted.width, height: fitted.height)
    }
    zoomAnchor.frame = display
    zoomed = true
    receive()
    return zoomAnchor
  }

  // The zoom fades full screen into this view, so a returning device needs something to land on
  // before the live renderer is handed back.
  private func receive() {
    guard standIn == nil, let stream, stream.fullscreen?.window != nil,
          let snapshot = stream.resizableSnapshotView(
            from: stream.displayFrame, afterScreenUpdates: false, withCapInsets: .zero) else { return }
    snapshot.frame = display
    snapshot.clipsToBounds = true
    snapshot.layer.cornerRadius = displayRadius
    snapshot.layer.cornerCurve = .continuous
    snapshot.isUserInteractionEnabled = false
    insertSubview(snapshot, aboveSubview: content)
    standIn = snapshot
    standInHidden = false
    isHidden = false
    needsEntrance = false
  }

  private func dropStandIn() {
    standIn?.removeFromSuperview()
    standIn = nil
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      endMotion()
      dropStandIn()
      needsEntrance = true
    } else {
      attach()
    }
  }

  func layout(in available: CGRect) {
    area = available.insetBy(dx: 12, dy: 12)
    guard let stream, motion != "hide" else { return }
    isHidden = (stream.fullscreen?.window != nil && standIn == nil) || area.width < 116 || area.height < 132
    guard area.width >= 116, area.height >= 132 else { return }
    let height = min(268, area.height)
    let width = min(144, area.width, max(116, (height - 48) / 2 + 8))
    bounds.size = CGSize(width: width, height: height)
    center = CGPoint(
      x: area.minX + (area.width - width) * position.x + width / 2,
      y: area.minY + (area.height - height) * position.y + height / 2)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    content.frame = CGRect(x: 4, y: 44, width: bounds.width - 8, height: max(0, bounds.height - 48))
    if let hosted = content.subviews.lazy.compactMap({ $0 as? SimulatorStreamView }).first {
      hosted.frame = content.bounds
      hosted.layoutIfNeeded()
      display = hosted.convert(hosted.displayFrame, to: self)
      displayRadius = hosted.displayCornerRadius
    }
    let body = display == .zero ? content.frame : display
    shadow.frame = bounds
    shadow.layer.shadowPath = UIBezierPath(roundedRect: body, cornerRadius: displayRadius).cgPath
    zoomAnchor.frame = body
    standIn?.frame = body
    blackout?.frame = body
    expand.frame = CGRect(x: 4, y: 0, width: bounds.width / 2 - 4, height: 44)
    close.frame = CGRect(x: bounds.width / 2, y: 0, width: bounds.width / 2 - 4, height: 44)
    for button in [expand, close] {
      button.layoutIfNeeded()
      button.imageView?.layer.shadowColor = UIColor.systemBackground.resolvedColor(with: traitCollection).cgColor
      if let icon = button.imageView {
        icon.layer.shadowPath = UIBezierPath(roundedRect: icon.bounds.insetBy(dx: -3, dy: -2), cornerRadius: 4).cgPath
      }
    }
    if needsEntrance, motion == nil, !isHidden, window != nil, bounds.height > 48 { beginEntrance() }
  }

  private func setChrome(alpha: CGFloat) {
    for view in [shadow, expand, close] { view.alpha = alpha }
  }

  private func transform(onto target: CGRect) -> CGAffineTransform? {
    guard display.width > 0 else { return nil }
    let scale = target.width / display.width
    return CGAffineTransform(
      a: scale, b: 0, c: 0, d: scale,
      tx: target.midX - center.x - scale * (display.midX - bounds.midX),
      ty: target.midY - center.y - scale * (display.midY - bounds.midY))
  }

  private func startMotion(_ kind: String) -> Int {
    endMotion()
    motion = kind
    return motionID
  }

  private func endMotion() {
    motionID += 1
    motion = nil
    for view in [self, shadow, expand, close] { view.layer.removeAllAnimations() }
    transform = .identity
    alpha = 1
    setChrome(alpha: 1)
    blackout?.removeFromSuperview()
    blackout = nil
    leaving?.stop()
    leaving?.removeFromSuperview()
    leaving = nil
    isUserInteractionEnabled = true
  }

  private func beginEntrance() {
    needsEntrance = false
    let id = startMotion("appear")
    alpha = 0
    if !UIAccessibility.isReduceMotionEnabled { transform = CGAffineTransform(scaleX: 0.86, y: 0.86) }
    record(id)
    UIView.animate(withDuration: 0.36, delay: 0, usingSpringWithDamping: 0.86, initialSpringVelocity: 0,
                   options: [.allowUserInteraction]) {
      self.transform = .identity
      self.alpha = 1
    } completion: { _ in
      if id == self.motionID { self.endMotion() }
    }
  }

  private func hide() {
    guard window != nil, let superview else { onAction?("close"); return }
    let id = startMotion("hide")
    isUserInteractionEnabled = false
    record(id)
    UIView.animate(withDuration: 0.12, delay: 0, options: .curveEaseIn) { self.setChrome(alpha: 0) }
    if UIAccessibility.isReduceMotionEnabled {
      UIView.animate(withDuration: 0.2) { self.alpha = 0 } completion: { _ in self.finishHide(id) }
      return
    }
    let start = convert(CGPoint(x: display.midX, y: display.midY), to: superview)
    let end = chip().map { $0.convert(CGPoint(x: $0.bounds.height / 2, y: $0.bounds.midY), to: superview) }
      ?? CGPoint(x: start.x, y: start.y + display.height)
    let bend = CGPoint(x: start.x + (end.x - start.x) * 0.25, y: start.y + (end.y - start.y) * 0.6)
    let rect = { (point: CGPoint, scale: CGFloat) in
      CGRect(x: point.x - self.display.width * scale / 2, y: point.y - self.display.height * scale / 2,
             width: self.display.width * scale, height: self.display.height * scale)
    }
    guard let middle = transform(onto: rect(bend, 0.6)), let last = transform(onto: rect(end, 0.3)) else {
      return finishHide(id)
    }
    UIView.animateKeyframes(withDuration: 0.3, delay: 0.06, options: [.calculationModeCubic]) {
      UIView.addKeyframe(withRelativeStartTime: 0, relativeDuration: 0.5) { self.transform = middle }
      UIView.addKeyframe(withRelativeStartTime: 0.5, relativeDuration: 0.5) { self.transform = last }
      UIView.addKeyframe(withRelativeStartTime: 0.73, relativeDuration: 0.27) { self.alpha = 0 }
    } completion: { _ in self.finishHide(id) }
  }

  private func finishHide(_ id: Int) {
    guard id == motionID else { return }
    let chip = chip()
    endMotion()
    isHidden = true
    onAction?("close")
    guard let chip, !UIAccessibility.isReduceMotionEnabled else { return }
    UIView.animate(withDuration: 0.1, delay: 0, options: .curveEaseOut) {
      chip.transform = CGAffineTransform(scaleX: 1.08, y: 1.08)
    } completion: { _ in
      UIView.animate(withDuration: 0.3, delay: 0, usingSpringWithDamping: 0.6, initialSpringVelocity: 0) {
        chip.transform = .identity
      }
    }
  }

  private func powerOff(_ previous: SimulatorStreamView) {
    let id = startMotion("stop")
    leaving = previous
    isUserInteractionEnabled = false
    let black = UIView(frame: display)
    black.backgroundColor = .black
    black.alpha = 0
    black.layer.cornerRadius = displayRadius
    black.layer.cornerCurve = .continuous
    insertSubview(black, aboveSubview: content)
    blackout = black
    record(id)
    UIImpactFeedbackGenerator(style: .soft).impactOccurred()
    UIView.animate(withDuration: 0.15, delay: 0, options: .curveEaseIn) { black.alpha = 1 }
    let reduced = UIAccessibility.isReduceMotionEnabled
    UIView.animate(withDuration: 0.18, delay: 0.15, options: .curveEaseIn) {
      if !reduced { self.transform = CGAffineTransform(scaleX: 0.92, y: 0.92) }
      self.alpha = 0
      self.setChrome(alpha: 0)
    } completion: { _ in
      guard id == self.motionID else { return }
      self.endMotion()
      if self.stream == nil { self.isHidden = true }
    }
  }

  private func chip() -> UIView? {
    var queue = superview?.subviews ?? []
    while !queue.isEmpty {
      let view = queue.removeFirst()
      guard view !== self, !view.isHidden, view.alpha > 0 else { continue }
      if view.accessibilityIdentifier == "session-preview", view.window != nil { return view }
      queue += view.subviews
    }
    return nil
  }

  private func record(_ id: Int) {
    guard LodyUIVerify.enabled, let kind = motion else { return }
    let started = CACurrentMediaTime()
    var samples = [sample(started, presentation: false)]
    Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] timer in
      let finished = MainActor.assumeIsolated {
        guard let self else { return true }
        if self.motionID == id {
          samples.append(self.sample(started, presentation: true))
          return false
        }
        let result: [String: Any] = ["kind": kind, "samples": samples, "visible": !self.isHidden && self.window != nil]
        if let data = try? JSONSerialization.data(withJSONObject: result) {
          try? data.write(to: FileManager.default.temporaryDirectory
            .appendingPathComponent("lody-simulator-motion-\(kind)-\(UUID().uuidString).json"))
        }
        return true
      }
      if finished { timer.invalidate() }
    }
  }

  private func recordLanding(zoomed: Bool) {
    guard LodyUIVerify.enabled else { return }
    let result: [String: Any] = ["zoomed": zoomed, "standIn": standIn != nil, "hiddenWhileLanding": standInHidden]
    guard let data = try? JSONSerialization.data(withJSONObject: result) else { return }
    try? data.write(to: FileManager.default.temporaryDirectory
      .appendingPathComponent("lody-simulator-motion-land-\(UUID().uuidString).json"))
  }

  private func sample(_ started: CFTimeInterval, presentation: Bool) -> [String: Double] {
    let read = { (layer: CALayer) in presentation ? layer.presentation() ?? layer : layer }
    return ["seconds": CACurrentMediaTime() - started,
            "scale": Double(read(layer).affineTransform().a),
            "alpha": Double(read(layer).opacity),
            "chrome": Double(read(shadow.layer).opacity),
            "blackout": Double(blackout.map { read($0.layer).opacity } ?? 0)]
  }

  @objc private func open() { onAction?("expand") }

  @objc private func drag(_ gesture: UIPanGestureRecognizer) {
    if gesture.state == .began { dragStart = CGPoint(x: center.x - bounds.width / 2, y: center.y - bounds.height / 2) }
    let translation = gesture.translation(in: superview)
    let travel = CGSize(width: max(1, area.width - bounds.width), height: max(1, area.height - bounds.height))
    position = CGPoint(
      x: min(1, max(0, (dragStart.x + translation.x - area.minX) / travel.width)),
      y: min(1, max(0, (dragStart.y + translation.y - area.minY) / travel.height)))
    if gesture.state == .ended || gesture.state == .cancelled {
      position.x = position.x < 0.5 ? 0 : 1
      UIView.animate(withDuration: 0.2) { self.layout(in: self.area.insetBy(dx: -12, dy: -12)) }
    } else {
      layout(in: area.insetBy(dx: -12, dy: -12))
    }
  }
}
