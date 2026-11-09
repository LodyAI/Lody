import SwiftUI
import UIKit
import LodyDesignSystem

private final class ListAppearanceController: UIViewController {
  var onWillAppear: ((Bool, UIViewControllerTransitionCoordinator?) -> Void)?
  var onWillDisappear: ((Bool, UIViewControllerTransitionCoordinator?) -> Void)?
  override func viewWillAppear(_ animated: Bool) {
    super.viewWillAppear(animated)
    onWillAppear?(animated, transitionCoordinator ?? parent?.transitionCoordinator)
  }
  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    onWillDisappear?(animated, transitionCoordinator ?? parent?.transitionCoordinator)
  }
}

private final class SectionSupplementaryCell: UICollectionViewListCell {
  let arrow = UIImageView(image: UIImage(systemName: "chevron.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold)))
  var expanded: Bool?
}

private final class SectionHeaderTap: UITapGestureRecognizer {}

private final class RowSwitch: UISwitch {
  var rowID = ""
}

private final class SettingsListCell: UICollectionViewListCell {
  let optionButton = UIButton(type: .system)

  override init(frame: CGRect) {
    super.init(frame: frame)
    optionButton.showsMenuAsPrimaryAction = true
    addSubview(optionButton)
    optionButton.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
      optionButton.leadingAnchor.constraint(equalTo: leadingAnchor),
      optionButton.trailingAnchor.constraint(equalTo: trailingAnchor),
      optionButton.topAnchor.constraint(equalTo: topAnchor),
      optionButton.bottomAnchor.constraint(equalTo: bottomAnchor),
    ])
  }

  required init?(coder: NSCoder) { fatalError() }
}

private final class SearchHeaderCell: UICollectionViewCell {
  var onLayout: ((SearchHeaderCell) -> Void)?
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    contentView.backgroundColor = .clear
  }

  required init?(coder: NSCoder) { fatalError() }

  override func layoutSubviews() {
    super.layoutSubviews()
    onLayout?(self)
  }
}

private struct ListItemID: Hashable {
  let section: String
  let row: String
}

final class LodyGroupedList: LodyAppearanceView, UICollectionViewDelegate, UISearchBarDelegate, UITextFieldDelegate {
  var onRowPress: ([String: Any]) -> Void = { _ in }
  var onRowToggle: ([String: Any]) -> Void = { _ in }
  var onRowAction: ([String: Any]) -> Void = { _ in }
  var onReorder: ([String: Any]) -> Void = { _ in }
  var onRefresh: ([String: Any]) -> Void = { _ in }
  var onSegmentChange: ([String: Any]) -> Void = { _ in }
  var onSearchChange: ([String: Any]) -> Void = { _ in }
  var onNoticeAction: ([String: Any]) -> Void = { _ in }
  var onUnavailableAction: ([String: Any]) -> Void = { _ in }
  var onRowReview: (([String: Any]) -> Void)?
  var forwarded: ((String, [String: Any]) -> Void)?

  func emitRowPress(_ body: [String: Any]) {
    if body["expanded"] == nil,
       let id = body["id"] as? String,
       let row = rowsByID.first(where: { $0.key.row == id })?.value {
      unreadHold.begin(
        rowID: row.id,
        unread: row.unread,
        coversList: scrollOwner?.splitViewController?.isCollapsed ?? true
      )
    }
    onRowPress(body)
    forwarded?("rowPress", body)
  }

  func emitRowReview(_ id: String) {
    guard let onRowReview else {
      emitRowPress(["id": id])
      return
    }
    onRowReview(["id": id])
    forwarded?("rowReview", ["id": id])
  }

  func emitRowAction(_ body: [String: Any]) {
    onRowAction(body)
    forwarded?("rowAction", body)
  }
  private let segments = UISegmentedControl(items: [])
  private let steps = LodyStepStrip()
  private let searchField = UISearchTextField()
  private weak var searchHeader: SearchHeaderCell?
  private let segmentContainer = UIView()
  private var scopeSearch: UISearchController?
  private var segmentLabels: [String] = []
  private var segmentsUseSearchScope = false
  private var searchEnabled = false
  private var selectedSegment = 0
  private let appearance = ListAppearanceController()
  private weak var scrollOwner: UIViewController?
  private var sections: [LodyListSection] = []
  private var inputSections: [LodyListSection] = []
  private var notice: LodyListNotice?
  private var loading = false
  private var unavailableView: UIContentUnavailableView?
  private static let visualRowID = "__visual"
  private static let noticeSectionID = "__notice"
  private static let skeletonSectionID = "__skeleton"
  private let collection: UICollectionView
  var contentScrollView: UIScrollView { collection }
  private let refreshControl = UIRefreshControl()
  private let placeholder = UILabel()
  private let topFade = LodyEdgeFade(edge: .top)
  private let bottomFade = LodyEdgeFade()
  private var placeholderText = ""

  private static var accent: UIColor = .lodyAccent
  private var bottomInset: CGFloat = 0
  private var transparent = false
  private var contentStyle = false
  private var grouped = false
  /// The Chats list's design language for a flat list: no separators, `body` titles, `footnote`
  /// subtitles, tertiary `groupLabel` headers at the screen edge and the pressed fill.
  private var chatStyle = false
  private var textLeadings: [String: CGFloat] = [:]
  private var flatSystem: Bool { !grouped && !contentStyle }
  private static let flatHeaderTop: CGFloat = 10
  private var reordering = false
  var previewUserId = ""
  var previewWorkspaceId = ""
  private var rowsByID: [ListItemID: LodyListRow] = [:]
  private var unreadHold = LodyUnreadNavigationHold()
  private var collapsedSessions = Set<String>()
  private var toggles: [String: RowSwitch] = [:]
  private var dataSource: UICollectionViewDiffableDataSource<String, ListItemID>!

  private static let restingCard = UIColor.tertiarySystemGroupedBackground

  private lazy var registration = UICollectionView.CellRegistration<SettingsListCell, LodyListRow> { [weak self] cell, _, row in
    self?.configureSettingsCell(cell, row)
  }

  private func configureSettingsCell(_ cell: SettingsListCell, _ row: LodyListRow) {
    Self.configureSystem(cell, row, toggle: toggle(for: row), flat: flatSystem)
    if flatSystem { flatten(cell, row) }
    if reordering { cell.accessories.append(.reorder(displayed: .always)) }
    let button = cell.optionButton
    button.isHidden = row.options.isEmpty
    button.isEnabled = row.action
    button.accessibilityIdentifier = row.id
    button.accessibilityLabel = row.title
    button.accessibilityValue = row.value
    button.menu = row.options.isEmpty ? nil : UIMenu(options: .singleSelection, children: row.options.map { option in
      UIAction(title: option.title, state: option.selected ? .on : .off) { [weak self] _ in
        self?.emitRowAction(["id": row.id, "actionId": option.id])
      }
    })
    cell.isAccessibilityElement = row.options.isEmpty
    cell.accessibilityElements = row.options.isEmpty ? nil : [button]
    if !row.options.isEmpty {
      cell.accessibilityIdentifier = nil
      let indicator = UIImageView(image: UIImage(systemName: "chevron.up.chevron.down"))
      indicator.tintColor = flatSystem ? .lodyTertiary : .tertiaryLabel
      indicator.preferredSymbolConfiguration = .init(pointSize: 11, weight: .semibold)
      cell.accessories.append(.customView(configuration: .init(customView: indicator, placement: .trailing(at: { $0.count }))))
      cell.bringSubviewToFront(button)
    }
  }

