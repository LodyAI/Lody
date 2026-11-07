import UIKit

@MainActor
final class MentionPickerView: UIView, UICollectionViewDataSource, UICollectionViewDelegate {
  var onPick: ((String) -> Void)?
  var onQueryReset: (() -> Void)?
  var onRetry: (() -> Void)?
  private let notice = UIButton(type: .system)
  private var noticeHeight: NSLayoutConstraint!
  private var query = ""
  private let location = UIButton(type: .system)
  private let useDirectory = UIButton(type: .system)
  private let empty = UILabel()
  private let list: UICollectionView
  private var items: [ChatMentionItem] = []
  private var rows: [ChatMentionItem] = []
  private var category = "file"
  private var path = ""
  private var breadcrumbHeight: NSLayoutConstraint!
  private weak var scrollOwner: UIViewController?

  override init(frame: CGRect) {
    var config = UICollectionLayoutListConfiguration(appearance: .insetGrouped)
    config.backgroundColor = .lodyGroupedBackground
    list = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: config))
    super.init(frame: frame)
    backgroundColor = .lodyGroupedBackground
    location.contentHorizontalAlignment = .leading
    location.titleLabel?.font = .dynamic(of: 13, weight: .medium)
    location.tintColor = .secondaryLabel
    location.accessibilityIdentifier = "mention-picker-back"
    location.addTarget(self, action: #selector(back), for: .touchUpInside)
    useDirectory.titleLabel?.font = .dynamic(of: 14, weight: .medium)
    useDirectory.accessibilityIdentifier = "mention-picker-use-directory"
    useDirectory.addTarget(self, action: #selector(pickDirectory), for: .touchUpInside)
    list.dataSource = self
    list.delegate = self
    list.keyboardDismissMode = .onDrag
    list.register(UICollectionViewListCell.self, forCellWithReuseIdentifier: "item")
    LodyScrollEdges.grouped(list)
    empty.text = String(localized: "native.chat.mention.empty", bundle: .lody)
    empty.textColor = .secondaryLabel
    empty.font = .dynamic(of: 15)
    empty.textAlignment = .center
    empty.accessibilityIdentifier = "mention-picker-empty"
    notice.titleLabel?.font = .dynamic(of: 13)
    notice.titleLabel?.numberOfLines = 2
    notice.addTarget(self, action: #selector(retry), for: .touchUpInside)
    notice.accessibilityIdentifier = "mention-picker-notice"
    for view in [list, location, useDirectory, empty, notice] {
      addSubview(view)
      view.translatesAutoresizingMaskIntoConstraints = false
    }
    breadcrumbHeight = location.heightAnchor.constraint(equalToConstant: 0)
    noticeHeight = notice.heightAnchor.constraint(equalToConstant: 0)
    NSLayoutConstraint.activate([
      notice.topAnchor.constraint(equalTo: location.bottomAnchor),
      notice.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
      notice.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20), noticeHeight,
      location.topAnchor.constraint(equalTo: safeAreaLayoutGuide.topAnchor),
      location.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 20),
      breadcrumbHeight,
      useDirectory.centerYAnchor.constraint(equalTo: location.centerYAnchor),
      useDirectory.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -20),
      useDirectory.leadingAnchor.constraint(greaterThanOrEqualTo: location.trailingAnchor, constant: 12),
      useDirectory.heightAnchor.constraint(equalToConstant: 44),
      list.topAnchor.constraint(equalTo: topAnchor),
      list.leadingAnchor.constraint(equalTo: leadingAnchor), list.trailingAnchor.constraint(equalTo: trailingAnchor),
      list.bottomAnchor.constraint(equalTo: keyboardLayoutGuide.topAnchor),
      empty.centerXAnchor.constraint(equalTo: list.centerXAnchor), empty.centerYAnchor.constraint(equalTo: list.centerYAnchor),
    ])
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) { fatalError() }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      if let scrollOwner { LodyScrollEdges.unbind(list, from: scrollOwner) }
      scrollOwner = nil
      return
    }
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController {
        LodyScrollEdges.bind(list, to: controller)
        LodyScrollEdges.grouped(list)
        scrollOwner = controller
        controller.definesPresentationContext = true
        break
      }
      responder = current.next
    }
  }

  func configure(category: String, items: [ChatMentionItem], query: String, notice text: String) {
    self.category = category
    self.items = items.filter { $0.category == category }
    self.query = query
    notice.setTitle(text, for: .normal)
    notice.isHidden = text.isEmpty
    noticeHeight.constant = notice.isHidden ? 0 : 44
    render()
  }

  private func render() {
    rows = items.filter { item in
      if category == "file" && query.isEmpty { return (item.path as NSString).deletingLastPathComponent == path }
      return item.matches(query)
    }
    location.setImage(path.isEmpty ? nil : UIImage(systemName: "chevron.left"), for: .normal)
    location.setTitle(path.isEmpty ? String(localized: String.LocalizationValue("native.chat.mention." + (ChatMentionItem.labels[category] ?? category)), bundle: .lody) : "  " + path, for: .normal)
    location.isEnabled = !path.isEmpty
    location.isHidden = path.isEmpty
    breadcrumbHeight.constant = path.isEmpty ? 0 : 44
    list.contentInset.top = breadcrumbHeight.constant + noticeHeight.constant
    list.verticalScrollIndicatorInsets.top = list.contentInset.top
    useDirectory.isHidden = path.isEmpty
    useDirectory.setTitle(String.localizedStringWithFormat(String(localized: "native.chat.mention.directory", bundle: .lody), String(describing: (path as NSString).lastPathComponent)), for: .normal)
    empty.isHidden = !rows.isEmpty
    list.reloadData()
  }

  @objc private func retry() { onRetry?() }
  @objc private func back() {
    path = (path as NSString).deletingLastPathComponent
    query = ""
    onQueryReset?()
    render()
  }
  @objc private func pickDirectory() { onPick?(path) }
  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { rows.count }
  func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
    let item = rows[indexPath.item]
    let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "item", for: indexPath) as! UICollectionViewListCell
    cell.contentConfiguration = item.content
    cell.accessibilityIdentifier = "mention-picker-item:" + item.path
    cell.accessories = item.kind == "directory" ? [.disclosureIndicator()] : []
    return cell
  }
  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    collectionView.deselectItem(at: indexPath, animated: true)
    let item = rows[indexPath.item]
    if item.kind == "directory" {
      path = item.path
      query = ""
      onQueryReset?()
      render()
    } else { onPick?(item.path) }
  }
}
