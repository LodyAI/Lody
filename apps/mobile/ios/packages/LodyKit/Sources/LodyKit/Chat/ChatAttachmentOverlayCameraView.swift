@preconcurrency import AVFoundation
import UIKit
import AnchoredOverlayKit

private final class ChatCameraPreview: UIView {
  override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
  var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

/// Native viewfinder and capture controls reused by the attachment overlay.
final class ChatAttachmentOverlayCameraView: UIView {
  var onCollapse: (() -> Void)?
  var onShutter: ((AVCaptureDevice.FlashMode, CGFloat) -> Void)?
  var onFlip: (() -> Void)?
  var onFocus: ((CGPoint) -> Void)?
  var onRetry: (() -> Void)?
  private let preview = ChatCameraPreview()
  private let image = UIImageView()
  private let shutterFlash = UIView()
  lazy var controls = OverlayActionBar(leading: collapse, trailing: more, center: shutter,
                                        sideInset: 20, rowHeight: 96)
  private let collapse = OverlayActionButton()
  private let shutter = UIButton(type: .custom)
  private let shutterRing = UIView()
  private let shutterFace = UIView()
  private let more = OverlayActionButton()
  private let flip = OverlayActionButton()
  private let flash = OverlayActionButton()
  private var toolsExpanded = false
  private let status = UILabel()
  private let retry = OverlayActionButton()
  private let focusRing = UIView()
  private var expanded = false
  private var ready = false
  private var busy = false
  private var supportsFlash = false
  private var canSwitchCamera = false
  private var flashMode: AVCaptureDevice.FlashMode = .auto
  private var rotation: AVCaptureDevice.RotationCoordinator?
  private var rotationObservation: NSKeyValueObservation?
  var controlInsets = UIEdgeInsets.zero { didSet { controls.safeAreaClearance = controlInsets } }
  var previewLayer: AVCaptureVideoPreviewLayer { preview.previewLayer }

