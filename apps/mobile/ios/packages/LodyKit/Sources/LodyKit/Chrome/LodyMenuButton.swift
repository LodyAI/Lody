import UIKit

struct LodyMenuItem: Equatable {
  var id: String = ""
  var title: String = ""
  var symbol: String = ""
  var selected: Bool?
  var subtitle: String = ""
  var disabled: Bool = false
  var children: [LodyMenuItem] = []
  /// A remote avatar (workspace logo) drawn as the item's image; `monogram` until it loads.
  var photo: String = ""
  var monogram: String = ""
}

struct LodyMenuAvatar {
  var text: String = ""
  var color: String = ""
  var image: String = ""
}

final class LodyMenuButton: UIView {
  var onSelect: ([String: Any]) -> Void = { _ in }
  var onSize: ([String: Any]) -> Void = { _ in }
  var selected: ((String) -> Void)?
  var sized: ((CGFloat) -> Void)?
  private let button = UIButton(type: .system)
  private var avatar = LodyMenuAvatar()
  private var photoURL: URL?
  private var photo: UIImage?
  private var label = ""
  private var labelHidden = false
  private var detail = ""

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

  private var items: [LodyMenuItem] = []
  private var loadingPhotos = Set<URL>()

  /// The item's avatar: a cached photo, else its monogram while the photo loads (the menu is
  /// rebuilt once it arrives), else its SF Symbol.
  private func image(_ item: LodyMenuItem) -> UIImage? {
    let side: CGFloat = 24
    if let url = LodyListPhoto.url(item.photo) {
      if let photo = LodyListPhoto.cached(url) {
        return UIGraphicsImageRenderer(size: CGSize(width: side, height: side)).image { _ in
          photo.draw(in: CGRect(x: 0, y: 0, width: side, height: side))
        }.withRenderingMode(.alwaysOriginal)
      }
      if loadingPhotos.insert(url).inserted {
        LodyListPhoto.load(url) { [weak self] loaded in
          guard let self else { return }
          self.loadingPhotos.remove(url)
          if loaded != nil, self.itemsContainPhoto(url) { self.rebuildMenu() }
        }
      }
    }
    if !item.monogram.isEmpty { return LodyListPhoto.monogram(item.monogram, side: side).withRenderingMode(.alwaysOriginal) }
    return item.symbol.isEmpty ? nil : UIImage(systemName: item.symbol)
  }

  func setItems(_ value: [LodyMenuItem]) {
    guard items != value else { return }
    items = value
    rebuildMenu()
  }

  private func itemsContainPhoto(_ url: URL) -> Bool {
    func contains(_ item: LodyMenuItem) -> Bool {
      LodyListPhoto.url(item.photo) == url || item.children.contains(where: contains)
    }
    return items.contains(where: contains)
  }

  private func rebuildMenu() {
    let value = items
    func action(_ item: LodyMenuItem, state: UIMenuElement.State = .off) -> UIAction {
      let result = UIAction(
        title: item.title,
        image: image(item),
        attributes: item.disabled ? .disabled : [],
        state: state
      ) { [weak self] _ in
        self?.onSelect(["id": item.id])
        self?.selected?(item.id)
      }
      result.subtitle = item.subtitle.isEmpty ? nil : item.subtitle
      return result
    }

    func element(_ item: LodyMenuItem) -> UIMenuElement {
      if item.children.isEmpty { return action(item) }
      return UIMenu(title: item.title, subtitle: item.subtitle.isEmpty ? nil : item.subtitle,
        image: item.symbol.isEmpty ? nil : UIImage(systemName: item.symbol), children: item.children.map(element))
    }

    let choices = value.compactMap { item -> UIAction? in
      guard let selected = item.selected else { return nil }
      return action(item, state: selected ? .on : .off)
    }
    var children: [UIMenuElement] = []
    if !choices.isEmpty {
      children.append(UIMenu(options: [.displayInline, .singleSelection], children: choices))
    }
    let actions = value.compactMap { item in
      item.selected == nil ? element(item) : nil
    }
    if !actions.isEmpty {
      children.append(UIMenu(options: .displayInline, children: actions))
    }
    button.menu = UIMenu(children: children)
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
    let width = LodyMenuButtonStyle.unconstrainedWidth(for: button)
    onSize(["width": width])
    sized?(width)
  }
}
