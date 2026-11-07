import Lexical
import LexicalListPlugin
import UIKit

final class ChatComposerFormatBar: UIView {
  private enum Item: String, CaseIterable {
    case heading, bold, italic, strikethrough, code, bulletList, quote

    var symbol: String {
      let symbols: [Item: String] = [
        .heading: "textformat.size", .bold: "bold", .italic: "italic", .strikethrough: "strikethrough",
        .code: "chevron.left.forwardslash.chevron.right", .bulletList: "list.bullet", .quote: "text.quote",
      ]
      return symbols[self] ?? ""
    }

    var format: TextFormatType? {
      let formats: [Item: TextFormatType] = [.bold: .bold, .italic: .italic, .strikethrough: .strikethrough, .code: .code]
      return formats[self]
    }
  }

  private weak var editor: Editor?
  private var buttons: [Item: UIButton] = [:]
  private var active: Set<Item> = []
  var onChange: (() -> Void)?

  init(editor: Editor) {
    self.editor = editor
    super.init(frame: .zero)
    let stack = UIStackView()
    stack.axis = .horizontal
    stack.spacing = 2
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
      stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
      stack.topAnchor.constraint(equalTo: topAnchor),
      stack.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
    for item in Item.allCases {
      var configuration = UIButton.Configuration.plain()
      configuration.image = UIImage(systemName: item.symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15, weight: .medium))
      configuration.background.cornerRadius = 8
      configuration.background.backgroundInsets = NSDirectionalEdgeInsets(top: 6, leading: 4, bottom: 6, trailing: 4)
      let button = UIButton(configuration: configuration, primaryAction: UIAction { [weak self] _ in self?.perform(item) })
      button.accessibilityLabel = String(localized: String.LocalizationValue("native.chat.composer.format." + item.rawValue), bundle: .lody)
      button.accessibilityIdentifier = "composer-format-\(item.rawValue)"
      button.widthAnchor.constraint(equalToConstant: 44).isActive = true
      buttons[item] = button
      stack.addArrangedSubview(button)
    }
    render()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func refresh() {
    var next: Set<Item> = []
    try? editor?.read {
      guard let selection = try getSelection() as? RangeSelection else { return }
      for item in Item.allCases {
        if let format = item.format, selection.hasFormat(type: format) { next.insert(item) }
      }
      let block = try selection.anchor.getNode().getTopLevelElement()
      if block is HeadingNode { next.insert(.heading) }
      if block is QuoteNode { next.insert(.quote) }
      if (block as? ListNode)?.getListType() == .bullet { next.insert(.bulletList) }
    }
    active = next
    render()
  }

  private func render() {
    for (item, button) in buttons {
      let on = active.contains(item)
      button.configuration?.baseForegroundColor = on ? .lodyAccent : .label
      button.configuration?.background.backgroundColor = on ? UIColor.lodyAccent.withAlphaComponent(0.15) : .clear
      button.accessibilityTraits = on ? [.button, .selected] : .button
    }
  }

  private func perform(_ item: Item) {
    guard let editor else { return }
    let on = active.contains(item)
    if let format = item.format {
      _ = editor.dispatchCommand(type: .formatText, payload: format)
    } else if item == .bulletList {
      _ = editor.dispatchCommand(type: on ? .removeList : .insertUnorderedList)
    } else {
      try? editor.update {
        guard let selection = try getSelection() as? RangeSelection else { return }
        setBlocksType(selection: selection) {
          if on { return createParagraphNode() }
          return item == .heading ? createHeadingNode(headingTag: .h1) : createQuoteNode()
        }
      }
    }
    refresh()
    onChange?()
  }
}
