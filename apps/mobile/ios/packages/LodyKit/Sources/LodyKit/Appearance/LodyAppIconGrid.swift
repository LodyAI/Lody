import UIKit

struct LodyAppIconItem {
  var id: String = ""
  var title: String = ""
}

private final class AppIconCell: UICollectionViewCell {
  let image = UIImageView()
  let label = UILabel()
  let check = UIImageView(image: UIImage(systemName: "checkmark.circle.fill"))
  let progress = UIActivityIndicatorView(style: .medium)

  override init(frame: CGRect) {
    super.init(frame: frame)
    isAccessibilityElement = true
    image.contentMode = .scaleAspectFit
    image.layer.cornerCurve = .continuous
    image.layer.cornerRadius = 17
    image.clipsToBounds = true
    label.font = .preferredFont(forTextStyle: .footnote)
    label.adjustsFontForContentSizeCategory = true
    label.textAlignment = .center
    label.numberOfLines = 2
    label.textColor = .label
    check.tintColor = .systemBlue
    check.backgroundColor = .systemBackground
    check.layer.cornerRadius = 11
    for view in [image, label, check, progress] { contentView.addSubview(view) }
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func layoutSubviews() {
    super.layoutSubviews()
    let size = min(76, bounds.width - 20)
    image.frame = CGRect(x: (bounds.width - size) / 2, y: 10, width: size, height: size)
    label.frame = CGRect(x: 4, y: image.frame.maxY + 10, width: bounds.width - 8, height: 36)
    check.frame = CGRect(x: image.frame.maxX - 17, y: image.frame.maxY - 17, width: 22, height: 22)
    progress.center = image.center
  }

  func configure(_ item: LodyAppIconItem, selected: Bool, pending: Bool, enabled: Bool) {
    image.image = UIImage(named: "AppIconPreview-\(item.id)")
    image.alpha = pending ? 0.4 : 1
    label.text = item.title
    check.isHidden = !selected
    if pending { progress.startAnimating() } else { progress.stopAnimating() }
    accessibilityIdentifier = "app-icon-\(item.id)"
    accessibilityLabel = item.title
    accessibilityValue = selected ? String(localized: "native.chat.attachment.selected", bundle: .lody) : nil
    accessibilityTraits = [.button]
    if selected { accessibilityTraits.insert(.selected) }
    if !enabled { accessibilityTraits.insert(.notEnabled) }
  }
}

final class LodyAppIconGrid: LodyAppearanceView, UICollectionViewDataSource, UICollectionViewDelegate {
  var onSelect: ([String: Any]) -> Void = { _ in }
  var selectHandler: ((String) -> Void)?
  private let collection: UICollectionView
  private weak var scrollOwner: UIViewController?
  private var items: [LodyAppIconItem] = []
  private var selected = ""
  private var pending = ""
  private var enabled = false

  override init(frame: CGRect) {
    let item = NSCollectionLayoutItem(layoutSize: .init(widthDimension: .fractionalWidth(1.0 / 3), heightDimension: .fractionalHeight(1)))
    let group = NSCollectionLayoutGroup.horizontal(layoutSize: .init(widthDimension: .fractionalWidth(1), heightDimension: .absolute(140)), repeatingSubitem: item, count: 3)
    let section = NSCollectionLayoutSection(group: group)
    section.contentInsets = .init(top: 20, leading: 16, bottom: 20, trailing: 16)
    collection = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout(section: section))
    super.init(frame: frame)
    collection.register(AppIconCell.self, forCellWithReuseIdentifier: "icon")
    collection.dataSource = self
    collection.delegate = self
    collection.alwaysBounceVertical = true
    collection.contentInsetAdjustmentBehavior = .automatic
    collection.backgroundColor = .lodyGroupedBackground
    LodyScrollEdges.grouped(collection)
    addSubview(collection)
  }

  func setItems(_ value: [LodyAppIconItem]) { items = value; collection.reloadData() }
  func setSelected(_ value: String) { selected = value; collection.reloadData() }
  func setPending(_ value: String) { pending = value; collection.reloadData() }
  func setEnabled(_ value: Bool) { enabled = value; collection.reloadData() }
  override func lodyAppearanceDidChange() { collection.reloadData() }

  override func layoutSubviews() {
    super.layoutSubviews()
    collection.frame = bounds
    attachScrollOwner()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      if let scrollOwner { LodyScrollEdges.unbind(collection, from: scrollOwner) }
      scrollOwner = nil
    } else { attachScrollOwner() }
  }

  private func attachScrollOwner() {
    guard window != nil, scrollOwner == nil else { return }
    var responder = next
    while let current = responder {
      if let controller = current as? UIViewController {
        LodyScrollEdges.bind(collection, to: controller)
        scrollOwner = controller
        return
      }
      responder = current.next
    }
  }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { items.count }

  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "icon", for: indexPath) as! AppIconCell
    let item = items[indexPath.item]
    cell.configure(item, selected: item.id == selected, pending: item.id == pending, enabled: enabled)
    return cell
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: false)
    guard enabled, pending.isEmpty else { return }
    let id = items[indexPath.item].id
    onSelect(["id": id])
    selectHandler?(id)
  }
}
