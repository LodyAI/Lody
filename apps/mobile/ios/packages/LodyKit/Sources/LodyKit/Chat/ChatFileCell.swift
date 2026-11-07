import UIKit

final class ChatFileCell: UICollectionViewListCell {
  static let headerHeight: CGFloat = 44

  private let chrome = UIView()
  private let separator = UIView()

  override init(frame: CGRect) {
    super.init(frame: frame)
    automaticallyUpdatesBackgroundConfiguration = false
    backgroundConfiguration = .clear()
    chrome.isUserInteractionEnabled = false
    chrome.layer.cornerCurve = .continuous
    chrome.layer.masksToBounds = true
    insertSubview(chrome, belowSubview: contentView)
    separator.backgroundColor = .lodyLine
    chrome.addSubview(separator)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func apply(group: String, selected: Bool) {
    backgroundConfiguration = .clear()
    chrome.backgroundColor = selected ? .lodyInsetSelected : .lodyInset
    chrome.layer.cornerRadius = group == "middle" ? 0 : 12
    switch group {
    case "first":
      chrome.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
    case "last":
      chrome.layer.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
    case "middle":
      chrome.layer.maskedCorners = []
    default:
      chrome.layer.maskedCorners = [
        .layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner,
      ]
    }
    separator.isHidden = group == "last" || group == "only" || group.isEmpty
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    chrome.frame = bounds
    separator.frame = CGRect(
      x: 14,
      y: bounds.height - 0.5,
      width: max(0, bounds.width - 28),
      height: 0.5
    )
  }

  static func title(for path: String) -> NSAttributedString {
    NSAttributedString(string: path.replacingOccurrences(of: "\\", with: "/"), attributes: [
      .font: LodyDesign.mono(12.5),
      .foregroundColor: UIColor.lodyInk,
    ])
  }

  static func headerContent(for text: String) -> UIListContentConfiguration {
    var content = UIListContentConfiguration.cell()
    content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
    content.text = text
    content.textProperties.font = LodyDesign.font(.subheadline, size: 14.5, weight: .semibold)
    content.textProperties.color = .lodyInk
    content.textProperties.numberOfLines = 1
    content.textProperties.lineBreakMode = .byTruncatingTail
    return content
  }

  static func rowContent(for path: String = "Filename") -> UIListContentConfiguration {
    var content = UIListContentConfiguration.cell()
    content.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: 14, bottom: 0, trailing: 14)
    content.attributedText = title(for: path)
    content.textProperties.font = LodyDesign.mono(12.5)
    content.textProperties.color = .lodyInk
    content.textProperties.numberOfLines = 1
    content.textProperties.lineBreakMode = .byTruncatingTail
    return content
  }

  static func rowHeight() -> CGFloat {
    44
  }
}


final class ChatFileListCell: UICollectionViewCell, UICollectionViewDataSource, UICollectionViewDelegateFlowLayout {
  private let list: UICollectionView
  private var files: [ChatFileDiff] = []
  private var entryID = ""
  var onSelect: ((String) -> Void)?

  static func height(count: Int) -> CGFloat { CGFloat(min(count, 6)) * ChatFileCell.rowHeight() }

  override init(frame: CGRect) {
    let layout = UICollectionViewFlowLayout()
    layout.minimumLineSpacing = 0
    layout.minimumInteritemSpacing = 0
    list = UICollectionView(frame: .zero, collectionViewLayout: layout)
    super.init(frame: frame)
    list.backgroundColor = .lodyInset
    list.layer.cornerRadius = 12
    list.layer.cornerCurve = .continuous
    list.layer.maskedCorners = [.layerMinXMaxYCorner, .layerMaxXMaxYCorner]
    list.contentInsetAdjustmentBehavior = .never
    list.alwaysBounceVertical = false
    list.dataSource = self
    list.delegate = self
    list.register(ChatFileCell.self, forCellWithReuseIdentifier: "file")
    contentView.addSubview(list)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func configure(entryID: String, files: [ChatFileDiff]) {
    let changedEntry = self.entryID != entryID
    guard changedEntry || self.files != files else { return }
    self.entryID = entryID
    self.files = files
    list.isScrollEnabled = files.count > 6
    list.reloadData()
    if changedEntry { list.setContentOffset(.zero, animated: false) }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if list.bounds.size != contentView.bounds.size { list.collectionViewLayout.invalidateLayout() }
    list.frame = contentView.bounds
  }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { files.count }
  func collectionView(_ collectionView: UICollectionView, layout: UICollectionViewLayout, sizeForItemAt indexPath: IndexPath) -> CGSize {
    CGSize(width: collectionView.bounds.width, height: ChatFileCell.rowHeight())
  }
  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "file", for: indexPath) as! ChatFileCell
    let file = files[indexPath.item]
    cell.contentConfiguration = ChatFileCell.rowContent(for: file.path)
    cell.apply(group: indexPath.item == files.count - 1 ? "last" : "middle", selected: false)
    let counts = UILabel()
    counts.font = LodyDesign.mono(12, compatibleWith: cell.traitCollection)
    let value = NSMutableAttributedString(string: "+\(file.add ?? 0)", attributes: [.foregroundColor: UIColor.systemGreen])
    value.append(NSAttributedString(string: "  −\(file.del ?? 0)", attributes: [.foregroundColor: UIColor.systemRed]))
    counts.attributedText = value
    cell.accessories = [.customView(configuration: .init(customView: counts, placement: .trailing())), .disclosureIndicator()]
    cell.isAccessibilityElement = true
    cell.accessibilityTraits = .button
    cell.accessibilityLabel = String.localizedStringWithFormat(String(localized: "native.chat.file.diffStats", bundle: .lody), String(describing: file.add ?? 0), String(describing: file.del ?? 0), file.path)
    cell.accessibilityHint = String(localized: "native.chat.row.openChanges", bundle: .lody)
    return cell
  }
  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    onSelect?(files[indexPath.item].path)
  }
}
