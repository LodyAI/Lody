import UIKit

@MainActor final class SimulatorStreamView: UIView {
  struct Source: Decodable, Equatable {
    let streamId: String
    let url: String
    let udid: String
    let name: String
    let operationId: String?
  }

  private static let streams = NSMapTable<NSString, SimulatorStreamView>.strongToWeakObjects()
  private static let fixtureURL = "lody-simulator-fixture://stream"
  weak var preview: SimulatorPreview?
  weak var fullscreen: LodySimulatorView?
  var compact = false { didSet { isUserInteractionEnabled = !compact; setNeedsLayout() } }
  var displayFrame: CGRect {
    guard let device else { return bounds }
    return device.convert(device.bodyFrame, to: self)
  }
  var displayCornerRadius: CGFloat { device?.bodyCornerRadius ?? 12 }

  static func shared(_ json: String) -> SimulatorStreamView? {
    guard let source = try? JSONDecoder().decode(Source.self, from: Data(json.utf8)),
          !source.streamId.isEmpty else { return nil }
    if let existing = streams.object(forKey: source.streamId as NSString), existing.source == source { return existing }
    let stream = SimulatorStreamView(frame: .zero)
    stream.setSource(source)
    streams.setObject(stream, forKey: source.streamId as NSString)
    return stream
  }

  private static let buttons = ["home": "home", "app-switcher": "app-switcher", "lock": "lock",
                                "volume-up": "volume-up", "volume-down": "volume-down", "action": "action"]

  private var source: Source?
  private var viewer: URL?
  private var device: SimulatorDeviceView?
  private var frameSize = CGSize.zero
  private let status = UILabel()
  private let decoder = SimulatorStreamDecoder()
  private var transport: SimulatorTransport?
  private var rtcDisabled = false
  private var h264Disabled = false
  private var usingH264 = false
  private var transportRetries = 0
  private var recoveries = 0
  private var showingVideo = false
  private var exterior: SimulatorExterior?
  private var exteriorTask: Task<Void, Never>?
  private var lastMessageAt = Date.distantPast
  private var timers: [Timer] = []
  private var retryTimer: Timer?
  private var configTimer: Timer?
  private var configuredSize = CGSize.zero
  private var finger: UITouch?
  private var edge: String?
  private var controlBusy = false
  private static var fixtureActive = 0
  private var fixtureTimer: Timer?
  private var fixtureFrame = 0
  private var fixtureConnections = 0
  private let fixtureID = UUID().uuidString
  private var observers: [NSObjectProtocol] = []

