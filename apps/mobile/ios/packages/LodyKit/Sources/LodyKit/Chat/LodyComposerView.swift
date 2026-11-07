import UIKit

/// Standalone host for the same input used by LodyChatView, including sheet keyboard clearance.
final class LodyComposerView: UIView {
  var onSend: ([String: Any]) -> Void = { _ in }
  var onRelayReady: ([String: Any]) -> Void = { _ in }
  var onHeightChange: ([String: Any]) -> Void = { _ in }
  var onComposerOptionChange: ([String: Any]) -> Void = { _ in }
  var onMentionBrowse: ([String: Any]) -> Void = { _ in }
  let composer = ChatComposerView(frame: .zero)
  var composerRelay = false
  var forwarded: ((String, [String: Any]) -> Void)?
  private var relayConstraints: [NSLayoutConstraint] = []
  private var relayFrame: CGRect = .zero
  private var relayAppearance: UIUserInterfaceStyle = .unspecified
  private(set) var relayPayload: [String: Any]?
  private(set) static var relays: [String: LodyComposerView] = [:]
  private weak var relayTarget: LodyChatView?
  private var contentHeight: CGFloat = 64
  private var reportedHeight: CGFloat = 0
  var scrollEdge = false { didSet { setNeedsLayout() } }
  private var keyboardFrame: CGRect = .null

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    reportHeight()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    reportHeight()
    attachScrollEdge()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil, relayPayload != nil {
      DispatchQueue.main.async { [weak self] in self?.relayTarget?.adoptComposerIfNeeded() }
    }
    guard composer.superview === self else { return }
    if window == nil { composer.attachScrollEdge(to: nil) }
    else { setNeedsLayout() }
  }

  private func attachScrollEdge() {
    guard composer.superview === self else { return }
    guard scrollEdge, window != nil else {
      composer.attachScrollEdge(to: nil)
      return
    }
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController,
         let scrollView = controller.contentScrollView(for: .bottom) {
        composer.attachScrollEdge(to: scrollView)
        return
      }
      responder = current.next
    }
    composer.attachScrollEdge(to: nil)
  }

  @objc private func scrollOwnerChanged(_ notification: Notification) {
    var responder: UIResponder? = next
    while let current = responder {
      if current === notification.object as? UIViewController {
        setNeedsLayout()
        return
      }
      responder = current.next
    }
  }

  private func reportHeight() {
    // Keyboard frames use screen coordinates; the sheet host uses local coordinates.
    // Measure the host's actual overlap so sheet detents and its inner header cannot
    // leave the send row under the prediction bar.
    let keyboard = window.map { convert($0.convert(keyboardFrame, from: nil), from: $0) } ?? .null
    let overlap = keyboard.intersects(bounds) ? max(0, bounds.maxY - keyboard.minY) : 0
    let height = contentHeight + (overlap > 0 ? overlap : max(16, safeAreaInsets.bottom))
    guard height != reportedHeight else { return }
    reportedHeight = height
    onHeightChange(["height": height])
  }

  @objc private func keyboardChanged(_ notification: Notification) {
    keyboardFrame = notification.name == UIResponder.keyboardWillHideNotification
      ? .null
      : (notification.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? CGRect ?? .null)
    reportHeight()
  }

  deinit { NotificationCenter.default.removeObserver(self) }

  private func prepare(_ payload: [String: Any]) -> Bool {
    guard composerRelay, window != nil, let id = payload["id"] as? String else { return false }
    relayPayload = payload
    Self.relays[id] = self
    composer.relaying = true
    onSend(payload)
    forwarded?("send", payload)
    return true
  }

  func prepareDestination(_ target: LodyChatView) {
    guard relayTarget == nil, let window else { return }
    relayTarget = target
    // The keyboard expanded this sheet. Keep that detent while its responder
    // changes host, rather than letting UIKit collapse it before dismissal.
    var owner = owningViewController
    while let controller = owner {
      if controller.presentingViewController != nil, let sheet = controller.sheetPresentationController,
         (sheet.presentedView?.frame.height ?? 0) > window.bounds.height * 0.85 {
        sheet.selectedDetentIdentifier = sheet.detents.last?.identifier
        break
      }
      owner = controller.parent
    }
    relayFrame = composer.convert(composer.bounds, to: window)
    relayAppearance = composer.overrideUserInterfaceStyle
    composer.overrideUserInterfaceStyle = composer.traitCollection.userInterfaceStyle
    relayConstraints = constraints.filter { ($0.firstItem as? UIView) === composer || ($0.secondItem as? UIView) === composer }
    NSLayoutConstraint.deactivate(relayConstraints)
    composer.translatesAutoresizingMaskIntoConstraints = true
    window.addSubview(composer)
    composer.frame = relayFrame
    onRelayReady([:])
    forwarded?("relayReady", [:])
  }

  func restoreDraft(token: Int) {
    if let id = relayPayload?["id"] as? String {
      Self.relays[id] = nil
      relayPayload = nil
      relayTarget?.setRelayContentHidden(false)
      relayTarget = nil
      addSubview(composer)
      composer.translatesAutoresizingMaskIntoConstraints = false
      NSLayoutConstraint.activate(relayConstraints)
      composer.overrideUserInterfaceStyle = relayAppearance
      composer.relaying = false
      layoutIfNeeded()
    }
    composer.restoreDraft(token: token)
  }

  func completeRelay() {
    if let id = relayPayload?["id"] as? String { Self.relays[id] = nil }
    relayPayload = nil
    relayTarget?.setRelayContentHidden(false)
    relayTarget = nil
    composer.prepareSend = nil
    composer.onHeightChange = nil
    composer.overrideUserInterfaceStyle = relayAppearance
  }

  static func cancelRelay(_ id: String) {
    guard let source = relays[id] else { return }
    if source.window != nil {
      source.restoreDraft(token: 0)
    } else {
      // The durable outbox owns the submitted draft after its source page closes.
      source.completeRelay()
      source.composer.relaying = false
      source.composer.removeFromSuperview()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    NotificationCenter.default.addObserver(self, selector: #selector(scrollOwnerChanged), name: LodyScrollEdges.ownerChanged, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
    NotificationCenter.default.addObserver(self, selector: #selector(keyboardChanged), name: UIResponder.keyboardWillHideNotification, object: nil)
    composer.setInputIdentifier("create-session-input")
    composer.onSend = { [weak self] in
      self?.onSend($0)
      self?.forwarded?("send", $0)
    }
    composer.prepareSend = { [weak self] in self?.prepare($0) ?? false }
    composer.onHeightChange = { [weak self] height in
      self?.contentHeight = height
      self?.reportHeight()
      self?.forwarded?("contentHeight", ["height": height])
    }
    composer.onMentionBrowse = { [weak self] in
      self?.onMentionBrowse($0)
      self?.forwarded?("mentionBrowse", $0)
    }
    composer.onComposerOptionChange = { [weak self] in
      self?.onComposerOptionChange($0)
      self?.forwarded?("optionChange", $0)
    }
    addSubview(composer)
    composer.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      composer.topAnchor.constraint(equalTo: topAnchor),
      composer.leadingAnchor.constraint(equalTo: leadingAnchor),
      composer.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])
  }
}
