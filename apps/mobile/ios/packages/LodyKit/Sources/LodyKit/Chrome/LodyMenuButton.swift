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

/// The workspace capsule uses the same native button menu as conversation More.
@MainActor
final class LodyMenuButton: UIView {
  var selected: ((String) -> Void)?
  var sized: ((CGFloat) -> Void)?
  private let button = UIButton(type: .system)
  private var avatar = LodyMenuAvatar()
  private var photoURL: URL?
  private var photo: UIImage?
  private var label = ""
  private var labelHidden = false
  private var detail = ""
  private var items: [LodyMenuItem] = []

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override init(frame: CGRect) {
    super.init(frame: frame)
    button.changesSelectionAsPrimaryAction = false
    button.showsMenuAsPrimaryAction = true
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

  func setItems(_ value: [LodyMenuItem]) {
    guard items != value else { return }
    items = value
    updateMenu()
  }

  private func updateMenu() {
    button.menu = items.isEmpty ? nil : UIMenu(children: items.map { item in
      UIAction(title: item.title, image: menuImage(item), identifier: UIAction.Identifier(item.id),
               state: item.selected ? .on : .off) { [weak self] _ in
        guard let self, let current = self.items.first(where: { $0.id == item.id }), !current.selected else { return }
        self.selected?(current.id)
      }
    })
  }

  private func menuImage(_ item: LodyMenuItem) -> UIImage {
    var image = LodyListPhoto.monogram(item.monogram, side: 24)
    if let url = LodyListPhoto.url(item.photo) {
      image = LodyListPhoto.image(for: url, ready: { [weak self] _ in self?.updateMenu() }) ?? image
    }

    return UIGraphicsImageRenderer(size: CGSize(width: 24, height: 24)).image { _ in
      UIBezierPath(ovalIn: CGRect(x: 0, y: 0, width: 24, height: 24)).addClip()
      image.draw(in: CGRect(x: 0, y: 0, width: 24, height: 24))
    }.withRenderingMode(.alwaysOriginal)
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
