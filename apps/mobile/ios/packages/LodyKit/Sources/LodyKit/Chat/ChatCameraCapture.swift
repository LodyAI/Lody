@preconcurrency import AVFoundation
import UIKit

/// The camera page owns one session. Configuration, capture and start/stop share a serial queue.
final class ChatCameraCapture: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
  let session = AVCaptureSession()
  var onPreparePreview: ((AVCaptureDevice?, @escaping @Sendable () -> Void) -> Void)?
  var onReady: ((AVCaptureDevice?, Bool) -> Void)?
  var onPhoto: ((ChatAttachment) -> Void)?
  var onError: ((String) -> Void)?
  private let queue = DispatchQueue(label: "ai.lody.mobile.attachment-camera")
  private let output = AVCapturePhotoOutput()
  private var input: AVCaptureDeviceInput?
  private var wantsActive = false
  private var generation = 0
  private var captureGeneration: Int?
  private var captureID: Int64?
  private var observers: [NSObjectProtocol] = []
  private var fixtureShots = 0
  private var fixtureEvents: [String] = []
  static var fixture: Bool { LodyUIVerify.enabled && LodyUIVerify.has("--ui-verify-camera") }

  override init() {
    super.init()
    guard !Self.fixture else { return }
    for name in [AVCaptureSession.wasInterruptedNotification, AVCaptureSession.runtimeErrorNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: session, queue: nil) { [weak self] _ in
        self?.fail("native.chat.camera.interrupted")
      })
    }
    observers.append(NotificationCenter.default.addObserver(forName: AVCaptureSession.interruptionEndedNotification, object: session, queue: nil) { [weak self] _ in
      DispatchQueue.main.async { [weak self] in
        guard let self, wantsActive else { return }
        setActive(false)
        onError?("native.chat.camera.interrupted")
      }
    })
  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
    let session = session
    queue.async { if session.isRunning { session.stopRunning() } }
  }

  // Called on main; serial queue closures preserve the ordering of foreground/visibility changes.
  func setActive(_ active: Bool) {
    guard wantsActive != active else { return }
    wantsActive = active
    queue.async { [self] in
      if Self.fixture {
        fixtureEvents.append(active ? "start" : "stop")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("lody-camera-events.json")
        if let data = try? JSONSerialization.data(withJSONObject: fixtureEvents) { try? data.write(to: url, options: .atomic) }
      }
      if !active {
        generation += 1
        captureGeneration = nil
        captureID = nil
        if session.isRunning { session.stopRunning() }
        return
      }
      if Self.fixture {
        DispatchQueue.main.async { [weak self] in self?.onReady?(nil, true) }
        return
      }
      do {
        if input == nil { try configure(position: .back) }
        prepareAndStart()
      } catch { fail("native.chat.camera.unavailable") }
    }
  }

  // Configure the main-thread preview before the serial capture queue starts
  // producing frames. A stopped/replaced activation cannot resume this start.
  private func prepareAndStart() {
    let expectedGeneration = generation
    let device = input?.device
    DispatchQueue.main.async { [weak self] in
      guard let self, self.wantsActive else { return }
      let start: @Sendable () -> Void = { [weak self] in
        guard let self else { return }
        self.queue.async { [self] in
          guard generation == expectedGeneration else { return }
          if !session.isRunning { session.startRunning() }
          guard session.isRunning else { fail("native.chat.camera.unavailable"); return }
          ready()
        }
      }
      if let prepare = self.onPreparePreview { prepare(device, start) }
      else { start() }
    }
  }

  private func configure(position: AVCaptureDevice.Position) throws {
    guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: position) else {
      throw NSError(domain: "LodyCamera", code: 1)
    }
    let next = try AVCaptureDeviceInput(device: device)
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    session.sessionPreset = .photo
    let previous = input
    if let previous { session.removeInput(previous) }
    guard session.canAddInput(next) else {
      if let previous { session.addInput(previous) }
      throw NSError(domain: "LodyCamera", code: 2)
    }
    session.addInput(next)
    input = next
    if !session.outputs.contains(output) {
      guard session.canAddOutput(output) else {
        session.removeInput(next)
        input = nil
        throw NSError(domain: "LodyCamera", code: 3)
      }
      session.addOutput(output)
    }
  }

  private func ready() {
    let device = input?.device
    let canFlip = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) != nil
      && AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) != nil
    DispatchQueue.main.async { [weak self] in self?.onReady?(device, canFlip) }
  }

  func flip() {
    queue.async { [self] in
      guard captureGeneration == nil else { return }
      if Self.fixture { DispatchQueue.main.async { [weak self] in self?.onReady?(nil, true) }; return }
      do {
        generation += 1
        if session.isRunning { session.stopRunning() }
        try configure(position: input?.device.position == .front ? .back : .front)
        prepareAndStart()
      } catch { fail("native.chat.camera.unavailable") }
    }
  }

  func focus(at point: CGPoint) {
    queue.async { [self] in
      guard let device = input?.device else { return }
      do {
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        if device.isFocusPointOfInterestSupported && device.isFocusModeSupported(.autoFocus) {
          device.focusPointOfInterest = point
          device.focusMode = .autoFocus
        }
        if device.isExposurePointOfInterestSupported && device.isExposureModeSupported(.continuousAutoExposure) {
          device.exposurePointOfInterest = point
          device.exposureMode = .continuousAutoExposure
        }
      } catch { fail("native.chat.camera.interrupted") }
    }
  }

  func capture(flash: AVCaptureDevice.FlashMode, angle: CGFloat) {
    queue.async { [self] in
      guard captureGeneration == nil else { return }
      captureGeneration = generation
      if Self.fixture {
        fixtureShots += 1
        // An explicit offline camera fixture rejects its first shutter press to exercise retry.
        if fixtureShots == 1 {
          captureGeneration = nil
          fail("native.chat.camera.saveFailed")
        } else {
          receive(Self.fixtureImage().jpegData(compressionQuality: 0.9))
        }
        return
      }
      guard session.isRunning, !session.isInterrupted, output.captureReadiness == .ready else {
        captureGeneration = nil
        fail("native.chat.camera.interrupted")
        return
      }
      let settings = AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg])
      captureID = settings.uniqueID
      if output.supportedFlashModes.contains(flash) { settings.flashMode = flash }
      if let connection = output.connection(with: .video) {
        if connection.isVideoRotationAngleSupported(angle) { connection.videoRotationAngle = angle }
        if connection.isVideoMirroringSupported {
          connection.automaticallyAdjustsVideoMirroring = false
          connection.isVideoMirrored = input?.device.position == .front
        }
      }
      output.capturePhoto(with: settings, delegate: self)
    }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
    let data = error == nil ? photo.fileDataRepresentation() : nil
    let id = photo.resolvedSettings.uniqueID
    queue.async { [self] in receive(data, id: id) }
  }

  func photoOutput(_ output: AVCapturePhotoOutput, didFinishCaptureFor resolvedSettings: AVCaptureResolvedPhotoSettings, error: Error?) {
    guard error != nil else { return }
    let id = resolvedSettings.uniqueID
    queue.async { [self] in
      guard captureID == id, captureGeneration != nil else { return }
      captureGeneration = nil
      captureID = nil
      fail("native.chat.camera.saveFailed")
    }
  }

  private func receive(_ data: Data?, id: Int64? = nil) {
    guard captureID == id, captureGeneration == generation else { return }
    captureGeneration = nil
    captureID = nil
    guard let data, let attachment = Self.store(data) else { fail("native.chat.camera.saveFailed"); return }
    DispatchQueue.main.async { [weak self] in
      guard let self, wantsActive, let onPhoto else { try? FileManager.default.removeItem(at: attachment.url); return }
      onPhoto(attachment)
    }
  }

  static func store(_ data: Data) -> ChatAttachment? {
    guard UIImage(data: data) != nil, let url = ChatAttachment.store(data, name: "Photo.jpg") else { return nil }
    return ChatAttachment(id: UUID().uuidString, name: "Photo.jpg", url: url, isImage: true)
  }

  private func fail(_ key: String) {
    DispatchQueue.main.async { [weak self] in
      guard let self, wantsActive else { return }
      onError?(key)
    }
  }

  static func fixtureImage() -> UIImage {
    UIGraphicsImageRenderer(size: CGSize(width: 720, height: 960)).image { context in
      UIColor(red: 0.89, green: 0.82, blue: 0.70, alpha: 1).setFill()
      context.fill(CGRect(x: 0, y: 0, width: 720, height: 960))
      UIColor(red: 0.34, green: 0.47, blue: 0.56, alpha: 1).setFill()
      UIBezierPath(roundedRect: CGRect(x: 110, y: 220, width: 420, height: 560), cornerRadius: 18).fill()
      UIColor.white.setFill()
      UIBezierPath(ovalIn: CGRect(x: 400, y: 540, width: 230, height: 230)).fill()
      ("Camera fixture" as NSString).draw(at: CGPoint(x: 150, y: 310), withAttributes: [
        .font: UIFont.systemFont(ofSize: 36, weight: .medium), .foregroundColor: UIColor.white,
      ])
    }
  }
}
