import AnchoredOverlayKit
import AVFoundation
import UIKit

/// Owns transient capture resources; permissions and accepted attachments belong to the composer.
final class ChatCameraPage: UIView, OverlayPageActivity, OverlayContentSafeArea, OverlayPageChrome {
  var overlayChrome: UIView { cameraView.controls }
  var onBack: (() -> Void)?
  var onRequestAccess: (() -> Void)?
  var onPick: ((ChatAttachment) -> Void)?
  private let camera = ChatCameraCapture()
  private lazy var cameraView = ChatAttachmentOverlayCameraView(session: camera.session)
  private var active = false
  private var handingOff = false
  private var verificationFrames: [[String: CGFloat]] = []
  var overlayExtendsToEdges: Bool { true }

  init() {
    super.init(frame: .zero)
    addSubview(cameraView)
    cameraView.setExpanded(true)
    cameraView.onCollapse = { [weak self] in self?.onBack?() }
    cameraView.onShutter = { [weak self] flash, angle in self?.camera.capture(flash: flash, angle: angle) }
    cameraView.onFlip = { [weak self] in self?.camera.flip() }
    cameraView.onFocus = { [weak self] point in self?.camera.focus(at: point) }
    cameraView.onRetry = { [weak self] in
      guard let self, active else { return }
      if !ChatCameraCapture.fixture && AVCaptureDevice.authorizationStatus(for: .video) != .authorized {
        onRequestAccess?()
      } else {
        camera.setActive(false)
        updateSession()
      }
    }
    camera.onPreparePreview = { [weak self] device, completion in
      guard let self, active, !handingOff else { return }
      cameraView.preparePreview(device: device)
      completion()
    }
    camera.onReady = { [weak self] device, canFlip in
      guard let self, active, !handingOff else { return }
      cameraView.setReady(device: device, canFlip: canFlip)
    }
    camera.onError = { [weak self] key in
      guard let self, active, !handingOff else { return }
      cameraView.showError(key)
    }
    camera.onPhoto = { [weak self] photo in
      guard let self, active, !handingOff else {
        try? FileManager.default.removeItem(at: photo.url)
        return
      }
      handingOff = true
      camera.setActive(false)
      guard let onPick else {
        try? FileManager.default.removeItem(at: photo.url)
        return
      }
      // The closing panel scales its content while the photo fades in over it;
      // controls would visibly shrink with the viewfinder.
      cameraView.controls.isHidden = true
      onPick(photo)
    }
    NotificationCenter.default.addObserver(self, selector: #selector(suspend), name: UIApplication.willResignActiveNotification, object: nil)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  deinit {
    NotificationCenter.default.removeObserver(self)
  }
  override func layoutSubviews() { super.layoutSubviews(); cameraView.frame = bounds }
  func overlaySafeAreaInsetsDidChange(_ insets: UIEdgeInsets) {
    if active, ChatCameraCapture.fixture, verificationFrames.count < 240, bounds.width > 0, bounds.height > 0 {
      verificationFrames.append(["width": bounds.width, "height": bounds.height,
        "visibleHeight": overlayChrome.bounds.height])
    }
    if cameraView.controlInsets != insets {
      cameraView.controlInsets = insets
      cameraView.setNeedsLayout()
    }
  }
  func overlayPageActivityDidChange(isActive: Bool) {
    active = isActive
    if isActive { updateSession() }
    else {
      camera.setActive(false)
      if ChatCameraCapture.fixture {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("lody-camera-layout.json")
        if let data = try? JSONSerialization.data(withJSONObject: verificationFrames) {
          try? data.write(to: url, options: .atomic)
        }
        verificationFrames.removeAll()
      }
    }
  }
  @objc private func suspend() { camera.setActive(false) }
  private func updateSession() {
    guard active, !handingOff else { return }
    if ChatCameraCapture.fixture || AVCaptureDevice.authorizationStatus(for: .video) == .authorized {
      camera.setActive(true)
    } else {
      let status = AVCaptureDevice.authorizationStatus(for: .video)
      if status == .restricted {
        cameraView.showError("native.chat.camera.restricted", action: nil)
      } else {
        cameraView.showError("native.chat.camera.denied", action: "native.chat.attachment.openSettings")
      }
    }
  }
}
