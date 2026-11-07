import UIKit

/// Offline experiment only: the actual chat composer travels between controllers.
final class LodyComposerHandoffPOC: UIView {
  var onClose: ([String: Any]) -> Void = { _ in }
  private var navigation: UINavigationController?

  override func didMoveToWindow() {
    super.didMoveToWindow()
    guard window != nil, navigation == nil, let owner = owningViewController else { return }
    let page = ComposerHandoffPOCController()
    let navigation = UINavigationController(rootViewController: page)
    navigation.modalPresentationStyle = .fullScreen
    page.onClose = { [weak self, weak navigation] in
      navigation?.dismiss(animated: true) { self?.onClose([:]) }
    }
    self.navigation = navigation
    owner.present(navigation, animated: false)
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    if superview == nil { navigation?.dismiss(animated: false) }
  }
}

private final class ComposerHandoffPOCController: UIViewController {
  var onClose: (() -> Void)?
  private let slow = UISwitch()
  private var chat: LodyChatView?
  private var sheet: UINavigationController?
  private var composerConstraints: [NSLayoutConstraint] = []
  private var sheetConstraints: [NSLayoutConstraint] = []
  private var moving = false
  private var arrived = false
  private let status = UILabel()

  init() {
    super.init(nibName: nil, bundle: nil)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "Composer Relay POC"
    view.backgroundColor = .systemGroupedBackground
    navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.onClose?() })
    let description = UILabel()
    description.text = "One composer. Change pages, then send.\nOffline preview only."
    description.numberOfLines = 0
    description.font = .preferredFont(forTextStyle: .body)
    let delayLabel = UILabel()
    delayLabel.text = "Prepare for 1.2 seconds"
    slow.accessibilityIdentifier = "composer-relay-delay"
    slow.accessibilityLabel = delayLabel.text
    let delay = UIStackView(arrangedSubviews: [delayLabel, slow])
    delay.distribution = .equalSpacing
    let open = UIButton(configuration: .filled())
    open.setTitle("New conversation", for: .normal)
    open.accessibilityIdentifier = "composer-relay-open"
    open.addAction(UIAction { [weak self] _ in self?.openSheet() }, for: .touchUpInside)
    open.heightAnchor.constraint(greaterThanOrEqualToConstant: 44).isActive = true
    let stack = UIStackView(arrangedSubviews: [description, delay, open])
    stack.axis = .vertical
    stack.spacing = 28
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(stack)
    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 32),
      stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
    ])
  }

  private func openSheet() {
    let chat = LodyChatView(frame: .zero)
    self.chat = chat
    arrived = false
    moving = false
    chat.setComposerState(#"{"editable":true,"canSend":true,"sending":false,"notice":"","reconnect":false,"placeholder":"Message..."}"#)
    chat.composer.setInitialDraft("Same composer, next page, then send.")
    let nativeSend = chat.composer.onSend
    chat.composer.onSend = { [weak chat] payload in
      nativeSend?(payload)
      var pending = payload
      pending["status"] = "Offline POC"
      pending["phase"] = "accepted"
      if let data = try? JSONSerialization.data(withJSONObject: pending), let json = String(data: data, encoding: .utf8) {
        chat?.setPendingSendJSON(json)
      }
    }
    chat.composer.previewBeforeSubmit = { [weak self] in
      guard let self, !self.arrived else { return false }
      if !self.moving {
        self.moving = true
        self.status.text = "Preparing conversation. Composer stays here."
        DispatchQueue.main.asyncAfter(deadline: .now() + (self.slow.isOn ? 1.2 : 0)) { [weak self] in self?.transfer() }
      }
      return true
    }
    let source = UIViewController()
    source.title = "New conversation"
    source.view.backgroundColor = .systemGroupedBackground
    source.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in
      self?.moving = false
      self?.sheet?.dismiss(animated: true)
      self?.sheet = nil
    })
    status.text = "Lody iOS  /  This Mac\nSend and watch the composer and keyboard."
    status.numberOfLines = 0
    status.textColor = .secondaryLabel
    status.font = .preferredFont(forTextStyle: .subheadline)
    status.translatesAutoresizingMaskIntoConstraints = false
    source.view.addSubview(status)
    NSLayoutConstraint.activate([
      status.topAnchor.constraint(equalTo: source.view.safeAreaLayoutGuide.topAnchor, constant: 24),
      status.leadingAnchor.constraint(equalTo: source.view.leadingAnchor, constant: 24),
      status.trailingAnchor.constraint(equalTo: source.view.trailingAnchor, constant: -24),
    ])
    let composer = chat.composer
    composerConstraints = chat.constraints.filter { ($0.firstItem as? UIView) === composer || ($0.secondItem as? UIView) === composer }
    NSLayoutConstraint.deactivate(composerConstraints)
    source.view.addSubview(composer)
    sheetConstraints = [
      composer.leadingAnchor.constraint(equalTo: source.view.leadingAnchor),
      composer.trailingAnchor.constraint(equalTo: source.view.trailingAnchor),
      composer.bottomAnchor.constraint(equalTo: source.view.keyboardLayoutGuide.topAnchor),
    ]
    NSLayoutConstraint.activate(sheetConstraints)
    let sheet = UINavigationController(rootViewController: source)
    sheet.modalPresentationStyle = .pageSheet
    sheet.sheetPresentationController?.detents = [.large()]
    sheet.sheetPresentationController?.prefersGrabberVisible = true
    sheet.isModalInPresentation = true
    self.sheet = sheet
    present(sheet, animated: true) {
      self.input(in: composer)?.becomeFirstResponder()
    }
  }

  private func input(in view: UIView) -> UITextView? {
    if let input = view as? UITextView { return input }
    return view.subviews.lazy.compactMap { self.input(in: $0) }.first
  }

  private func transfer() {
    guard moving, let sheet, let chat, let window = view.window else { return }
    let composer = chat.composer
    let input = input(in: composer)
    let focused = input?.isFirstResponder == true
    let selection = input?.selectedRange
    let frame = composer.convert(composer.bounds, to: window)
    // Keep the source appearance while temporarily outside its controller hierarchy.
    let appearance = composer.traitCollection.userInterfaceStyle
    composer.overrideUserInterfaceStyle = appearance
    NSLayoutConstraint.deactivate(sheetConstraints)
    composer.translatesAutoresizingMaskIntoConstraints = true
    window.addSubview(composer)
    composer.frame = frame
    let destination = UIViewController()
    destination.title = "New conversation"
    destination.view.backgroundColor = .lodyBackground
    chat.translatesAutoresizingMaskIntoConstraints = false
    destination.view.addSubview(chat)
    NSLayoutConstraint.activate([
      chat.topAnchor.constraint(equalTo: destination.view.topAnchor),
      chat.leadingAnchor.constraint(equalTo: destination.view.leadingAnchor),
      chat.trailingAnchor.constraint(equalTo: destination.view.trailingAnchor),
      chat.bottomAnchor.constraint(equalTo: destination.view.bottomAnchor),
    ])
    destination.navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Try again", primaryAction: UIAction { [weak self] _ in
      self?.navigationController?.popViewController(animated: true)
    })
    navigationController?.pushViewController(destination, animated: false)
    destination.view.layoutIfNeeded()
    sheet.dismiss(animated: true) { [weak self, weak input] in
      guard let self else { return }
      UIView.performWithoutAnimation {
        chat.addSubview(composer)
        composer.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate(self.composerConstraints)
        chat.setNeedsLayout()
        chat.layoutIfNeeded()
      }
      input?.becomeFirstResponder()
      if let selection { input?.selectedRange = selection }
      if LodyUIVerify.enabled {
        let adopted = composer.convert(composer.bounds, to: window)
        let report: [String: Any] = [
          "sameComposer": chat.composer === composer,
          "focusedBefore": focused, "focusedAfter": input?.isFirstResponder == true,
          "appearanceBefore": appearance.rawValue, "appearanceAfter": chat.traitCollection.userInterfaceStyle.rawValue,
          "source": [frame.minX, frame.minY, frame.width, frame.height],
          "adopted": [adopted.minX, adopted.minY, adopted.width, adopted.height],
        ]
        if let data = try? JSONSerialization.data(withJSONObject: report) {
          try? data.write(to: FileManager.default.temporaryDirectory.appendingPathComponent("lody-composer-relay.json"))
        }
      }
      self.arrived = true
      self.sheet = nil
      // Only after the same composer is adopted does its normal send path run.
      composer.perform(NSSelectorFromString("submit"))
    }
  }
}