  private func flatten(_ cell: SettingsListCell, _ row: LodyListRow) {
    guard var content = cell.contentConfiguration as? UIListContentConfiguration else { return }
    if chatStyle { return chatFlatten(cell, row, content) }
    let textLeading = textLeadings[row.id] ?? LodyFlatRows.readingMargin
    let monogram = !row.monogram.isEmpty && row.image.isEmpty && row.filePath.isEmpty
    let photo = LodyListPhoto.url(row.image) != nil || monogram
    let font = photo
      ? LodyDesign.font(.body, size: 17, weight: .semibold)
      : LodyDesign.font(.subheadline, size: 15)
    let secondaryFont = row.subtitleMono ? LodyDesign.mono(12) : LodyDesign.font(.footnote, size: 12.5)
    content.textProperties.font = font
    if !row.destructive { content.textProperties.color = .lodyInk }
    content.secondaryTextProperties.font = secondaryFont
    content.secondaryTextProperties.color = .lodySecondary
    content.textToSecondaryTextVerticalPadding = 2
    var leading = textLeading
    if monogram {
      content.image = LodyListPhoto.monogram(row.monogram, side: LodyFlatRows.avatarSize)
    }
    if content.image != nil, photo {
      let side = CGSize(width: LodyFlatRows.avatarSize, height: LodyFlatRows.avatarSize)
      content.imageProperties.maximumSize = side
      content.imageProperties.reservedLayoutSize = side
      content.imageProperties.cornerRadius = side.width / 2
      content.imageToTextPadding = 12
      leading = LodyFlatRows.readingMargin
    } else if content.image != nil {
      let box = LodyFlatRows.iconBox
      content.imageProperties.reservedLayoutSize = CGSize(width: box, height: LodyFlatRows.iconSize)
      content.imageProperties.maximumSize = CGSize(width: LodyFlatRows.iconSize, height: LodyFlatRows.iconSize)
      content.imageProperties.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 16, weight: .regular)
      if row.imageTint.isEmpty, !row.destructive, !row.imageOriginal, row.filePath.isEmpty, row.status.isEmpty {
        content.imageProperties.tintColor = .lodySecondary
      }
      leading = LodyFlatRows.iconCenter - box / 2
      content.imageToTextPadding = max(0, textLeading - leading - box)
    }
    let text = font.lineHeight + (content.secondaryText == nil ? 0 : secondaryFont.lineHeight + 2)
    let lines = max(text, content.image == nil ? 0 : content.imageProperties.reservedLayoutSize.height)
    let vertical = max(8, ceil((LodyFlatRows.minHeight(hasSubtitle: content.secondaryText != nil) - lines) / 2))
    content.directionalLayoutMargins = .init(top: vertical, leading: leading, bottom: vertical, trailing: LodyDesign.Rail.trailing)
    cell.preservesSuperviewLayoutMargins = false
    cell.directionalLayoutMargins = .init(top: 0, leading: 0, bottom: 0, trailing: LodyDesign.Rail.trailing)
    cell.contentConfiguration = content
  }

  /// A chat row's metrics: `listEdgeX` edges, a `md` glyph then `listRowGap` before the title,
  /// `body` / `footnote` text and at least `LodySize.listRow` tall.
  private func chatFlatten(_ cell: SettingsListCell, _ row: LodyListRow, _ base: UIListContentConfiguration) {
    var content = base
    let monogram = !row.monogram.isEmpty && row.image.isEmpty && row.filePath.isEmpty
    let photo = LodyListPhoto.url(row.image) != nil || monogram
    let font = photo ? LodyTextStyle.bodyEmphasis.uiFont : LodyTextStyle.body.uiFont
    let secondaryFont = row.subtitleMono ? LodyDesign.mono(12) : LodyTextStyle.footnote.uiFont
    content.textProperties.font = font
    if !row.destructive { content.textProperties.color = LodyUIColor.textPrimary }
    content.secondaryTextProperties.font = secondaryFont
    content.secondaryTextProperties.color = LodyUIColor.textSecondary
    content.textToSecondaryTextVerticalPadding = LodySpacing.xxs
    if monogram {
      content.image = LodyListPhoto.monogram(row.monogram, side: LodyFlatRows.avatarSize)
    }
    if content.image != nil, photo {
      let side = CGSize(width: LodyFlatRows.avatarSize, height: LodyFlatRows.avatarSize)
      content.imageProperties.maximumSize = side
      content.imageProperties.reservedLayoutSize = side
      content.imageProperties.cornerRadius = side.width / 2
      content.imageToTextPadding = LodyLayout.listRowGap
    } else if content.image != nil {
      let side = CGSize(width: LodyIconSize.md, height: LodyIconSize.md)
      content.imageProperties.reservedLayoutSize = side
      content.imageProperties.maximumSize = side
      content.imageProperties.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 15, weight: .regular)
      if row.imageTint.isEmpty, !row.destructive, !row.imageOriginal, row.filePath.isEmpty, row.status.isEmpty {
        content.imageProperties.tintColor = LodyUIColor.iconSecondary
      }
      content.imageToTextPadding = LodyLayout.listRowGap
    }
    let text = font.lineHeight + (content.secondaryText == nil ? 0 : secondaryFont.lineHeight + LodySpacing.xxs)
    let lines = max(text, content.image == nil ? 0 : content.imageProperties.reservedLayoutSize.height)
    let vertical = max(LodySpacing.sm, ceil((LodySize.listRow - lines) / 2))
    content.directionalLayoutMargins = .init(
      top: vertical, leading: LodyLayout.listEdgeX, bottom: vertical, trailing: LodyLayout.listEdgeX
    )
    cell.preservesSuperviewLayoutMargins = false
    cell.directionalLayoutMargins = .init(top: 0, leading: 0, bottom: 0, trailing: LodyLayout.listEdgeX)
    cell.contentConfiguration = content
  }

  private lazy var visualRegistration = UICollectionView.CellRegistration<UICollectionViewListCell, ListItemID> { [weak self] cell, _, id in
    self?.configureVisual(cell, id)
  }

  private func configureVisual(_ cell: UICollectionViewListCell, _ id: ListItemID) {
    cell.accessories = []
    cell.accessibilityIdentifier = nil
    if id.section == Self.noticeSectionID, let notice {
      let tint = lodyTint(notice.tint) ?? .secondaryLabel
      cell.contentConfiguration = UIHostingConfiguration {
        LodyListNoticeView(notice: notice, tint: Color(uiColor: tint)) { [weak self] in
          self?.onNoticeAction([:])
          self?.forwarded?("noticeAction", [:])
        }
      }
      .margins(.vertical, 2)
      return
    }
    guard let visual = sections.first(where: { $0.id == id.section })?.visual else {
      cell.contentConfiguration = nil
      return
    }
    cell.contentConfiguration = UIHostingConfiguration {
      LodyListVisualView(visual: visual, accent: Color(uiColor: Self.accent))
    }
    .margins(.all, 16)
  }

  private func composedSections() -> [LodyListSection] {
    var result: [LodyListSection] = []
    if let notice, !notice.text.isEmpty {
      result.append(.synthetic(id: Self.noticeSectionID, rowID: Self.visualRowID))
    }
    var visualRow = LodyListRow()
    visualRow.id = Self.visualRowID
    result += inputSections.map { $0.visual == nil ? $0 : $0.prepending(visualRow) }
    if loading, inputSections.allSatisfy({ $0.rows.isEmpty && $0.visual == nil }) {
      var skeleton = LodyListVisual()
      skeleton.type = "skeleton"
      result.append(.synthetic(id: Self.skeletonSectionID, rowID: Self.visualRowID, visual: skeleton))
    }
    return result
  }

  func setNotice(_ value: LodyListNotice?) {
    notice = value
    applySections(composedSections(), animated: true)
  }

  func setLoading(_ value: Bool) {
    guard loading != value else { return }
    loading = value
    applySections(composedSections(), animated: false)
  }

  func setUnavailable(_ value: LodyListUnavailable?) {
    guard let value, !value.title.isEmpty else {
      unavailableView?.removeFromSuperview()
      unavailableView = nil
      updatePlaceholder()
      return
    }
    var configuration = UIContentUnavailableConfiguration.empty()
    configuration.image = UIImage(systemName: value.symbol)
    configuration.text = value.title
    configuration.secondaryText = value.message.isEmpty ? nil : value.message
    if !value.actionTitle.isEmpty {
      var button = UIButton.Configuration.lodyProminent()
      button.title = value.actionTitle
      configuration.button = button
      configuration.buttonProperties.primaryAction = UIAction { [weak self] _ in
        self?.onUnavailableAction([:])
        self?.forwarded?("unavailableAction", [:])
      }
    }
    let view = unavailableView ?? UIContentUnavailableView(configuration: configuration)
    view.configuration = configuration
    view.accessibilityIdentifier = "list-unavailable"
    if view.superview == nil { insertSubview(view, aboveSubview: collection) }
    view.layoutIfNeeded()
    Self.firstButton(in: view)?.accessibilityIdentifier = "list-unavailable-action"
    unavailableView = view
    updatePlaceholder()
    setNeedsLayout()
  }

  // UIContentUnavailableConfiguration exposes no identifier for its button.
  private static func firstButton(in view: UIView) -> UIButton? {
    for subview in view.subviews {
      if let button = subview as? UIButton { return button }
      if let button = firstButton(in: subview) { return button }
    }
    return nil
  }

  private lazy var sessionRegistration = UICollectionView.CellRegistration<LodyIndentedCell, LodyListRow> { [weak self] cell, _, row in
    self?.configureSession(cell, row)
  }

  private var outline: Bool { sections.contains { $0.rows.first?.parent == true } }

  private lazy var projectRegistration = UICollectionView.CellRegistration<LodyIndentedCell, LodyListRow> { [weak self] cell, _, row in
    self?.configureProject(cell, row)
  }

  private func configureProject(_ cell: UICollectionViewListCell, _ row: LodyListRow) {
    let id = row.id
    cell.contentConfiguration = LodyProjectRowContent(
      row: row,
      expanded: row.navigates ? nil : true,
      onToggle: { [weak self] in self?.toggleOutline(id) }
    )
    cell.accessories = []
    cell.accessibilityIdentifier = row.id
    cell.accessibilityTraits = [.button, .header]
  }

  private func configureSession(_ cell: LodyIndentedCell, _ row: LodyListRow) {
    let id = row.id
    let expanded = !collapsedSessions.contains(id)
    var content = LodySessionRowContent(row: row, treeDown: !row.collapsedValue.isEmpty && expanded, expanded: expanded)
    content.onReview = { [weak self] in self?.emitRowReview(id) }
    if !row.collapsedValue.isEmpty {
      content.onToggle = { [weak self] in self?.toggleOutline(id) }
    }
    cell.contentConfiguration = content
    cell.textLeading = LodySessionRowView.textLeading(for: row, density: .regular)
    cell.accessories = []
    cell.accessibilityIdentifier = row.id
    cell.accessibilityTraits = row.action ? .button : .staticText
  }

  private static func configureSystem(
    _ cell: UICollectionViewListCell,
    _ row: LodyListRow,
    toggle: UISwitch? = nil,
    flat: Bool = false
  ) {
    cell.accessibilityIdentifier = row.id
    let accent = LodyGroupedList.accent
    if let progress = row.progress, progress.isFinite {
      cell.contentConfiguration = LodyProgressRowContent(row: row)
      cell.accessories = []
      cell.isAccessibilityElement = true
      cell.accessibilityLabel = [row.title, row.value, row.subtitle].filter { !$0.isEmpty }.joined(separator: ", ")
      cell.accessibilityValue = nil
      cell.accessibilityTraits = .staticText
      return
    }
    var content = UIListContentConfiguration.subtitleCell()
    content.text = row.title
    let subtitle = [row.subtitle, row.badge].filter { !$0.isEmpty }.joined(separator: " · ")
    content.secondaryText = subtitle.isEmpty ? nil : subtitle
    content.textProperties.numberOfLines = 0
    content.secondaryTextProperties.numberOfLines = row.wrapSubtitle ? 0 : 1
    if row.subtitleMono {
      content.secondaryTextProperties.font = .monospacedSystemFont(
        ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize,
        weight: .regular
      )
    }
    content.textProperties.color = row.destructive ? .systemRed : .label
    #if LODY_SHARE_EXTENSION
    let fileIcon: UIImage? = nil
    #else
    let fileIcon = row.filePath.isEmpty ? nil : MaterialFileIcon.image(for: row.filePath)
    #endif
    if let fileIcon {
      content.image = fileIcon
    } else if !row.repository.isEmpty {
      content.image = RepositoryImages.image(row.repository) { [weak cell] image in
        guard let cell, cell.accessibilityIdentifier == row.id,
              var next = cell.contentConfiguration as? UIListContentConfiguration else { return }
        next.image = image
        next.imageProperties.tintColor = nil
        cell.contentConfiguration = next
      } ?? LodyIcon.github.uiImage
      content.imageProperties.maximumSize = CGSize(width: 20, height: 20)
      content.imageProperties.reservedLayoutSize = LodyListGlyph.reservedSize
      content.imageProperties.cornerRadius = 4
      content.imageProperties.tintColor = nil
    } else if let url = LodyListPhoto.url(row.image) {
      if let image = LodyListPhoto.image(for: url, ready: { [weak cell] image in
        guard let cell, cell.accessibilityIdentifier == row.id,
              var next = cell.contentConfiguration as? UIListContentConfiguration else { return }
        LodyListPhoto.apply(&next, image: image)
        cell.contentConfiguration = next
      }) {
        LodyListPhoto.apply(&content, image: image)
      } else if let placeholder = UIImage(systemName: "person.crop.circle.fill") {
        LodyListPhoto.apply(&content, image: placeholder, placeholder: true)
      }
    } else if row.imageOriginal && !row.imageAsset.isEmpty {
      content.image = UIImage(named: row.imageAsset)?.withRenderingMode(.alwaysOriginal)
      content.imageProperties.maximumSize = CGSize(width: 29, height: 29)
      content.imageProperties.reservedLayoutSize = LodyListGlyph.reservedSize
      content.imageProperties.cornerRadius = 6
    } else if !row.imageAsset.isEmpty || !row.image.isEmpty {
      if !row.imageAsset.isEmpty {
        LodyListGlyph.apply(
          &content,
          image: LodyIcon(rawValue: row.imageAsset)?.uiImage?.withRenderingMode(.alwaysTemplate)
            ?? UIImage(named: row.imageAsset, in: .main, compatibleWith: nil)?
            .withRenderingMode(.alwaysTemplate)
            ?? UIImage(named: row.imageAsset)?.withRenderingMode(.alwaysTemplate),
          asset: true
        )
      } else {
        LodyListGlyph.apply(&content, image: UIImage(systemName: row.image), asset: false)
      }
      content.imageProperties.tintColor =
        lodyTint(row.imageTint) ?? (row.destructive ? .systemRed : accent)
    }
    if !row.status.isEmpty {
      content.image = LodyListStatus.badged(
        content.image,
        tint: content.imageProperties.tintColor ?? accent,
        status: row.status,
        traits: cell.traitCollection
      )
    }
    cell.contentConfiguration = content
    var accessories: [UICellAccessory] = []
    cell.accessibilityValue = nil
    if !row.valueSegments.isEmpty {
      let label = UILabel()
      label.font = .preferredFont(forTextStyle: .body)
      label.adjustsFontForContentSizeCategory = true
      label.isAccessibilityElement = false
      let value = NSMutableAttributedString(string: "")
      for segment in row.valueSegments {
        value.append(NSAttributedString(string: segment.text, attributes: [
          .foregroundColor: lodyTint(segment.tint) ?? UIColor.secondaryLabel,
        ]))
      }
      label.attributedText = value
      label.sizeToFit()
      cell.accessibilityValue = value.string
      accessories.append(.customView(configuration: .init(customView: label, placement: .trailing())))
    } else if !row.value.isEmpty && !row.valueSymbol.isEmpty {
      let label = LodyListStatus.symbolLabel(row.valueSymbol, text: row.value, color: .secondaryLabel)
      accessories.append(.customView(configuration: .init(customView: label, placement: .trailing())))
    } else if !row.value.isEmpty {
      var options = UICellAccessory.LabelOptions()
      options.tintColor = flat ? .lodySecondary : .secondaryLabel
      if flat { options.font = LodyDesign.font(.subheadline, size: 15) }
      accessories.append(.label(text: row.value, options: options))
    }
    if !row.trailingSymbol.isEmpty {
      let glyph = LodyListStatus.trailingGlyph(row.trailingSymbol)
      accessories.append(.customView(configuration: .init(customView: glyph, placement: .trailing())))
    }
    if let toggle {
      accessories.append(
        .customView(configuration: .init(customView: toggle, placement: .trailing()))
      )
    }
    if row.selected { accessories.append(.checkmark()) }
    if row.disclosure {
      accessories.append(.disclosureIndicator(options: flat ? .init(tintColor: .lodyTertiary) : .init()))
    }
    cell.accessories = accessories
    var traits: UIAccessibilityTraits = row.action ? .button : .staticText
    if row.selected { traits.insert(.selected) }
    cell.accessibilityTraits = traits
    let spoken = [row.accessibilityValue, row.trailingSymbolLabel].filter { !$0.isEmpty }.joined(separator: ", ")
    cell.accessibilityValue = spoken.isEmpty ? nil : spoken
    cell.accessibilityLabel = row.selected && !row.accessibilityValue.isEmpty
      ? "\(row.title), \(row.accessibilityValue)"
      : nil
  }

  private static let searchKind = "list-search-header"

  private lazy var searchRegistration = UICollectionView.SupplementaryRegistration<SearchHeaderCell>(
    elementKind: Self.searchKind
  ) { [weak self] cell, _, _ in
    self?.installSearch(in: cell)
  }

  private let headerRegistration = UICollectionView.SupplementaryRegistration<SectionSupplementaryCell>(
    elementKind: UICollectionView.elementKindSectionHeader
  ) { _, _, _ in }

  private let footerRegistration = UICollectionView.SupplementaryRegistration<SectionSupplementaryCell>(
    elementKind: UICollectionView.elementKindSectionFooter
  ) { _, _, _ in }

  override init(frame: CGRect) {
    collection = UICollectionView(frame: .zero, collectionViewLayout: UICollectionViewCompositionalLayout.list(using: .init(appearance: .insetGrouped)))
    super.init(frame: frame)
    // UIKit rejects a registration created inside the cell provider.
    _ = sessionRegistration
    _ = projectRegistration
    _ = registration
    _ = visualRegistration
    _ = searchRegistration
    collection.backgroundColor = .lodyGround
    collection.tintColor = .lodyAccent
    collection.contentInsetAdjustmentBehavior = .automatic
    collection.alwaysBounceVertical = true
    collection.keyboardDismissMode = .onDrag
    dataSource = UICollectionViewDiffableDataSource<String, ListItemID>(collectionView: collection) { [weak self] collection, index, id in
      guard let self, let row = self.rowsByID[id] else { return nil }
      return self.cell(in: collection, at: index, row: self.displayed(row))
    }
    dataSource.supplementaryViewProvider = { [weak self] collection, kind, index in
      self?.supplementary(in: collection, kind: kind, at: index)
    }
    dataSource.reorderingHandlers.canReorderItem = { [weak self] _ in
      guard let self else { return false }
      return self.reordering && self.sections.count == 1 && !self.outline
    }
    dataSource.reorderingHandlers.didReorder = { [weak self] transaction in
      guard let self, self.sections.count == 1 else { return }
      let ids = transaction.finalSnapshot.itemIdentifiers
      self.sections[0].rows = ids.compactMap { self.rowsByID[$0] }
      self.onReorder(["ids": ids.map(\.row)])
      self.forwarded?("reorder", ["ids": ids.map(\.row)])
    }
    dataSource.sectionSnapshotHandlers.willExpandItem = { [weak self] item in
      self?.outlineChanged(item, expanded: true)
    }
    dataSource.sectionSnapshotHandlers.willCollapseItem = { [weak self] item in
      self?.outlineChanged(item, expanded: false)
    }
    collection.delegate = self
    let layout = UICollectionViewCompositionalLayout { [weak self] index, environment in
      let flatSystem = self?.flatSystem ?? false
      let flat = (self?.contentStyle ?? false) || flatSystem
      var configuration = UICollectionLayoutListConfiguration(appearance: flat ? .plain : .insetGrouped)
      // The collection owns the ground; the layout must not repaint it at full detent.
      configuration.backgroundColor = .clear
      if flat {
        configuration.headerTopPadding = 0
        if flatSystem, index > 0 {
          configuration.headerTopPadding = self?.chatStyle == true
            ? LodySpacing.lg : LodyDesign.Rail.groupGap - Self.flatHeaderTop
        }
        configuration.showsSeparators = flatSystem && !(self?.chatStyle ?? false)
      }
      // `.firstItemInSection` splits the inset card into a header card and an
      // items card; a parent row is a plain first item so the card stays whole.
      let model = self?.section(at: index)
      let outline = model?.rows.first?.parent ?? false
      if flatSystem, !(self?.chatStyle ?? false) {
        var separators = UIListSeparatorConfiguration(listAppearance: .plain)
        separators.color = .lodyLine
        configuration.separatorConfiguration = separators
        let count = model?.rows.count ?? 0
        let leading = LodyFlatRows.textLeading(sectionHasIcons: LodyFlatRows.sectionHasIcons(model?.rows ?? []))
        configuration.itemSeparatorHandler = { indexPath, proposed in
          var separator = proposed
          separator.topSeparatorVisibility = .hidden
          let inset = LodyFlatRows.separatorLeading(textLeading: leading, isLast: indexPath.item >= count - 1)
          separator.bottomSeparatorVisibility = inset == nil ? .hidden : .visible
          separator.bottomSeparatorInsets = .init(top: 0, leading: inset ?? 0, bottom: 0, trailing: 0)
          return separator
        }
      }
      let hideEmptyFooter = LodyListSectionAnimation.hidesEmptyFooter(
        rowCount: model?.rows.count ?? 0,
        placeholder: self?.placeholderText ?? ""
      )
      let emptyLeadingHeader = index == 0
        && (model?.header ?? "").isEmpty
        && (model?.headerValue ?? "").isEmpty
        && (model?.headerStatus ?? "").isEmpty
        && (model?.headerActionId ?? "").isEmpty
      configuration.headerMode = outline || emptyLeadingHeader ? .none : .supplementary
      let emptyFlatFooter = flatSystem && (model?.footer ?? "").isEmpty
      configuration.footerMode = outline || hideEmptyFooter || emptyFlatFooter ? .none : .supplementary
      configuration.leadingSwipeActionsConfigurationProvider = { indexPath in
        self?.swipeActions(at: indexPath, leading: true)
      }
      configuration.trailingSwipeActionsConfigurationProvider = { indexPath in
        self?.swipeActions(at: indexPath, leading: false)
      }
      let section = NSCollectionLayoutSection.list(using: configuration, layoutEnvironment: environment)
      // Plain lists pin headers by default; a clear header would float over rows.
      for item in section.boundarySupplementaryItems { item.pinToVisibleBounds = false }
      if flat, !flatSystem, index > 0, outline {
        section.contentInsets.top = LodyDesign.Rail.bandGap
      } else if flat, !flatSystem, index > 0 {
        section.contentInsets.top = model?.gap == .group ? LodyDesign.Rail.groupGap : LodyDesign.Rail.sectionGap
      }
      if outline, !flat {
        // The decoration spans the section frame including its insets; matching
        // them puts the card exactly under the rows.
        let card = NSCollectionLayoutDecorationItem.background(elementKind: LodySectionCardView.kind)
        card.contentInsets = section.contentInsets
        section.decorationItems = [card]
      }
      return section
    }
    layout.register(LodySectionCardView.self, forDecorationViewOfKind: LodySectionCardView.kind)
    collection.setCollectionViewLayout(layout, animated: false)
    LodyScrollEdges.grouped(collection)
    refreshControl.addTarget(self, action: #selector(refreshPulled), for: .valueChanged)
    registerForTraitChanges([UITraitUserInterfaceStyle.self], action: #selector(appearanceChanged))
    placeholder.textAlignment = .center
    placeholder.numberOfLines = 0
    placeholder.textColor = .secondaryLabel
    placeholder.font = .preferredFont(forTextStyle: .subheadline)
    placeholder.adjustsFontForContentSizeCategory = true
    placeholder.isHidden = true
    addSubview(collection)
    addSubview(placeholder)
    topFade.color = ground
    bottomFade.color = ground
    addSubview(topFade)
    addSubview(bottomFade)
    segments.addTarget(self, action: #selector(segmentChanged), for: .valueChanged)
    segments.accessibilityIdentifier = "list-segments"
    steps.addTarget(self, action: #selector(stepChanged), for: .valueChanged)
    steps.tintColor = Self.accent
    steps.isHidden = true
    searchField.autocapitalizationType = .none
    searchField.autocorrectionType = .no
    searchField.spellCheckingType = .no
    searchField.returnKeyType = .search
    searchField.delegate = self
    searchField.isHidden = true
    searchField.accessibilityIdentifier = "list-search"
    searchField.addTarget(self, action: #selector(searchFieldChanged), for: .editingChanged)
    // Keep the input attached while diffable snapshots recycle its layout header.
    collection.addSubview(searchField)
    segmentContainer.accessibilityIdentifier = "list-strip"
    segmentContainer.isHidden = true
    segmentContainer.addSubview(segments)
    segmentContainer.addSubview(steps)
    addSubview(segmentContainer)
    // Registers the overlay with the scroll view so UIKit shapes the top edge
    // effect around it. Without this the control floats with nothing behind it.
    let interaction = UIScrollEdgeElementContainerInteraction()
    interaction.scrollView = collection
    interaction.edge = .top
    segmentContainer.addInteraction(interaction)
    appearance.view = UIView(frame: .zero)
    appearance.view.isUserInteractionEnabled = false
    appearance.onWillAppear = { [weak self] animated, coordinator in
      self?.deselectOnReturn(animated: animated, coordinator: coordinator)
    }
    appearance.onWillDisappear = { [weak self] _, coordinator in
      self?.finishUnreadHold(coordinator: coordinator)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    collection.frame = bounds
    updateBottomInset()
    let insets = collection.adjustedContentInset
    if !segmentContainer.isHidden {
      // Content starts below the bar plus the strip; the strip sits in that gap.
      let top = max(0, insets.top - collection.contentInset.top)
      segmentContainer.frame = CGRect(x: 0, y: top, width: bounds.width, height: segmentBarHeight)
      segments.frame = segmentContainer.bounds.insetBy(dx: 20, dy: Self.stripInset)
      steps.frame = segments.frame
    }
    placeholder.frame = bounds.inset(by: UIEdgeInsets(top: insets.top + 24, left: 32, bottom: insets.bottom + 24, right: 32))
    unavailableView?.frame = bounds.inset(by: UIEdgeInsets(top: insets.top, left: 0, bottom: insets.bottom, right: 0))
    attachScrollOwner()
    updateEdgeFades()
  }

  private func updateEdgeFades() {
    let fades = contentStyle && !transparent
    topFade.isHidden = !fades
    bottomFade.isHidden = !fades
    collection.topEdgeEffect.isHidden = fades
    collection.bottomEdgeEffect.isHidden = fades
    guard fades else { return }
    let insets = collection.adjustedContentInset
    let topBottom = insets.top + LodyEdgeFade.topExtent
    let topHeight = max(100, topBottom)
    topFade.frame = CGRect(x: 0, y: topBottom - topHeight, width: bounds.width, height: topHeight)
    let bottomHeight = max(100, insets.bottom + LodyEdgeFade.overlap)
    bottomFade.frame = CGRect(x: 0, y: bounds.height - bottomHeight, width: bounds.width, height: bottomHeight)
  }

  func scrollViewDidChangeAdjustedContentInset(_ scrollView: UIScrollView) {
    setNeedsLayout()
  }

  override func willMove(toSuperview newSuperview: UIView?) {
    if newSuperview == nil, appearance.parent != nil {
      appearance.willMove(toParent: nil)
      appearance.view.removeFromSuperview()
      appearance.removeFromParent()
    }
    super.willMove(toSuperview: newSuperview)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      detachSegments()
      if scrollOwner?.contentScrollView(for: .top) === collection {
        if let scrollOwner { LodyScrollEdges.unbind(collection, from: scrollOwner) }
      }
      scrollOwner = nil
    } else {
      attachScrollOwner()
    }
  }

  private func attachScrollOwner() {
    guard window != nil, scrollOwner == nil else { return }
    var responder: UIResponder? = next
    while let current = responder {
      if let controller = current as? UIViewController {
        LodyScrollEdges.bind(collection, to: controller)
        LodyScrollEdges.grouped(collection)
        scrollOwner = controller
        attachSegments(to: controller)
        if appearance.parent == nil {
          controller.addChild(appearance)
          addSubview(appearance.view)
          appearance.didMove(toParent: controller)
        }
        return
      }
      responder = current.next
    }
  }

  /// The bar owns the segmented control, the way Calendar's New sheet does:
  /// content scrolls under it and the navigation bar supplies the material and
  /// the scroll edge effect. A floating sibling view gets neither.
  private static let stripInset: CGFloat = 8
  private static let stripControlHeight: CGFloat = 36
  private var segmentBarHeight: CGFloat {
    Self.stripInset + Self.stripControlHeight + Self.stripInset
  }

  private var searchHeaderHeight: CGFloat {
    Self.stripControlHeight + Self.stripInset
  }

  /// Include the segment strip in the scroll view inset so UIKit covers it with the scroll edge effect.
  private func syncSegmentInset() {
    let wanted = segmentContainer.isHidden ? 0 : segmentBarHeight
    guard collection.contentInset.top != wanted else { return }
    collection.contentInset.top = wanted
    collection.verticalScrollIndicatorInsets.top = wanted
    setNeedsLayout()
  }

  private func attachSegments(to controller: UIViewController) {
    guard segments.numberOfSegments > 0 else { return }
    // No public API puts an arbitrary view in the bar's stacked palette; the
    // only thing that rides there is a search bar. Its scope bar, however, is a
    // real segmented control, and `.manual` activation keeps it visible without
    // search being active — the Calendar "New" layout, with public API only.
    guard segmentsUseSearchScope else { return }
    let item = controller.navigationItem
    let search = scopeSearch ?? UISearchController(searchResultsController: nil)
    scopeSearch = search
    search.scopeBarActivation = .manual
    search.hidesNavigationBarDuringPresentation = false
    search.obscuresBackgroundDuringPresentation = false
    search.searchBar.delegate = self
    search.searchBar.scopeButtonTitles = segmentLabels
    search.searchBar.showsScopeBar = true
    search.searchBar.selectedScopeButtonIndex = selectedSegment
    item.preferredSearchBarPlacement = .stacked
    item.hidesSearchBarWhenScrolling = false
    item.searchController = search
  }

  private func detachSegments() {
    guard let item = scrollOwner?.navigationItem else { return }
    if scopeSearch != nil, item.searchController === scopeSearch {
      item.searchController = nil
    }
    scopeSearch = nil
  }

  func searchBar(_ searchBar: UISearchBar, selectedScopeButtonIndexDidChange index: Int) {
    guard index != selectedSegment else { return }
    selectedSegment = index
    onSegmentChange(["index": index])
    forwarded?("segmentChange", ["index": index])
  }

  @objc private func searchFieldChanged() {
    onSearchChange(["text": searchField.text ?? ""])
    forwarded?("searchChange", ["text": searchField.text ?? ""])
  }

  func textFieldShouldReturn(_ textField: UITextField) -> Bool {
    textField.resignFirstResponder()
    return true
  }

  func setSearchPlaceholder(_ value: String) {
    searchField.placeholder = value
    let show = !value.isEmpty && !segmentsUseSearchScope
    searchField.isHidden = !show
    if show != searchEnabled {
      searchEnabled = show
      applySearchBoundary()
    }
    syncSegmentInset()
    setNeedsLayout()
  }

  func setSearchText(_ value: String) {
    guard searchField.text != value else { return }
    searchField.text = value
  }

  func setSegmentsUseSearchScope(_ value: Bool) {
    segmentsUseSearchScope = value
    let show = !(searchField.placeholder ?? "").isEmpty && !value
    searchField.isHidden = !show
    if show != searchEnabled {
      searchEnabled = show
      applySearchBoundary()
    }
    syncSegmentInset()
    setNeedsLayout()
  }

  func setSegments(_ labels: [String]) {
    segmentLabels = labels
    segments.removeAllSegments()
    for (index, label) in labels.enumerated() { segments.insertSegment(withTitle: label, at: index, animated: false) }
    steps.setTitles(labels)
    segments.selectedSegmentIndex = selectedSegment
    segmentContainer.isHidden = labels.isEmpty || segmentsUseSearchScope
    syncSegmentInset()
    if labels.isEmpty {
      detachSegments()
    } else if let controller = scrollOwner {
      attachSegments(to: controller)
    }
    setNeedsLayout()
  }

  func setSelectedSegment(_ index: Int) {
    selectedSegment = index
    segments.selectedSegmentIndex = index
    steps.setSelectedIndex(index)
    scopeSearch?.searchBar.selectedScopeButtonIndex = index
  }

  func setSegmentsStyle(_ value: String) {
    steps.isHidden = value != "steps"
    segments.isHidden = !steps.isHidden
  }

  func setSegmentsDone(_ value: [Bool]) {
    steps.setDone(value)
  }

  @objc private func stepChanged() {
    selectedSegment = steps.selectedIndex
    onSegmentChange(["index": selectedSegment])
    forwarded?("segmentChange", ["index": selectedSegment])
    collection.setContentOffset(CGPoint(x: 0, y: -collection.adjustedContentInset.top), animated: false)
  }

  @objc private func segmentChanged() {
    selectedSegment = segments.selectedSegmentIndex
    onSegmentChange(["index": selectedSegment])
    forwarded?("segmentChange", ["index": selectedSegment])
    collection.setContentOffset(CGPoint(x: 0, y: -collection.adjustedContentInset.top), animated: false)
  }

  private func toggleOutline(_ id: String) {
    guard let item = rowsByID.keys.first(where: { $0.row == id }) else { return }
    var snapshot = dataSource.snapshot(for: item.section)
    guard snapshot.contains(item) else { return }
    let expanded = !snapshot.isExpanded(item)
    if expanded {
      snapshot.expand([item])
    } else {
      snapshot.collapse([item])
    }
    dataSource.apply(snapshot, to: item.section, animatingDifferences: !UIAccessibility.isReduceMotionEnabled)
    outlineChanged(item, expanded: expanded)
  }

  private func outlineChanged(_ item: ListItemID, expanded: Bool) {
    guard let row = rowsByID[item] else { return }
    if row.parent {
      emitRowPress(["id": item.row, "expanded": expanded])
      return
    }
    if expanded { collapsedSessions.remove(item.row) }
    else { collapsedSessions.insert(item.row) }
    // UIKit finishes its outline update before refreshing the parent's summary.
    DispatchQueue.main.async { [weak self] in
      guard let self, let index = self.dataSource.indexPath(for: item),
            let cell = self.collection.cellForItem(at: index) as? UICollectionViewListCell,
            let current = self.rowsByID[item] else { return }
      self.configure(cell, row: self.displayed(current))
    }
  }

  func setSections(_ value: [LodyListSection], animated: Bool = true) {
    inputSections = value
    applySections(composedSections(), animated: animated)
  }

  private func applySections(_ value: [LodyListSection], animated: Bool) {
    let previous = dataSource.snapshot()
    let previousRows = rowsByID
    let hasHierarchy = value.contains(where: { $0.rows.contains { $0.parent || !$0.collapsedValue.isEmpty } })
    // Providers must still resolve the old visible rows while removing hierarchy.
    if !hasHierarchy { LodyListSection.prepareForFlatSnapshot(in: dataSource) }
    sections = value
    rowsByID = Dictionary(value.flatMap { section in
      section.rows.map { (ListItemID(section: section.id, row: $0.id), $0) }
    }, uniquingKeysWith: { _, latest in latest })
    textLeadings = [:]
    for section in value {
      let leading = LodyFlatRows.textLeading(sectionHasIcons: LodyFlatRows.sectionHasIcons(section.rows))
      for row in section.rows { textLeadings[row.id] = leading }
    }
    let live = Set(rowsByID.keys.map(\.row))
    toggles = toggles.filter { live.contains($0.key) }
    // Hierarchy belongs to the data, even when sections arrives before contentStyle.
    if hasHierarchy {
      applyOutline(value, previous: previous)
      updatePlaceholder()
      return
    }
    // Footer mode depends on placeholder visibility; resolve it before apply.
    updatePlaceholder()
    var snapshot = NSDiffableDataSourceSnapshot<String, ListItemID>()
    for section in value {
      snapshot.appendSections([section.id])
      snapshot.appendItems(section.rows.map { ListItemID(section: section.id, row: $0.id) }, toSection: section.id)
    }
    let existing = Set(previous.itemIdentifiers)
    let retained = snapshot.itemIdentifiers.filter { existing.contains($0) }
    // Reconfiguring must dequeue from the cell's original registration, so a
    // row whose kind changed (a new session gaining its badge) reloads instead.
    let rekinded = Set(retained.filter { id in
      guard let old = previousRows[id], let new = rowsByID[id] else { return false }
      return kind(of: old) != kind(of: new)
    })
    snapshot.reloadItems(Array(rekinded))
    snapshot.reconfigureItems(retained.filter { !rekinded.contains($0) })
    // Start disclosure rotation alongside the snapshot's row animation.
    for index in collection.indexPathsForVisibleSupplementaryElements(ofKind: UICollectionView.elementKindSectionHeader) {
      guard previous.sectionIdentifiers.indices.contains(index.section),
            let section = value.first(where: { $0.id == previous.sectionIdentifiers[index.section] }),
            let view = collection.supplementaryView(forElementKind: UICollectionView.elementKindSectionHeader, at: index) as? SectionSupplementaryCell else { continue }
      configureSupplementary(view, section: section, header: true)
    }
    let animate = animated
      && window != nil
      && !previous.sectionIdentifiers.isEmpty
      && !UIAccessibility.isReduceMotionEnabled
      && !LodyListSectionAnimation.itemCountsCrossEmpty(
        previous: itemCounts(in: previous),
        next: itemCounts(in: snapshot)
      )
    let finish: () -> Void = { [weak self] in
      guard let self else { return }
      for kind in [UICollectionView.elementKindSectionHeader, UICollectionView.elementKindSectionFooter] {
        for index in self.collection.indexPathsForVisibleSupplementaryElements(ofKind: kind) {
          if let view = self.collection.supplementaryView(forElementKind: kind, at: index) as? SectionSupplementaryCell,
             let section = self.section(at: index.section) {
            self.configureSupplementary(view, section: section, header: kind == UICollectionView.elementKindSectionHeader)
          }
        }
      }
      self.collection.collectionViewLayout.invalidateLayout()
    }
    if animate {
      dataSource.apply(snapshot, animatingDifferences: true, completion: finish)
    } else {
      UIView.performWithoutAnimation {
        self.dataSource.apply(snapshot, animatingDifferences: false, completion: finish)
        self.collection.layoutIfNeeded()
      }
    }
  }

  private func itemCounts(in snapshot: NSDiffableDataSourceSnapshot<String, ListItemID>) -> [String: Int] {
    Dictionary(uniqueKeysWithValues: snapshot.sectionIdentifiers.map {
      ($0, snapshot.itemIdentifiers(inSection: $0).count)
    })
  }

  /// Section snapshots own expansion, so a parent row collapses its children
  /// with UIKit's outline animation. A section
  /// order change rebuilds without animation: the flat snapshot that reorders
  /// sections carries no items, and re-adding them animated would replay every
  /// row.
  private func applyOutline(_ value: [LodyListSection], previous: NSDiffableDataSourceSnapshot<String, ListItemID>) {
    let ids = value.map(\.id)
    let sameSections = previous.sectionIdentifiers == ids
    if !sameSections {
      var main = NSDiffableDataSourceSnapshot<String, ListItemID>()
      main.appendSections(ids)
      dataSource.apply(main, animatingDifferences: false)
    }
    let animate = sameSections && window != nil && !UIAccessibility.isReduceMotionEnabled
    for section in value {
      let snapshot = section.outlineSnapshot(collapsed: collapsedSessions) {
        ListItemID(section: section.id, row: $0)
      }
      dataSource.apply(snapshot, to: section.id, animatingDifferences: animate)
    }
    for index in collection.indexPathsForVisibleItems {
      guard let cell = collection.cellForItem(at: index) as? UICollectionViewListCell, let row = row(at: index) else { continue }
      configure(cell, row: displayed(row))
    }
  }

  func setContentStyle(_ value: Bool) {
    guard value != contentStyle else { return }
    contentStyle = value
    lodyAppearanceDidChange()
    collection.collectionViewLayout.invalidateLayout()
    collection.reloadData()
    setNeedsLayout()
  }

  func setChatStyle(_ value: Bool) {
    guard value != chatStyle else { return }
    chatStyle = value
    collection.collectionViewLayout.invalidateLayout()
    collection.reloadData()
    setNeedsLayout()
  }

  func setGrouped(_ value: Bool) {
    guard value != grouped else { return }
    grouped = value
    lodyAppearanceDidChange()
    collection.collectionViewLayout.invalidateLayout()
    collection.reloadData()
    setNeedsLayout()
  }

  func setReordering(_ value: Bool) {
    guard value != reordering else { return }
    reordering = value
    collection.isEditing = value
    for index in collection.indexPathsForVisibleItems {
      guard let cell = collection.cellForItem(at: index) as? UICollectionViewListCell,
            let row = row(at: index) else { continue }
      configure(cell, row: displayed(row))
    }
  }

  /// A sheet paints its own material. Dropping the list's ground lets that
  /// material show between groups. The tertiary grouped surface keeps cells
  /// distinct when an expanded sheet switches to an opaque secondary surface.
  func setTransparent(_ value: Bool) {
    guard value != transparent else { return }
    transparent = value
    collection.backgroundColor = value ? .clear : ground
    collection.reloadData()
    setNeedsLayout()
  }

  private var ground: UIColor { grouped && !contentStyle ? .lodyGroupedBackground : .lodyGround }

  override func lodyAppearanceDidChange() {
    collection.backgroundColor = transparent ? .clear : ground
    topFade.color = ground
    bottomFade.color = ground
  }

  func setBottomInset(_ height: CGFloat) {
    bottomInset = height
    updateBottomInset()
  }

  private func updateBottomInset() {
    let wanted = max(0, bottomInset - collection.safeAreaInsets.bottom)
    guard collection.contentInset.bottom != wanted else { return }
    collection.contentInset.bottom = wanted
    collection.verticalScrollIndicatorInsets.bottom = wanted
  }

  func setPreviewUserId(_ value: String) {
    previewUserId = value
  }

  func setPreviewWorkspaceId(_ value: String) {
    previewWorkspaceId = value
  }

  func setAccent(_ value: String) {
    guard let color = lodyTint(value), color != LodyGroupedList.accent else { return }
    LodyGroupedList.accent = color
    collection.tintColor = color
    steps.tintColor = color
    collection.reloadData()
  }

  // Status badges are bitmaps resolved against the cell's appearance.
  @objc private func appearanceChanged() {
    let ids = collection.indexPathsForVisibleItems.compactMap { dataSource.itemIdentifier(for: $0) }
    guard !ids.isEmpty else { return }
    var snapshot = dataSource.snapshot()
    snapshot.reconfigureItems(ids)
    dataSource.apply(snapshot, animatingDifferences: false)
  }

  func setRefreshing(_ value: Bool) {
    if value, !refreshControl.isRefreshing {
      refreshControl.beginRefreshing()
    } else if !value, refreshControl.isRefreshing {
      refreshControl.endRefreshing()
    }
  }

  func setRefreshEnabled(_ value: Bool) {
    if value {
      if collection.refreshControl !== refreshControl {
        collection.refreshControl = refreshControl
      }
    } else {
      if refreshControl.isRefreshing { refreshControl.endRefreshing() }
      if collection.refreshControl === refreshControl {
        collection.refreshControl = nil
      }
    }
  }

  func setPlaceholder(_ value: String) {
    placeholderText = value
    updatePlaceholder()
  }

  private func updatePlaceholder() {
    let empty = inputSections.allSatisfy { $0.rows.isEmpty && $0.visual == nil && $0.headerActionId.isEmpty }
    let hide = !empty || placeholderText.isEmpty || loading || unavailableView != nil
    let visibilityChanged = placeholder.isHidden != hide
    placeholder.text = placeholderText
    placeholder.isHidden = hide
    if visibilityChanged {
      collection.collectionViewLayout.invalidateLayout()
    }
  }

  @objc private func refreshPulled() {
    onRefresh([:])
    forwarded?("refresh", [:])
  }

  private enum RowKind { case system, session, project, visual }

  private func kind(of row: LodyListRow) -> RowKind {
    if row.id == Self.visualRowID { return .visual }
    guard contentStyle else { return .system }
    if row.parent { return .project }
    return row.value.isEmpty && row.badge.isEmpty ? .system : .session
  }

  private func cell(in collectionView: UICollectionView, at indexPath: IndexPath, row: LodyListRow) -> UICollectionViewListCell {
    let cell: UICollectionViewListCell
    switch kind(of: row) {
    case .system: cell = collectionView.dequeueConfiguredReusableCell(using: registration, for: indexPath, item: row)
    case .session: cell = collectionView.dequeueConfiguredReusableCell(using: sessionRegistration, for: indexPath, item: row)
    case .project: cell = collectionView.dequeueConfiguredReusableCell(using: projectRegistration, for: indexPath, item: row)
    case .visual:
      let id = ListItemID(section: dataSource.sectionIdentifier(for: indexPath.section) ?? "", row: row.id)
      cell = collectionView.dequeueConfiguredReusableCell(using: visualRegistration, for: indexPath, item: id)
    }
    decorate(cell, row: row)
    if let notice, dataSource.sectionIdentifier(for: indexPath.section) == Self.noticeSectionID {
      var background = UIBackgroundConfiguration.listGroupedCell()
      background.backgroundColor = (lodyTint(notice.tint) ?? .secondaryLabel).withAlphaComponent(0.12)
      cell.configurationUpdateHandler = nil
      cell.backgroundConfiguration = background
    }
    return cell
  }

  private func configure(_ cell: UICollectionViewListCell, row: LodyListRow) {
    switch kind(of: row) {
    case .system: if let cell = cell as? SettingsListCell { configureSettingsCell(cell, row) }
    case .session: if let cell = cell as? LodyIndentedCell { configureSession(cell, row) }
    case .project: configureProject(cell, row)
    case .visual: break
    }
    decorate(cell, row: row)
  }

  @objc private func rowSwitchChanged(_ sender: RowSwitch) {
    let requested = sender.isOn
    // The owner may reject a change without sending different props back.
    if let index = indexPath(for: sender.rowID), let current = row(at: index)?.toggle {
      sender.setOn(current, animated: false)
    }
    onRowToggle(["id": sender.rowID, "value": requested])
    forwarded?("rowToggle", ["id": sender.rowID, "value": requested])
  }

  /// Reused per row id so a reconfigure keeps the live switch instead of swapping in a
  /// fresh one, which reads as a flicker mid-animation.
  private func toggle(for row: LodyListRow) -> UISwitch? {
    guard let on = row.toggle else { return nil }
    let toggle = toggles[row.id] ?? {
      let created = RowSwitch()
      created.addTarget(self, action: #selector(rowSwitchChanged(_:)), for: .valueChanged)
      toggles[row.id] = created
      return created
    }()
    toggle.rowID = row.id
    toggle.setOn(on, animated: false)
    toggle.isEnabled = row.action
    toggle.accessibilityIdentifier = row.id + ":toggle"
    return toggle
  }

  private func decorate(_ cell: UICollectionViewListCell, row: LodyListRow) {
    // Project membership keeps the existing columns; only opened sessions indent.
    cell.indentationWidth = 20
    cell.indentationLevel = row.parentId.isEmpty || contentStyle ? 0 : 1
    cell.configurationUpdateHandler = nil
    cell.automaticallyUpdatesBackgroundConfiguration = true
    if contentStyle {
      cell.automaticallyUpdatesBackgroundConfiguration = false
      if var content = cell.contentConfiguration as? UIListContentConfiguration {
        content.textProperties.numberOfLines = 2
        content.secondaryTextProperties.font = .preferredFont(forTextStyle: .footnote)
        content.directionalLayoutMargins = .init(
          top: 10, leading: LodyDesign.Rail.text, bottom: 10, trailing: LodyDesign.Rail.trailing
        )
        if outline, row.navigates {
          content.textProperties.font = LodyDesign.font(.subheadline, size: 15)
          content.textProperties.color = .lodySecondary
        }
        cell.contentConfiguration = content
      }
      cell.configurationUpdateHandler = { cell, state in
        cell.backgroundConfiguration = LodyListCellBackground.railConfiguration(for: state)
      }
    } else if flatSystem, chatStyle {
      // Pressed rows tint like chat rows.
      cell.automaticallyUpdatesBackgroundConfiguration = false
      cell.configurationUpdateHandler = { cell, state in
        var background = UIBackgroundConfiguration.clear()
        background.backgroundColor = state.isHighlighted || state.isSelected || state.isSwiped ? LodyUIColor.fillPressed : .clear
        cell.backgroundConfiguration = background
      }
    } else if flatSystem {
      cell.automaticallyUpdatesBackgroundConfiguration = false
      cell.configurationUpdateHandler = { cell, state in
        cell.backgroundConfiguration = LodyListCellBackground.railConfiguration(for: state)
      }
    } else if transparent {
      // A static backgroundConfiguration freezes the cell's appearance, so the
      // highlighted and selected states stop rendering. The update handler
      // keeps UIKit's state resolution and only forces the resting color to be
      // opaque, which the glass sheet context otherwise makes translucent.
      cell.configurationUpdateHandler = { cell, state in
        var background = UIBackgroundConfiguration.listGroupedCell().updated(for: state)
        if !state.isHighlighted && !state.isSelected {
          background.backgroundColor = LodyGroupedList.restingCard
        }
        cell.backgroundConfiguration = background
      }
    } else {
      cell.backgroundConfiguration = UIBackgroundConfiguration.listGroupedCell()
    }
  }

  private func section(at index: Int) -> LodyListSection? {
    guard let id = dataSource.sectionIdentifier(for: index) else { return nil }
    return sections.first { $0.id == id }
  }

  private func applySearchBoundary() {
    guard let layout = collection.collectionViewLayout as? UICollectionViewCompositionalLayout else {
      return
    }
    var configuration = layout.configuration
    if searchEnabled {
      let item = NSCollectionLayoutBoundarySupplementaryItem(
        layoutSize: NSCollectionLayoutSize(
          widthDimension: .fractionalWidth(1),
          heightDimension: .absolute(searchHeaderHeight)
        ),
        elementKind: Self.searchKind,
        alignment: .top
      )
      item.pinToVisibleBounds = false
      configuration.boundarySupplementaryItems = [item]
    } else {
      configuration.boundarySupplementaryItems = []
    }
    layout.configuration = configuration
    layout.invalidateLayout()
  }

  private func installSearch(in cell: SearchHeaderCell) {
    searchHeader?.onLayout = nil
    searchHeader = cell
    cell.onLayout = { [weak self] header in
      guard let self else { return }
      self.searchField.frame = header.convert(
        CGRect(x: 20, y: 0, width: header.bounds.width - 40, height: 36), to: self.collection)
      self.collection.bringSubviewToFront(self.searchField)
    }
    cell.setNeedsLayout()
  }

  private func supplementary(in collectionView: UICollectionView, kind: String, at indexPath: IndexPath) -> UICollectionReusableView? {
    if kind == Self.searchKind {
      return collectionView.dequeueConfiguredReusableSupplementary(
        using: searchRegistration, for: indexPath
      )
    }
    guard let section = section(at: indexPath.section) else { return nil }
    let header = kind == UICollectionView.elementKindSectionHeader
    let view = collectionView.dequeueConfiguredReusableSupplementary(
      using: header ? headerRegistration : footerRegistration,
      for: indexPath
    )
    configureSupplementary(view, section: section, header: header)
    return view
  }

  private func configureSupplementary(_ view: SectionSupplementaryCell, section: LodyListSection, header: Bool) {
    let text = header ? section.header : section.footer
    if view.accessibilityIdentifier != section.headerActionId { view.expanded = nil }
    if !header || section.headerExpanded == nil { view.accessories = [] }
    view.accessibilityValue = nil
    view.accessibilityIdentifier = header ? section.headerActionId : nil
    view.accessibilityTraits = header ? .header : .staticText
    view.isUserInteractionEnabled = header && !section.headerActionId.isEmpty
    guard !text.isEmpty else {
      view.contentConfiguration = nil
      return
    }
    var content = UIListContentConfiguration.groupedFooter()
    if header {
      content = section.headerProminent ? .prominentInsetGroupedHeader() : .groupedHeader()
      if section.headerProminent { content.textProperties.color = .label }
    }
    if flatSystem, chatStyle {
      content.textProperties.transform = .none
      content.textProperties.color = LodyUIColor.textTertiary
      content.textProperties.font = header ? LodyTextStyle.groupLabel.uiFont : LodyTextStyle.footnote.uiFont
    } else if flatSystem {
      content.textProperties.transform = .none
      content.textProperties.color = .lodySecondary
      content.textProperties.font = header
        ? LodyDesign.font(.footnote, size: 13, weight: .semibold)
        : LodyDesign.font(.footnote, size: 12.5)
    }
    content.text = text
    content.textProperties.numberOfLines = 0
    if header, !section.headerStatus.isEmpty,
       let title = LodyListStatus.header(
         text,
         status: section.headerStatus,
         font: content.textProperties.font,
         color: content.textProperties.resolvedColor()
       ) {
      content.attributedText = title
      view.accessibilityLabel = text
    } else {
      view.accessibilityLabel = nil
    }
    if flatSystem, chatStyle {
      // Group spacing belongs above the header; keep the label close to its rows.
      content.directionalLayoutMargins = header
        ? .init(top: LodySpacing.sm, leading: LodyLayout.listEdgeX, bottom: LodySpacing.xs, trailing: LodyLayout.listEdgeX)
        : .init(top: LodySpacing.sm, leading: LodyLayout.listEdgeX, bottom: 0, trailing: LodyLayout.listEdgeX)
    } else if flatSystem {
      let footerLeading = LodyFlatRows.textLeading(sectionHasIcons: LodyFlatRows.sectionHasIcons(section.rows))
      content.directionalLayoutMargins = header
        ? .init(top: Self.flatHeaderTop, leading: LodyFlatRows.readingMargin, bottom: 6, trailing: LodyDesign.Rail.trailing)
        : .init(top: 8, leading: footerLeading, bottom: 0, trailing: LodyDesign.Rail.trailing)
    } else if contentStyle {
      content.directionalLayoutMargins = .init(top: 10, leading: 16, bottom: 10, trailing: LodyDesign.Rail.trailing)
      if header {
        let title = NSMutableAttributedString(string: text, attributes: [
          .font: LodyDesign.font(.footnote, size: 13, weight: .semibold), .foregroundColor: UIColor.lodySecondary,
        ])
        if !section.headerValue.isEmpty {
          title.append(NSAttributedString(string: "  " + section.headerValue, attributes: [
            .font: LodyDesign.mono(12), .foregroundColor: UIColor.lodyTertiary,
          ]))
        }
        content.text = nil
        content.attributedText = title
        content.directionalLayoutMargins.top = 10
        content.directionalLayoutMargins.bottom = 4
      }
    }
    if header && !section.headerActionId.isEmpty {
      view.accessibilityTraits = [.header, .button]
      if let expanded = section.headerExpanded {
        let arrow = view.arrow
        let changed = view.expanded != expanded
        let shouldAnimate = view.expanded != nil && changed && view.window != nil && !UIAccessibility.isReduceMotionEnabled
        view.expanded = expanded
        let rotation = { arrow.transform = expanded ? CGAffineTransform(rotationAngle: .pi / 2) : .identity }
        if shouldAnimate {
          UIView.animate(withDuration: 0.3, delay: 0, options: [.beginFromCurrentState, .allowUserInteraction, .curveEaseInOut], animations: rotation)
        } else if changed {
          UIView.performWithoutAnimation(rotation)
        }
        arrow.tintColor = .secondaryLabel
        arrow.bounds = CGRect(x: 0, y: 0, width: 16, height: 16)
        arrow.contentMode = .center
        if view.accessories.isEmpty {
          view.accessories = [.customView(configuration: .init(customView: arrow, placement: .trailing()))]
        }
        view.accessibilityValue = String(localized: String.LocalizationValue(expanded ? "native.list.expanded" : "native.list.collapsed"), bundle: .lody)
      } else {
        view.accessories = [.disclosureIndicator()]
      }
      if !(view.gestureRecognizers?.contains { $0 is SectionHeaderTap } ?? false) {
        view.addGestureRecognizer(SectionHeaderTap(target: self, action: #selector(headerPressed(_:))))
      }
    }
    view.contentConfiguration = content
    view.backgroundConfiguration = .clear()
  }

  @objc private func headerPressed(_ gesture: UITapGestureRecognizer) {
    guard let id = gesture.view?.accessibilityIdentifier, !id.isEmpty else { return }
    emitRowPress(["id": id])
  }

  private func swipeActions(at indexPath: IndexPath, leading: Bool) -> UISwipeActionsConfiguration? {
    guard let row = row(at: indexPath) else { return nil }
    return LodyListRowInteractions.swipes(row: row, leading: leading) { [weak self] id, actionId in
      self?.emitRowAction(["id": id, "actionId": actionId])
    }
  }

  func row(at index: IndexPath) -> LodyListRow? {
    dataSource.itemIdentifier(for: index).flatMap { rowsByID[$0] }
  }

  private func selectable(_ indexPath: IndexPath) -> Bool {
    guard let row = row(at: indexPath) else { return false }
    return row.action && row.toggle == nil && row.options.isEmpty
  }
  func collectionView(_ collectionView: UICollectionView, shouldSelectItemAt indexPath: IndexPath) -> Bool {
    selectable(indexPath)
  }
  func collectionView(_ collectionView: UICollectionView, shouldHighlightItemAt indexPath: IndexPath) -> Bool {
    selectable(indexPath)
  }
  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    guard let row = row(at: indexPath) else { return }
    if row.navigates {
      collectionView.selectItem(at: indexPath, animated: true, scrollPosition: [])
    } else {
      collectionView.deselectItem(at: indexPath, animated: true)
    }
    if row.parent && !row.navigates {
      toggleOutline(row.id)
      return
    }
    emitRowPress(["id": row.id])
  }

  func collectionView(
    _ collectionView: UICollectionView,
    contextMenuConfigurationForItemsAt indexPaths: [IndexPath],
    point: CGPoint
  ) -> UIContextMenuConfiguration? {
    guard let indexPath = indexPaths.first else { return nil }
    return menuConfiguration(at: indexPath)
  }

  func collectionView(
    _ collectionView: UICollectionView,
    contextMenuConfigurationForItemAt indexPath: IndexPath,
    point: CGPoint
  ) -> UIContextMenuConfiguration? {
    menuConfiguration(at: indexPath)
  }

  func collectionView(
    _ collectionView: UICollectionView,
    willPerformPreviewActionForMenuWith configuration: UIContextMenuConfiguration,
    animator: UIContextMenuInteractionCommitAnimating
  ) {
    guard let id = configuration.identifier as? String else { return }
    animator.addCompletion { [weak self] in
      self?.commitMenu(id)
    }
  }

  private func menuConfiguration(at indexPath: IndexPath) -> UIContextMenuConfiguration? {
    guard let row = row(at: indexPath) else { return nil }
    return LodyListRowInteractions.menu(row: row, userId: previewUserId, workspaceId: previewWorkspaceId) { [weak self] id, actionId in
      self?.emitRowAction(["id": id, "actionId": actionId])
    }
  }

  private func commitMenu(_ id: String) {
    if id.hasPrefix("toggle:") {
      emitRowPress(["id": "project:" + String(id.dropFirst(7))])
      return
    }
    emitRowPress(["id": id])
  }

  private func indexPath(for id: String) -> IndexPath? {
    rowsByID.keys.first { $0.row == id }.flatMap { dataSource.indexPath(for: $0) }
  }

  private func displayed(_ row: LodyListRow) -> LodyListRow {
    var copy = row.displayingCollapsed(collapsedSessions.contains(row.id), keepingTime: true)
    copy.unread = unreadHold.applied(rowID: row.id, unread: row.unread)
    return copy
  }

  private func finishUnreadHold(coordinator: UIViewControllerTransitionCoordinator?) {
    guard unreadHold.isHolding else { return }
    let apply = { [weak self] in self?.releaseUnreadHold() }
    guard let coordinator else {
      apply()
      return
    }
    let started = coordinator.animate(alongsideTransition: nil, completion: { _ in apply() })
    if !started { apply() }
  }

  private func releaseUnreadHold() {
    guard let id = unreadHold.end() else { return }
    guard let item = rowsByID.keys.first(where: { $0.row == id }) else { return }
    var snapshot = dataSource.snapshot()
    guard snapshot.itemIdentifiers.contains(item) else { return }
    snapshot.reconfigureItems([item])
    dataSource.apply(snapshot, animatingDifferences: false)
  }

  private func deselectOnReturn(animated: Bool, coordinator: UIViewControllerTransitionCoordinator?) {
    guard let index = collection.indexPathsForSelectedItems?.first else { return }
    guard let id = row(at: index)?.id else { return }
    guard let coordinator else {
      collection.deselectItem(at: index, animated: animated)
      return
    }
    let started = coordinator.animate(alongsideTransition: { [weak self] _ in
      guard let self, let current = self.indexPath(for: id) else { return }
      self.collection.deselectItem(at: current, animated: animated)
    }, completion: { [weak self] context in
      guard context.isCancelled, let self, let current = self.indexPath(for: id) else { return }
      self.collection.selectItem(at: current, animated: false, scrollPosition: [])
    })
    if !started { collection.deselectItem(at: index, animated: animated) }
  }

}
