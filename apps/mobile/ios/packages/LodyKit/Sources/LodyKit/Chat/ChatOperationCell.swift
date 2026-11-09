import UIKit

/// A compact operation receipt. Status belongs to its target Turn, not later session activity.
final class ChatOperationCell: UICollectionViewCell {
  let conversation = ConversationTreeRow()
  let tabStrip = ConversationTabStrip()
  var titleLabel: UILabel { conversation.titleLabel }
  var detailLabel: UILabel { conversation.detailLabel }
  var statusLabel: UILabel { conversation.statusLabel }
  let openButton = UIButton(type: .system)
  let bodyButton = UIButton(type: .system)
  private var row: ChatRow?
  var onOpen: (() -> Void)?
  var onReply: (() -> Void)?
  var onToggle: (() -> Void)?
  var onPeerOpen: ((ChatOperationPeer) -> Void)?
  var onPeerReply: ((ChatOperationPeer) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    contentView.backgroundColor = .clear
    for view in [bodyButton, conversation, openButton, tabStrip] { contentView.addSubview(view) }
    openButton.tintColor = .lodyInk
    openButton.setImage(UIImage(systemName: "arrow.up.right"), for: .normal)
    openButton.accessibilityLabel = String(localized: "session.operation.open", bundle: .lody)
    openButton.addAction(UIAction { [weak self] _ in self?.onOpen?() }, for: .touchUpInside)
    bodyButton.addAction(UIAction { [weak self] _ in
      guard let self, let row else { return }
      if row.kind == "operationHeader" { onToggle?() }
      else if row.operation?.kind == "reply", row.operation?.reply?.isEmpty == false { onReply?() }
      else { onOpen?() }
    }, for: .touchUpInside)
    registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (cell: ChatOperationCell, _) in
      if let row = cell.row { cell.configure(row) }
    }
  }
  required init?(coder: NSCoder) { fatalError() }

  override func prepareForReuse() {
    super.prepareForReuse()
    row = nil; onOpen = nil; onReply = nil; onToggle = nil
    conversation.glyph.kind = .none
    conversation.isCurrent = false
    conversation.selectionBackground.isHidden = true
    conversation.agentView.image = nil
    tabStrip.configure([]); tabStrip.onSelect = nil; tabStrip.onOpen = nil
    onPeerOpen = nil; onPeerReply = nil
  }

  func configure(_ row: ChatRow) {
    self.row = row
    conversation.isCurrent = row.operationCurrent
    bodyButton.accessibilityTraits = row.operationCurrent ? [.button, .selected] : [.button]
    conversation.showsAgent = row.operation != nil
    conversation.depth = row.treeChild ? 1 : 0
    conversation.continues = row.treeChild && !row.treeLast
    conversation.setAgent(cliType: row.operationCLIType, agentType: row.operationAgentType)
    switch row.operation?.status {
    case "running", "active", "pending": conversation.glyph.kind = .live
    case "failed": conversation.glyph.kind = .failed
    case "succeeded": conversation.glyph.kind = .done
    default: conversation.glyph.kind = .none
    }
    titleLabel.text = row.text
    detailLabel.text = row.detail
    statusLabel.text = conversation.glyph.kind == .none ? row.operation?.statusLabel : nil
    openButton.isHidden = row.operation == nil
    openButton.isEnabled = row.actionable
    let hasReply = row.operation?.kind == "reply" && row.operation?.reply?.isEmpty == false
    bodyButton.isEnabled = row.actionable || hasReply
    if row.kind == "operationHeader", row.actionable {
      titleLabel.text = (row.disclosed ? "⌄ " : "› ") + row.text
    }
    bodyButton.accessibilityLabel = [row.text, row.operation?.statusLabel ?? "", row.detail].filter { !$0.isEmpty }.joined(separator: ", ")
    bodyButton.accessibilityHint = hasReply ? String(localized: "session.operation.fullReply", bundle: .lody) : nil
    bodyButton.accessibilityValue = nil
    if row.kind == "operationHeader", row.actionable {
      let state = row.disclosed ? "native.list.expanded" : "native.list.collapsed"
      bodyButton.accessibilityValue = String(localized: String.LocalizationValue(state), bundle: .lody)
    }
    bodyButton.isAccessibilityElement = bodyButton.isEnabled
    titleLabel.isAccessibilityElement = !bodyButton.isEnabled
    detailLabel.isAccessibilityElement = !bodyButton.isEnabled
    statusLabel.isAccessibilityElement = !bodyButton.isEnabled
    tabStrip.isHidden = row.operationPeers.isEmpty
    if !row.operationPeers.isEmpty {
      titleLabel.isHidden = true; detailLabel.isHidden = true; statusLabel.isHidden = true
      conversation.showsAgent = false; conversation.glyph.kind = .none
      conversation.isCurrent = false
      bodyButton.isHidden = true; openButton.isHidden = true
      tabStrip.configure(row.operationPeers.enumerated().map { index, peer in
        let card = peer.card
        var item = ConversationTabStrip.Item(id: String(index), title: peer.text, detail: peer.detail, status: card.statusLabel,
          cliType: peer.cliType, agentType: peer.agentType, current: peer.current)
        item.opensReply = card.kind == "reply" && card.reply?.isEmpty == false
        item.enabled = peer.actionable || item.opensReply
        item.separateOpen = true
        item.openEnabled = peer.actionable
        switch card.status {
        case "running", "active", "pending": item.glyph = .live
        case "failed": item.glyph = .failed
        case "succeeded": item.glyph = .done
        default: break
        }
        return item
      })
      tabStrip.onSelect = { [weak self] id in
        guard let index = Int(id), let peers = self?.row?.operationPeers, peers.indices.contains(index) else { return }
        let peer = peers[index]
        if peer.card.kind == "reply", peer.card.reply?.isEmpty == false { self?.onPeerReply?(peer) }
        else if peer.actionable { self?.onPeerOpen?(peer) }
      }
      tabStrip.onOpen = { [weak self] id in
        guard let index = Int(id), let peers = self?.row?.operationPeers, peers.indices.contains(index), peers[index].actionable else { return }
        let peer = peers[index]
        self?.onPeerOpen?(peer)
      }
    } else {
      titleLabel.isHidden = false; detailLabel.isHidden = false; statusLabel.isHidden = false
      bodyButton.isHidden = false
      tabStrip.configure([])
    }
    conversation.setNeedsLayout()
    setNeedsLayout()
  }

  static func height(_ row: ChatRow, traits: UITraitCollection) -> CGFloat {
    ConversationTreeRow.height(detail: !row.detail.isEmpty || row.operationPeers.contains { !$0.detail.isEmpty }, traits: traits)
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let row else { return }
    let width = contentView.bounds.width
    let end: CGFloat = row.operation == nil ? 0 : 44
    conversation.frame = CGRect(x: 0, y: 0, width: max(0, width - end), height: bounds.height)
    let indent: CGFloat = row.treeChild ? 24 : 0
    tabStrip.frame = CGRect(x: indent, y: 0, width: max(0, width - indent), height: bounds.height)
    bodyButton.frame = CGRect(x: 0, y: 0, width: width - (row.operation == nil ? 0 : 44), height: bounds.height)
    openButton.frame = CGRect(x: width - 44, y: 0, width: 44, height: max(44, bounds.height))
  }
}
