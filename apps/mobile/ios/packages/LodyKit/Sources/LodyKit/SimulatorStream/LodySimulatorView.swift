import UIKit

/// Full-screen host borrows the chat-owned renderer, including its live decoder.
final class LodySimulatorView: UIView {
  private var stream: SimulatorStreamView?
  private var lastCommand = 0

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    NotificationCenter.default.addObserver(self, selector: #selector(willPush(_:)),
      name: Notification.Name("LodyWillPush"), object: nil)
  }

  isolated deinit { NotificationCenter.default.removeObserver(self) }

  @objc private func willPush(_ notification: Notification) {
    guard let controller = notification.object as? UIViewController,
          isDescendant(of: controller.view) else { return }
    adoptZoomTransition(on: controller)
  }

  func setSource(_ json: String) {
    let next = SimulatorStreamView.shared(json)
    guard next !== stream else { return }
    returnToPreview()
    stream = next
    if window != nil { attach() }
  }

  func setCommand(_ json: String) {
    struct Command: Decodable { let token: Int; let action: String }
    guard let command = try? JSONDecoder().decode(Command.self, from: Data(json.utf8)),
          command.token > lastCommand else { return }
    lastCommand = command.token
    stream?.perform(command.action)
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    adoptZoomTransition()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      returnToPreview()
    } else {
      adoptZoomTransition()
      attach()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if stream?.superview === self { stream?.frame = bounds }
  }

  func adoptZoomTransition(on destination: UIViewController? = nil) {
    guard let controller = destination ?? (sequence(first: self as UIResponder, next: { $0.next })
      .first(where: { $0 is UIViewController }) as? UIViewController),
      controller.preferredTransition == nil else { return }
    let options = UIViewController.Transition.ZoomOptions()
    options.interactiveDismissShouldBegin = { [weak self, weak controller] context in
      guard context.willBegin else { return false }
      guard let self, let controller, let stream = self.stream,
            stream.superview === self else { return true }
      // Swipes on the remote device belong to its touch stream, not the
      // enclosing controller's interactive zoom return.
      let deviceFrame = stream.convert(stream.displayFrame, to: controller.view)
      return !deviceFrame.contains(context.location)
    }
    options.alignmentRectProvider = { [weak self] context in
      guard let stream = self?.stream, stream.superview === self else { return nil }
      return stream.convert(stream.displayFrame, to: context.zoomedViewController.view)
    }
    controller.preferredTransition = .zoom(options: options) { [weak self] _ in
      guard let stream = self?.stream else { return nil }
      return stream.preview?.zoomSource(fitting: stream.displayFrame.size)
    }
  }

  private func attach() {
    guard let stream else { return }
    stream.fullscreen = self
    stream.compact = false
    addSubview(stream)
    stream.frame = bounds
    stream.preview?.isHidden = true
  }

  func returnToPreview() {
    guard let stream, stream.fullscreen === self else { return }
    stream.fullscreen = nil
    stream.preview?.attach(returning: window == nil)
  }
}
