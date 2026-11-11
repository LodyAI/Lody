import UIKit

/// One workspace in the switcher panel: its logo (`photo`, the `monogram` until it loads) and name.
struct LodyMenuItem: Equatable {
  var id: String = ""
  var title: String = ""
  var selected = false
  var photo: String = ""
  var monogram: String = ""
}

struct LodyMenuAvatar {
  var text: String = ""
  var color: String = ""
  var image: String = ""
}

/// The workspace capsule. Tapping it opens `WorkspaceSwitcherPanel` anchored below it: a UIMenu
/// cannot keep long workspace names on one line with a trailing fade.
@MainActor
final class LodyMenuButton: UIView {
  var selected: ((String) -> Void)?
  var sized: ((CGFloat) -> Void)?
  private let button = UIButton(type: .system)
  private var avatar = LodyMenuAvatar()
  private var photoURL: URL?
  private var photo: UIImage?
  private var accountEmail = ""
  private var label = ""
  private var labelHidden = false
  private var detail = ""
  private var items: [LodyMenuItem] = []
  private weak var panel: WorkspaceSwitcherPanel?

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    button.changesSelectionAsPrimaryAction = false
    button.addAction(UIAction { [weak self] _ in self?.presentPanel() }, for: .primaryActionTriggered)
    addSubview(button)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    apply()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    button.frame = bounds
  }

  /// The capsule's identifier is on the control VoiceOver and UI checks actually reach.
  override var accessibilityIdentifier: String? {
    get { button.accessibilityIdentifier }
    set { button.accessibilityIdentifier = newValue }
  }

  func setAccessibilityName(_ value: String) {
    button.accessibilityLabel = value
  }

  func setAvatar(_ value: LodyMenuAvatar) {
    avatar = value
    let url = LodyListPhoto.url(value.image)
    photoURL = url
    photo = url.flatMap { source in
      LodyListPhoto.image(for: source, ready: { [weak self] image in
        guard let self, self.photoURL == source else { return }
        self.photo = image
        self.apply()
      })
    }
    apply()
  }

  func setLabel(_ value: String) {
    label = value
    apply()
  }

  func setLabelHidden(_ hidden: Bool) {
    guard labelHidden != hidden else { return }
    labelHidden = hidden
    apply()
  }

  func setDetail(_ value: String) {
    detail = value
    apply()
  }

  func setAccountEmail(_ value: String) {
    let email = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard accountEmail != email else { return }
    accountEmail = email
    updateMenu()
  }

  func setItems(_ value: [LodyMenuItem]) {
    guard items != value else { return }
    items = value
    updateMenu()
  }

  private func updateMenu() {
    panel?.update(items: items, accountEmail: accountEmail)
    if items.isEmpty { panel?.dismiss(animated: true) }
  }

  private func presentPanel() {
    guard !items.isEmpty, panel == nil, var presenter = owningController() else { return }
    while let presented = presenter.presentedViewController, !presented.isBeingDismissed { presenter = presented }
    let next = WorkspaceSwitcherPanel(
      items: items, accountEmail: accountEmail, maxWidth: (window?.bounds.width ?? 375) - 32
    ) { [weak self] id in self?.selected?(id) }
    next.modalPresentationStyle = .popover
    if let popover = next.popoverPresentationController {
      popover.sourceView = button
      popover.sourceRect = button.bounds
      popover.permittedArrowDirections = [.up, .down]
      popover.delegate = next
    }
    panel = next
    presenter.present(next, animated: true)
  }

  private func owningController() -> UIViewController? {
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController { return controller }
      responder = current.next
    }
    return nil
  }

  private func apply() {
    let tint = lodyTint(avatar.color)
    LodyMenuButtonStyle.apply(
      label: label,
      detail: detail,
      avatar: LodyMenuButtonStyle.avatarImage(
        text: avatar.text,
        fill: tint ?? .lodyAccent,
        foreground: tint == nil ? LodyAccent.foregroundColor : .white,
        photo: photo
      ),
      showsLabel: !labelHidden, to: button
    )
    sized?(LodyMenuButtonStyle.unconstrainedWidth(for: button))
  }
}
