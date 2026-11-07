import Litext
import UIKit

final class ChatMarkdownCell: UICollectionViewCell {
  private var markdown: ChatMarkdownView?
  var selectionLabels: [TextLabelView] { markdown?.selectionLabels ?? [] }
  private let icon = UIImageView()
  private(set) var row: ChatRow?
  private var topInset = ChatRowPadding.content
  var onLink: ((String) -> Void)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    icon.contentMode = .center
    contentView.addSubview(icon)
    clipsToBounds = false
    contentView.clipsToBounds = false
    isAccessibilityElement = true
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(_ row: ChatRow, markdown: ChatMarkdownView, previousKind: String? = nil) {
    self.row = row
    topInset = ChatRowPadding.top(kind: row.kind, previousKind: previousKind)
    if self.markdown !== markdown {
      if self.markdown?.superview === contentView {
        self.markdown?.clearSelection()
        self.markdown?.removeFromSuperview()
      }
      self.markdown = markdown
      contentView.addSubview(markdown)
    }
    markdown.onLink = { [weak self] in self?.onLink?($0) }
    markdown.setShine(row.shines)
    icon.image = row.symbol.isEmpty ? nil : UIImage(systemName: row.symbol, withConfiguration: ChatCell.iconSymbolConfiguration(for: row))
    icon.tintColor = .secondaryLabel  // No warning orange in a conversation.
    accessibilityIdentifier = row.id
    accessibilityLabel = row.text
    accessibilityCustomActions = markdown.fileActions
    accessibilityTraits = row.actionable ? .button : .staticText
    setNeedsLayout()
  }

  func clearSelection() {
    if markdown?.superview === contentView { markdown?.clearSelection() }
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    row = nil
    topInset = ChatRowPadding.content
    markdown?.setShine(false)
    if markdown?.superview === contentView {
      markdown?.clearSelection()
      markdown?.onLink = nil
      markdown?.removeFromSuperview()
    }
    markdown = nil
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    guard let row, let markdown else { return }
    let width = contentView.bounds.width
    let inset = ChatCell.leading(row)
    let textWidth = ChatCell.textWidth(row, width: width)
    markdown.measure(width: textWidth)
    let height = markdown.measuredHeight
    markdown.frame = CGRect(x: inset, y: topInset, width: textWidth, height: height)
    icon.frame = ChatCell.iconFrame(for: row, textY: topInset, textHeight: height)
    var view: UIView? = superview
    while let current = view, !(current is UIScrollView) { view = current.superview }
    markdown.trackedScrollView = view as? UIScrollView
    clipsToBounds = false
    contentView.clipsToBounds = false
    layer.masksToBounds = false
    contentView.layer.masksToBounds = false
    ChatTableViewport.apply(to: markdown)
  }

  override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
    if super.point(inside: point, with: event) { return true }
    guard let markdown, markdown.superview === contentView else { return false }
    return markdown.point(inside: markdown.convert(point, from: self), with: event)
  }

  override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
    guard !isHidden, alpha > 0.01, isUserInteractionEnabled else { return nil }
    if let markdown, markdown.superview === contentView, let hit = markdown.hitTest(markdown.convert(point, from: self), with: event) {
      return hit
    }
    return super.hitTest(point, with: event)
  }
}

// Only adjacent rendered Markdown rows share a group. Do not silently copy past
// user bubbles, tools, or unloaded history. Table cells retain their own group.
extension LodyChatView: TextSelectionGroupDelegate {
  func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
    if !collectionView.visibleCells.contains(where: { $0 === cell }) {
      (cell as? ChatMarkdownCell)?.clearSelection()
      (cell as? ChatPlanCell)?.clearSelection()
    }
  }

  func refreshMarkdownSelections() {
    var runs: [String: [TextLabelView]] = [:]
    var previous: IndexPath?
    var key = ""
    for index in collection.indexPathsForVisibleItems.sorted() {
      guard let cell = collection.cellForItem(at: index) as? ChatMarkdownCell,
            let row = cell.row else { previous = nil; continue }
      if previous?.section != index.section || previous?.item != index.item - 1 {
        key = row.id
      }
      runs[key, default: []].append(contentsOf: cell.selectionLabels)
      previous = index
    }
    runs = runs.filter { $0.value.count > 1 }
    for (key, group) in markdownSelections where runs[key] == nil {
      group.labels = []
      markdownSelections[key] = nil
    }
    for (key, labels) in runs {
      let group = markdownSelections[key] ?? TextSelectionGroup()
      group.delegate = self
      // Assigning labels clears selection. Keep it through ordinary layouts and
      // text streaming; reset only when a row/block is replaced or leaves view.
      if !group.labels.elementsEqual(labels, by: ===) { group.labels = labels }
      markdownSelections[key] = group
    }
  }

  func textSelectionGroupDidChangeSelection(_ group: TextSelectionGroup) {
    if group.hasSelection { pauseTracking() }
  }

  func textSelectionGroup(_ group: TextSelectionGroup, didDragSelectionIn label: TextLabelView, at location: CGPoint) {
    ChatTableViewport.markdown(from: label)?.textLabelView(label, didDragSelectionAt: location)
  }
}