  init(session: AVCaptureSession, dismissKey: String = "native.chat.camera.collapse") {
    super.init(frame: .zero)
    clipsToBounds = true
    overrideUserInterfaceStyle = .dark
    controls.overrideUserInterfaceStyle = .dark
    backgroundColor = .black
    layer.cornerCurve = .continuous
    preview.accessibilityIdentifier = "camera-viewfinder"
    preview.accessibilityLabel = String(localized: "native.chat.camera.photo", bundle: .lody)
    preview.isAccessibilityElement = true
    if !ChatCameraCapture.fixture { previewLayer.session = session }
    previewLayer.videoGravity = .resizeAspectFill
    image.contentMode = .scaleAspectFill
    image.clipsToBounds = true
    if ChatCameraCapture.fixture { image.image = ChatCameraCapture.fixtureImage() }
    shutterFlash.backgroundColor = .white
    shutterFlash.alpha = 0
    shutterFlash.isUserInteractionEnabled = false
    for item in [preview, image, shutterFlash, controls] { addSubview(item) }
    for button in [collapse, more, flip, flash, retry] {
      button.appearance = ChatAttachmentMenu.mediaActionAppearance
    }
    collapse.setImage(UIImage(systemName: "chevron.left"), for: .normal)
    collapse.accessibilityLabel = String(localized: String.LocalizationValue(dismissKey), bundle: .lody)
    collapse.accessibilityIdentifier = "camera-collapse"
    collapse.addAction(UIAction { [weak self] _ in self?.onCollapse?() }, for: .touchUpInside)
    more.setImage(UIImage(systemName: "ellipsis"), for: .normal)
    more.accessibilityIdentifier = "camera-more"
    more.accessibilityLabel = String(localized: "native.chat.camera.more", bundle: .lody)
    more.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      setToolsExpanded(!toolsExpanded, animated: true)
    }, for: .touchUpInside)
    flip.setImage(UIImage(systemName: "arrow.trianglehead.2.clockwise.rotate.90.camera"), for: .normal)
    flip.accessibilityIdentifier = "camera-flip"
    flip.accessibilityLabel = String(localized: "native.chat.camera.flip", bundle: .lody)
    flip.addAction(UIAction { [weak self] _ in
      guard let self, ready, !busy else { return }
      ready = false
      render()
      onFlip?()
    }, for: .touchUpInside)
    flash.accessibilityIdentifier = "camera-flash"
    flash.accessibilityLabel = String(localized: "native.chat.camera.flash", bundle: .lody)
    flash.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      switch flashMode {
      case .auto: flashMode = .on
      case .on: flashMode = .off
      default: flashMode = .auto
      }
      updateOptions()
      UISelectionFeedbackGenerator().selectionChanged()
    }, for: .touchUpInside)
    shutterRing.layer.borderWidth = 4
    shutterRing.layer.borderColor = UIColor.white.cgColor
    shutterFace.backgroundColor = .white
    for part in [shutterRing, shutterFace] {
      part.isUserInteractionEnabled = false
      shutter.addSubview(part)
    }
    shutter.accessibilityLabel = String(localized: "native.chat.composer.takePhoto", bundle: .lody)
    shutter.accessibilityIdentifier = "camera-shutter"
    shutter.addAction(UIAction { [weak self] _ in
      guard let self, ready, !busy else { return }
      busy = true
      render()
      UIImpactFeedbackGenerator(style: .rigid).impactOccurred()
      shutterFlash.alpha = 0.12
      shutterFace.transform = CGAffineTransform(scaleX: 0.88, y: 0.88)
      UIView.animate(withDuration: 0.18, delay: 0, options: [.beginFromCurrentState]) {
        self.shutterFlash.alpha = 0
        self.shutterFace.transform = .identity
      }
      onShutter?(flashMode, rotation?.videoRotationAngleForHorizonLevelCapture ?? 90)
    }, for: .touchUpInside)
    status.textColor = .white
    status.backgroundColor = .black.withAlphaComponent(0.65)
    status.layer.cornerRadius = 16
    status.clipsToBounds = true
    status.font = .preferredFont(forTextStyle: .body)
    status.numberOfLines = 0
    status.textAlignment = .center
    status.accessibilityIdentifier = "camera-status"
    retry.accessibilityIdentifier = "camera-retry"
    retry.addAction(UIAction { [weak self] _ in self?.onRetry?() }, for: .touchUpInside)
    focusRing.layer.borderWidth = 1.5
    focusRing.layer.borderColor = UIColor.white.cgColor
    focusRing.layer.cornerRadius = 8
    focusRing.alpha = 0
    focusRing.isUserInteractionEnabled = false
    for item in [flip, flash, status, retry, focusRing] { controls.addSubview(item) }
    controls.isUserInteractionEnabled = true
    // Only the actual controls intercept touches; focus taps elsewhere use this view.
    let focusTap = UITapGestureRecognizer(target: self, action: #selector(focus(_:)))
    focusTap.cancelsTouchesInView = false
    addGestureRecognizer(focusTap)
    render()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    preview.frame = bounds
    image.frame = bounds
    shutterFlash.frame = bounds
    CATransaction.commit()
    controls.layoutIfNeeded()
    let diameter = OverlayControlMetrics().diameter
    var tools: [UIButton] = []
    if canSwitchCamera { tools.append(flip) }
    if supportsFlash { tools.append(flash) }
    for (index, button) in tools.enumerated() {
      button.frame = more.convert(more.bounds, to: controls).offsetBy(dx: 0, dy: -CGFloat(index + 1) * (diameter + 12))
    }
    shutterRing.frame = shutter.bounds
    shutterRing.layer.cornerRadius = shutter.bounds.height / 2
    shutterFace.frame = shutter.bounds.insetBy(dx: 5, dy: 5)
    shutterFace.layer.cornerRadius = shutterFace.bounds.height / 2
    let messageHeight = min(110, status.sizeThatFits(CGSize(width: max(1, bounds.width - 64), height: 200)).height + 32)
    status.frame = CGRect(x: 24, y: bounds.midY - messageHeight / 2 - 22, width: bounds.width - 48, height: messageHeight)
    retry.frame = CGRect(x: bounds.midX - diameter / 2, y: status.frame.maxY + 12, width: diameter, height: diameter)
  }

  func setExpanded(_ value: Bool) {
    expanded = value
    accessibilityIdentifier = value ? "camera-expanded" : "camera-tile-preview"
    controls.accessibilityElementsHidden = !value
    render()
  }

  func preparePreview(device: AVCaptureDevice?) {
    rotationObservation = nil
    rotation = device.map { AVCaptureDevice.RotationCoordinator(device: $0, previewLayer: previewLayer) }
    rotationObservation = rotation?.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) { [weak self] coordinator, _ in
      // RotationCoordinator delivers preview-angle observations on the main queue.
      MainActor.assumeIsolated {
        guard let connection = self?.previewLayer.connection else { return }
        let angle = coordinator.videoRotationAngleForHorizonLevelPreview
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        CATransaction.commit()
      }
    }
  }

  func setReady(device: AVCaptureDevice?, canFlip: Bool) {
    ready = true
    busy = false
    status.text = nil
    supportsFlash = device?.hasFlash == true || ChatCameraCapture.fixture
    canSwitchCamera = canFlip
    updateOptions()
    render()
  }

  func showError(_ key: String, action: String? = "native.chat.camera.retry") {
    ready = false
    busy = false
    status.text = String(localized: String.LocalizationValue(key), bundle: .lody)
    retry.accessibilityLabel = action.map { String(localized: String.LocalizationValue($0), bundle: .lody) }
    retry.setImage(UIImage(systemName: action == "native.chat.camera.retry" ? "arrow.clockwise" : "gearshape"), for: .normal)
    render()
    setNeedsLayout()
  }

  private func updateOptions() {
    let mode: String
    let symbol: String
    switch flashMode {
    case .on: mode = "on"; symbol = "bolt.fill"
    case .off: mode = "off"; symbol = "bolt.slash.fill"
    default: mode = "auto"; symbol = "bolt.badge.a"
    }
    flash.setImage(UIImage(systemName: symbol), for: .normal)
    flash.accessibilityValue = String(localized: String.LocalizationValue("native.chat.camera.flash." + mode), bundle: .lody)
    setNeedsLayout()
  }

  private func setToolsExpanded(_ value: Bool, animated: Bool) {
    toolsExpanded = value
    more.setImage(UIImage(systemName: value ? "xmark" : "ellipsis"), for: .normal)
    more.accessibilityLabel = String(localized: String.LocalizationValue(value ? "native.close" : "native.chat.camera.more"), bundle: .lody)
    let buttons = [flip, flash]
    if value {
      render()
      for button in buttons {
        button.alpha = 0
        if !UIAccessibility.isReduceMotionEnabled {
          button.transform = CGAffineTransform(translationX: 0, y: 12)
        }
      }
    }
    UIView.animate(withDuration: animated ? 0.2 : 0, delay: 0, options: [.beginFromCurrentState, .curveEaseOut]) {
      for button in buttons {
        button.alpha = value ? 1 : 0
        button.transform = .identity
      }
    } completion: { [weak self] _ in self?.render() }
  }

  private func render() {
    controls.alpha = expanded ? 1 : 0
    more.isEnabled = ready && !busy
    flip.isHidden = !toolsExpanded || !canSwitchCamera
    flash.isHidden = !toolsExpanded || !supportsFlash
    flip.isEnabled = ready && !busy
    flash.isEnabled = ready && !busy
    status.isHidden = status.text == nil
    retry.isHidden = status.isHidden || retry.accessibilityLabel == nil
    shutter.isEnabled = ready && !busy
    shutter.alpha = shutter.isEnabled ? 1 : 0.4
    collapse.isEnabled = true
  }

  @objc private func focus(_ gesture: UITapGestureRecognizer) {
    guard expanded, ready, !busy else { return }
    let point = gesture.location(in: controls)
    guard preview.frame.contains(gesture.location(in: self)) else { return }
    guard ![collapse, shutter, more, retry, flip, flash].contains(where: { !$0.isHidden && $0.point(inside: controls.convert(point, to: $0), with: nil) }) else { return }
    onFocus?(previewLayer.captureDevicePointConverted(fromLayerPoint: gesture.location(in: preview)))
    focusRing.layer.removeAllAnimations()
    focusRing.frame = CGRect(x: point.x - 30, y: point.y - 30, width: 60, height: 60)
    focusRing.alpha = 1
    UIView.animate(withDuration: 0.3, delay: 0.6, options: [.beginFromCurrentState]) { self.focusRing.alpha = 0 }
  }
}