  override init(frame: CGRect) {
    super.init(frame: frame)
    status.textColor = .secondaryLabel
    status.font = .preferredFont(forTextStyle: .subheadline)
    status.adjustsFontForContentSizeCategory = true
    addSubview(status)
    let center = NotificationCenter.default
    observers = [
      center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.disconnect() }
      },
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in
        MainActor.assumeIsolated { self?.connect() }
      },
    ]
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  isolated deinit {
    exteriorTask?.cancel()
    disconnect()
    observers.forEach(NotificationCenter.default.removeObserver)
  }

  func stop() {
    if let source, Self.streams.object(forKey: source.streamId as NSString) === self {
      Self.streams.removeObject(forKey: source.streamId as NSString)
    }
    source = nil
    viewer = nil
    exteriorTask?.cancel()
    disconnect()
  }

  private func setSource(_ next: Source) {
    disconnect()
    source = next
    viewer = URL(string: next.url)
    h264Disabled = false
    rtcDisabled = false
    transportRetries = 0
    guard let viewer else { return setStatus("native.simulator.unavailable") }
    if next.url != Self.fixtureURL {
      exteriorTask = Task { [weak self] in
        guard let loaded = await SimulatorRemote.exterior(viewer), let self, self.source == next else { return }
        self.exterior = loaded
        self.installDevice()
      }
    }
    connect()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    let inset: CGFloat = compact ? 0 : 16
    let safe = compact ? UIEdgeInsets.zero : safeAreaInsets
    let area = bounds.inset(by: UIEdgeInsets(
      top: safe.top + inset, left: safe.left + inset,
      bottom: safe.bottom + inset, right: safe.right + inset))
    status.sizeToFit()
    status.center = CGPoint(x: area.midX, y: area.midY)
    if bounds.size != configuredSize { scheduleStreamConfig() }
    guard let device, area.width > 0, area.height > 0 else { return }
    let canvas = device.canvasSize
    let scale = min(area.width / canvas.width, area.height / canvas.height)
    let previousFrame = device.frame
    device.bounds = CGRect(origin: .zero, size: CGSize(width: canvas.width * scale, height: canvas.height * scale))
    device.center = CGPoint(x: area.midX, y: area.midY)
    if compact, previousFrame != device.frame { preview?.setNeedsLayout() }
    bringSubviewToFront(status)
  }

  private func install(_ size: CGSize) {
    frameSize = size
    if device == nil { installDevice() }
  }

  private func installDevice() {
    guard let shape = exterior ?? (frameSize == .zero ? nil : .plain(frameSize)) else { return }
    let previous = device
    let device = SimulatorDeviceView(exterior: shape)
    device.onButton = { [weak self] id in self?.perform(id) }
    device.seed.image = previous?.seed.image
    device.display.accessibilityIdentifier = "simulator-stream"
    device.display.isAccessibilityElement = true
    device.display.accessibilityLabel = source?.name
    previous?.removeFromSuperview()
    insertSubview(device, belowSubview: status)
    self.device = device
    if showingVideo {
      showingVideo = false
      decoder.awaitKeyFrame()
      send(["type": "keyframe-request"])
    }
    setNeedsLayout()
    preview?.setNeedsLayout()
  }

  private func connect() {
    guard transport == nil, fixtureTimer == nil, retryTimer == nil, let source, let viewer else { return }
    decoder.reset()
    recoveries = 0
    if LodyUIVerify.enabled, source.url == Self.fixtureURL {
      fixtureConnections += 1
      Self.fixtureActive += 1
      fixtureTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated { self?.fixtureTick() }
      }
      return
    }
    if device == nil { setStatus("native.simulator.connecting") }
    usingH264 = !h264Disabled
    let transport = SimulatorTransport(viewer: viewer, h264: usingH264)
    self.transport = transport
    transport.onOpen = { [weak self, weak transport] in
      guard let self, let transport, self.transport === transport else { return }
      self.opened(transport)
    }
    transport.onMessage = { [weak self, weak transport] message in
      guard let self, let transport, self.transport === transport else { return }
      self.receive(message, transport: transport)
    }
    transport.onClose = { [weak self, weak transport] code in
      guard let self, let transport else { return }
      self.failed(transport, code: code)
    }
    transport.onFallback = { [weak self, weak transport] in
      guard let self, let transport, self.transport === transport else { return }
      self.rtcDisabled = true
      self.decoder.reset()
      self.finger = nil
      self.edge = nil
      self.timers.forEach { $0.invalidate() }
      self.timers = []
    }
    transport.start(preferRTC: !rtcDisabled)
  }

  private func opened(_ transport: SimulatorTransport) {
    let mode = transport.mode
    configuredSize = .zero
    lastMessageAt = Date()
    let started = Date()
    timers = [
      Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated { if self?.window != nil { self?.send(["type": "heartbeat"]) } }
      },
      Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
        MainActor.assumeIsolated {
          guard let self, self.transport === transport else { return }
          if self.usingH264, Date().timeIntervalSince(self.lastMessageAt) >= 8 { return self.failed(transport) }
          if self.frameSize == .zero, Date().timeIntervalSince(started) >= 20 { self.failed(transport) }
        }
      },
    ]
    // Sending can synchronously fail RTC and open its fallback. Install timers
    // first so that transition cancels this connection's timers as well.
    sendStreamConfig()
    if self.transport === transport, transport.mode == mode { send(["type": "heartbeat"]) }
  }

  private func receive(_ message: URLSessionWebSocketTask.Message, transport: SimulatorTransport) {
    lastMessageAt = Date()
    switch message {
    case .string(let text):
      guard text.utf8.count <= 4096,
            let object = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
            object["type"] as? String == "ping", let id = object["id"] as? Int, id > 0 else { return }
      send(["type": "pong", "id": id])
    case .data(let data):
      let packet: SimulatorStreamDecoder.Packet
      do { packet = try decoder.handle(data, h264: usingH264) } catch {
        return failed(transport, codec: usingH264)
      }
      if let size = packet.size { install(size) }
      if let output = packet.output { show(output) }
      guard self.transport === transport else { return }
      send(["type": "frame-ack", "sequence": packet.sequence])
    @unknown default:
      break
    }
  }

  /// Transport loss retries H.264 twice per stream; a codec failure falls back to MJPEG
  /// once. Neither replays input.
  private func failed(_ transport: SimulatorTransport, code: Int = 1000, codec: Bool = false) {
    guard self.transport === transport else { return }
    let fallback = usingH264 && (codec || code == 4002)
    let retry = usingH264 && !fallback
    disconnect()
    if fallback {
      h264Disabled = true
      return connect()
    }
    guard retry, transportRetries < 2 else { return setStatus("native.simulator.disconnected") }
    transportRetries += 1
    if device == nil { setStatus("native.simulator.connecting") }
    retryTimer = Timer.scheduledTimer(withTimeInterval: transportRetries == 1 ? 0.5 : 1.5, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated {
        self?.retryTimer = nil
        self?.connect()
      }
    }
  }

  private func disconnect() {
    if fixtureTimer != nil { Self.fixtureActive -= 1 }
    fixtureTimer?.invalidate()
    fixtureTimer = nil
    retryTimer?.invalidate()
    retryTimer = nil
    configTimer?.invalidate()
    configTimer = nil
    timers.forEach { $0.invalidate() }
    timers = []
    transport?.close()
    transport = nil
    controlBusy = false
    finger = nil
    edge = nil
  }

  private func scheduleStreamConfig() {
    guard transport != nil else { return }
    configTimer?.invalidate()
    configTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: false) { [weak self] _ in
      MainActor.assumeIsolated { self?.sendStreamConfig() }
    }
  }

  private func sendStreamConfig() {
    let size = bounds.size == .zero ? UIScreen.main.bounds.size : bounds.size
    configuredSize = bounds.size
    send([
      "type": "stream-config",
      "width": Int(min(8192, max(1, size.width.rounded()))),
      "height": Int(min(8192, max(1, size.height.rounded()))),
      "dpr": min(2, max(0.5, traitCollection.displayScale)),
    ])
  }

  private func fixtureTick() {
    fixtureFrame += 1
    let image = UIGraphicsImageRenderer(size: CGSize(width: 184, height: 384)).image { context in
      UIColor.systemIndigo.setFill()
      context.fill(CGRect(x: 0, y: 0, width: 184, height: 384))
      let text = "Lody\nSimulator\n\(fixtureFrame)"
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .center
      (text as NSString).draw(in: CGRect(x: 8, y: 140, width: 168, height: 180), withAttributes: [
        .font: UIFont.systemFont(ofSize: 24, weight: .semibold),
        .foregroundColor: UIColor.white, .paragraphStyle: paragraph,
      ])
    }
    var header = Data([0x4C, 0x4F, 0x44, 0x59])
    withUnsafeBytes(of: UInt32(fixtureFrame).bigEndian) { header.append(contentsOf: $0) }
    if let data = image.jpegData(compressionQuality: 0.8),
       let packet = try? decoder.handle(header + data, h264: false) {
      if let size = packet.size { install(size) }
      if let output = packet.output { show(output) }
    }
    device?.display.accessibilityValue = "stream:\(fixtureID),connections:\(fixtureConnections),active:\(Self.fixtureActive),frame:\(fixtureFrame)"
  }

  private func show(_ output: SimulatorStreamDecoder.Output) {
    status.isHidden = true
    guard let device else { return }
    switch output {
    case .image(let image):
      device.seed.image = image
      if showingVideo {
        device.display.displayLayer.flushAndRemoveImage()
        showingVideo = false
      }
    case .frame(let sample):
      let layer = device.display.displayLayer
      if layer.status == .failed {
        layer.flush()
        recoveries += 1
        if recoveries > 3, let transport { return failed(transport, codec: true) }
        decoder.awaitKeyFrame()
        return send(["type": "keyframe-request"])
      }
      layer.enqueue(sample)
      showingVideo = true
    }
  }

  private func setStatus(_ key: String) {
    status.text = String(localized: String.LocalizationValue(key), bundle: .lody)
    status.isHidden = false
    setNeedsLayout()
  }

  func perform(_ action: String) {
    guard let transport, let operationId = source?.operationId, !controlBusy else { return }
    let control: [String: String]
    if let button = Self.buttons[action] {
      control = ["kind": "button", "button": button]
    } else if action == "rotate-left" || action == "rotate-right" {
      control = ["kind": "rotate", "direction": action == "rotate-left" ? "left" : "right"]
    } else if action == "shake" {
      control = ["kind": "shake"]
    } else {
      return
    }
    lift()
    controlBusy = true
    Task { [weak self] in
      _ = await transport.perform(operationId: operationId, control: control)
      if self?.transport === transport { self?.controlBusy = false }
    }
  }

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard finger == nil, !controlBusy, let transport, transport.mode == .webRTC || transport.mode == .webSocket, let device, let touch = touches.first,
          device.display.bounds.contains(touch.location(in: device.display)) else { return }
    let point = location(touch)
    finger = touch
    edge = point.y >= frameSize.height * 0.93 ? "bottom" : nil
    self.touch("touch1-down", point)
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let finger, touches.contains(finger) else { return }
    touch("touch1-move", location(finger))
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let finger, touches.contains(finger) else { return }
    touch("touch1-up", location(finger))
    self.finger = nil
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    guard let finger, touches.contains(finger) else { return }
    lift()
  }

  private func lift() {
    guard let finger else { return }
    touch("touch1-up", location(finger))
    self.finger = nil
  }

  /// Points are in the decoded frame's pixels; the gateway forwards them to the
  /// device unchanged. The mobile canvas stays portrait while the device rotates.
  private func location(_ touch: UITouch) -> CGPoint {
    guard let device else { return .zero }
    let point = touch.location(in: device.display)
    let bounds = device.display.bounds
    guard bounds.width > 0, bounds.height > 0 else { return .zero }
    return CGPoint(
      x: min(max(point.x / bounds.width, 0), 1) * frameSize.width,
      y: min(max(point.y / bounds.height, 0), 1) * frameSize.height)
  }

  private func touch(_ type: String, _ point: CGPoint) {
    var envelope: [String: Any] = [
      "type": type, "x": point.x, "y": point.y,
      "width": Int(frameSize.width), "height": Int(frameSize.height),
    ]
    if let edge { envelope["edge"] = edge }
    send(envelope)
  }

  private func send(_ envelope: [String: Any]) {
    transport?.send(envelope)
  }
}
