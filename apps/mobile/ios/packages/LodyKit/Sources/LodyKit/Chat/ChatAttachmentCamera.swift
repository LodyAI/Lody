#if LODY_SHARE_EXTENSION
@preconcurrency import AVFoundation
import UIKit

private final class ChatCameraPreview: UIView {
  override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
  var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
}

/// This exact view moves between the first grid cell and the sheet; the preview is never replaced.
final class ChatAttachmentCameraView: UIView {
  var onCollapse: (() -> Void)?
  var onShutter: ((AVCaptureDevice.FlashMode, CGFloat) -> Void)?
  var onFlip: (() -> Void)?
  var onLibrary: (() -> Void)?
  var onFocus: ((CGPoint) -> Void)?
  var onRetry: (() -> Void)?
  var onRetake: (() -> Void)?
  var onAdd: (() -> Void)?
  private let preview = ChatCameraPreview()
  private let image = UIImageView()
  private let shutterFlash = UIView()
  private let glyph = UIImageView(image: UIImage(systemName: "camera.fill"))
  private let controls = UIView()
  private let collapse = UIButton(configuration: .glass())
  private let flash = UIButton(configuration: .glass())
  private let shutter = UIButton(type: .custom)
  private let shutterRing = UIView()
  private let shutterFace = UIView()
  private let flip = UIButton(configuration: .glass())
  private let library = UIButton(configuration: .glass())
  private let libraryThumbnail = UIImageView()
  private let retake = UIButton(configuration: .glass())
  private let add = UIButton(configuration: .glass())
  private let status = UILabel()
  private let retry = UIButton(configuration: .glass())
  private let focusRing = UIView()
  /// A host whose own bounds are not already 3:4 keeps the viewfinder letterboxed.
  var letterboxed = false { didSet { setNeedsLayout() } }
  private var transitionViewport: CGSize?
  private var expanded = false
  private var reviewing = false
  private var ready = false
  private var busy = false
  private var flashMode: AVCaptureDevice.FlashMode = .auto
  private var rotation: AVCaptureDevice.RotationCoordinator?
  private var rotationObservation: NSKeyValueObservation?
  var controlInsets = UIEdgeInsets.zero
  var previewLayer: AVCaptureVideoPreviewLayer { preview.previewLayer }

