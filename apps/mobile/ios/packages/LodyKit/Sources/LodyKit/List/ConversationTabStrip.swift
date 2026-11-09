import UIKit
import LodyDesignSystem

/// A single conversation's exact targets. Tabs share a horizontal lane, never a tree level.
final class ConversationTabStrip: UIView, UIScrollViewDelegate {
  struct Item {
    var id: String
    var title: String
    var detail: String = ""
    var status: String = ""
    var cliType: String? = nil
    var agentType: String? = nil
    var glyph: LodyStatusGlyph.Kind = .none
    var current = false
    var enabled = true
    var opensReply = false
    var separateOpen = false
    var openEnabled = true
  }
  let scroll = UIScrollView()
  private let fade = CAGradientLayer()
  private(set) var buttons: [UIButton] = []
  private(set) var openButtons: [UIButton] = []
  private(set) var contents: [ConversationTreeRow] = []
  private var items: [Item] = []
  private var previousIDs: [String] = []
  private(set) var fadesLeading = false
  private(set) var fadesTrailing = false
  var onSelect: ((String) -> Void)?
  var onOpen: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    scroll.showsHorizontalScrollIndicator = false
    scroll.showsVerticalScrollIndicator = false
    scroll.alwaysBounceVertical = false
    scroll.isDirectionalLockEnabled = true
    scroll.delegate = self
    addSubview(scroll)
    fade.startPoint = CGPoint(x: 0, y: 0.5)
    fade.endPoint = CGPoint(x: 1, y: 0.5)
    layer.mask = fade
  }
  required init?(coder: NSCoder) { fatalError() }

  func configure(_ items: [Item]) {
    let changed = items.map(\.id) != previousIDs
    self.items = items
    previousIDs = items.map(\.id)
    for view in buttons { view.removeFromSuperview() }
    for view in openButtons { view.removeFromSuperview() }
    for view in contents { view.removeFromSuperview() }
    buttons = []; openButtons = []; contents = []
    for item in items {
      let button = UIButton(type: .system)
      button.isEnabled = item.enabled
      button.accessibilityLabel = [item.title, item.status, item.detail].filter { !$0.isEmpty }.joined(separator: ", ")
      button.accessibilityIdentifier = "session-relation-" + item.id
      button.accessibilityTraits = item.current ? [.button, .selected] : [.button]
      if item.opensReply { button.accessibilityHint = String(localized: "session.operation.fullReply", bundle: .lody) }
      button.addAction(UIAction { [weak self] _ in self?.onSelect?(item.id) }, for: .touchUpInside)
      scroll.addSubview(button)
      let content = ConversationTreeRow()
      content.titleLabel.text = item.title
      content.detailLabel.text = item.detail
      content.statusLabel.text = item.glyph == .none ? item.status : ""
      content.isCurrent = item.current
      content.setAgent(cliType: item.cliType, agentType: item.agentType)
      content.glyph.kind = item.glyph
      content.accessibilityElementsHidden = true
      scroll.addSubview(content)
      let open = UIButton(type: .system)
      open.setImage(UIImage(systemName: "arrow.up.right"), for: .normal)
      open.tintColor = .lodyInk
      open.isHidden = !item.separateOpen
      open.isEnabled = item.openEnabled
      open.accessibilityLabel = String(localized: "session.operation.open", bundle: .lody) + ", " + item.title
      open.addAction(UIAction { [weak self] _ in self?.onOpen?(item.id) }, for: .touchUpInside)
      scroll.addSubview(open)
      buttons.append(button); openButtons.append(open); contents.append(content)
    }
    if changed { scroll.contentOffset = .zero }
    setNeedsLayout()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scroll.frame = bounds
    var x: CGFloat = 0
    for index in items.indices {
      let item = items[index]
      let width = items.count == 1 ? bounds.width : max(220, min(300, bounds.width * 0.88))
      let openWidth: CGFloat = item.separateOpen ? 44 : 0
      buttons[index].frame = CGRect(x: x, y: 0, width: max(0, width - openWidth), height: bounds.height)
      contents[index].frame = buttons[index].frame
      openButtons[index].frame = CGRect(x: x + width - openWidth, y: 0, width: openWidth, height: bounds.height)
      x += width + LodySpacing.lg
    }
    scroll.contentSize = CGSize(width: max(bounds.width, x - LodySpacing.lg), height: bounds.height)
    let offset = min(max(0, scroll.contentOffset.x), max(0, scroll.contentSize.width - bounds.width))
    if offset != scroll.contentOffset.x && !scroll.isDragging { scroll.contentOffset.x = offset }
    updateFades()
  }

  func scrollViewDidScroll(_ scrollView: UIScrollView) { updateFades() }

  private func updateFades() {
    fadesLeading = scroll.contentOffset.x > 0.5
    fadesTrailing = scroll.contentOffset.x + scroll.bounds.width < scroll.contentSize.width - 0.5
    let edge = min(0.15, 16 / max(1, bounds.width))
    CATransaction.begin(); CATransaction.setDisableActions(true)
    fade.frame = bounds
    fade.locations = [0, NSNumber(value: edge), NSNumber(value: 1 - edge), 1]
    fade.colors = [fadesLeading ? UIColor.clear.cgColor : UIColor.black.cgColor, UIColor.black.cgColor, UIColor.black.cgColor, fadesTrailing ? UIColor.clear.cgColor : UIColor.black.cgColor]
    CATransaction.commit()
  }
}