  init(session: AVCaptureSession, dismissKey: String = "native.chat.camera.collapse") {
    super.init(frame: .zero)
    clipsToBounds = true
    overrideUserInterfaceStyle = .dark
    backgroundColor = .black
    layer.cornerCurve = .continuous
    preview.accessibilityIdentifier = "camera-viewfinder"
    preview.accessibilityLabel = String(localized: "native.chat.camera.photo", bundle: .lody)
    preview.isAccessibilityElement = true
    previewLayer.session = session
    previewLayer.videoGravity = .resizeAspectFill
    image.contentMode = .scaleAspectFill
    image.clipsToBounds = true
    if ChatCameraCapture.fixture { image.image = ChatCameraCapture.fixtureImage() }
    glyph.tintColor = .white
    glyph.backgroundColor = .black.withAlphaComponent(0.4)
    glyph.layer.cornerRadius = 24
    glyph.clipsToBounds = true
    glyph.contentMode = .center
    glyph.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 24)
    shutterFlash.backgroundColor = .white
    shutterFlash.alpha = 0
    shutterFlash.isUserInteractionEnabled = false
    for item in [preview, image, shutterFlash, glyph, controls] { addSubview(item) }
    for button in [collapse, flash, flip, library, retake, add, retry] {
      button.configuration?.cornerStyle = .capsule
      button.configuration?.contentInsets = .zero
      button.configuration?.preferredSymbolConfigurationForImage = .init(pointSize: 20, weight: .medium)
    }
    for button in [flip, library, retry] {
      button.configuration?.preferredSymbolConfigurationForImage = .init(pointSize: 21, weight: .medium)
    }
    for button in [retake, add] {
      button.configuration?.preferredSymbolConfigurationForImage = .init(pointSize: 16, weight: .semibold)
      button.configuration?.imagePadding = 7
      button.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 18)
      button.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { attributes in
        var resolved = attributes
        resolved.font = .systemFont(ofSize: 16, weight: .semibold)
        return resolved
      }
    }
    collapse.setImage(UIImage(systemName: "chevron.down"), for: .normal)
    collapse.accessibilityLabel = String(localized: String.LocalizationValue(dismissKey), bundle: .lody)
    collapse.accessibilityIdentifier = "camera-collapse"
    collapse.addAction(UIAction { [weak self] _ in self?.onCollapse?() }, for: .touchUpInside)
    flash.accessibilityIdentifier = "camera-flash"
    flash.addAction(UIAction { [weak self] _ in
      guard let self else { return }
      switch flashMode { case .auto: flashMode = .on; case .on: flashMode = .off; default: flashMode = .auto }
      updateFlash()
    }, for: .touchUpInside)
    updateFlash()
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
      shutterFlash.alpha = 1
      UIView.animate(withDuration: 0.2, delay: 0.02) { self.shutterFlash.alpha = 0 }
      onShutter?(flashMode, rotation?.videoRotationAngleForHorizonLevelCapture ?? 90)
    }, for: .touchUpInside)
    flip.setImage(UIImage(systemName: "arrow.trianglehead.2.clockwise.rotate.90.camera"), for: .normal)
    flip.accessibilityLabel = String(localized: "native.chat.camera.flip", bundle: .lody)
    flip.accessibilityIdentifier = "camera-flip"
    library.setImage(UIImage(systemName: "photo.stack"), for: .normal)
    libraryThumbnail.contentMode = .scaleAspectFill
    libraryThumbnail.clipsToBounds = true
    libraryThumbnail.isUserInteractionEnabled = false
    libraryThumbnail.isHidden = true
    libraryThumbnail.layer.cornerCurve = .continuous
    libraryThumbnail.layer.borderWidth = 1
    libraryThumbnail.layer.borderColor = UIColor.white.withAlphaComponent(0.5).cgColor
    library.addSubview(libraryThumbnail)
    library.accessibilityLabel = String(localized: "native.chat.composer.photoLibrary", bundle: .lody)
    library.accessibilityIdentifier = "camera-library"
    library.addAction(UIAction { [weak self] _ in self?.onLibrary?() }, for: .touchUpInside)
    flip.addAction(UIAction { [weak self] _ in
      self?.ready = false
      self?.render()
      self?.onFlip?()
    }, for: .touchUpInside)
    retake.setImage(UIImage(systemName: "arrow.counterclockwise"), for: .normal)
    retake.setTitle(String(localized: "native.chat.camera.retake", bundle: .lody), for: .normal)
    retake.accessibilityLabel = String(localized: "native.chat.camera.retake", bundle: .lody)
    retake.accessibilityIdentifier = "camera-retake"
    retake.addAction(UIAction { [weak self] _ in self?.onRetake?() }, for: .touchUpInside)
    add.setImage(UIImage(systemName: "checkmark"), for: .normal)
    add.setTitle(String(localized: "native.chat.camera.add", bundle: .lody), for: .normal)
    add.tintColor = .systemBlue
    add.accessibilityLabel = String(localized: "native.chat.camera.add", bundle: .lody)
    add.accessibilityIdentifier = "camera-add"
    add.addAction(UIAction { [weak self] _ in self?.onAdd?() }, for: .touchUpInside)
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
    for item in [collapse, flash, shutter, flip, library, retake, add, status, retry, focusRing] { controls.addSubview(item) }
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
    // Keep the camera's render size fixed during the morph. Changing the capture
    // layer's bounds makes its aspect-fill crop jump ahead of the UIView animation.
    var viewfinder = bounds
    if letterboxed {
      let available = CGRect(x: 0, y: controlInsets.top + 64, width: bounds.width,
        height: max(1, bounds.height - controlInsets.top - controlInsets.bottom - 228))
      let width = min(available.width, available.height * 3 / 4)
      viewfinder = CGRect(x: bounds.midX - width / 2, y: available.midY - width * 2 / 3,
        width: width, height: width * 4 / 3)
    }
    let viewport = transitionViewport ?? viewfinder.size
    let scale = max(viewfinder.width / max(1, viewport.width), viewfinder.height / max(1, viewport.height))
    for content in [preview, image] {
      content.bounds = CGRect(origin: .zero, size: viewport)
      content.center = CGPoint(x: viewfinder.midX, y: viewfinder.midY)
      content.transform = CGAffineTransform(scaleX: scale, y: scale)
    }
    shutterFlash.frame = viewfinder
    glyph.frame = CGRect(x: bounds.midX - 24, y: bounds.midY - 24, width: 48, height: 48)
    controls.frame = bounds
    let top = max(24, controlInsets.top + 6)
    let centerY = bounds.height - controlInsets.bottom - 84
    let left = 22 + controlInsets.left
    let right = bounds.width - 22 - controlInsets.right
    // A presented sheet renders scaled, so a 44 pt button would measure below the minimum target.
    collapse.frame = CGRect(x: left, y: top, width: 46, height: 46)
    flash.frame = CGRect(x: right - 46, y: top, width: 46, height: 46)
    shutter.frame = CGRect(x: bounds.midX - 37, y: centerY - 37, width: 74, height: 74)
    library.frame = CGRect(x: left, y: centerY - 26, width: 52, height: 52)
    libraryThumbnail.frame = library.bounds
    libraryThumbnail.layer.cornerRadius = 10
    flip.frame = CGRect(x: right - 52, y: centerY - 26, width: 52, height: 52)
    let retakeWidth = max(104, ceil(retake.intrinsicContentSize.width))
    let addWidth = max(104, ceil(add.intrinsicContentSize.width))
    retake.frame = CGRect(x: left, y: centerY - 23, width: retakeWidth, height: 46)
    add.frame = CGRect(x: right - addWidth, y: centerY - 23, width: addWidth, height: 46)
    shutterRing.frame = shutter.bounds
    shutterRing.layer.cornerRadius = shutter.bounds.height / 2
    shutterFace.frame = shutter.bounds.insetBy(dx: 5, dy: 5)
    shutterFace.layer.cornerRadius = shutterFace.bounds.height / 2
    let messageHeight = min(110, status.sizeThatFits(CGSize(width: max(1, bounds.width - 64), height: 200)).height + 32)
    status.frame = CGRect(x: 24, y: bounds.midY - messageHeight / 2 - 22, width: bounds.width - 48, height: messageHeight)
    retry.frame = CGRect(x: bounds.midX - 24, y: status.frame.maxY + 12, width: 48, height: 48)
  }

  func setLibraryThumbnail(_ thumbnail: UIImage?) {
    libraryThumbnail.image = thumbnail
    libraryThumbnail.isHidden = thumbnail == nil
    library.setImage(thumbnail == nil ? UIImage(systemName: "photo.stack") : nil, for: .normal)
  }

  func prepareTransition(viewport: CGSize?) {
    transitionViewport = viewport
    setNeedsLayout()
    layoutIfNeeded()
  }

  func setExpanded(_ value: Bool) {
    expanded = value
    accessibilityIdentifier = value ? "camera-expanded" : "camera-tile-preview"
    controls.accessibilityElementsHidden = !value
    render()
  }

  func setReady(device: AVCaptureDevice?, canFlip: Bool) {
    ready = true
    busy = false
    status.text = nil
    rotationObservation = nil
    rotation = device.map { AVCaptureDevice.RotationCoordinator(device: $0, previewLayer: previewLayer) }
    rotationObservation = rotation?.observe(\.videoRotationAngleForHorizonLevelPreview, options: [.initial, .new]) { [weak self] coordinator, _ in
      // RotationCoordinator delivers preview-angle observations on the main queue.
      MainActor.assumeIsolated {
        guard let connection = self?.previewLayer.connection else { return }
        let angle = coordinator.videoRotationAngleForHorizonLevelPreview
        if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
      }
    }
    flash.isEnabled = device?.hasFlash == true || ChatCameraCapture.fixture
    flip.isEnabled = canFlip
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

  func setPhoto(_ photo: ChatAttachment?) {
    reviewing = photo != nil
    ready = false
    image.contentMode = reviewing ? .scaleAspectFit : .scaleAspectFill
    busy = false
    status.text = nil
    image.image = photo.flatMap { UIImage(contentsOfFile: $0.url.path) }
    if photo == nil && ChatCameraCapture.fixture { image.image = ChatCameraCapture.fixtureImage() }
    render()
  }

  private func updateFlash() {
    let key: String
    switch flashMode { case .auto: key = "auto"; case .on: key = "on"; default: key = "off" }
    let symbol: String
    switch flashMode { case .auto: symbol = "bolt.badge.a"; case .on: symbol = "bolt.fill"; default: symbol = "bolt.slash" }
    flash.setImage(UIImage(systemName: symbol), for: .normal)
    flash.accessibilityLabel = String(localized: "native.chat.camera.flash", bundle: .lody) + ": " + String(localized: String.LocalizationValue("native.chat.camera.flash." + key), bundle: .lody)
  }

  private func render() {
    glyph.alpha = expanded ? 0 : 1
    controls.alpha = expanded ? 1 : 0
    shutter.isHidden = reviewing
    library.isHidden = reviewing
    flip.isHidden = reviewing
    flash.isHidden = reviewing
    retake.isHidden = !reviewing
    add.isHidden = !reviewing
    status.isHidden = status.text == nil || reviewing
    retry.isHidden = status.isHidden || retry.accessibilityLabel == nil
    shutter.isEnabled = ready && !busy && !reviewing
    shutter.alpha = shutter.isEnabled ? 1 : 0.4
    collapse.isEnabled = !busy
    flip.isEnabled = flip.isEnabled && !busy
  }

  @objc private func focus(_ gesture: UITapGestureRecognizer) {
    guard expanded, ready, !reviewing, !busy else { return }
    let point = gesture.location(in: controls)
    guard preview.frame.contains(gesture.location(in: self)) else { return }
    guard ![collapse, flash, shutter, flip, library, retry, retake, add].contains(where: { !$0.isHidden && $0.frame.contains(point) }) else { return }
    onFocus?(previewLayer.captureDevicePointConverted(fromLayerPoint: gesture.location(in: preview)))
    focusRing.layer.removeAllAnimations()
    focusRing.frame = CGRect(x: point.x - 30, y: point.y - 30, width: 60, height: 60)
    focusRing.alpha = 1
    UIView.animate(withDuration: 0.3, delay: 0.6, options: [.beginFromCurrentState]) { self.focusRing.alpha = 0 }
  }
}

#endif
